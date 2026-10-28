"""Orbit Screenshot — capture, annotate, save or copy.

Capturing goes through the xdg-desktop-portal Screenshot API, so on GNOME you
get the normal selection UI (area / window / screen) and it works on Wayland.
The editor: pen, highlighter, arrow, rectangle, ellipse, text, pixelate (for
hiding passwords or faces; irreversible in the saved file) and crop, with undo.
Saves to ~/Home/Pictures/Screenshots or copies the image to the clipboard.

  orbit-screenshot            open the editor
  orbit-screenshot --capture  capture straight away (bound to Shift+Super+S)
  orbit-screenshot FILE       annotate an existing image
"""
import datetime as dt
import io
import pathlib
import random
import shutil
import subprocess
import sys
import tempfile

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Adw", "1")
gi.require_version("GdkPixbuf", "2.0")
gi.require_foreign("cairo")
import cairo  # noqa: E402
from gi.repository import Adw, Gdk, GdkPixbuf, Gio, GLib, Gtk  # noqa: E402

from . import annotate, paths, ui  # noqa: E402

TOOL_ICONS = {t: (f"orbit-tool-{t}-symbolic", tip) for t, tip in (
    ("pen", "Pen (P)"), ("highlight", "Highlighter (H)"), ("arrow", "Arrow (A)"), ("rect", "Rectangle (R)"),
    ("ellipse", "Ellipse (E)"), ("text", "Text (T)"), ("pixelate", "Pixelate to hide (X)"), ("crop", "Crop (C)"))}


def screenshots_dir():
    d = paths.orbit_home() / "Pictures" / "Screenshots"
    d.mkdir(parents=True, exist_ok=True)
    return d


def pixbuf_to_surface(pb):
    surf = cairo.ImageSurface(cairo.FORMAT_ARGB32, pb.get_width(), pb.get_height())
    cr = cairo.Context(surf)
    Gdk.cairo_set_source_pixbuf(cr, pb, 0, 0)
    cr.paint()
    return surf


def surface_png_bytes(surf):
    buf = io.BytesIO()
    surf.write_to_png(buf)
    return buf.getvalue()


def portal_screenshot(interactive, callback):
    """Ask xdg-desktop-portal for a screenshot; callback(path or None, error or None)."""
    try:
        bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    except GLib.Error as e:
        callback(None, e.message)
        return
    token = f"orbit{random.randint(0, 1 << 30)}"
    sender = bus.get_unique_name()[1:].replace(".", "_")
    handle = f"/org/freedesktop/portal/desktop/request/{sender}/{token}"
    sub = {}

    def on_response(conn, snd, path, iface, sig, params):
        conn.signal_unsubscribe(sub["id"])
        code, results = params.unpack()
        if code == 0 and "uri" in results:
            callback(Gio.File.new_for_uri(results["uri"]).get_path(), None)
        else:
            callback(None, None if code == 1 else "the screenshot was not taken")

    sub["id"] = bus.signal_subscribe("org.freedesktop.portal.Desktop", "org.freedesktop.portal.Request",
                                     "Response", handle, None, Gio.DBusSignalFlags.NO_MATCH_RULE, on_response)
    opts = {"handle_token": GLib.Variant("s", token), "interactive": GLib.Variant("b", interactive)}

    def called(conn, res):
        try:
            conn.call_finish(res)
        except GLib.Error as e:
            conn.signal_unsubscribe(sub["id"])
            fallback_screenshot(interactive, callback, e.message)

    bus.call("org.freedesktop.portal.Desktop", "/org/freedesktop/portal/desktop",
             "org.freedesktop.portal.Screenshot", "Screenshot", GLib.Variant("(sa{sv})", ("", opts)),
             GLib.VariantType("(o)"), Gio.DBusCallFlags.NONE, -1, None, called)


def fallback_screenshot(interactive, callback, why):
    tool = shutil.which("gnome-screenshot")
    if not tool:
        callback(None, f"no screenshot portal ({why})")
        return
    out = pathlib.Path(tempfile.mkstemp(suffix=".png")[1])
    argv = [tool, "-f", str(out)] + (["-a"] if interactive else [])
    ui.run_async(lambda: subprocess.run(argv, check=False).returncode,
                 lambda rc: callback(str(out) if rc == 0 and out.stat().st_size else None,
                                     None if rc == 0 else "gnome-screenshot failed"))


