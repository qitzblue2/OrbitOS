"""Orbit Updater — install Orbit and Debian updates, see what changed, get notified.

The window lists what can be updated (Orbit apps and Aphelion first, then
security fixes, then the rest), installs everything with one button through
pkexec and orbit-updater-helper with a live progress bar, and sends a desktop
notification when it finishes. `orbit-updater --background` is the hourly and
after-every-update check run by orbit-updater-check.{timer,path}: it sends a
notification for updates that are ready and for update runs that finished.
"""
import subprocess
import sys

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Adw", "1")
from gi.repository import Adw, Gio, GLib, Gtk  # noqa: E402

from . import ui, updater  # noqa: E402

KIND = {"orbit": ("Orbit", "orbit-updater"), "security": ("Security fixes", "security-high-symbolic"),
        "system": ("System", "package-x-generic-symbolic")}


class UpdaterWindow(Adw.ApplicationWindow):
    def __init__(self, app):
        super().__init__(application=app, title="Orbit Updater", default_width=760, default_height=720)
        self._toasts = Adw.ToastOverlay()
        self.updates, self.busy = [], False
        hb = Adw.HeaderBar()
        self.check_btn = Gtk.Button(icon_name="view-refresh-symbolic", tooltip_text="Check for updates (F5)",
                                    action_name="win.check")
        hb.pack_start(self.check_btn)
        menu = Gio.Menu()
        menu.append("About Orbit Updater", "win.about")
        hb.pack_end(Gtk.MenuButton(icon_name="open-menu-symbolic", menu_model=menu))

        page = Adw.PreferencesPage()
        top = Adw.PreferencesGroup()
        head = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8, margin_top=6, margin_bottom=12)
        self.icon = Gtk.Image(icon_name="orbit-updater", pixel_size=64)
        self.title = Gtk.Label(css_classes=["title-1"], wrap=True, justify=Gtk.Justification.CENTER)
        self.desc = Gtk.Label(css_classes=["dim-label"], wrap=True, justify=Gtk.Justification.CENTER)
        self.update_btn = Gtk.Button(label="Update Now", css_classes=["suggested-action", "pill"], visible=False,
                                     halign=Gtk.Align.CENTER, margin_top=6)
        self.update_btn.connect("clicked", lambda *_: self.upgrade())
        self.progress = Gtk.ProgressBar(show_text=True, visible=False, width_request=360, halign=Gtk.Align.CENTER)
        for w in (self.icon, self.title, self.desc, self.update_btn, self.progress):
            head.append(w)
        top.add(head)
        page.add(top)
        self.groups = {}
        for kind, (title, _icon) in KIND.items():
            g = Adw.PreferencesGroup(title=title, visible=False)
            page.add(g)
            self.groups[kind] = (g, [])
        self.recent = Adw.PreferencesGroup(title="Recently installed")
        self._recent_rows = []
        page.add(self.recent)
        auto = Adw.PreferencesGroup()
        row = Adw.ActionRow(title="Automatic updates",
                            subtitle="Orbit also installs updates by itself every night and tells you when it did.")
        row.set_subtitle_lines(2)
        row.add_prefix(Gtk.Image(icon_name="emblem-synchronizing-symbolic"))
        auto.add(row)
        page.add(auto)

        tv = Adw.ToolbarView(content=page)
        tv.add_top_bar(hb)
        self._toasts.set_child(tv)
        self.set_content(self._toasts)
        for name, cb in {"check": lambda: self.check(refresh=True),
                         "about": lambda: ui.about(self, "Orbit Updater", "orbit-updater",
                                                   "Keep Orbit OS up to date.")}.items():
            a = Gio.SimpleAction.new(name, None)
            a.connect("activate", lambda *_a, cb=cb: cb())
            self.add_action(a)
        self.check(refresh=False)

    # ---- list
    def check(self, refresh):
        """refresh=True downloads the newest list first (asks for the password once)."""
        if self.busy:
            return
        self._busy(True, "Checking for updates…")

        def work():
            if refresh:
                self._run_helper("refresh")
            return updater.upgradable(), updater.history()[-5:]
        ui.run_async(work, self._show, lambda e: (self._busy(False), ui.toast(self, f"Checking failed: {e}")))

    def _show(self, res):
        self.updates, runs = res
        self._busy(False)
        n = len(self.updates)
        if n:
            self._head(f"{n} update{'s' * (n != 1)} ready", updater.summary([u["name"] for u in self.updates]),
                       "orbit-updater")
        else:
            self._head("Orbit is up to date", "Press ↻ to check the server again.", "emblem-ok-symbolic")
        self.update_btn.set_visible(n > 0)
        for kind, (grp, rows) in self.groups.items():
            for r in rows:
                grp.remove(r)
            rows.clear()
            items = [u for u in self.updates if u["kind"] == kind]
            grp.set_visible(bool(items))
            for u in items[:40]:
                r = Adw.ActionRow(title=GLib.markup_escape_text(u["name"]),
                                  subtitle=GLib.markup_escape_text(f"{u['old']} → {u['new']}"))
                grp.add(r)
                rows.append(r)
            if len(items) > 40:
                r = Adw.ActionRow(title=f"and {len(items) - 40} more")
                grp.add(r)
                rows.append(r)
        for r in self._recent_rows:
            self.recent.remove(r)
        self._recent_rows = []
        for run in reversed(runs):
            changed = run["upgraded"] + run["installed"]
            if not changed and not run["error"]:
                continue
            r = Adw.ActionRow(title=run["end"].replace("  ", " · "),
                              subtitle=("Didn’t finish · " if run["error"] else "")
                              + GLib.markup_escape_text(updater.summary(changed) or "nothing changed"))
            r.add_prefix(Gtk.Image(icon_name="dialog-warning-symbolic" if run["error"] else "emblem-ok-symbolic"))
            self.recent.add(r)
            self._recent_rows.append(r)
        self.recent.set_visible(bool(self._recent_rows))

    # ---- install
    def upgrade(self):
        if self.busy:
            return
        self._busy(True, "Installing updates…")
        self.progress.set_visible(True)
        self.progress.set_fraction(0)
        count = len(self.updates)

        updater.mark_window_upgrading(True)

        def done(ok):
            updater.mark_window_upgrading(False)
            self.progress.set_visible(False)
            if ok:
                updater.notify("Orbit is up to date", f"{count} update{'s' * (count != 1)} installed. "
                               "Restart when convenient to finish.")
            else:
                updater.notify("Updates didn’t finish", "Check the internet connection and try again.", "critical")
            self.check(refresh=False)
        ui.run_async(lambda: self._run_helper("upgrade") == 0, done, lambda e: done(False))

    def _run_helper(self, job):
        p = subprocess.Popen(["pkexec", updater.HELPER, job], stdout=subprocess.PIPE, text=True)
        for line in p.stdout:
            if line.startswith("orbit-progress: "):
                pct, _, text = line[len("orbit-progress: "):].strip().partition(" ")
                GLib.idle_add(self._progress, float(pct) / 100, text)
        return p.wait()

    def _progress(self, frac, text):
        self.progress.set_fraction(frac)
        self.progress.set_text(text[:60])
        return False

    def _busy(self, on, title=None):
        self.busy = on
        self.check_btn.set_sensitive(not on)
        self.update_btn.set_sensitive(not on)
        if on and title:
            self._head(title, "", "orbit-updater")

    def _head(self, title, desc, icon):
        self.title.set_label(title)
        self.desc.set_label(desc)
        self.desc.set_visible(bool(desc))
        self.icon.set_from_icon_name(icon)


class UpdaterApp(ui.OrbitApp):
    def __init__(self):
        super().__init__("org.orbit_os.Updater", lambda app: UpdaterWindow(app))
        self.connect("startup", lambda *_: ui.add_shortcuts(self, {"win.check": ["F5"]}))


def background():
    """Hourly / after-update check: notify, remember what was said, never open a window."""
    try:
        updates = updater.upgradable()
    except (OSError, subprocess.SubprocessError):
        updates = []
    events, state = updater.background_events(updates, updater.history(), updater.load_state())
    for title, body in events:
        updater.notify(title, body, "critical" if title.startswith("Updates didn") else "normal")
    updater.save_state(state)
    return 0


def main():
    if "--background" in sys.argv[1:]:
        return background()
    return UpdaterApp().run_main()
