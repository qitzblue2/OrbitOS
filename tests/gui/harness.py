"""Run an Orbit app window headlessly (Xvfb), drive it, and save PNG screenshots.

Used by tests/gui/screenshots.py. Renders the window's own widget tree via
Gtk.WidgetPaintable, so it works without a compositor.
"""
import pathlib
import sys
import traceback

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "packages/orbit-apps/src"))

import gi  # noqa: E402

gi.require_version("Graphene", "1.0")

gi.require_version("Gtk", "4.0")
gi.require_version("Adw", "1")
from gi.repository import GLib, Graphene, Gtk  # noqa: E402

ERRORS = []


def excepthook(t, v, tb):
    ERRORS.append("".join(traceback.format_exception(t, v, tb)))
    sys.__excepthook__(t, v, tb)


sys.excepthook = excepthook


def snapshot(widget, path):
    w, h = widget.get_width(), widget.get_height()
    paint = Gtk.WidgetPaintable(widget=widget)
    snap = Gtk.Snapshot()
    paint.snapshot(snap, w, h)
    node = snap.to_node()
    if node is None:
        raise RuntimeError("nothing rendered")
    renderer = widget.get_native().get_renderer()
    tex = renderer.render_texture(node, Graphene.Rect().init(0, 0, w, h))
    tex.save_to_png(str(path))


def run(app, steps, outdir, settle_ms=700):
    """steps: list of (name or None, callable(window)). Screenshot after each named step."""
    outdir = pathlib.Path(outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    state = {"i": 0}

    def tick():
        win = app.props.active_window
        if win is None:
            return True
        if state["i"] >= len(steps):
            app.quit()
            return False
        name, fn = steps[state["i"]]
        state["i"] += 1
        try:
            if fn:
                fn(win)
        except Exception:
            ERRORS.append(traceback.format_exc())

        def shot():
            if name:
                try:
                    target = getattr(win, "_shot_target", None) or win
                    snapshot(target, outdir / f"{name}.png")
                except Exception:
                    ERRORS.append(traceback.format_exc())
            return False
        GLib.timeout_add(settle_ms // 2, shot)
        return True

    GLib.timeout_add(settle_ms, tick)
    app.run([sys.argv[0]])
    return ERRORS
