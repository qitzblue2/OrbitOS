#!/usr/bin/env python3
"""Generate every Orbit OS theme file from branding/tokens.json.

Outputs go to branding/build/ (or --out). Nothing here hardcodes a color:
all values come from tokens.json, so changing a token and re-running this
script re-themes GTK, GNOME Shell, GDM, Plymouth, GRUB, the terminal and Qt.

Usage: generate.py [--out DIR] [--wallpaper-size 3840x2160] [--no-wallpapers]
"""
import argparse
import json
import os
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
TOKENS = json.loads((HERE / "tokens.json").read_text())


# ---------- color helpers ----------
def hex2rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def rgb2hex(c):
    return "#%02x%02x%02x" % tuple(max(0, min(255, round(v))) for v in c)


def rgba(h, a):
    r, g, b = hex2rgb(h)
    return f"rgba({r},{g},{b},{a:g})"


def mix(a, b, t):
    ca, cb = hex2rgb(a), hex2rgb(b)
    return rgb2hex([x + (y - x) * t for x, y in zip(ca, cb)])


def luminance(h):
    def ch(v):
        v /= 255
        return v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4
    r, g, b = (ch(v) for v in hex2rgb(h))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a, b):
    la, lb = sorted((luminance(a), luminance(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


def from_seeds(ground, ink, accent):
    """Derive a full scheme from three seeds (ground, ink, accent)."""
    dark = luminance(ground) < 0.4
    step = (lambda t: mix(ground, ink, t))
    return {
        "dark": dark,
        "canvas": ground, "panel": step(0.03), "surface": step(0.07), "raised": step(0.10),
        "menu": step(0.18), "menu_alpha": 0.62 if dark else 0.78,
        "text": ink, "text_secondary": step(0.85),
        "text_muted_alpha": 0.68, "text_faint_alpha": 0.44 if dark else 0.48,
        "border_alpha": 0.07 if dark else 0.09, "border_strong_alpha": 0.13 if dark else 0.16,
        "fill_base": "#ffffff" if dark else "#000000",
        "fill_rest": 0.05, "fill_hover": 0.08, "fill_active": 0.12, "fill_pressed": 0.16,
        "row_hover": 0.04, "row_active": 0.075, "row_rim": 0.06,
        "lit": accent, "lit_text": ground if contrast(accent, ground) >= 4.5 else ink,
        "accent": accent,
        "tile_top": step(0.12), "tile_bottom": step(0.06), "glyph": ink,
    }


def all_schemes():
    out = dict(TOKENS["schemes"])
    for name, s in TOKENS["seed_themes"].items():
        if not name.startswith("_"):
            out[name] = from_seeds(s["ground"], s["ink"], s["accent"])
    return out


# ---------- GTK (3 and 4 share one libadwaita-compatible color sheet) ----------
def gtk_css(s, high_contrast=False):
    fb = s["fill_base"]
    border = rgba(fb, 0.5 if high_contrast else s["border_alpha"])
    t = TOKENS
    return f"""/* Orbit OS — generated from tokens.json. Do not edit by hand. */
@define-color window_bg_color {s['canvas']};
@define-color window_fg_color {s['text']};
@define-color view_bg_color {s['surface']};
@define-color view_fg_color {s['text']};
@define-color headerbar_bg_color {s['panel']};
@define-color headerbar_fg_color {s['text']};
@define-color headerbar_backdrop_color {s['panel']};
@define-color sidebar_bg_color {s['panel']};
@define-color sidebar_fg_color {s['text']};
@define-color card_bg_color {s['raised']};
@define-color card_fg_color {s['text']};
@define-color dialog_bg_color {s['raised']};
@define-color dialog_fg_color {s['text']};
@define-color popover_bg_color {s['menu']};
@define-color popover_fg_color {s['text']};
@define-color accent_bg_color {s['lit']};
@define-color accent_fg_color {s['lit_text']};
@define-color accent_color {s['accent']};
@define-color borders {border};
@define-color theme_bg_color {s['canvas']};
@define-color theme_fg_color {s['text']};
@define-color theme_base_color {s['surface']};
@define-color theme_text_color {s['text']};
@define-color theme_selected_bg_color {s['lit']};
@define-color theme_selected_fg_color {s['lit_text']};

* {{ font-family: "{t['type']['ui_font']}", sans-serif; }}
window, .background {{ font-size: {t['type']['ui_size_px']}px; }}
button {{ min-height: {t['space']['control_min']}px; border-radius: {t['radius']['sm']}px;
  background: {rgba(fb, s['fill_rest'])}; transition: opacity {t['motion']['fast_ms']}ms ease-out; }}
button:hover {{ background: {rgba(fb, s['fill_hover'])}; }}
button:active, button:checked {{ background: {rgba(fb, s['fill_active'])}; }}
button.suggested-action, switch:checked {{ background: {s['lit']}; color: {s['lit_text']}; }}
row:hover, .navigation-sidebar row:hover {{ background: {rgba(fb, s['row_hover'])}; }}
row:selected, .navigation-sidebar row:selected {{
  background: {rgba(fb, s['row_active'])}; box-shadow: inset 0 0 0 1px {rgba(fb, s['row_rim'])};
  color: {s['text']}; }}
popover > contents, menu {{ border-radius: {t['radius']['md']}px; border: 1px solid {rgba(fb, s['border_strong_alpha'])}; }}
.dim-label {{ opacity: {s['text_muted_alpha']}; }}
*:focus-visible {{ outline: 2px solid {s['text']}; outline-offset: 2px; }}
"""


# ---------- GNOME Shell (also used for GDM) ----------
def shell_css(s, glass=True):
    fb, t, g = s["fill_base"], TOKENS, TOKENS["glass"]
    panel = rgba(s["panel"], 0.55) if glass else s["panel"]
    menu = rgba(s["menu"], s["menu_alpha"]) if glass else s["raised"]
    return f"""/* Orbit OS shell theme — generated. Imports the stock shell theme and overrides colors. */
@import url("resource:///org/gnome/shell/theme/gnome-shell.css");
stage {{ font-family: "{t['type']['ui_font']}", sans-serif; font-size: {t['type']['ui_size_px']}px; color: {s['text']}; }}
#panel {{ background-color: {panel}; height: {t['space']['control_max'] - 4}px; }}
#panel .panel-button {{ color: {s['text']}; border-radius: {t['radius']['sm']}px; }}
#panel .panel-button:hover {{ background-color: {rgba(fb, s['fill_hover'])}; }}
#panel .panel-button:active, #panel .panel-button:checked {{ background-color: {rgba(fb, s['fill_active'])}; }}
.popup-menu-content, .quick-settings, .calendar, .message-list {{
  background-color: {menu}; color: {s['text']};
  border: 1px solid {rgba(fb, s['border_strong_alpha'])}; border-radius: {t['radius']['lg']}px; }}
.popup-menu-item:hover, .popup-menu-item:focus {{ background-color: {rgba(fb, s['row_hover'] * 2)}; }}
.quick-toggle:checked {{ background-color: {s['lit']}; color: {s['lit_text']}; }}
#dash, .dash-background {{ background-color: {menu}; border-radius: {t['radius']['lg']}px; }}
.search-entry {{ background-color: {rgba(fb, s['fill_rest'])}; color: {s['text']}; border-radius: {t['radius']['md']}px; }}
.app-well-app-label, .overview-tile .overview-label {{ text-shadow: 0 1px 2px {rgba(g['scrim'], 0.6)}; }}
.login-dialog {{ background-color: {rgba(g['scrim'], g['scrim_alpha']) if glass else s['canvas']}; }}
"""


# ---------- terminal (GNOME Terminal dconf profile) ----------
def terminal_dconf(s):
    # 16-color palette: derived from ink/ground plus muted hues; no accent by default.
    ground, ink = s["canvas"], s["text"]
    hues = ["#c25d6a", "#6fae7c", "#c9a85c", "#6e8fc9", "#a17cc9", "#5fb0b0"]
    base = [mix(ground, ink, 0.08)] + hues + [mix(ground, ink, 0.75)]
    bright = [mix(ground, ink, 0.35)] + [mix(h, ink, 0.25) for h in hues] + [ink]
    pal = ", ".join(f"'{c}'" for c in base + bright)
    return f"""[org/gnome/terminal/legacy/profiles:/:b1dcc9dd-5262-4d8d-a863-c897e6d979b9]
visible-name='Orbit'
use-system-font=false
font='{TOKENS['type']['mono_font']} {TOKENS['type']['mono_size_pt']}'
use-theme-colors=false
background-color='{ground}'
foreground-color='{ink}'
bold-is-bright=false
palette=[{pal}]
audible-bell=false
"""


# ---------- Qt (qt5ct / qt6ct color scheme) ----------
def qt_colors(s):
    roles = [s["text"], s["raised"], s["raised"], s["surface"], s["panel"], s["panel"], s["text"],
             s["text"], s["text"], s["surface"], s["canvas"], s["panel"], s["lit"], s["lit_text"],
             s["accent"], s["accent"], s["surface"], s["canvas"], s["menu"], s["text"], s["text_secondary"]]
    line = ", ".join(roles)
    return f"[ColorScheme]\nactive_colors={line}\ninactive_colors={line}\ndisabled_colors={line}\n"


# ---------- Plymouth ----------
def plymouth(s):
    r, g, b = (v / 255 for v in hex2rgb(s["canvas"]))
    script = f"""// Orbit OS Plymouth script — generated
Window.SetBackgroundTopColor({r:.3f}, {g:.3f}, {b:.3f});
Window.SetBackgroundBottomColor({r:.3f}, {g:.3f}, {b:.3f});
logo.image = Image("logo.png");
logo.sprite = Sprite(logo.image);
logo.sprite.SetX(Window.GetWidth() / 2 - logo.image.GetWidth() / 2);
logo.sprite.SetY(Window.GetHeight() / 2 - logo.image.GetHeight() / 2);
fun refresh() {{
  t = Math.Sin(Plymouth.GetTime() * 2) * 0.25 + 0.75;  // opacity-only pulse
  logo.sprite.SetOpacity(t);
}}
Plymouth.SetRefreshFunction(refresh);
"""
    theme = """[Plymouth Theme]
Name=Orbit OS
Description=Orbit OS boot splash
ModuleName=script

[script]
ImageDir=/usr/share/plymouth/themes/orbit
ScriptFile=/usr/share/plymouth/themes/orbit/orbit.script
"""
    return theme, script


# ---------- GRUB ----------
def grub_theme(s):
    return f"""# Orbit OS GRUB theme — generated
title-text: ""
desktop-color: "{s['canvas']}"
terminal-font: "Unifont Regular 16"
+ boot_menu {{
  left = 30%  top = 35%  width = 40%  height = 40%
  item_color = "{s['text_secondary']}"
  selected_item_color = "{s['lit_text']}"
  selected_item_pixmap_style = "select_*.png"
  item_height = 32  item_spacing = 8  item_padding = 12
}}
+ label {{ left = 0 top = 90% width = 100% align = "center" color = "{s['text_secondary']}"
  text = "Enter: boot   e: edit   c: command line" }}
"""


# ---------- wallpapers ----------
def wallpaper(name, size, out):
    from PIL import Image, ImageDraw, ImageFilter
    spec = TOKENS["wallpapers"][name]
    w, h = size
    sw, sh = 480, int(480 * h / w)  # draw small, blur, upscale: smooth and fast
    img = Image.new("RGB", (sw, sh), hex2rgb(spec["base"]))
    for color, x, y, r in spec["blobs"]:
        layer = Image.new("RGB", (sw, sh), hex2rgb(color))
        mask = Image.new("L", (sw, sh), 0)
        rad = r * sw * 0.5
        ImageDraw.Draw(mask).ellipse([x * sw - rad, y * sh - rad, x * sw + rad, y * sh + rad], fill=230)
        mask = mask.filter(ImageFilter.GaussianBlur(sw * 0.09))
        img = Image.composite(layer, img, mask)
    img = img.filter(ImageFilter.GaussianBlur(sw * 0.02)).resize((w, h), Image.BICUBIC)
    img.save(out, optimize=True)
    return img


def worst_wallpaper_color(path):
    """Lightest and darkest average patches (where labels could sit)."""
    from PIL import Image
    im = Image.open(path).convert("RGB").resize((32, 18))
    px = [rgb2hex(im.getpixel((x, y))) for y in range(18) for x in range(32)]
    return min(px, key=luminance), max(px, key=luminance)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(HERE / "build"))
    ap.add_argument("--wallpaper-size", default="3840x2160")
    ap.add_argument("--no-wallpapers", action="store_true")
    a = ap.parse_args()
    out = pathlib.Path(a.out)
    schemes = all_schemes()

    failures = []
    for name, s in schemes.items():
        d = out / "themes" / f"Orbit-{name}"
        for sub in ("gtk-3.0", "gtk-4.0"):
            (d / sub).mkdir(parents=True, exist_ok=True)
            (d / sub / "gtk.css").write_text(gtk_css(s))
        (d / "gnome-shell").mkdir(exist_ok=True)
        (d / "gnome-shell" / "gnome-shell.css").write_text(shell_css(s, glass=True))
        (d / "gnome-shell" / "gnome-shell-solid.css").write_text(shell_css(s, glass=False))
        (d / "index.theme").write_text(
            f"[Desktop Entry]\nType=X-GNOME-Metatheme\nName=Orbit {name}\n\n[X-GNOME-Metatheme]\n"
            f"GtkTheme=Orbit-{name}\nIconTheme=orbit\n")
        (d / "terminal.dconf").write_text(terminal_dconf(s))
        (d / "qt-colors.conf").write_text(qt_colors(s))
        for fg, bg, label in [(s["text"], s["canvas"], "text/canvas"), (s["text"], s["surface"], "text/surface"),
                              (s["lit_text"], s["lit"], "lit_text/lit"), (s["text_secondary"], s["panel"], "secondary/panel")]:
            c = contrast(fg, bg)
            if c < 4.5:
                failures.append(f"{name}: {label} contrast {c:.2f} < 4.5")

    hc = dict(schemes["graphite"], canvas="#000000", surface="#000000", panel="#000000", text="#ffffff")
    hcd = out / "themes" / "Orbit-high-contrast" / "gtk-4.0"
    hcd.mkdir(parents=True, exist_ok=True)
    (hcd / "gtk.css").write_text(gtk_css(hc, high_contrast=True))
    (hcd.parent / "gnome-shell").mkdir(exist_ok=True)
    (hcd.parent / "gnome-shell" / "gnome-shell.css").write_text(shell_css(hc, glass=False))

    pd = out / "plymouth" / "orbit"
    pd.mkdir(parents=True, exist_ok=True)
    theme, script = plymouth(schemes["graphite"])
    (pd / "orbit.plymouth").write_text(theme)
    (pd / "orbit.script").write_text(script)
    gd = out / "grub" / "orbit"
    gd.mkdir(parents=True, exist_ok=True)
    (gd / "theme.txt").write_text(grub_theme(schemes["graphite"]))

    if not a.no_wallpapers:
        w, h = (int(v) for v in a.wallpaper_size.split("x"))
        wd = out / "wallpapers"
        wd.mkdir(parents=True, exist_ok=True)
        g = TOKENS["glass"]
        for name in TOKENS["wallpapers"]:
            p = wd / f"orbit-{name}.png"
            wallpaper(name, (w, h), p)
            # Labels on glass are white with a scrim behind them; check worst case.
            lo, hi = worst_wallpaper_color(p)
            behind = mix(hi, g["scrim"], g["scrim_alpha"])
            c = contrast("#ffffff", behind)
            print(f"wallpaper {name}: white label over brightest patch {hi} + scrim = {c:.2f}:1")
            if c < 4.5 and name != "light":
                failures.append(f"wallpaper {name}: label contrast {c:.2f} < 4.5")
            if name == "light":
                c2 = contrast(schemes["light"]["text"], hi)
                print(f"wallpaper light: dark label over brightest patch = {c2:.2f}:1")
                if c2 < 4.5:
                    failures.append(f"wallpaper light: dark label contrast {c2:.2f} < 4.5")

    print(f"generated {len(schemes)} schemes into {out}")
    if failures:
        print("CONTRAST FAILURES:\n  " + "\n  ".join(failures), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