class Canvas(Gtk.DrawingArea):
    def __init__(self, win):
        super().__init__(hexpand=True, vexpand=True, focusable=True)
        self.win = win
        self.base = None          # cairo.ImageSurface of the screenshot
        self.history = annotate.History()
        self.live = None          # shape being drawn
        self.scale = 1.0
        self.ox = self.oy = 0.0
        self.set_draw_func(self._draw)
        drag = Gtk.GestureDrag()
        drag.connect("drag-begin", self._begin)
        drag.connect("drag-update", self._update)
        drag.connect("drag-end", self._end)
        self.add_controller(drag)
        self.set_cursor(Gdk.Cursor.new_from_name("crosshair"))

    def set_image(self, surf):
        self.base = surf
        self.history = annotate.History()
        self.queue_draw()

    # coordinate mapping (widget <-> image)
    def _fit(self, w, h):
        if not self.base:
            return
        iw, ih = self.base.get_width(), self.base.get_height()
        self.scale = min(1.0, (w - 48) / iw, (h - 48) / ih)
        self.ox = (w - iw * self.scale) / 2
        self.oy = (h - ih * self.scale) / 2

    def to_image(self, x, y):
        return (x - self.ox) / self.scale, (y - self.oy) / self.scale

    def _draw(self, area, cr, w, h):
        if not self.base:
            return
        self._fit(w, h)
        cr.translate(self.ox, self.oy)
        cr.scale(self.scale, self.scale)
        iw, ih = self.base.get_width(), self.base.get_height()
        # soft shadow under the image
        cr.set_source_rgba(0, 0, 0, 0.35)
        cr.rectangle(6 / self.scale, 10 / self.scale, iw, ih)
        cr.fill()
        cr.set_source_surface(self.base, 0, 0)
        cr.paint()
        for s in self.history.shapes + ([self.live] if self.live else []):
            if s.tool == "crop":
                continue
            annotate.draw_shape(cr, self.base, s)
        crop = self.history.crop
        if self.live and self.live.tool == "crop" and len(self.live.points) >= 2:
            crop = annotate.normalized_rect(self.live.points[0], self.live.points[-1])
        if crop:
            x, y, cw, ch = crop
            cr.set_source_rgba(0, 0, 0, 0.55)
            cr.set_fill_rule(cairo.FILL_RULE_EVEN_ODD)
            cr.rectangle(0, 0, iw, ih)
            cr.rectangle(x, y, cw, ch)
            cr.fill()
            cr.set_source_rgba(1, 1, 1, 0.9)
            cr.set_line_width(1.5 / self.scale)
            cr.rectangle(x, y, cw, ch)
            cr.stroke()

    def _begin(self, g, x, y):
        if not self.base:
            return
        self.grab_focus()
        ix, iy = self.to_image(x, y)
        tool = self.win.tool
        if tool == "text":
            g.set_state(Gtk.EventSequenceState.DENIED)

            def add(text):
                self.history.add(annotate.Shape("text", self.win.color, self.win.width, [(ix, iy)], text))
                self.queue_draw()
                self.win.changed()
            ui.ask_text(self.win, "Add Text", "", "Add", add)
            return
        self.live = annotate.Shape(tool, self.win.color, self.win.width, [(ix, iy)])

    def _update(self, g, dx, dy):
        if not self.live:
            return
        ok, sx, sy = g.get_start_point()
        p = self.to_image(sx + dx, sy + dy)
        if self.live.tool in ("pen", "highlight"):
            self.live.points.append(p)
        else:
            self.live.points = [self.live.points[0], p]
        self.queue_draw()

    def _end(self, g, dx, dy):
        if not self.live:
            return
        s, self.live = self.live, None
        x0, y0, x1, y1 = s.bbox()
        if s.tool in ("pen", "highlight") or (x1 - x0) + (y1 - y0) > 4:
            self.history.add(s)
            self.win.changed()
        self.queue_draw()

    def result(self):
        return annotate.render(self.base, self.history.shapes, self.history.crop)


