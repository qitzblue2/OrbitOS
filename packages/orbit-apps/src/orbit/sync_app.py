"""Orbit Sync — keep Notes, Documents and other folders the same on all your PCs.

Turning it on starts Syncthing for this user (systemd user service). Pairing
is: copy this PC's sync ID, add it on the other PC; this PC then shows "wants
to pair" with an Accept button. Files deleted or replaced by another PC are
kept in the folder's .stversions for 30 days.
"""
import shutil
import subprocess

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Adw", "1")
from gi.repository import Adw, Gio, GLib, Gtk  # noqa: E402

from . import sync, ui  # noqa: E402

SERVICE = "syncthing.service"


def service(action):
    return subprocess.run(["systemctl", "--user", action, *(["--now"] if action in ("enable", "disable") else []),
                           SERVICE], capture_output=True, text=True)


def running():
    return service("is-active").stdout.strip() == "active"


class SyncWindow(Adw.ApplicationWindow):
    def __init__(self, app):
        super().__init__(application=app, title="Orbit Sync", default_width=740, default_height=720)
        self._toasts = Adw.ToastOverlay()
        self.client = None
        hb = Adw.HeaderBar()
        self.add_btn = Gtk.Button(label="Add PC…", action_name="win.add-pc")
        hb.pack_start(self.add_btn)
        menu = Gio.Menu()
        menu.append("Refresh", "win.refresh")
        menu.append("About Orbit Sync", "win.about")
        hb.pack_end(Gtk.MenuButton(icon_name="open-menu-symbolic", menu_model=menu))

        self.stack = Gtk.Stack(transition_type=Gtk.StackTransitionType.CROSSFADE)
        missing = Adw.StatusPage(icon_name="orbit-sync", title="Sync isn’t installed",
                                 description="Run Orbit Updater: the next update installs it.")
        self.stack.add_named(missing, "missing")

        page = Adw.PreferencesPage()
        top = Adw.PreferencesGroup()
        self.switch = Adw.SwitchRow(title="Sync this PC")
        self.switch.add_prefix(Gtk.Image(icon_name="emblem-synchronizing-symbolic"))
        self._sw = self.switch.connect("notify::active", self._toggle)
        top.add(self.switch)
        self.id_row = Adw.ActionRow(title="This PC’s sync ID", subtitle_selectable=True)
        self.id_row.add_css_class("property")
        self.id_row.set_subtitle_lines(2)
        copy = Gtk.Button(icon_name="edit-copy-symbolic", tooltip_text="Copy", valign=Gtk.Align.CENTER,
                          css_classes=["flat"])
        copy.connect("clicked", lambda *_: (self.get_display().get_clipboard().set(self.id_row.get_subtitle()),
                                            ui.toast(self, "Copied. On the other PC: Orbit Sync → Add PC…")))
        self.id_row.add_suffix(copy)
        top.add(self.id_row)
        page.add(top)

        self.pending = Adw.PreferencesGroup(title="Wants to pair")
        self.pcs = Adw.PreferencesGroup(title="Your other PCs")
        self.items = Adw.PreferencesGroup(title="What to sync",
                                          description="Turn on the same folders on each PC. Files another PC "
                                                      "deleted or replaced are kept for 30 days in the "
                                                      "folder’s .stversions.")
        self.item_rows = {}
        for iid, label, folder, icon in sync.ITEMS:
            row = Adw.SwitchRow(title=label, subtitle=f"~/Home/{folder}")
            row.add_prefix(Gtk.Image(icon_name=icon))
            row._h = row.connect("notify::active", self._item, iid)
            self.items.add(row)
            self.item_rows[iid] = row
        for g in (self.pending, self.pcs, self.items):
            page.add(g)
        how = Adw.PreferencesGroup(
            description="PCs connect to each other directly, encrypted. There is no account and no server "
                        "that can read your files. When they aren’t on the same network, Syncthing’s relays "
                        "pass the encrypted data along.")
        page.add(how)
        self._dyn = []
        self.stack.add_named(page, "main")

        tv = Adw.ToolbarView(content=self.stack)
        tv.add_top_bar(hb)
        self._toasts.set_child(tv)
        self.set_content(self._toasts)
        for name, cb in {"add-pc": self.ask_add, "refresh": self.refresh,
                         "about": lambda: ui.about(self, "Orbit Sync", "orbit-sync",
                                                   "Keep your folders the same on all your PCs.")}.items():
            a = Gio.SimpleAction.new(name, None)
            a.connect("activate", lambda *_a, cb=cb: cb())
            self.add_action(a)
        self.refresh()
        self._timer = GLib.timeout_add_seconds(5, lambda: (self.refresh(quiet=True), True)[1])
        self.connect("close-request", lambda *_: (GLib.source_remove(self._timer), False)[1])

    # ---- state
    def refresh(self, quiet=False):
        if shutil.which("syncthing") is None:
            self.stack.set_visible_child_name("missing")
            self.add_btn.set_visible(False)
            return
        self.stack.set_visible_child_name("main")
        on = running()
        self._set_switch(on)
        self.add_btn.set_sensitive(on)
        for w in (self.id_row, self.pending, self.pcs, self.items):
            w.set_visible(on)
        if not on:
            self.switch.set_subtitle("Off")
            return

        def load():
            c = sync.Client()
            me = c.my_id()
            return c, me, c.devices(me), c.pending(), c.enabled_items(), c.status()

        def show(res):
            self.client, me, devices, pending, enabled, status = res
            self.id_row.set_subtitle(me)
            connected = sum(d["connected"] for d in devices)
            self.switch.set_subtitle(("Syncing…" if status == "syncing" else "Up to date")
                                     + (f" · {connected} of {len(devices)} PCs online" if devices else
                                        " · no other PCs yet"))
            self._fill(devices, pending)
            for iid, row in self.item_rows.items():
                row.handler_block(row._h)
                row.set_active(iid in enabled)
                row.handler_unblock(row._h)

        def fail(e):
            self.switch.set_subtitle("Starting…")
            if not quiet:
                GLib.timeout_add_seconds(2, lambda: (self.refresh(quiet=True), False)[1])
        ui.run_async(load, show, fail)

    def _set_switch(self, on):
        self.switch.handler_block(self._sw)
        self.switch.set_active(on)
        self.switch.handler_unblock(self._sw)

    def _fill(self, devices, pending):
        for grp, row in self._dyn:
            grp.remove(row)
        self._dyn = []
        self.pending.set_visible(bool(pending))
        for p in pending:
            row = Adw.ActionRow(title=GLib.markup_escape_text(p["name"]),
                                subtitle=GLib.markup_escape_text(p["id"][:15] + "…"))
            row.add_prefix(Gtk.Image(icon_name="computer-symbolic"))
            yes = Gtk.Button(label="Accept", css_classes=["suggested-action"], valign=Gtk.Align.CENTER)
            yes.connect("clicked", lambda *_b, p=p: self._do(lambda c: c.add_device(p["id"], p["name"]),
                                                             f"Paired with {p['name']}"))
            no = Gtk.Button(label="Ignore", valign=Gtk.Align.CENTER, css_classes=["flat"])
            no.connect("clicked", lambda *_b, p=p: self._do(lambda c: c.ignore_pending(p["id"]), "Ignored"))
            row.add_suffix(no)
            row.add_suffix(yes)
            self.pending.add(row)
            self._dyn.append((self.pending, row))
        for d in devices:
            row = Adw.ActionRow(title=GLib.markup_escape_text(d["name"]),
                                subtitle="Online" if d["connected"] else "Offline")
            row.add_prefix(Gtk.Image(icon_name="computer-symbolic",
                                     css_classes=["orbit-ok"] if d["connected"] else ["dim-label"]))
            rm = Gtk.Button(icon_name="user-trash-symbolic", tooltip_text="Stop syncing with this PC",
                            valign=Gtk.Align.CENTER, css_classes=["flat"])
            rm.connect("clicked", lambda *_b, d=d: ui.confirm(
                self, f"Stop syncing with {d['name']}?", "Files already on both PCs stay where they are.",
                "Stop", lambda: self._do(lambda c: c.remove_device(d["id"]), "Removed")))
            row.add_suffix(rm)
            self.pcs.add(row)
            self._dyn.append((self.pcs, row))
        if not devices:
            row = Adw.ActionRow(title="No other PCs yet",
                                subtitle="Copy this PC’s sync ID above, then on the other PC: Add PC… and "
                                         "paste it.")
            row.set_subtitle_lines(3)
            self.pcs.add(row)
            self._dyn.append((self.pcs, row))

    # ---- actions
    def _do(self, fn, ok_text):
        def done(_):
            ui.toast(self, ok_text, 2)
            self.refresh(quiet=True)
        ui.run_async(lambda: fn(self.client or sync.Client()), done,
                     lambda e: ui.toast(self, str(e), 4))

    def _toggle(self, row, _pspec):
        on = row.get_active()
        self.switch.set_subtitle("Starting…" if on else "Stopping…")
        ui.run_async(lambda: service("enable" if on else "disable"),
                     lambda _r: GLib.timeout_add(1500, lambda: (self.refresh(), False)[1]))

    def _item(self, row, _pspec, iid):
        self._do(lambda c: c.set_item(iid, row.get_active()),
                 ("Syncing " if row.get_active() else "Stopped syncing ") + row.get_title())

    def ask_add(self):
        d = Adw.AlertDialog(heading="Add a PC",
                            body="On the other PC open Orbit Sync, copy its sync ID and paste it here.")
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
        eid = Gtk.Entry(placeholder_text="Sync ID (XXXXXXX-XXXXXXX-…)")
        name = Gtk.Entry(placeholder_text="Name, e.g. Laptop", activates_default=True)
        box.append(eid)
        box.append(name)
        d.set_extra_child(box)
        d.add_response("cancel", "Cancel")
        d.add_response("ok", "Add")
        d.set_response_appearance("ok", Adw.ResponseAppearance.SUGGESTED)
        d.set_default_response("ok")

        def resp(_d, r):
            if r != "ok":
                return
            if not sync.normalize_id(eid.get_text()):
                ui.toast(self, "That doesn’t look like a sync ID", 3)
                return
            nm = name.get_text().strip() or "Orbit PC"
            self._do(lambda c: c.add_device(eid.get_text(), nm),
                     f"Added {nm}. Accept it on that PC too.")
        d.connect("response", resp)
        d.present(self)


class SyncApp(ui.OrbitApp):
    def __init__(self):
        super().__init__("org.orbit_os.Sync", lambda app: SyncWindow(app))


def main():
    return SyncApp().run_main()
