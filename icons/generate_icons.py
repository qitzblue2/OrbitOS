#!/usr/bin/env python3
"""Build the `orbit` freedesktop icon theme from glyph specs + design tokens.

If icons/source/<glyph>.svg exists (exported from the "Orbit OS Icon Set"
canvas) its inner paths are used for that glyph; otherwise the glyph is
redrawn from the spec below (24x24 grid, 1.6px stroke, round caps/joins,
outline only, 2px safe padding).

Styles: glass (default theme `orbit`), graphite (`orbit-graphite`), light
(`orbit-light`). Each gets scalable/apps tiles, places (folders), mimetypes
and a shared symbolic set.

Usage: generate_icons.py [--out icons/build]
"""
import argparse
import json
import pathlib
import re

HERE = pathlib.Path(__file__).resolve().parent
TOKENS = json.loads((HERE.parent / "branding" / "tokens.json").read_text())

# --- 16 app glyphs, 24x24, drawn inside 2..22 ---
GLYPHS = {
    "files": '<path d="M3 7.5a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    "browser": '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.6 2.6 3.6 5.6 3.6 9s-1 6.4-3.6 9c-2.6-2.6-3.6-5.6-3.6-9S9.4 5.6 12 3z"/>',
    "terminal": '<rect x="3" y="4.5" width="18" height="15" rx="3"/><path d="M7 10l3 2.5L7 15M12.5 15.5H17"/>',
    "code": '<path d="M8.5 7.5L4 12l4.5 4.5M15.5 7.5L20 12l-4.5 4.5M13.5 5.5l-3 13"/>',
    "notes": '<path d="M6 3.5h9l3.5 3.5v13.5H6z"/><path d="M14.5 3.5V7.5h4M9 11.5h6M9 15h6"/>',
    "settings": '<path d="M4 8h9M17 8h3M4 16h3M11 16h9"/><circle cx="15" cy="8" r="2"/><circle cx="9" cy="16" r="2"/>',
    "media": '<circle cx="12" cy="12" r="9"/><path d="M10 8.5v7l5.5-3.5z"/>',
    "photos": '<rect x="3" y="4.5" width="18" height="15" rx="3"/><circle cx="9" cy="10" r="1.8"/><path d="M3.5 17l5-4.5 4 3.5 3-2.5 5 4"/>',
    "calculator": '<rect x="5" y="3" width="14" height="18" rx="3"/><path d="M8.5 7.5h7M8.5 12h.01M12 12h.01M15.5 12h.01M8.5 16h.01M12 16h.01M15.5 16h.01"/>',
    "calendar": '<rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4M8 14h.01M12 14h.01M16 14h.01"/>',
    "activity": '<path d="M3 12h4l2.5-6 5 12 2.5-6h4"/>',
    "passwords": '<rect x="4.5" y="10" width="15" height="10.5" rx="3"/><path d="M8 10V7.5a4 4 0 0 1 8 0V10M12 14v3"/>',
    "archives": '<rect x="3.5" y="4" width="17" height="5" rx="1.5"/><path d="M5 9v9.5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M10 13h4"/>',
    "launcher": '<rect x="4" y="4" width="6.5" height="6.5" rx="2"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="2"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="2"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="2"/>',
    "updates": '<path d="M12 3.5v10M8 9.5l4 4 4-4M4 14.5v3a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-3"/>',
    "network": '<path d="M2.5 9.5a14 14 0 0 1 19 0M5.5 13a9.5 9.5 0 0 1 13 0M8.5 16.4a5 5 0 0 1 7 0"/><path d="M12 19.8h.01"/>',
}

