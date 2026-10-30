"""Orbit Focus — a timer that holds back notifications and distracting sites.

Pick a length, press Start: notifications wait and Aphelion won't open the
sites on your list until the time is up (it shows a calm "Focus time" page
instead). `orbit-focus --end` (run by the timer) ends the session.
"""
import json
import sys

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Adw", "1")
from gi.repository import Adw, Gio, GLib, Gtk  # noqa: E402

from . import focus, paths, ui  # noqa: E402

SITES_FILE = paths.CONFIG / "focus-sites.json"


def saved_sites():
    try:
        return focus.clean_sites(json.loads(SITES_FILE.read_text()))
    except (OSError, ValueError):
        return list(focus.DEFAULT_SITES)


class FocusWindow(Adw.ApplicationWindow):
    def __init__(self, app):
        super().__init__(application=app, title="Focus", default_width=560, default_height=640)
        self._toasts = Adw.ToastOverlay()
        hb = Adw.HeaderBar()
        menu = Gio.Menu()
        menu.append("About Orbit Focus", "win.about")
        hb.pack_end(Gtk.MenuButton(icon_name="open-menu-symbolic", menu_model=menu))

        page = Adw.PreferencesPage()
        head = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10, margin_bottom=8)
        self.clock = Gtk.Label(css_classes=["title-1", "numeric"])
        self.clock.set_markup("<span size='300%' weight='bold'>25:00</span>")
        self.sub = Gtk.Label(css_classes=["dim-label"])
        self.lengths = Gtk.Box(css_classes=["linked"], halign=Gtk.Align.CENTER)
        self.length = focus.LENGTHS[0]
        group = None
        for m in focus.LENGTHS:
            b = Gtk.ToggleButton(label=f"{m} min", group=group, active=m == self.length)
            group = group or b
            b.connect("toggled", lambda btn, m=m: btn.get_active() and self._pick(m))
            self.lengths.append(b)
        self.btn = Gtk.Button(css_classes=["pill", "suggested-action"], halign=Gtk.Align.CENTER)
        self.btn.connect("clicked", lambda *_: self.toggle())
        for w in (self.clock, self.sub, self.lengths, self.btn):
            head.append(w)
        g = Adw.PreferencesGroup()
        g.add(head)
        page.add(g)

        sites = Adw.PreferencesGroup(title="Sites to keep away",
                                     description="Aphelion won’t open these (and their subdomains) during focus time.")
        self.entry = Gtk.TextView(wrap_mode=Gtk.WrapMode.WORD, top_margin=8, bottom_margin=8, left_margin=10,
                                  right_margin=10, css_classes=["card"])
        self.entry.get_buffer().set_text(", ".join(saved_sites()))
        sites.add(Gtk.ScrolledWindow(child=self.entry, min_content_height=110))
        page.add(sites)
        what = Adw.PreferencesGroup(title="During focus time")
        for icon, text in (("notifications-disabled-symbolic", "Notifications wait in the list (Super+M)"),
                           ("action-unavailable-symbolic", "The sites above don’t open in Aphelion"),
                           ("alarm-symbolic", "A notification says when the time is up")):
            r = Adw.ActionRow(title=text)
            r.add_prefix(Gtk.Image(icon_name=icon))
            what.add(r)
        page.add(what)

        tv = Adw.ToolbarView(content=page)
        tv.add_top_bar(hb)
        self._toasts.set_child(tv)
        self.set_content(self._toasts)
        a = Gio.SimpleAction.new("about", None)
        a.connect("activate", lambda *_: ui.about(self, "Orbit Focus", "orbit-focus", "Time without distractions."))
        self.add_action(a)
        self.tick()
        self._timer = GLib.timeout_add_seconds(1, self.tick)
        self.connect("close-request", lambda *_: (GLib.source_remove(self._timer), False)[1])

    def _pick(self, m):
        self.length = m
        self.tick()

    def tick(self):
        s = focus.load()
        left = focus.remaining(s) if s else self.length * 60
        self.clock.set_markup(f"<span size='300%' weight='bold'>{left // 60:02d}:{left % 60:02d}</span>")
        self.lengths.set_sensitive(s is None)
        self.entry.set_sensitive(s is None)
        if s:
            self.btn.set_label("End Focus")
            self.btn.set_css_classes(["pill", "destructive-action"])
            self.sub.set_label(f"Focusing · {len(s['sites'])} sites kept away")
        else:
            self.btn.set_label("Start Focus")
            self.btn.set_css_classes(["pill", "suggested-action"])
            self.sub.set_label("Notifications wait, distracting sites stay closed")
        return True

    def toggle(self):
        if focus.load():
            focus.end(finished=False)
            ui.toast(self, "Focus ended. Notifications are back.", 2)
        else:
            buf = self.entry.get_buffer()
            sites = focus.clean_sites(buf.get_text(buf.get_start_iter(), buf.get_end_iter(), False))
            paths.ensure(SITES_FILE.parent)
            SITES_FILE.write_text(json.dumps(sites))
            buf.set_text(", ".join(sites))
            focus.start(self.length, sites)
            ui.toast(self, f"Focus for {self.length} minutes", 2)
        self.tick()


class FocusApp(ui.OrbitApp):
    def __init__(self):
        super().__init__("org.orbit_os.Focus", lambda app: FocusWindow(app))


def main():
    if sys.argv[1:] == ["--end"]:
        focus.end()
        return 0
    return FocusApp().run_main()
