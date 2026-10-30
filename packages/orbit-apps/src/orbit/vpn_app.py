"""Orbit VPN — connect to your own WireGuard server (tools/orbit-vpn-server.sh).

Import the device config once (file, or paste it); after that one switch
connects. All traffic then goes through your server, and the window shows the
address websites see. `orbit-vpn FILE.conf` (double-click) opens the import.
"""
import pathlib

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Adw", "1")
from gi.repository import Adw, Gio, GLib, Gtk  # noqa: E402

from . import ui, vpn  # noqa: E402

SERVER_STEPS = [
    ("1. On your VPS", "git clone https://github.com/qitzblue2/OrbitOS && cd OrbitOS"),
    ("2. Set up the server (once)", "sudo ./tools/orbit-vpn-server.sh setup"),
    ("3. Make a config for this laptop", "sudo ./tools/orbit-vpn-server.sh add laptop"),
    ("4. Copy it here (run on this laptop)", "scp root@YOUR-VPS:/etc/wireguard/orbit-clients/laptop.conf ~/Downloads/"),
]


class VpnWindow(Adw.ApplicationWindow):
    def __init__(self, app):
        super().__init__(application=app, title="VPN", default_width=720, default_height=680)
        self._toasts = Adw.ToastOverlay()
        hb = Adw.HeaderBar()
        hb.pack_start(Gtk.Button(label="Import Config…", action_name="win.import"))
        menu = Gio.Menu()
        menu.append("Paste a Config…", "win.paste")
        menu.append("About Orbit VPN", "win.about")
        hb.pack_end(Gtk.MenuButton(icon_name="open-menu-symbolic", menu_model=menu))

        page = Adw.PreferencesPage()
        head = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6, margin_bottom=12)
        self.icon = Gtk.Image(icon_name="orbit-vpn", pixel_size=64)
        self.title = Gtk.Label(css_classes=["title-1"])
        self.desc = Gtk.Label(css_classes=["dim-label"], wrap=True, justify=Gtk.Justification.CENTER)
        for w in (self.icon, self.title, self.desc):
            head.append(w)
        g = Adw.PreferencesGroup()
        g.add(head)
        page.add(g)
        self.list = Adw.PreferencesGroup(title="Your VPNs")
        self._rows = []
        page.add(self.list)
        self.help = Adw.PreferencesGroup(
            title="Set up your server",
            description="Your VPS runs WireGuard; each device gets its own key, and removing one never affects "
                        "the others.")
        for title, cmd in SERVER_STEPS:
            row = Adw.ActionRow(title=title, subtitle=GLib.markup_escape_text(cmd), subtitle_selectable=True)
            row.add_css_class("property")
            copy = Gtk.Button(icon_name="edit-copy-symbolic", tooltip_text="Copy", valign=Gtk.Align.CENTER,
                              css_classes=["flat"])
            copy.connect("clicked", lambda *_b, c=cmd: (self.get_display().get_clipboard().set(c),
                                                        ui.toast(self, "Copied", 1)))
            row.add_suffix(copy)
            self.help.add(row)
        page.add(self.help)

        tv = Adw.ToolbarView(content=page)
        tv.add_top_bar(hb)
        self._toasts.set_child(tv)
        self.set_content(self._toasts)
        for name, cb in {"import": self.pick, "paste": self.ask_paste,
                         "about": lambda: ui.about(self, "Orbit VPN", "orbit-vpn",
                                                   "Your own VPN through your own server.")}.items():
            a = Gio.SimpleAction.new(name, None)
            a.connect("activate", lambda *_a, cb=cb: cb())
            self.add_action(a)
        self.refresh()
        self._timer = GLib.timeout_add_seconds(5, lambda: (self.refresh(), True)[1])
        self.connect("close-request", lambda *_: (GLib.source_remove(self._timer), False)[1])

    # ---- state
    def refresh(self):
        ui.run_async(lambda: [dict(c, auto=vpn.autoconnect(c["name"])) for c in vpn.connections()], self._show,
                     lambda e: self._show([]))

    def _show(self, conns):
        key = [(c["name"], c["active"], c["auto"]) for c in conns]
        if key == getattr(self, "_key", None):
            return  # nothing changed: keep open rows open, don't ask for the address again
        self._key = key
        for r in self._rows:
            self.list.remove(r)
        self._rows = []
        active = [c for c in conns if c["active"]]
        self.help.set_visible(not conns)
        self.list.set_visible(bool(conns))
        if active:
            self.title.set_label("Connected")
            self.icon.set_css_classes(["orbit-ok"])
            self.desc.set_label("Your traffic goes through your server.")
            ui.run_async(vpn.public_ip, lambda ip: self.desc.set_label(
                f"Your traffic goes through your server. Websites see {ip}.") if ip and self._key == key else None)
        else:
            self.title.set_label("Not connected" if conns else "No VPN yet")
            self.icon.set_css_classes([])
            self.desc.set_label("Turn a VPN on below." if conns else
                                "Set up your server (below), then Import Config… on this laptop.")
        for c in conns:
            exp = Adw.ExpanderRow(title=GLib.markup_escape_text(c["name"]),
                                  subtitle="Connected" if c["active"] else "Off")
            exp.add_prefix(Gtk.Image(icon_name="network-vpn-symbolic"))
            sw = Gtk.Switch(active=c["active"], valign=Gtk.Align.CENTER)
            sw.connect("state-set", self._switch, c["name"])
            exp.add_suffix(sw)
            auto = Adw.SwitchRow(title="Connect automatically", subtitle="When this PC goes online",
                                 active=c["auto"])
            auto.connect("notify::active", lambda r, _p, n=c["name"]: self._do(
                lambda: vpn.set_autoconnect(n, r.get_active()), None))
            exp.add_row(auto)
            rm = Adw.ActionRow(title="Remove this VPN", activatable=True)
            rm.add_prefix(Gtk.Image(icon_name="user-trash-symbolic"))
            rm.connect("activated", lambda *_r, n=c["name"]: ui.confirm(
                self, f"Remove {n}?", "You’ll need its config file to add it again.", "Remove",
                lambda: self._do(lambda: vpn.delete(n), "Removed")))
            exp.add_row(rm)
            self.list.add(exp)
            self._rows.append(exp)

    def _switch(self, _sw, on, name):
        self._key = None
        self.title.set_label("Connecting…" if on else "Disconnecting…")
        self._do(lambda: (vpn.up if on else vpn.down)(name), "Connected" if on else "Disconnected")
        return False

    def _do(self, fn, ok_text):
        def done(_):
            self._key = None
            if ok_text:
                ui.toast(self, ok_text, 2)
            self.refresh()
        ui.run_async(fn, done, lambda e: (ui.toast(self, f"Couldn’t do that: {e}", 5), self.refresh()))

    # ---- import
    def pick(self):
        flt = Gtk.FileFilter(name="WireGuard configs")
        flt.add_pattern("*.conf")
        store = Gio.ListStore.new(Gtk.FileFilter)
        store.append(flt)
        dlg = Gtk.FileDialog(title="Import a VPN Config", filters=store, default_filter=flt)

        def done(d, res):
            try:
                f = d.open_finish(res)
            except GLib.Error:
                return
            self.import_file(f.get_path())
        dlg.open(self, None, done)

    def import_file(self, path):
        try:
            text = pathlib.Path(path).read_text()
        except (OSError, UnicodeDecodeError) as e:
            ui.toast(self, f"Couldn’t read it: {e}")
            return
        self._import(text, pathlib.Path(path).stem)

    def ask_paste(self):
        d = Adw.AlertDialog(heading="Paste a VPN Config",
                            body="Paste the whole config from orbit-vpn-server.sh add (from [Interface] to the end).")
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
        name = Gtk.Entry(text="vps", placeholder_text="Name")
        tv = Gtk.TextView(monospace=True, wrap_mode=Gtk.WrapMode.CHAR, height_request=180)
        box.append(name)
        box.append(Gtk.ScrolledWindow(child=tv, min_content_height=180))
        d.set_extra_child(box)
        d.add_response("cancel", "Cancel")
        d.add_response("ok", "Import")
        d.set_response_appearance("ok", Adw.ResponseAppearance.SUGGESTED)
        d.connect("response", lambda _d, r: self._import(tv.get_buffer().props.text, name.get_text())
                  if r == "ok" else None)
        d.present(self)

    def _import(self, text, name):
        try:
            info = vpn.parse_conf(text)
        except vpn.VpnError as e:
            ui.toast(self, str(e), 5)
            return
        nm = vpn.clean_name(name)
        warn = "" if info["full_tunnel"] else " (only some traffic goes through it)"
        self._do(lambda: vpn.import_conf(text, nm), f"Added {nm} → {info['endpoint']}{warn}. Switch it on to connect.")


class VpnApp(ui.OrbitApp):
    def __init__(self):
        super().__init__("org.orbit_os.Vpn", lambda app: VpnWindow(app), flags=Gio.ApplicationFlags.HANDLES_OPEN)
        self.connect("open", self._open)

    def _open(self, _app, files, _n, _hint):
        win = self.props.active_window or VpnWindow(self)
        win.present()
        for f in files:
            if f.get_path():
                win.import_file(f.get_path())


def main():
    return VpnApp().run_main()