# Folder symbols (drawn small, centered on the folder front panel at 12,14)
FOLDER_SYMBOLS = {
    "music": '<path d="M10.5 17V11l4-1v5.5"/><circle cx="9.5" cy="17" r="1"/><circle cx="13.5" cy="15.5" r="1"/>',
    "favorites": '<path d="M12 17.6l-2.9-2.8a1.8 1.8 0 0 1 2.9-2.2 1.8 1.8 0 0 1 2.9 2.2z"/>',
    "documents": '<path d="M10 11h3l1.5 1.5V17.5H10z"/><path d="M11 14.5h2.5"/>',
    "videos": '<rect x="9" y="12" width="4.5" height="4" rx="1"/><path d="M13.5 13.3l2-1v3.4l-2-1"/>',
    "downloads": '<circle cx="12" cy="14.5" r="3.2"/><path d="M12 12.8v3.2M10.8 14.9l1.2 1.2 1.2-1.2"/>',
    "pictures": '<rect x="9" y="12.3" width="6" height="4.7" rx="1.2"/><circle cx="12" cy="14.6" r="1.2"/><path d="M10.6 12.3l.6-1h1.6l.6 1"/>',
    "desktop": '<rect x="9" y="11.5" width="6" height="4.2" rx="1"/><path d="M11 17.5h2M12 15.7v1.8"/>',
    "projects": '<path d="M10.6 12.2L9 14.5l1.6 2.3M13.4 12.2L15 14.5l-1.6 2.3"/>',
    "spaces": '<circle cx="12" cy="14.5" r="2.8"/><path d="M8.6 14.5h6.8"/>',
    "notes": '<path d="M10 11.5h4M10 13.8h4M10 16.1h2.5"/>',
    "inbox": '<path d="M9 14.5h2l.5 1h1l.5-1h2M9 14.5l1-2.5h4l1 2.5v2.5H9z"/>',
    "plain": "",
}

# freedesktop names each glyph/folder maps to (verified against Ubuntu 24.04 .desktop files
# by tests/check-icon-names.sh at build time; aliases become symlinks).
APP_MAP = {
    "files": ["org.gnome.Nautilus", "system-file-manager"],
    "browser": ["firefox", "firefox-esr", "chromium", "web-browser"],
    "terminal": ["org.gnome.Terminal", "utilities-terminal", "org.gnome.Ptyxis"],
    "code": ["org.gnome.TextEditor", "accessories-text-editor", "org.gnome.gedit"],
    "notes": ["org.gnome.gitlab.somas.Apostrophe", "orbit-notes"],
    "settings": ["org.gnome.Settings", "preferences-system", "orbit-settings"],
    "media": ["org.gnome.Totem", "org.gnome.Showtime", "multimedia-video-player", "vlc"],
    "photos": ["org.gnome.Loupe", "org.gnome.eog", "image-viewer"],
    "calculator": ["org.gnome.Calculator", "accessories-calculator"],
    "calendar": ["org.gnome.Calendar", "org.gnome.Todo", "x-office-calendar"],
    "activity": ["org.gnome.SystemMonitor", "utilities-system-monitor"],
    "passwords": ["org.keepassxc.KeePassXC", "keepassxc"],
    "archives": ["org.gnome.FileRoller", "file-roller"],
    "launcher": ["orbit-launcher", "view-app-grid"],
    "updates": ["org.gnome.Software", "system-software-update", "update-manager"],
    "network": ["preferences-system-network", "network-wireless", "nm-device-wireless"],
}
FOLDER_MAP = {
    "plain": ["folder"], "music": ["folder-music"], "favorites": ["folder-favorites"],
    "documents": ["folder-documents"], "videos": ["folder-videos"], "downloads": ["folder-download"],
    "pictures": ["folder-pictures"], "desktop": ["user-desktop", "folder-desktop"],
    "projects": ["folder-projects"], "spaces": ["folder-spaces"], "notes": ["folder-notes"],
    "inbox": ["folder-inbox"],
}
SPACE_COLORS = {"personal": "#f28dc4", "work": "#5aa6ff", "study": "#4fd1c0"}
MIME = {  # file-type glyph drawn on a page
    "document": ("x-office-document", '<path d="M9 12h6M9 14.5h6M9 17h4"/>'),
    "image": ("image-x-generic", '<path d="M8.5 17.5l2.5-2.5 2 1.8 1.5-1.3 1.5 2"/><circle cx="10" cy="12" r="1"/>'),
    "audio": ("audio-x-generic", '<path d="M11 17v-5l3.5-.8V16"/><circle cx="10.2" cy="17" r=".9"/><circle cx="13.7" cy="16" r=".9"/>'),
    "video": ("video-x-generic", '<path d="M10.5 11.8v5l4-2.5z"/>'),
    "archive": ("package-x-generic", '<path d="M12 9.5v1M12 12v1M12 14.5v1"/><rect x="11" y="16" width="2" height="2" rx=".5"/>'),
    "code": ("text-x-script", '<path d="M10.5 12.5L8.8 14.5l1.7 2M13.5 12.5l1.7 2-1.7 2"/>'),
    "pdf": ("application-pdf", '<path d="M9 16.5c2-1 4-3.5 4.5-5.5.3-1-1.2-1.2-1-0 .4 2 1.5 4 3 5"/>'),
}
SIZES = [16, 24, 32, 48, 64, 128, 256, 512]


