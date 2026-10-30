"""Orbit Sharing — share folders with Windows PCs on your network.

One switch turns sharing on (it asks for a sharing password, which is what a
Windows PC asks for together with your user name). Folders are added from
your home only, read-only unless you allow changes. `orbit-sharing FOLDER`
(used by Files) opens the window with that folder ready to add.
"""
import json
import os
import pwd
import socket
import subprocess

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Adw", "1")
from gi.repository import Adw, Gio, GLib, Gtk  # noqa: E402

from . import paths, sharing, ui  # noqa: E402


def sharing_active():
    r = subprocess.run(["systemctl", "is-active", "smbd.service"], capture_output=True, text=True)
    return r.stdout.strip() == "active"


def helper(cmd, stdin=""):
    r = subprocess.run(["pkexec", sharing.HELPER, cmd], input=stdin, capture_output=True, text=True)
    return r.returncode, (r.stderr.strip().splitlines() or [""])[-1]


class SharingWindow(Adw.ApplicationWindow):
    def __init__(self, app):
        super().__init__(application=app, title="Sharing", default_width=720, default_height=640)
        self._toasts = Adw.ToastOverlay()
        self.user = pwd.getpwuid(os.getuid()).pw_name
        self.shares = sharing.load()
        hb = Adw.HeaderBar()
        add = Gtk.Button(icon_name="list-add-symbolic", tooltip_text="Share a folder", action_name="win.add")
        hb.pack_start(add)
        menu = Gio.Menu()
        menu.append("About Orbit Sharing", "win.about")
        hb.pack_end(Gtk.MenuButton(icon_name="open-menu-symbolic", menu_model=menu))

        page = Adw.PreferencesPage()
        top = Adw.PreferencesGroup()
        self.switch = Adw.SwitchRow(title="Share with Windows PCs",
                                    subtitle="Off: nothing on this PC can be reached from the network")
        self.switch.add_prefix(Gtk.Image(icon_name="network-workgroup-symbolic"))
        self._switch_handler = self.switch.connect("notify::active", self._toggle)
        top.add(self.switch)
        page.add(top)

        self.how = Adw.PreferencesGroup(title="On the Windows PC")
        host = socket.gethostname()
        for title, value in (("In File Explorer, type", f"\\\\{host}"), ("User name", self.user),
                             ("Password", "your sharing password")):
            row = Adw.ActionRow(title=title, subtitle=GLib.markup_escape_text(value), subtitle_selectable=True)
            row.add_css_class("property")
            self.how.add(row)
        page.add(self.how)

        self.list = Adw.PreferencesGroup(title="Shared folders",
                                         description="Only folders in your home can be shared. Hidden files are "
                                                     "never shared.")
        self._rows = []
        page.add(self.list)

        tv = Adw.ToolbarView(content=page)
        tv.add_top_bar(hb)
        self._toasts.set_child(tv)
        self.set_content(self._toasts)
        for name, cb in {"add": self.pick,
                         "about": lambda: ui.about(self, "Orbit Sharing", "orbit-sharing",
                                                   "Share folders with Windows PCs.")}.items():
            a = Gio.SimpleAction.new(name, None)
            a.connect("activate", lambda *_a, cb=cb: cb())
            self.add_action(a)
        self._set_switch(sharing_active())
        self.fill()

    # ---- switch
    def _set_switch(self, on):
        self.switch.handler_block(self._switch_handler)
        self.switch.set_active(on)
        self.switch.handler_unblock(self._switch_handler)
        self.how.set_visible(on)
        self.switch.set_subtitle("On: the folders below can be opened from Windows PCs on this network" if on
                                 else "Off: nothing on this PC can be reached from the network")

    def _toggle(self, row, _pspec):
        if row.get_active():
            self._ask_password()
        else:
            ui.run_async(lambda: helper("off"), lambda r: self._after("off", r))

    def _ask_password(self):
        d = Adw.AlertDialog(heading="Choose a sharing password",
                            body=f"Windows PCs ask for it, with the user name “{self.user}”. "
                                 "At least 8 characters. It can differ from your login password.")
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
        e1 = Gtk.PasswordEntry(show_peek_icon=True, placeholder_text="Sharing password")
        e2 = Gtk.PasswordEntry(show_peek_icon=True, placeholder_text="Again", activates_default=True)
        box.append(e1)
        box.append(e2)
        d.set_extra_child(box)
        d.add_response("cancel", "Cancel")
        d.add_response("ok", "Turn On")
        d.set_response_appearance("ok", Adw.ResponseAppearance.SUGGESTED)
        d.set_default_response("ok")

        def resp(_d, r):
            pw, again = e1.get_text(), e2.get_text()
            if r != "ok":
                self._set_switch(False)
            elif pw != again:
                ui.toast(self, "The two passwords are different")
                self._set_switch(False)
            elif not sharing.password_ok(pw):
                ui.toast(self, "Use at least 8 characters")
                self._set_switch(False)
            else:
                ui.run_async(lambda: self._turn_on(pw), lambda r: self._after("on", r))
        d.connect("response", resp)
        d.present(self)

    def _turn_on(self, pw):
        rc, err = helper("on", pw + "\n")
        if rc == 0:
            rc, err = helper("apply", json.dumps(self.shares))
        return rc, err

    def _after(self, what, res):
        rc, err = res
        if rc != 0:
            ui.toast(self, f"Couldn’t change sharing: {err or 'cancelled'}", 5)
        self._set_switch(sharing_active())
        if rc == 0:
            ui.toast(self, "Sharing is on" if what == "on" else "Sharing is off", 2)

    # ---- folders
    def fill(self):
        for r in self._rows:
            self.list.remove(r)
        self._rows = []
        for s in self.shares:
            row = Adw.ActionRow(title=GLib.markup_escape_text(s["name"]),
                                subtitle=GLib.markup_escape_text(s["path"].replace(str(paths.HOME), "~", 1)))
            row.add_prefix(Gtk.Image(icon_name="folder-remote-symbolic"))
            mode = Gtk.DropDown.new_from_strings(["Read only", "Can change"])
            mode.set_selected(1 if s["writable"] else 0)
            mode.set_valign(Gtk.Align.CENTER)
            mode.connect("notify::selected", self._mode, s)
            row.add_suffix(mode)
            rm = Gtk.Button(icon_name="user-trash-symbolic", tooltip_text="Stop sharing", valign=Gtk.Align.CENTER,
                            css_classes=["flat"])
            rm.connect("clicked", lambda *_b, s=s: self._remove(s))
            row.add_suffix(rm)
            self.list.add(row)
            self._rows.append(row)
        if not self.shares:
            row = Adw.ActionRow(title="No shared folders", subtitle="Press + to share one.")
            self.list.add(row)
            self._rows.append(row)

    def pick(self):
        dlg = Gtk.FileDialog(title="Share a Folder",
                             initial_folder=Gio.File.new_for_path(str(paths.orbit_home())))

        def done(d, res):
            try:
                f = d.select_folder_finish(res)
            except GLib.Error:
                return
            self.add_path(f.get_path())
        dlg.select_folder(self, None, done)

    def add_path(self, path):
        new = self.shares + [{"name": sharing.suggest_name(path, [s["name"] for s in self.shares]),
                              "path": path, "writable": False}]
        self._commit(new)

    def _mode(self, dd, _pspec, s):
        new = [dict(x, writable=dd.get_selected() == 1) if x is s else x for x in self.shares]
        self._commit(new)

    def _remove(self, s):
        self._commit([x for x in self.shares if x is not s])

    def _commit(self, new):
        try:
            new = sharing.validate(new, paths.HOME)
        except sharing.ShareError as e:
            ui.toast(self, str(e), 5)
            self.fill()
            return
        self.shares = new
        sharing.save(new)
        self.fill()
        if sharing_active():
            ui.run_async(lambda: helper("apply", json.dumps(new)),
                         lambda r: ui.toast(self, "Updated" if r[0] == 0 else f"Couldn’t update: {r[1]}", 2))


class SharingApp(ui.OrbitApp):
    def __init__(self):
        super().__init__("org.orbit_os.Sharing", lambda app: SharingWindow(app),
                         flags=Gio.ApplicationFlags.HANDLES_OPEN)
        self.connect("open", self._open)

    def _open(self, _app, files, _n, _hint):
        win = self.props.active_window or SharingWindow(self)
        win.present()
        for f in files:
            if f.get_path() and os.path.isdir(f.get_path()):
                win.add_path(f.get_path())


def main():
    return SharingApp().run_main()
