"""Orbit Optimizer — free up space and choose which apps start at login.

"Clean Up" measures first and deletes nothing until you press Clean. Your own
caches, thumbnails and Trash are cleaned directly; system files (old update
downloads, logs, crash reports, unused packages) go through pkexec and
orbit-tune-helper, which only knows those fixed jobs. "Startup" turns login
apps on or off with a per-user override, so nothing system-wide changes.
"""
import subprocess

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Adw", "1")
from gi.repository import Adw, Gio, GLib, Gtk  # noqa: E402

from . import tune, ui  # noqa: E402

TARGET_ICON = {"cache": "folder-symbolic", "thumbnails": "image-x-generic-symbolic",
               "trash": "user-trash-symbolic", "apt": "software-update-available-symbolic",
               "journal": "text-x-generic-symbolic", "crash": "dialog-warning-symbolic",
               "autoremove": "package-x-generic-symbolic"}


class OptimizerWindow(Adw.ApplicationWindow):
    def __init__(self, app):
        super().__init__(application=app, title="Optimizer", default_width=760, default_height=720)
        self._toasts = Adw.ToastOverlay()
        self.targets, self.checks = [], {}

        self.stack = Adw.ViewStack()
        switcher = Adw.ViewSwitcher(stack=self.stack, policy=Adw.ViewSwitcherPolicy.WIDE)
        hb = Adw.HeaderBar(title_widget=switcher)
        self.rescan = Gtk.Button(icon_name="view-refresh-symbolic", tooltip_text="Measure again (F5)",
                                 action_name="win.scan")
        hb.pack_start(self.rescan)
        menu = Gio.Menu()
        menu.append("About Orbit Optimizer", "win.about")
        hb.pack_end(Gtk.MenuButton(icon_name="open-menu-symbolic", menu_model=menu))

        # clean-up page
        clean = Adw.PreferencesPage()
        self.total = Adw.PreferencesGroup()
        self.clean_btn = Gtk.Button(label="Clean Up", css_classes=["suggested-action", "pill"],
                                    halign=Gtk.Align.CENTER, sensitive=False)
        self.clean_btn.connect("clicked", lambda *_: self.clean())
        self.total.set_header_suffix(self.clean_btn)
        clean.add(self.total)
        self.user_group = Adw.PreferencesGroup(title="Your files")
        self.sys_group = Adw.PreferencesGroup(title="System",
                                              description="Asks for your password once.")
        clean.add(self.user_group)
        clean.add(self.sys_group)
        self._rows = []
        self.stack.add_titled_with_icon(clean, "clean", "Clean Up", "user-trash-symbolic")

        # startup page
        self.startup = Adw.PreferencesPage()
        self.start_group = Adw.PreferencesGroup(
            title="Apps that start when you log in",
            description="Fewer apps here means a faster login. Orbit’s own parts aren’t listed.")
        self.startup.add(self.start_group)
        self._start_rows = []
        self.stack.add_titled_with_icon(self.startup, "startup", "Startup", "system-run-symbolic")

        tv = Adw.ToolbarView(content=self.stack)
        tv.add_top_bar(hb)
        bar = Adw.ViewSwitcherBar(stack=self.stack)
        tv.add_bottom_bar(bar)
        bp = Adw.Breakpoint.new(Adw.BreakpointCondition.parse("max-width: 560sp"))
        bp.add_setter(bar, "reveal", True)
        bp.add_setter(hb, "title-widget", Adw.WindowTitle(title="Optimizer"))
        self.add_breakpoint(bp)
        self._toasts.set_child(tv)
        self.set_content(self._toasts)
        for name, cb in {"scan": self.scan,
                         "about": lambda: ui.about(self, "Orbit Optimizer", "orbit-optimizer",
                                                   "Free up space and speed up login.")}.items():
            a = Gio.SimpleAction.new(name, None)
            a.connect("activate", lambda *_a, cb=cb: cb())
            self.add_action(a)
        self.scan()
        self.load_startup()

    # ---- clean up
    def scan(self):
        self.rescan.set_sensitive(False)
        self.clean_btn.set_sensitive(False)
        self.total.set_title("Measuring…")
        self.total.set_description("Nothing is deleted until you press Clean Up.")
        ui.run_async(tune.scan, self._show, lambda e: ui.toast(self, f"Measuring failed: {e}"))

    def _show(self, targets):
        self.targets = targets
        for grp, row in self._rows:
            grp.remove(row)
        self._rows, self.checks = [], {}
        for t in targets:
            grp = self.sys_group if t["system"] else self.user_group
            row = Adw.ActionRow(title=t["title"], subtitle=t["detail"])
            row.add_prefix(Gtk.Image(icon_name=TARGET_ICON.get(t["id"], "folder-symbolic")))
            size = "—" if t["id"] == "autoremove" else ui.human_size(t["size"])
            row.add_suffix(Gtk.Label(label=size, css_classes=["dim-label", "numeric"]))
            chk = Gtk.CheckButton(active=t["id"] != "trash" and (t["size"] > 0 or t["id"] == "autoremove"),
                                  valign=Gtk.Align.CENTER)
            chk.connect("toggled", lambda *_: self._update_total())
            row.add_suffix(chk)
            row.set_activatable_widget(chk)
            grp.add(row)
            self._rows.append((grp, row))
            self.checks[t["id"]] = chk
        self.rescan.set_sensitive(True)
        self._update_total()

    def _update_total(self):
        chosen = [t for t in self.targets if self.checks[t["id"]].get_active()]
        n = sum(t["size"] for t in chosen)
        self.total.set_title(f"{ui.human_size(n)} can be freed" if n else "Nothing big to clean")
        self.clean_btn.set_sensitive(bool(chosen))

    def clean(self):
        chosen = [t for t in self.targets if self.checks[t["id"]].get_active()]
        if any(t["id"] == "trash" for t in chosen):
            ui.confirm(self, "Empty the Trash?", "Files in the Trash will be deleted for good.", "Clean Up",
                       lambda: self._clean(chosen))
        else:
            self._clean(chosen)

    def _clean(self, chosen):
        self.clean_btn.set_sensitive(False)
        self.total.set_title("Cleaning…")

        def work():
            freed = sum(tune.clean_user(t["id"]) for t in chosen if not t["system"])
            system = [t for t in chosen if t["system"]]
            ok = True
            if system:
                r = subprocess.run(tune.clean_system_argv([t["id"] for t in system]),
                                   capture_output=True, text=True)
                ok = r.returncode == 0
                if ok:
                    freed += sum(t["size"] for t in system)
            return freed, ok

        def done(res):
            freed, ok = res
            ui.toast(self, f"Freed {ui.human_size(freed)}" if ok else
                     f"Freed {ui.human_size(freed)}; system files were not cleaned", 4)
            self.scan()
        ui.run_async(work, done, lambda e: (ui.toast(self, f"Cleaning failed: {e}"), self.scan()))

    # ---- startup
    def load_startup(self):
        for row in self._start_rows:
            self.start_group.remove(row)
        self._start_rows = []
        apps = tune.autostart_apps()
        if not apps:
            row = Adw.ActionRow(title="No apps start at login", subtitle="Login is as fast as it gets.")
            self.start_group.add(row)
            self._start_rows.append(row)
        for a in apps:
            row = Adw.SwitchRow(title=GLib.markup_escape_text(a["name"]),
                                subtitle=GLib.markup_escape_text(a["comment"]), active=a["enabled"])
            row.add_prefix(Gtk.Image(icon_name=a["icon"], pixel_size=32))
            row.connect("notify::active", self._toggle_start, a["id"])
            self.start_group.add(row)
            self._start_rows.append(row)

    def _toggle_start(self, row, _pspec, fid):
        try:
            tune.set_autostart(fid, row.get_active())
        except (OSError, ValueError) as e:
            ui.toast(self, f"Couldn’t change it: {e}")
            return
        ui.toast(self, ("Starts at login" if row.get_active() else "Won’t start at login") + " from next time", 2)


class OptimizerApp(ui.OrbitApp):
    def __init__(self):
        super().__init__("org.orbit_os.Optimizer", lambda app: OptimizerWindow(app))
        self.connect("startup", lambda *_: ui.add_shortcuts(self, {"win.scan": ["F5"]}))


def main():
    return OptimizerApp().run_main()
