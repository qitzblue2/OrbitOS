"""Small helpers every Orbit app uses: app bootstrap, CSS, toasts, dialogs."""
import subprocess
import sys
import threading

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Adw", "1")
from gi.repository import Adw, Gdk, Gio, GLib, Gtk  # noqa: E402

from . import tokens  # noqa: E402


class OrbitApp(Adw.Application):
    """Adw.Application that loads the shared Orbit CSS and follows dark/light."""

    def __init__(self, app_id, window_factory, flags=Gio.ApplicationFlags.DEFAULT_FLAGS):
        super().__init__(application_id=app_id, flags=flags)
        self._factory = window_factory
        self._css = Gtk.CssProvider()
        self.connect("startup", self._on_startup)
        self.connect("activate", self._on_activate)

    def _on_startup(self, *_):
        sm = Adw.StyleManager.get_default()
        sm.connect("notify::dark", lambda *_: self._load_css())
        self._load_css()
        Gtk.StyleContext.add_provider_for_display(
            Gdk.Display.get_default(), self._css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)

    def _load_css(self):
        try:
            css = tokens.app_css(Adw.StyleManager.get_default().get_dark())
        except FileNotFoundError:
            css = ""
        self._css.load_from_string(css) if hasattr(self._css, "load_from_string") else \
            self._css.load_from_data(css.encode())

    def _on_activate(self, *_):
        win = self.props.active_window or self._factory(self)
        win.present()

    def run_main(self):
        return self.run(sys.argv)


def toast(window, text, timeout=3):
    """Show a toast on a window that keeps its Adw.ToastOverlay in window._toasts."""
    overlay = getattr(window, "_toasts", None)
    if overlay is not None:
        overlay.add_toast(Adw.Toast(title=GLib.markup_escape_text(text), timeout=timeout))


def confirm(parent, heading, body, action_label, callback, destructive=True):
    """Adw.AlertDialog with Cancel + one action; callback() on confirm."""
    d = Adw.AlertDialog(heading=heading, body=body)
    d.add_response("cancel", "Cancel")
    d.add_response("ok", action_label)
    d.set_response_appearance("ok", Adw.ResponseAppearance.DESTRUCTIVE if destructive
                              else Adw.ResponseAppearance.SUGGESTED)
    d.set_default_response("cancel")
    d.connect("response", lambda _d, r: callback() if r == "ok" else None)
    d.present(parent)


def ask_text(parent, heading, initial, action_label, callback):
    """Dialog with one entry; callback(text) on confirm (non-empty only)."""
    d = Adw.AlertDialog(heading=heading)
    entry = Gtk.Entry(text=initial, activates_default=True)
    d.set_extra_child(entry)
    d.add_response("cancel", "Cancel")
    d.add_response("ok", action_label)
    d.set_response_appearance("ok", Adw.ResponseAppearance.SUGGESTED)
    d.set_default_response("ok")
    d.connect("response", lambda _d, r: callback(entry.get_text().strip())
              if r == "ok" and entry.get_text().strip() else None)
    d.present(parent)
    # select the stem so typing replaces the name but keeps the extension
    stem = initial.rsplit(".", 1)[0] if "." in initial[1:] else initial
    GLib.idle_add(lambda: (entry.grab_focus(), entry.select_region(0, len(stem))) and False)


def run_async(func, on_done=None, on_error=None):
    """Run func() in a thread; deliver result/exception on the GTK main loop."""
    def worker():
        try:
            res = func()
        except Exception as e:  # noqa: BLE001 - reported to the UI
            if on_error:
                GLib.idle_add(on_error, e)
            return
        if on_done:
            GLib.idle_add(on_done, res)
    t = threading.Thread(target=worker, daemon=True)
    t.start()
    return t


def spawn(argv):
    """Fire-and-forget a helper process (never through a shell)."""
    try:
        subprocess.Popen(argv, start_new_session=True)
        return True
    except OSError:
        return False


def about(parent, name, icon, summary):
    a = Adw.AboutDialog(application_name=name, application_icon=icon, version="1.0.0",
                        comments=summary, license_type=Gtk.License.GPL_3_0,
                        developer_name="Orbit OS", website="https://github.com/qitzblue2/OrbitOS")
    a.present(parent)


def add_shortcuts(app, mapping):
    """mapping: {'win.action': ['<Ctrl>t', ...]}"""
    for action, accels in mapping.items():
        app.set_accels_for_action(action, accels)


def human_size(n):
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1000 or unit == "TB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1000
    return f"{n:.1f} TB"
