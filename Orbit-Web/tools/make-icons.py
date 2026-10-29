#!/usr/bin/env python3
"""Aphelion app icon: Orbit glass tile, an orbit, a bright star and a teal planet at the
orbit's far point (its aphelion). Writes SVG, PNG sizes, .ico (Windows) and .icns (macOS).

  python3 tools/make-icons.py      (needs cairosvg + Pillow)
"""
import io
import math
import pathlib

import cairosvg
from PIL import Image

OUT = pathlib.Path(__file__).resolve().parents[1] / "assets" / "icons"
SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024]


def icon_svg(small=False):
    S = 1024
    r = S * 0.225                      # macOS-like squircle-ish radius on an inset tile
    pad = 64 if not small else 24      # macOS wants a margin; tiny sizes use the whole square
    t = S - 2 * pad
    cx = cy = S / 2
    rx, ry, rot = 330, 150, -28
    # point on the rotated ellipse at angle 0 (the far end): the aphelion
    a = math.radians(rot)
    px, py = cx + rx * math.cos(a), cy + rx * math.sin(a)
    stroke = 34 if not small else 64
    star = 104 if not small else 150
    planet = 62 if not small else 112
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{S}" height="{S}" viewBox="0 0 {S} {S}">
<defs>
  <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#3a2b66"/><stop offset=".55" stop-color="#221a44"/><stop offset="1" stop-color="#120a26"/>
  </linearGradient>
  <radialGradient id="pink" cx=".18" cy=".72" r=".55"><stop offset="0" stop-color="#f28dc4" stop-opacity=".55"/><stop offset="1" stop-color="#f28dc4" stop-opacity="0"/></radialGradient>
  <radialGradient id="blue" cx=".86" cy=".16" r=".5"><stop offset="0" stop-color="#5aa6ff" stop-opacity=".55"/><stop offset="1" stop-color="#5aa6ff" stop-opacity="0"/></radialGradient>
  <radialGradient id="glow" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#ffffff" stop-opacity=".55"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></radialGradient>
  <radialGradient id="tglow" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#4fd1c0" stop-opacity=".7"/><stop offset="1" stop-color="#4fd1c0" stop-opacity="0"/></radialGradient>
  <linearGradient id="sheen" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff" stop-opacity=".22"/><stop offset=".5" stop-color="#ffffff" stop-opacity="0"/></linearGradient>
  <clipPath id="tile"><rect x="{pad}" y="{pad}" width="{t}" height="{t}" rx="{r}"/></clipPath>
</defs>
<g clip-path="url(#tile)">
  <rect x="{pad}" y="{pad}" width="{t}" height="{t}" fill="url(#g)"/>
  <rect x="{pad}" y="{pad}" width="{t}" height="{t}" fill="url(#pink)"/>
  <rect x="{pad}" y="{pad}" width="{t}" height="{t}" fill="url(#blue)"/>
  <rect x="{pad}" y="{pad}" width="{t}" height="{t * .5}" fill="url(#sheen)"/>
  <ellipse cx="{cx}" cy="{cy}" rx="{rx}" ry="{ry}" transform="rotate({rot} {cx} {cy})" fill="none" stroke="#ffffff" stroke-opacity=".78" stroke-width="{stroke}"/>
  <circle cx="{cx}" cy="{cy}" r="{star * 2.1}" fill="url(#glow)"/>
  <circle cx="{cx}" cy="{cy}" r="{star}" fill="#f4f4f6"/>
  <circle cx="{px}" cy="{py}" r="{planet * 2.2}" fill="url(#tglow)"/>
  <circle cx="{px}" cy="{py}" r="{planet}" fill="#4fd1c0"/>
</g>
<rect x="{pad + 2}" y="{pad + 2}" width="{t - 4}" height="{t - 4}" rx="{r - 2}" fill="none" stroke="#ffffff" stroke-opacity=".28" stroke-width="{4 if not small else 10}"/>
</svg>
'''


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "png").mkdir(exist_ok=True)
    big, small = icon_svg(False), icon_svg(True)
    (OUT / "aphelion.svg").write_text(big)
    (OUT / "aphelion-small.svg").write_text(small)
    imgs = {}
    for n in SIZES:
        data = cairosvg.svg2png(bytestring=(small if n <= 32 else big).encode(), output_width=n, output_height=n)
        (OUT / "png" / f"{n}x{n}.png").write_bytes(data)
        imgs[n] = Image.open(io.BytesIO(data)).convert("RGBA")
    imgs[256].save(OUT / "aphelion.ico", sizes=[(n, n) for n in (16, 24, 32, 48, 64, 128, 256)],
                   append_images=[imgs[n] for n in (16, 24, 32, 48, 64, 128)])
    imgs[1024].save(OUT / "aphelion.icns")
    imgs[512].save(OUT / "aphelion.png")
    # contact sheet for checking legibility at small sizes
    sheet = Image.new("RGBA", (sum(min(n, 256) + 16 for n in SIZES[:8]) + 16, 290), (30, 30, 33, 255))
    x = 16
    for n in SIZES[:8]:
        im = imgs[n] if n <= 256 else imgs[256]
        sheet.alpha_composite(im, (x, 16 + (256 - im.height) // 2))
        x += im.width + 16
    sheet.save(OUT / "contact-sheet.png")
    print("icons written to", OUT)


if __name__ == "__main__":
    main()
