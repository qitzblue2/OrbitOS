#!/usr/bin/env python3
"""Exit 0 if a screenshot looks like a rendered desktop, not a console or blank screen."""
import sys
from PIL import Image

im = Image.open(sys.argv[1]).convert("RGB").resize((160, 100))
px = [im.getpixel((x, y)) for y in range(im.height) for x in range(im.width)]
dark = sum(1 for p in px if max(p) < 20) / len(px)
colors = len({(r >> 4, g >> 4, b >> 4) for r, g, b in px})
# console text is grey-on-black; a desktop has a wallpaper with saturated or mid-tone pixels
mid = sum(1 for p in px if 40 < sum(p) / 3 < 230) / len(px)
ok = dark < 0.6 and colors > 30 and mid > 0.3
print(f"screen_check: dark={dark:.2f} colors={colors} midtones={mid:.2f} -> {'desktop' if ok else 'not yet'}")
sys.exit(0 if ok else 1)
