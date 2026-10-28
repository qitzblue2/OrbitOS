#!/usr/bin/env python3
"""Validate the generated icon themes, rasterize PNGs, build a contact sheet.

Fails (exit 1) if: an icon in APP_MAP/FOLDER_MAP is missing, an SVG contains
a script, event handler, external reference, embedded raster or filter, or
an icon is not legible at 16 px (too little contrast between glyph and tile).

Rasterizer: rsvg-convert if installed, else the cairosvg Python module.
Usage: check_and_raster.py [--themes icons/build] [--sheet tests/icon-contact-sheet.png] [--no-png]
"""
import argparse
import io
import pathlib
import re
import shutil
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from generate_icons import APP_MAP, FOLDER_MAP, SIZES  # noqa: E402

FORBIDDEN = [r"<script", r"\bon\w+\s*=", r"<image", r"<foreignObject", r"<filter", r"href\s*=\s*[\"'](?!#)",
             r"url\((?!#)", r"@import", r"data:"]


def render(svg_path, size):
    if shutil.which("rsvg-convert"):
        return subprocess.run(["rsvg-convert", "-w", str(size), "-h", str(size), str(svg_path)],
                              check=True, capture_output=True).stdout
    import cairosvg
    return cairosvg.svg2png(url=str(svg_path), output_width=size, output_height=size)


def legibility(png, bg):
    """Max luminance spread inside the icon over a background; low = mush."""
    from PIL import Image
    im = Image.open(io.BytesIO(png)).convert("RGBA")
    base = Image.new("RGBA", im.size, bg)
    base.alpha_composite(im)
    # judge the inner area where the glyph sits, so the tile edge does not count
    lo, hi = im.width // 5, im.width - im.width // 5
    lum = sorted(0.2126 * r + 0.7152 * g + 0.0722 * b for r, g, b, _ in
                 (base.getpixel((x, y)) for y in range(lo, hi) for x in range(lo, hi)))
    n = len(lum)
    return lum[int(n * 0.95)] - lum[int(n * 0.05)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--themes", default=str(HERE / "build"))
    ap.add_argument("--sheet", default=str(HERE.parent / "tests" / "icon-contact-sheet.png"))
    ap.add_argument("--no-png", action="store_true")
    a = ap.parse_args()
    themes = pathlib.Path(a.themes)
    errors = []

    for svg in themes.rglob("*.svg"):
        if svg.is_symlink():
            continue
        text = svg.read_text()
        for pat in FORBIDDEN:
            if re.search(pat, text, re.I):
                errors.append(f"unsafe SVG ({pat}): {svg}")

    for t in ("orbit", "orbit-graphite", "orbit-light"):
        for names in APP_MAP.values():
            for n in names:
                if not (themes / t / "scalable/apps" / f"{n}.svg").exists():
                    errors.append(f"missing {t}/apps/{n}")
                if not (themes / t / "symbolic/apps" / f"{n}-symbolic.svg").exists():
                    errors.append(f"missing {t}/apps/{n}-symbolic")
        for names in FOLDER_MAP.values():
            for n in names:
                if not (themes / t / "scalable/places" / f"{n}.svg").exists():
                    errors.append(f"missing {t}/places/{n}")

    from PIL import Image, ImageDraw
    # backgrounds each style is judged against: glass on its wallpaper tone, tiles on canvas
    bgs = {"orbit": (90, 60, 150, 255), "orbit-graphite": (26, 26, 29, 255), "orbit-light": (241, 241, 243, 255)}
    rows = []
    for t, bg in bgs.items():
        icons = sorted((themes / t / "scalable/apps").glob("*.svg"))
        icons = [p for p in icons if not p.is_symlink()]
        icons += sorted(p for p in (themes / t / "scalable/places").glob("*.svg") if not p.is_symlink())
        row = []
        for p in icons:
            png16 = render(p, 16)
            spread = legibility(png16, bg)
            if spread < 40:
                errors.append(f"not legible at 16px (spread {spread:.0f}): {t}/{p.name}")
            row.append((p.stem, png16, render(p, 64), bg))
        rows.append((t, row))
        if not a.no_png:
            for sub in ("apps", "places"):
                for p in (themes / t / "scalable" / sub).glob("*.svg"):
                    for n in SIZES:
                        d = themes / t / f"{n}x{n}" / sub
                        d.mkdir(parents=True, exist_ok=True)
                        dst = d / f"{p.stem}.png"
                        if p.is_symlink():
                            if dst.exists() or dst.is_symlink():
                                dst.unlink()
                            dst.symlink_to(pathlib.Path(p.readlink()).with_suffix(".png").name)
                        else:
                            dst.write_bytes(render(p, n))
        if shutil.which("gtk-update-icon-cache"):
            subprocess.run(["gtk-update-icon-cache", "-f", "-t", str(themes / t)], check=True)

    cols = max(len(r) for _, r in rows)
    cell = 84
    sheet = Image.new("RGBA", (cols * cell + 20, len(rows) * cell * 2 + 20), (128, 128, 128, 255))
    dr = ImageDraw.Draw(sheet)
    for ri, (t, row) in enumerate(rows):
        y = 10 + ri * cell * 2
        dr.rectangle([0, y, sheet.width, y + cell * 2 - 4], fill=row[0][3] if row else (0, 0, 0, 255))
        dr.text((10, y + 2), t, fill=(255, 255, 255, 255) if t != "orbit-light" else (0, 0, 0, 255))
        for ci, (name, p16, p64, _) in enumerate(row):
            x = 10 + ci * cell
            sheet.alpha_composite(Image.open(io.BytesIO(p64)).convert("RGBA"), (x + 10, y + 16))
            sheet.alpha_composite(Image.open(io.BytesIO(p16)).convert("RGBA"), (x + 34, y + 96))
    pathlib.Path(a.sheet).parent.mkdir(parents=True, exist_ok=True)
    sheet.save(a.sheet)
    print(f"contact sheet: {a.sheet}")

    if errors:
        print("ICON CHECK FAILED:\n  " + "\n  ".join(errors), file=sys.stderr)
        sys.exit(1)
    print("icon check passed")


if __name__ == "__main__":
    main()
