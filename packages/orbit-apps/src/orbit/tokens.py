"""Design tokens at runtime: the same tokens.json the theme generator uses."""
import json
import pathlib

_CANDIDATES = [
    pathlib.Path("/usr/share/orbit-os/tokens.json"),
    pathlib.Path(__file__).resolve().parents[4] / "branding" / "tokens.json",  # source checkout
]


def load():
    for p in _CANDIDATES:
        if p.is_file():
            return json.loads(p.read_text())
    raise FileNotFoundError("tokens.json not found (install orbit-os-branding)")


def rgba(hexcolor, alpha):
    h = hexcolor.lstrip("#")
    r, g, b = (int(h[i:i + 2], 16) for i in (0, 2, 4))
    return f"rgba({r},{g},{b},{alpha:g})"


def app_css(dark=True):
    """Extra CSS shared by all Orbit apps, on top of the Orbit GTK theme."""
    t = load()
    s = t["schemes"]["graphite" if dark else "light"]
    fb, rad, sp = s["fill_base"], t["radius"], t["space"]["unit"]
    return f"""
.orbit-card {{ background: {s['raised']}; border-radius: {rad['lg']}px;
  border: 1px solid {rgba(fb, s['border_alpha'])}; padding: {sp * 2}px; }}
.orbit-card:hover {{ background: {s['raised']}; box-shadow: inset 0 0 0 1px {rgba(fb, s['border_strong_alpha'])}; }}
.orbit-muted {{ opacity: {s['text_muted_alpha']}; }}
.orbit-faint {{ opacity: {s['text_faint_alpha']}; }}
.orbit-title {{ font-size: 20px; font-weight: 700; }}
.orbit-big {{ font-size: 34px; font-weight: 300; }}
.orbit-pill {{ border-radius: 999px; padding: 2px 10px; background: {rgba(fb, s['fill_active'])}; font-size: 11px; }}
.orbit-lit {{ background: {s['lit']}; color: {s['lit_text']}; }}
.orbit-ok {{ color: #6fae7c; }} .orbit-warn {{ color: #c9a85c; }} .orbit-fail {{ color: #c25d6a; }}
.orbit-swatch {{ min-width: 18px; min-height: 18px; border-radius: 999px; padding: 0; }}
.orbit-sidebar-dot {{ min-width: 10px; min-height: 10px; border-radius: 999px; }}
.orbit-tile {{ border-radius: {rad['md']}px; padding: {sp}px; }}
.orbit-tile:selected {{ background: {rgba(fb, s['row_active'])}; box-shadow: inset 0 0 0 1px {rgba(fb, s['row_rim'])}; }}
.orbit-mono {{ font-family: "{t['type']['mono_font']}", monospace; }}
.orbit-editor {{ font-size: 15px; padding: {sp * 3}px; }}
"""
