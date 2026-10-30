"""Orbit Windows Apps — install and run Windows programs with Wine.

Double-clicking a .exe or .msi anywhere opens it through `orbit-windows FILE`:
it runs straight away when Wine can handle it, or explains what is missing and
offers the one-click setup (pkexec orbit-windows-helper). Opened on its own,
the window lists installed Windows programs and has the C: drive, Wine's
settings and the Windows uninstaller one click away.
"""
import subprocess
import sys

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Adw", "1")
from gi.repository import Adw, Gio, GLib, Gtk  # noqa: E402

from . import ui, winapps  # noqa: E402


class WindowsWindow(Adw.ApplicationWindow):
    def __init__(self, app):
        super().__init__(application=app, title="Windows Apps", default_width=760, default_height=700)
        self._toasts = Adw.ToastOverlay()
        hb = Adw.HeaderBar()
        install = Gtk.Button(label="Install a Program…", css_classes=["suggested-action"],
                             action_name="win.install")
        hb.pack_start(install)
        menu = Gio.Menu()
        menu.append("Refresh", "win.refresh")
        menu.append("About Orbit Windows Apps", "win.about")
        hb.pack_end(Gtk.MenuButton(icon_name="open-menu-symbolic", menu_model=menu))

        page = Adw.PreferencesPage()
        self.setup_group = Adw.PreferencesGroup(title="Windows support")
        self.setup_btn = Gtk.Button(label="Set Up", css_classes=["suggested-action", "pill"], valign=Gtk.Align.CENTER)
        self.setup_btn.connect("clicked", lambda *_: self.setup())
        self.setup_group.set_header_suffix(self.setup_btn)
        self.rows = {}
        for key, title, sub in (("wine", "64-bit Windows programs", "Most new apps and games"),
                                ("wine32", "32-bit Windows programs", "Most installers and older apps")):
            row = Adw.ActionRow(title=title, subtitle=sub)
            img = Gtk.Image()
            row.add_suffix(img)
            self.rows[key] = img
            self.setup_group.add(row)
        page.add(self.setup_group)

        self.lib = Adw.PreferencesGroup(title="Installed Windows programs")
        self._lib_rows = []
        page.add(self.lib)

        tools = Adw.PreferencesGroup(title="Windows drive")
        for title, sub, icon, cb in (
                ("Open the C: drive", "Where Windows programs and their files live", "drive-harddisk-symbolic",
                 self.open_c),
                ("Uninstall a program", "The Windows “Add or remove programs” list", "user-trash-symbolic",
                 lambda: self._wine(["wine", "uninstaller"])),
                ("Windows settings", "Windows version, screen size, sound and drives (winecfg)",
                 "emblem-system-symbolic", lambda: self._wine(["winecfg"]))):
            row = Adw.ActionRow(title=title, subtitle=sub, activatable=True)
            row.add_prefix(Gtk.Image(icon_name=icon))
            row.add_suffix(Gtk.Image(icon_name="go-next-symbolic"))
            row.connect("activated", lambda _r, cb=cb: cb())
            tools.add(row)
        page.add(tools)
        note = Adw.PreferencesGroup(
            description="Tip: double-click any .exe or .msi in Files to run it. Most programs work; ones with "
                        "anti-cheat or special drivers may not.")
        page.add(note)

        tv = Adw.ToolbarView(content=page)
        tv.add_top_bar(hb)
        self._toasts.set_child(tv)
        self.set_content(self._toasts)
        for name, cb in {"install": self.pick, "refresh": self.refresh,
                         "about": lambda: ui.about(self, "Orbit Windows Apps", "orbit-windows",
                                                   "Run Windows programs on Orbit.")}.items():
            a = Gio.SimpleAction.new(name, None)
            a.connect("activate", lambda *_a, cb=cb: cb())
            self.add_action(a)
        self.refresh()

    def refresh(self):
        state = winapps.ready()
        for key, img in self.rows.items():
            img.set_from_icon_name("emblem-ok-symbolic" if state[key] else "list-remove-symbolic")
            img.set_css_classes(["orbit-ok"] if state[key] else ["dim-label"])
        full = all(state.values())
        self.setup_btn.set_visible(not full)
        self.setup_group.set_description("Ready." if full else "One click installs what is missing (about 600 MB).")
        for r in self._lib_rows:
            self.lib.remove(r)
        self._lib_rows = []
        apps = winapps.library()
        for a in apps:
            row = Adw.ActionRow(title=GLib.markup_escape_text(a["name"]))
            row.add_prefix(Gtk.Image(icon_name=a["icon"], pixel_size=32))
            b = Gtk.Button(label="Open", valign=Gtk.Align.CENTER, css_classes=["pill"])
            b.connect("clicked", lambda *_b, d=a["desktop"]: self._launch(d))
            row.add_suffix(b)
            self.lib.add(row)
            self._lib_rows.append(row)
        if not apps:
            row = Adw.ActionRow(title="Nothing installed yet",
                                subtitle="Press “Install a Program…” and pick a Windows installer (.exe or .msi).")
            row.set_subtitle_lines(2)
            self.lib.add(row)
            self._lib_rows.append(row)

    def _launch(self, desktop):
        info = Gio.DesktopAppInfo.new_from_filename(desktop)
        if info is None or not info.launch([], None):
            ui.toast(self, "Couldn’t start it")

    def _wine(self, argv):
        if not winapps.ready()["wine"]:
            ui.toast(self, "Set up Windows support first")
            return
        ui.spawn(argv)

    def open_c(self):
        c = winapps.c_drive()
        if not c.exists():
            ui.toast(self, "The C: drive appears after the first Windows program runs")
            return
        ui.spawn(["orbit-files", str(c)])

    def pick(self):
        flt = Gtk.FileFilter(name="Windows programs")
        for pat in ("*.exe", "*.EXE", "*.msi", "*.MSI"):
            flt.add_pattern(pat)
        store = Gio.ListStore.new(Gtk.FileFilter)
        store.append(flt)
        dlg = Gtk.FileDialog(title="Pick a Windows Installer", filters=store, default_filter=flt)

        def done(d, res):
            try:
                f = d.open_finish(res)
            except GLib.Error:
                return
            self.run_file(f.get_path())
        dlg.open(self, None, done)

    def run_file(self, path):
        why = winapps.explain_failure(path, winapps.ready())
        if why:
            d = Adw.AlertDialog(heading="Windows support needed", body=why)
            d.add_response("cancel", "Not Now")
            d.add_response("ok", "Set Up")
            d.set_response_appearance("ok", Adw.ResponseAppearance.SUGGESTED)
            d.connect("response", lambda _d, r: self.setup(then=path) if r == "ok" else None)
            d.present(self)
            return False
        try:
            winapps.start(path)
        except (OSError, ValueError) as e:
            ui.toast(self, f"Couldn’t start it: {e}")
            return False
        ui.toast(self, f"Starting {GLib.path_get_basename(path)}… The first start takes a minute.", 5)
        GLib.timeout_add_seconds(20, lambda: self.refresh() and False)
        return True

    def setup(self, then=None):
        self.setup_btn.set_sensitive(False)
        self.setup_btn.set_label("Installing…")

        def done(rc):
            self.setup_btn.set_sensitive(True)
            self.setup_btn.set_label("Set Up")
            self.refresh()
            if rc == 0:
                ui.toast(self, "Windows support is ready", 3)
                if then:
                    self.run_file(then)
            else:
                ui.toast(self, "Setup didn’t finish. Check the internet connection and try again.", 5)
        ui.run_async(lambda: subprocess.run(winapps.setup_argv(), capture_output=True).returncode, done,
                     lambda e: done(1))


class WindowsApp(ui.OrbitApp):
    def __init__(self):
        super().__init__("org.orbit_os.WindowsApps", lambda app: WindowsWindow(app),
                         flags=Gio.ApplicationFlags.HANDLES_OPEN)
        self.connect("open", self._open)

    def _open(self, _app, files, _n, _hint):
        win = self.props.active_window or WindowsWindow(self)
        paths_ = [f.get_path() for f in files if f.get_path() and winapps.kind(f.get_path())]
        ready = all(winapps.ready().values())
        if not ready or len(paths_) != 1:
            win.present()  # the setup question needs a visible window
        for p in paths_:
            started = win.run_file(p)
            if started and ready and len(paths_) == 1 and not self.props.active_window:
                # double-clicked a program and it just runs: no window needed
                GLib.timeout_add_seconds(3, lambda: (self.quit(), False)[1])
                return
        win.present()


def main():
    return WindowsApp().run_main()