class ScreenshotWindow(Adw.ApplicationWindow):
    def __init__(self, app):
        super().__init__(application=app, title="Screenshot", default_width=1100, default_height=760)
        self.tool, self.color, self.width = "arrow", annotate.PALETTE[0], 5.0
        self.saved_path = None
        self._toasts = Adw.ToastOverlay()

        hb = Adw.HeaderBar()
        cap = Adw.SplitButton(label="Capture", tooltip_text="Capture an area (Shift+Super+S)")
        cap.connect("clicked", lambda *_: self.capture(True, 0))
        cm = Gio.Menu()
        cm.append("Capture Area or Window", "win.capture-area")
        cm.append("Capture Whole Screen", "win.capture-screen")
        dm = Gio.Menu()
        for sec in (3, 5, 10):
            dm.append(f"In {sec} seconds", f"win.capture-delay::{sec}")
        cm.append_submenu("Capture After a Delay", dm)
        cm.append("Open Image…", "win.open")
        cap.set_menu_model(cm)
        hb.pack_start(cap)
        self.undo_btn = Gtk.Button(icon_name="edit-undo-symbolic", tooltip_text="Undo (Ctrl+Z)", action_name="win.undo")
        self.redo_btn = Gtk.Button(icon_name="edit-redo-symbolic", tooltip_text="Redo (Ctrl+Shift+Z)",
                                   action_name="win.redo")
        hb.pack_start(self.undo_btn)
        hb.pack_start(self.redo_btn)
        save = Adw.SplitButton(label="Save", tooltip_text="Save to Pictures/Screenshots (Ctrl+S)",
                               css_classes=["suggested-action"])
        save.connect("clicked", lambda *_: self.save())
        sm = Gio.Menu()
        sm.append("Save As…", "win.save-as")
        sm.append("Show in Files", "win.reveal")
        save.set_menu_model(sm)
        hb.pack_end(save)
        hb.pack_end(Gtk.Button(icon_name="edit-copy-symbolic", tooltip_text="Copy image (Ctrl+C)",
                               action_name="win.copy"))

        # tool bar
        bar = Gtk.Box(spacing=4, halign=Gtk.Align.CENTER, margin_top=8, margin_bottom=8, css_classes=["toolbar"])
        group = None
        self.tool_buttons = {}
        for t in annotate.TOOLS:
            icon, tip = TOOL_ICONS[t]
            b = Gtk.ToggleButton(icon_name=icon, tooltip_text=tip, group=group, active=t == self.tool)
            group = group or b
            b.connect("toggled", lambda btn, t=t: btn.get_active() and setattr(self, "tool", t))
            bar.append(b)
            self.tool_buttons[t] = b
        bar.append(Gtk.Separator(orientation=Gtk.Orientation.VERTICAL, margin_start=6, margin_end=6))
        cgroup = None
        for c in annotate.PALETTE:
            b = Gtk.ToggleButton(css_classes=["orbit-swatch", "circular"], tooltip_text=c, group=cgroup,
                                 active=c == self.color, valign=Gtk.Align.CENTER)
            cgroup = cgroup or b
            prov = Gtk.CssProvider()
            prov.load_from_string(f"* {{ background: {c}; min-width: 22px; min-height: 22px; border-radius: 999px;"
                                  f" box-shadow: inset 0 0 0 1px alpha(@window_fg_color, .25); }}"
                                  f" *:checked {{ box-shadow: 0 0 0 2px @window_bg_color, 0 0 0 4px {c}; }}")
            b.get_style_context().add_provider(prov, Gtk.STYLE_PROVIDER_PRIORITY_USER + 1)
            b.connect("toggled", lambda btn, c=c: btn.get_active() and setattr(self, "color", c))
            bar.append(b)
        bar.append(Gtk.Separator(orientation=Gtk.Orientation.VERTICAL, margin_start=6, margin_end=6))
        scale = Gtk.Scale.new_with_range(Gtk.Orientation.HORIZONTAL, 2, 16, 1)
        scale.set_value(self.width)
        scale.set_size_request(110, -1)
        scale.set_tooltip_text("Line width")
        scale.connect("value-changed", lambda s: setattr(self, "width", s.get_value()))
        bar.append(scale)

        self.canvas = Canvas(self)
        self.empty = Adw.StatusPage(icon_name="orbit-screenshot", title="Take a Screenshot",
                                    description="Pick an area or window, then draw arrows, boxes and text on it. "
                                                "Shortcut: Shift+Super+S")
        eb = Gtk.Box(spacing=12, halign=Gtk.Align.CENTER)
        for label, act, cls in (("Capture Area", "win.capture-area", ["suggested-action", "pill"]),
                                ("Whole Screen", "win.capture-screen", ["pill"]),
                                ("Open Image", "win.open", ["pill"])):
            eb.append(Gtk.Button(label=label, action_name=act, css_classes=cls))
        self.empty.set_child(eb)
        self.stack = Gtk.Stack(transition_type=Gtk.StackTransitionType.CROSSFADE)
        self.stack.add_named(self.empty, "empty")
        self.stack.add_named(self.canvas, "edit")
        self.info = Gtk.Label(css_classes=["caption", "dim-label"], margin_bottom=6)

        tv = Adw.ToolbarView()
        tv.add_top_bar(hb)
        tv.add_top_bar(bar)
        tv.set_content(self.stack)
        tv.add_bottom_bar(self.info)
        self._bar = bar
        self._toasts.set_child(tv)
        self.set_content(self._toasts)

        acts = {"capture-area": lambda: self.capture(True, 0), "capture-screen": lambda: self.capture(False, 0),
                "open": self.open_dialog, "undo": self.undo, "redo": self.redo, "copy": self.copy,
                "save": self.save, "save-as": self.save_as, "reveal": self.reveal}
        for name, cb in acts.items():
            a = Gio.SimpleAction.new(name, None)
            a.connect("activate", lambda *_a, cb=cb: cb())
            self.add_action(a)
        d = Gio.SimpleAction.new("capture-delay", GLib.VariantType.new("s"))
        d.connect("activate", lambda a, v: self.capture(False, int(v.get_string())))
        self.add_action(d)
        keys = Gtk.ShortcutController(scope=Gtk.ShortcutScope.LOCAL)
        for t, key in TOOL_KEYS.items():
            keys.add_shortcut(Gtk.Shortcut(
                trigger=Gtk.ShortcutTrigger.parse_string(key),
                action=Gtk.CallbackAction.new(lambda *_a, t=t: (self.tool_buttons[t].set_active(True), True)[1])))
        self.canvas.add_controller(keys)
        self.changed()

    # ---- state
    def changed(self):
        has = self.canvas.base is not None
        self.stack.set_visible_child_name("edit" if has else "empty")
        self._bar.set_sensitive(has)
        for n in ("undo", "copy", "save", "save-as"):
            self.lookup_action(n).set_enabled(has and (n != "undo" or bool(self.canvas.history.shapes)))
        self.lookup_action("redo").set_enabled(bool(self.canvas.history.redo_stack))
        self.lookup_action("reveal").set_enabled(self.saved_path is not None)
        if has:
            w, h = self.canvas.base.get_width(), self.canvas.base.get_height()
            crop = self.canvas.history.crop
            size = f"{int(crop[2])} × {int(crop[3])} (cropped from {w} × {h})" if crop else f"{w} × {h}"
            n = len([s for s in self.canvas.history.shapes if s.tool != "crop"])
            self.info.set_label(f"{size} px · {n} annotation{'s' if n != 1 else ''}")

    def load_file(self, path):
        try:
            pb = GdkPixbuf.Pixbuf.new_from_file(str(path))
        except GLib.Error as e:
            ui.toast(self, f"Can’t open image: {e.message}")
            return
        pb = pb.apply_embedded_orientation() or pb
        self.canvas.set_image(pixbuf_to_surface(pb))
        self.saved_path = None
        self.changed()

    # ---- capture
    def capture(self, interactive, delay):
        app = self.get_application()
        self.set_visible(False)  # keep our own window out of the shot

        def go():
            portal_screenshot(interactive, done)
            return False

        def done(path, err):
            self.set_visible(True)
            self.present()
            if path:
                self.load_file(path)
            elif err:
                ui.toast(self, f"Screenshot failed: {err}")
        app.hold()
        GLib.timeout_add(max(250, delay * 1000), lambda: (go(), app.release())[0])

    def open_dialog(self):
        dlg = Gtk.FileDialog(title="Open Image")
        f = Gtk.FileFilter(name="Images")
        f.add_mime_type("image/*")
        store = Gio.ListStore(item_type=Gtk.FileFilter)
        store.append(f)
        dlg.set_filters(store)
        dlg.set_initial_folder(Gio.File.new_for_path(str(paths.orbit_home() / "Pictures")))

        def done(d, res):
            try:
                gf = d.open_finish(res)
            except GLib.Error:
                return
            self.load_file(gf.get_path())
        dlg.open(self, None, done)

    # ---- edit
    def undo(self):
        self.canvas.history.undo()
        self.canvas.queue_draw()
        self.changed()

    def redo(self):
        self.canvas.history.redo()
        self.canvas.queue_draw()
        self.changed()

    # ---- output
    def copy(self):
        data = surface_png_bytes(self.canvas.result())
        tex = Gdk.Texture.new_from_bytes(GLib.Bytes.new(data))
        self.get_display().get_clipboard().set_texture(tex)
        ui.toast(self, "Copied to the clipboard", 2)

    def _write(self, path):
        self.canvas.result().write_to_png(str(path))
        self.saved_path = pathlib.Path(path)
        self.changed()
        t = Adw.Toast(title=f"Saved {self.saved_path.name}", button_label="Show", timeout=4)
        t.connect("button-clicked", lambda *_: self.reveal())
        self._toasts.add_toast(t)

    def save(self):
        name = dt.datetime.now().strftime("Screenshot %Y-%m-%d %H-%M-%S.png")
        self._write(screenshots_dir() / name)

    def save_as(self):
        dlg = Gtk.FileDialog(title="Save Screenshot", initial_name=dt.datetime.now().strftime(
            "Screenshot %Y-%m-%d %H-%M-%S.png"), initial_folder=Gio.File.new_for_path(str(screenshots_dir())))

        def done(d, res):
            try:
                gf = d.save_finish(res)
            except GLib.Error:
                return
            p = gf.get_path()
            self._write(p if p.lower().endswith(".png") else p + ".png")
        dlg.save(self, None, done)

    def reveal(self):
        if self.saved_path:
            ui.spawn(["orbit-files", str(self.saved_path.parent)])