def load_source(name):
    p = HERE / "source" / f"{name}.svg"
    if not p.exists():
        return GLYPHS.get(name)
    body = p.read_text()
    m = re.search(r"<svg[^>]*>(.*)</svg>", body, re.S)
    return m.group(1).strip() if m else GLYPHS.get(name)


def svg(inner, view=24, defs=""):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{view}" height="{view}" viewBox="0 0 {view} {view}">'
            f'{defs}{inner}</svg>\n')


def stroke_group(glyph, color, width=1.6, scale=None):
    tf = f' transform="{scale}"' if scale else ""
    return (f'<g fill="none" stroke="{color}" stroke-width="{width}" stroke-linecap="round" '
            f'stroke-linejoin="round"{tf}>{glyph}</g>')


def app_tile(glyph, style):
    """64-unit canvas: tile + glyph scaled into the middle (glyph 24 -> 34 units)."""
    sch, g = TOKENS["schemes"], TOKENS["glass"]
    r = 64 * TOKENS["radius"]["tile_ratio"] * 0.86  # tile is 56 wide
    k = 34 / 24
    glyph_g = stroke_group(glyph, "", 1.6, f"translate({32 - 12 * k} {32 - 12 * k}) scale({k:.4f})")
    if style == "glass":
        defs = (f'<defs><linearGradient id="f" x1="0.3" y1="0" x2="0.7" y2="1">'
                f'<stop offset="0" stop-color="#fff" stop-opacity="{g["fill_top"]}"/>'
                f'<stop offset="1" stop-color="#fff" stop-opacity="{g["fill_bottom"]}"/></linearGradient></defs>')
        tile = (f'<rect x="5" y="7" width="54" height="54" rx="{r}" fill="#28105a" fill-opacity=".18"/>'
                f'<rect x="4" y="4" width="56" height="56" rx="{r}" fill="url(#f)"/>'
                f'<rect x="4.5" y="4.5" width="55" height="55" rx="{r - .5}" fill="none" stroke="#fff" stroke-opacity="{g["rim_alpha"]}"/>'
                f'<path d="M{4 + r} 5.2H{60 - r}" stroke="#fff" stroke-opacity="{g["highlight_alpha"]}" stroke-linecap="round"/>')
        color = g["glyph"]
    else:
        s = sch["graphite" if style == "graphite" else "light"]
        rim = "#fff" if s["dark"] else "#000"
        defs = (f'<defs><linearGradient id="f" x1="0" y1="0" x2="0" y2="1">'
                f'<stop offset="0" stop-color="{s["tile_top"]}"/><stop offset="1" stop-color="{s["tile_bottom"]}"/>'
                f'</linearGradient></defs>')
        tile = (f'<rect x="4" y="4" width="56" height="56" rx="{r}" fill="url(#f)"/>'
                f'<rect x="4.5" y="4.5" width="55" height="55" rx="{r - .5}" fill="none" stroke="{rim}" stroke-opacity=".08"/>')
        color = s["glyph"]
    return svg(tile + glyph_g.replace('stroke=""', f'stroke="{color}"'), 64, defs)


def folder(symbol, style, tint=None):
    g = TOKENS["glass"]
    if style == "glass":
        line, back, front, sym = "#fff", g["folder_back"], g["folder_front"], g["glyph"]
        lo = g["outline_alpha"]
        fill = "#fff"
    else:
        s = TOKENS["schemes"]["graphite" if style == "graphite" else "light"]
        line, sym, lo = s["glyph"], s["glyph"], 0.55
        fill, back, front = s["tile_top"], 1, 1
    if tint:
        fill, back, front = tint, 0.35, 0.28
    w = g["outline_px"]
    body = (f'<path d="M3 6.5a1.8 1.8 0 0 1 1.8-1.8h4.4l1.8 1.8h8.2a1.8 1.8 0 0 1 1.8 1.8v1.2H3z" '
            f'fill="{fill}" fill-opacity="{back}" stroke="{line}" stroke-opacity="{lo}" stroke-width="{w}" stroke-linejoin="round"/>'
            f'<rect x="2.5" y="9" width="19" height="11.3" rx="2" fill="{fill}" fill-opacity="{front}" '
            f'stroke="{line}" stroke-opacity="{lo}" stroke-width="{w}"/>')
    if symbol:
        body += stroke_group(symbol, sym, 1.3)
    return svg(body)


