/* Arcade bowling physics: 2D collisions on the lane plane + simple vertical/tumble state.
   Units: meters, seconds. +x right, -z toward the pins. Same file runs in Node (tests) and inline in the page. */
const BowlPhys = (function () {
  const LANE_HALF = 0.5334, GUT_CENTER = 0.65, WALL = 0.74, LANE_END = -19.45, BACK_WALL = -20.55;
  const HEAD_Z = -18.29, ROW_DZ = 0.2639, PIN_DX = 0.1524;
  const BALL_R = 0.109, PIN_COM = 0.15;
  const GUT_Y = -0.07, PIT_Y = -0.4;
  const TUNE = {
    ballMass: 6.5, pinMass: 1.5,
    pinRStand: 0.068, pinRFall: 0.09,
    eBallPin: 0.55, ePinPin: 0.6,
    fallSpeed: 0.8,
    standFric: 3.2, lyingFric: 4.5,
    hook: 1.6, rollDecel: 0.18,
    hopK: 0.2, jitter: 0.08,
  };

  // selectable ball weights (lb). Heavier: more pin action, a little slower, hooks less.
  const WEIGHTS = [8, 10, 12, 14, 16];
  function ballSpec(lb) {
    const t = Math.max(0, Math.min(1, (lb - 6) / 10));
    return { lb, kg: lb * 0.45359, speedK: 1.06 - 0.16 * t, hookK: 1.2 - 0.35 * t, carry: 0.72 + 0.6 * t };
  }

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const groundY = (x, z) => (z < LANE_END ? PIT_Y : (Math.abs(x) > LANE_HALF ? GUT_Y : 0));

  class Sim {
    constructor(seed) {
      this.rand = mulberry32(seed || 1);
      this.T = Object.assign({}, TUNE);
      this.pins = [];
      this.ball = null;
      this.time = 0;
      this.events = [];
      this.calmTime = 0;
      this.resetRack();
    }

    makePin(id, x, z) {
      return {
        id, x0: x, z0: z, x, z, vx: 0, vz: 0, y: 0, vy: 0,
        state: 'stand',           // stand | fall | down
        tilt: 0, tiltV: 0, dir: 0, yaw: this.rand() * 6.28, yawV: 0,
        wob: 0, wobT: 0, zone: 'lane', removed: false,
      };
    }

    resetRack() {
      const rows = [[0], [-1, 1], [-2, 0, 2], [-3, -1, 1, 3]];
      this.pins = [];
      let id = 1;
      rows.forEach((r, i) => r.forEach(k => this.pins.push(this.makePin(id++, k * PIN_DX, HEAD_Z - i * ROW_DZ))));
      this.ball = null; this.time = 0; this.calmTime = 0; this.events = [];
    }

    // keep only standing, un-removed pins (second ball of a frame)
    clearFallen() {
      this.pins = this.pins.filter(p => p.state === 'stand' && !p.removed);
      this.pins.forEach(p => { p.vx = p.vz = 0; p.wob = 0; p.tilt = 0; p.y = 0; p.vy = 0; });
      this.ball = null; this.time = 0; this.calmTime = 0; this.events = [];
    }

    standing() { return this.pins.filter(p => p.state === 'stand').map(p => p.id); }

    launch({ x, aim, speed, spin, mass, hookK, carry }) {
      this.ball = {
        x, z: 1.0, vx: Math.sin(aim) * speed, vz: -Math.cos(aim) * speed, y: BALL_R, vy: 0,
        zone: 'lane', spin: spin || 0, spinFast: speed, travelled: 0, done: false, hitAny: false,
        mass: mass || this.T.ballMass, hookK: hookK || 1, carry: carry || 1,
      };
      this.time = 0; this.calmTime = 0; this.events = [];
    }

    emit(type, a) { this.events.push({ type, a: a || 0 }); }

    // ---- collisions ------------------------------------------------------------------------
    pinRadius(p) { return p.state === 'stand' ? this.T.pinRStand : this.T.pinRFall; }
    collidable(p) {
      if (p.removed) return false;
      if (p.zone === 'pit' && p.y < -0.15) return false;
      if (p.state === 'down') return Math.hypot(p.vx, p.vz) > 0.3;
      return true;
    }

    hitPin(p, speedAfter, n, vrel) {
      if (p.state === 'stand' && speedAfter > this.T.fallSpeed) {
        p.state = 'fall';
        p.dir = Math.atan2(p.vz, p.vx);
        p.tiltV = Math.min(22, 4 + 1.15 * speedAfter) * (0.85 + 0.3 * this.rand());
        if (speedAfter > 2.2) p.vy = Math.min(3.2, this.T.hopK * speedAfter * (0.35 + 0.9 * this.rand()));
        p.yawV = (this.rand() - 0.5) * 2 * Math.min(14, 2 + speedAfter);
        this.emit('pin', Math.min(1, vrel / 8));
      } else if (p.state === 'stand') {
        p.wob = Math.min(0.28, speedAfter * 0.3 + 0.03); p.wobT = 0; p.dir = Math.atan2(p.vz, p.vx);
      } else {
        // already falling/down: re-kick
        if (p.state === 'down' && Math.hypot(p.vx, p.vz) > 0.5) { p.state = 'fall'; p.dir = Math.atan2(p.vz, p.vx); p.tiltV = 6; }
        this.emit('pin', Math.min(1, vrel / 10) * 0.7);
      }
    }

    collideBallPin(b, p) {
      const T = this.T;
      const dx = b.x - p.x, dz = b.z - p.z;
      const R = BALL_R + this.pinRadius(p);
      const d2 = dx * dx + dz * dz;
      if (d2 >= R * R || d2 < 1e-9) return;
      const d = Math.sqrt(d2);
      let nx = dx / d, nz = dz / d;
      const jb = (this.rand() - 0.5) * 2 * T.jitter, cb = Math.cos(jb), sb = Math.sin(jb);
      [nx, nz] = [nx * cb - nz * sb, nx * sb + nz * cb];
      const vrel = (b.vx - p.vx) * nx + (b.vz - p.vz) * nz;
      const pen = R - d;
      const mb = b.mass || T.ballMass, mp = T.pinMass, inv = 1 / mb + 1 / mp;
      // positional separation (pin takes most of it)
      p.x -= nx * pen * (mb / (mb + mp)); p.z -= nz * pen * (mb / (mb + mp));
      b.x += nx * pen * (mp / (mb + mp)); b.z += nz * pen * (mp / (mb + mp));
      if (vrel < 0) {
        const j = -(1 + T.eBallPin) * vrel / inv;
        b.vx += j / mb * nx; b.vz += j / mb * nz;
        p.vx -= j / mp * nx * (b.carry || 1); p.vz -= j / mp * nz * (b.carry || 1);
        b.hitAny = true;
        this.hitPin(p, Math.hypot(p.vx, p.vz), { x: nx, z: nz }, -vrel);
        this.emit('ball', Math.min(1, -vrel / 8));
      }
    }

    collidePinPin(a, c) {
      const T = this.T;
      const dx = a.x - c.x, dz = a.z - c.z;
      const R = this.pinRadius(a) + this.pinRadius(c);
      const d2 = dx * dx + dz * dz;
      if (d2 >= R * R || d2 < 1e-9) return;
      const d = Math.sqrt(d2);
      let nx = dx / d, nz = dz / d;
      const jp = (this.rand() - 0.5) * 2 * T.jitter * 1.5, cp = Math.cos(jp), sp2 = Math.sin(jp);
      [nx, nz] = [nx * cp - nz * sp2, nx * sp2 + nz * cp];
      const vrel = (a.vx - c.vx) * nx + (a.vz - c.vz) * nz;
      const pen = R - d;
      a.x += nx * pen * 0.5; a.z += nz * pen * 0.5; c.x -= nx * pen * 0.5; c.z -= nz * pen * 0.5;
      if (vrel < 0) {
        const j = -(1 + T.ePinPin) * vrel / (2 / T.pinMass);
        a.vx += j / T.pinMass * nx; a.vz += j / T.pinMass * nz;
        c.vx -= j / T.pinMass * nx; c.vz -= j / T.pinMass * nz;
        this.hitPin(a, Math.hypot(a.vx, a.vz), null, -vrel);
        this.hitPin(c, Math.hypot(c.vx, c.vz), null, -vrel);
      }
    }

    // ---- integration -----------------------------------------------------------------------
    stepBall(dt) {
      const b = this.ball, T = this.T;
      if (!b || b.done) return;
      const sp = Math.hypot(b.vx, b.vz);
      if (b.zone === 'lane') {
        if (b.z < -3 && b.z > LANE_END) {
          const prog = Math.min(1, (-b.z - 3) / 14);
          b.vx += T.hook * (b.hookK || 1) * b.spin * (0.12 + 0.88 * prog * prog) * Math.min(1, sp / 7) * dt;
        }
        const nsp = Math.max(0, sp - T.rollDecel * dt);
        if (sp > 0) { b.vx *= nsp / sp; b.vz *= nsp / sp; }
        b.x += b.vx * dt; b.z += b.vz * dt;
        if (b.z < 0 && Math.abs(b.x) > LANE_HALF + 0.01 && b.z > LANE_END) {
          b.zone = 'gutter'; this.emit('gutter', 1);
        }
      } else if (b.zone === 'gutter') {
        const tx = Math.sign(b.x) * GUT_CENTER;
        b.vx = (tx - b.x) * 9;
        b.x += b.vx * dt; b.z += b.vz * dt;
        b.vz *= (1 - 0.05 * dt);
        b.y = Math.max(GUT_Y + BALL_R, b.y - 3 * dt);
      }
      if (b.z < LANE_END && b.zone !== 'pit') { b.zone = 'pit'; this.emit('pit', 1); }
      if (b.zone === 'pit') {
        b.vy -= 9.8 * dt; b.y += b.vy * dt;
        if (b.y < PIT_Y + BALL_R) { b.y = PIT_Y + BALL_R; b.vy = 0; }
        b.x += b.vx * dt; b.z += b.vz * dt;
        b.vx *= 0.98; b.vz *= (1 - 2.2 * dt);
        if (b.z < BACK_WALL + BALL_R) { b.z = BACK_WALL + BALL_R; b.vz = 0; }
        if (Math.abs(b.x) > WALL - BALL_R) { b.x = Math.sign(b.x) * (WALL - BALL_R); b.vx = 0; }
        if (Math.hypot(b.vx, b.vz) < 0.2) b.done = true;
      }
      if (b.zone !== 'pit' && sp < 0.15 && b.z < -3) b.done = true;
    }

    stepPin(p, dt) {
      const T = this.T;
      if (p.removed) return;
      const sp = Math.hypot(p.vx, p.vz);
      const gy = groundY(p.x, p.z);
      const airborne = p.y > gy + 1e-4 || Math.abs(p.vy) > 1e-3;
      if (p.state === 'stand') {
        if (sp > 0) {
          const ns = Math.max(0, sp - T.standFric * dt);
          p.vx *= ns / sp; p.vz *= ns / sp;
        }
        p.x += p.vx * dt; p.z += p.vz * dt;
        if (p.wob > 0) { p.wobT += dt; p.wob = Math.max(0, p.wob - 0.35 * dt); }
      } else {
        p.x += p.vx * dt; p.z += p.vz * dt;
        if (airborne) {
          p.vy -= 9.8 * dt; p.y += p.vy * dt;
          p.tilt += p.tiltV * dt;
          if (p.y <= gy) {
            p.y = gy;
            if (p.vy < -1.4) { this.emit('land', Math.min(1, -p.vy / 6)); p.vy = -p.vy * 0.28; } else p.vy = 0;
          }
        } else if (sp > 0) {
          const ns = Math.max(0, sp - T.lyingFric * dt);
          p.vx *= ns / sp; p.vz *= ns / sp;
        }
        // grounded lying pin: settle tilt to a flat pose
        if (!airborne) {
          const target = Math.round((p.tilt - Math.PI / 2) / Math.PI) * Math.PI + Math.PI / 2;
          const diff = target - p.tilt;
          p.tilt += diff * Math.min(1, 14 * dt);
          p.tiltV *= 0.9;
          if (Math.abs(diff) < 0.03 && sp < 0.12 && Math.abs(p.vy) < 0.05) { p.state = 'down'; p.vx = p.vz = 0; p.tilt = target; }
        }
        p.yaw += p.yawV * dt; p.yawV *= (1 - 1.2 * dt);
      }
      // zones
      p.zone = p.z < LANE_END ? 'pit' : (Math.abs(p.x) > LANE_HALF ? 'gutter' : 'lane');
      if (p.zone !== 'pit' && !airborne && p.state !== 'stand' && p.y > gy) p.y = gy;
      if (p.zone !== 'lane' && p.state === 'stand') {
        // a standing pin pushed over an edge falls
        p.state = 'fall'; p.dir = Math.atan2(p.vz, p.vx); p.tiltV = 6;
      }
      // walls
      if (Math.abs(p.x) > WALL - 0.05) { p.x = Math.sign(p.x) * (WALL - 0.05); p.vx *= -0.3; }
      if (p.z < BACK_WALL + 0.1) { p.z = BACK_WALL + 0.1; p.vz *= -0.25; if (p.y > PIT_Y + 0.05) this.emit('wall', 0.5); }
      if (p.z > HEAD_Z + 1.2) { p.z = HEAD_Z + 1.2; p.vz = 0; }
    }

    step(dt) {
      const b = this.ball;
      this.time += dt;
      this.stepBall(dt);
      for (const p of this.pins) this.stepPin(p, dt);
      // collisions
      if (b && b.zone !== 'gutter') {
        for (const p of this.pins) if (this.collidable(p) && p.y < 0.35) this.collideBallPin(b, p);
      } else if (b && b.zone === 'gutter') {
        for (const p of this.pins) if (p.zone === 'gutter' && this.collidable(p)) this.collideBallPin(b, p);
      }
      const ps = this.pins;
      for (let i = 0; i < ps.length; i++) {
        if (!this.collidable(ps[i])) continue;
        for (let k = i + 1; k < ps.length; k++) {
          if (!this.collidable(ps[k])) continue;
          // ghost rule: two standing, non-moving pins never interact
          if (ps[i].state === 'stand' && ps[k].state === 'stand' && Math.hypot(ps[i].vx, ps[i].vz) < 0.01 && Math.hypot(ps[k].vx, ps[k].vz) < 0.01) continue;
          this.collidePinPin(ps[i], ps[k]);
        }
      }
      // settle detection
      let moving = 0;
      for (const p of this.pins) if (!p.removed && (p.state === 'fall' || Math.hypot(p.vx, p.vz) > 0.04)) moving = Math.max(moving, 1);
      const ballMoving = b && !b.done && b.z < 1;
      this.calmTime = (moving || ballMoving) ? 0 : this.calmTime + dt;
    }

    isSettled() { return this.ball && this.ball.z < -3.5 && this.calmTime > 0.7 && this.ball.done; }
    ballGone() { return this.ball && (this.ball.done || this.ball.zone === 'pit'); }
    fallenCount() { return this.pins.filter(p => p.state !== 'stand' && !p.removed).length; }
  }

  // Where a ball released with these settings will roll (no pins). Mirrors Sim.stepBall for the lane zone,
  // so the on-screen guide line matches the real throw. Returns [[x, z], ...] and whether it ends in a gutter.
  function previewPath({ x, aim, speed, spin, hookK }) {
    const pts = [[x, 1.0]];
    let px = x, pz = 1.0, vx = Math.sin(aim) * speed, vz = -Math.cos(aim) * speed, out = false;
    const dt = 1 / 120;
    for (let i = 0; i < 1600; i++) {
      const sp = Math.hypot(vx, vz);
      if (pz < -3 && pz > LANE_END) {
        const prog = Math.min(1, (-pz - 3) / 14);
        vx += TUNE.hook * (hookK || 1) * spin * (0.12 + 0.88 * prog * prog) * Math.min(1, sp / 7) * dt;
      }
      const nsp = Math.max(0, sp - TUNE.rollDecel * dt);
      if (sp > 0) { vx *= nsp / sp; vz *= nsp / sp; }
      px += vx * dt; pz += vz * dt;
      if (i % 4 === 3) pts.push([px, pz]);
      if (pz < 0 && Math.abs(px) > LANE_HALF + 0.01) { pts.push([px, pz]); out = true; break; }
      if (pz < HEAD_Z - 0.3 || nsp < 0.2) { pts.push([px, pz]); break; }
    }
    return { pts, out };
  }

  // convenience for tests: run a throw until settled
  function run(sim, throwParams, maxT) {
    sim.launch(throwParams);
    const dt = 1 / 240;
    let guard = 0;
    while (sim.time < (maxT || 12) && guard++ < 100000) {
      sim.step(dt);
      if (sim.ball && sim.ball.done && sim.calmTime > 0.7) break;
      if (sim.time > 3 && sim.calmTime > 1.5) break;
    }
    return sim;
  }

  return { Sim, run, TUNE, WEIGHTS, ballSpec, previewPath, LANE_HALF, GUT_CENTER, WALL, LANE_END, BACK_WALL, HEAD_Z, ROW_DZ, PIN_DX, BALL_R, PIN_COM, GUT_Y, PIT_Y, mulberry32, groundY };
})();
if (typeof module !== 'undefined') module.exports = BowlPhys;
