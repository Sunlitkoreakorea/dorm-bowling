"""src/ 의 소스를 합쳐 배포용 index.html 한 장을 만듭니다.

    python build.py

phys.js(핀 물리)를 bowling.src.html 안에 끼워 넣고, 문서 머리(head)를 붙여 index.html 로 저장합니다.
"""
import re

src = open('src/bowling.src.html', encoding='utf-8').read()
phys = open('src/phys.js', encoding='utf-8').read()
phys = re.sub(r"\nif \(typeof module.*\n?$", "\n", phys.rstrip() + "\n")  # 브라우저에서는 module.exports 불필요
body = src.replace('/*__PHYS__*/', phys)

ICON = ("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E"
        "%3Ccircle cx='32' cy='32' r='28' fill='%2327b5f2'/%3E%3Ccircle cx='24' cy='22' r='4' fill='%230d2238'/%3E"
        "%3Ccircle cx='35' cy='19' r='4' fill='%230d2238'/%3E%3Ccircle cx='31' cy='30' r='4' fill='%230d2238'/%3E%3C/svg%3E")
head = (
    '<!doctype html>\n<html lang="ko">\n<head>\n<meta charset="utf-8">\n'
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
    '<meta name="description" content="기숙사 볼링 - 마우스, 손가락, 웹캠 손동작으로 즐기는 10프레임 3D 볼링 게임">\n'
    '<meta name="theme-color" content="#a8d3ea">\n'
    f'<link rel="icon" href="{ICON}">\n'
    '<style>:root{color-scheme:light}html,body{margin:0}[hidden]{display:none!important}</style>\n</head>\n<body>\n'
)
open('index.html', 'w', encoding='utf-8').write(head + body + '\n</body>\n</html>\n')
print('index.html', len(head + body), 'bytes')