ACCELS = {"win.undo": ["<Ctrl>z"], "win.redo": ["<Ctrl><Shift>z", "<Ctrl>y"], "win.copy": ["<Ctrl>c"],
          "win.save": ["<Ctrl>s"], "win.save-as": ["<Ctrl><Shift>s"], "win.open": ["<Ctrl>o"],
          "win.capture-area": ["<Ctrl>n"]}
# Single-letter tool keys live on the canvas only (see Canvas), never app-wide, so typing
# in the Add Text box or a file dialog can't switch tools.
TOOL_KEYS = dict(zip(annotate.TOOLS, "pharetxc"))


class ScreenshotApp(ui.OrbitApp):
    def __init__(self):
        super().__init__("org.orbit_os.Screenshot", lambda app: ScreenshotWindow(app),
                         Gio.ApplicationFlags.HANDLES_COMMAND_LINE)
        self.connect("command-line", self._cmd)
        self.connect("startup", lambda *_: ui.add_shortcuts(self, ACCELS))

    def _cmd(self, app, cl):
        args = cl.get_arguments()[1:]
        win = self.props.active_window or ScreenshotWindow(self)
        win.present()
        if "--capture" in args:
            win.capture(True, 0)
        else:
            files = [a for a in args if not a.startswith("-")]
            if files:
                win.load_file(cl.create_file_for_arg(files[0]).get_path())
        return 0


def main():
    return ScreenshotApp().run(sys.argv)