def page(symbol, style):
    s = TOKENS["schemes"]["graphite" if style != "light" else "light"]
    line = "#fff" if style == "glass" else s["glyph"]
    fill, fo = ("#fff", 0.16) if style == "glass" else (s["tile_top"], 1)
    body = (f'<path d="M6 3h8l4 4v14H6z" fill="{fill}" fill-opacity="{fo}" stroke="{line}" stroke-opacity=".75" '
            f'stroke-width="1.2" stroke-linejoin="round"/><path d="M14 3v4h4" fill="none" stroke="{line}" '
            f'stroke-opacity=".75" stroke-width="1.2" stroke-linejoin="round"/>' + stroke_group(symbol, line, 1.2))
    return svg(body)


def symbolic(glyph):
    # GNOME recolors symbolic icons; keep a single plain color and 16px canvas.
    return ('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24">'
            + stroke_group(glyph, "#bebebe", 1.8) + "</svg>\n")


def index_theme(name, title, inherits):
    dirs = ["scalable/apps", "scalable/places", "scalable/mimetypes", "symbolic/apps", "symbolic/places"]
    dirs += [f"{n}x{n}/apps" for n in SIZES] + [f"{n}x{n}/places" for n in SIZES]
    out = [f"[Icon Theme]\nName={title}\nComment=Orbit OS icons (glyphs redrawn from spec)\n"
           f"Inherits={inherits}\nExample=folder\nDirectories={','.join(dirs)}\n"]
    for d in dirs:
        ctx = {"apps": "Applications", "places": "Places", "mimetypes": "MimeTypes"}[d.split("/")[1]]
        if d.startswith("scalable"):
            out.append(f"\n[{d}]\nSize=64\nMinSize=8\nMaxSize=512\nType=Scalable\nContext={ctx}\n")
        elif d.startswith("symbolic"):
            out.append(f"\n[{d}]\nSize=16\nMinSize=8\nMaxSize=512\nType=Scalable\nContext={ctx}\n")
        else:
            n = int(d.split("x")[0])
            out.append(f"\n[{d}]\nSize={n}\nType=Fixed\nContext={ctx}\n")
    return "".join(out)


def write_alias(dirpath, canonical, names):
    """Write canonical file once; aliases become relative symlinks."""
    (dirpath / f"{names[0]}.svg").write_text(canonical)
    for alias in names[1:]:
        link = dirpath / f"{alias}.svg"
        if link.exists() or link.is_symlink():
            link.unlink()
        link.symlink_to(f"{names[0]}.svg")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(HERE / "build"))
    out = pathlib.Path(ap.parse_args().out)
    missing_sources = [n for n in GLYPHS if not (HERE / "source" / f"{n}.svg").exists()]
    themes = {"glass": ("orbit", "Orbit (Glass)"), "graphite": ("orbit-graphite", "Orbit Graphite"),
              "light": ("orbit-light", "Orbit Light")}
    for style, (tname, title) in themes.items():
        root = out / tname
        for d in ("scalable/apps", "scalable/places", "scalable/mimetypes", "symbolic/apps", "symbolic/places"):
            (root / d).mkdir(parents=True, exist_ok=True)
        inherits = "Yaru,hicolor" if style == "glass" else "orbit,Yaru,hicolor"
        if style == "light":
            inherits = "orbit,Yaru,hicolor"
        (root / "index.theme").write_text(index_theme(tname, title, inherits))
        for gname, names in APP_MAP.items():
            glyph = load_source(gname)
            write_alias(root / "scalable/apps", app_tile(glyph, style), names)
            write_alias(root / "symbolic/apps", symbolic(glyph), [n + "-symbolic" for n in names])
        for fname, names in FOLDER_MAP.items():
            write_alias(root / "scalable/places", folder(FOLDER_SYMBOLS[fname], style), names)
            write_alias(root / "symbolic/places", symbolic(
                '<path d="M3 7.5a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
                [n + "-symbolic" for n in names])
        for space, color in SPACE_COLORS.items():
            (root / "scalable/places" / f"folder-space-{space}.svg").write_text(
                folder(FOLDER_SYMBOLS["spaces"], style, tint=color))
        for _, (mname, sym) in MIME.items():
            (root / "scalable/mimetypes" / f"{mname}.svg").write_text(page(sym, style))
    print(f"icon themes written to {out}")
    if missing_sources:
        print(f"NOTE: icons/source/ missing {len(missing_sources)} of 16 exported glyphs; "
              "redrew them from the spec: " + ", ".join(missing_sources))


if __name__ == "__main__":
    main()
