"""Orbit Games — set up gaming once, then launch everything from one place.

"Library" lists installed games and game stores (Steam, Lutris, Heroic …) with
a Play button and the Game Mode switch. "Setup" shows what is ready (32-bit
support, Steam, GameMode, MangoHud, graphics drivers), installs the missing
parts through pkexec and orbit-games-helper, and gives the Steam launch options.
"""
import subprocess

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Adw", "1")
from gi.repository import Adw, Gio, GLib, Gtk  # noqa: E402

from . import games, ui  # noqa: E402

READY_ROWS = [("32bit", "32-bit support", "Steam and most Windows games need it"),
              ("steam", "Steam", "Valve’s store, with Proton for Windows games"),
              ("gamemode", "GameMode", "Gives the game priority while it runs"),
              ("mangohud", "MangoHud", "FPS and temperature overlay (Shift+F12 toggles it)")]


class GamesWindow(Adw.ApplicationWindow):
    def __init__(self, app):
        super().__init__(application=app, title="Games", default_width=820, default_height=740)
        self._toasts = Adw.ToastOverlay()
        self.stack = Adw.ViewStack()
        switcher = Adw.ViewSwitcher(stack=self.stack, policy=Adw.ViewSwitcherPolicy.WIDE)
        hb = Adw.HeaderBar(title_widget=switcher)
        hb.pack_start(Gtk.Button(icon_name="view-refresh-symbolic", tooltip_text="Refresh (F5)",
                                 action_name="win.refresh"))
        menu = Gio.Menu()
        menu.append("Get More Games…", "win.store")
        menu.append("About Orbit Games", "win.about")
        hb.pack_end(Gtk.MenuButton(icon_name="open-menu-symbolic", menu_model=menu))

        # library
        lib = Adw.PreferencesPage()
        mode = Adw.PreferencesGroup()
        self.mode_row = Adw.SwitchRow(title="Game Mode", active=games.game_mode_on(),
                                      subtitle="Performance power mode, notifications held back, "
                                               "background jobs paused")
        self.mode_row.add_prefix(Gtk.Image(icon_name="input-gaming-symbolic"))
        self.mode_row.connect("notify::active", self._toggle_mode)
        mode.add(self.mode_row)
        lib.add(mode)
        self.stores = Adw.PreferencesGroup(title="Stores and launchers")
        self.list = Adw.PreferencesGroup(title="Your games")
        lib.add(self.stores)
        lib.add(self.list)
        self._lib_rows = []
        self.stack.add_titled_with_icon(lib, "library", "Library", "input-gaming-symbolic")

        # setup
        setup = Adw.PreferencesPage()
        self.ready_group = Adw.PreferencesGroup(title="Ready to play?")
        self.setup_btn = Gtk.Button(label="Set Up Gaming", css_classes=["suggested-action", "pill"],
                                    valign=Gtk.Align.CENTER)
        self.setup_btn.connect("clicked", lambda *_: self._ask_setup())
        self.ready_group.set_header_suffix(self.setup_btn)
        self.ready_rows = {}
        for key, title, sub in READY_ROWS:
            row = Adw.ActionRow(title=title, subtitle=sub)
            self.ready_rows[key] = (row, Gtk.Image())
            row.add_suffix(self.ready_rows[key][1])
            self.ready_group.add(row)
        setup.add(self.ready_group)
        self.gpu_group = Adw.PreferencesGroup(title="Graphics")
        self.gpu_row = Adw.ActionRow(title="Graphics card")
        self.gpu_row.set_subtitle_lines(4)
        self.gpu_row.add_prefix(Gtk.Image(icon_name="video-display-symbolic"))
        self.gpu_group.add(self.gpu_row)
        setup.add(self.gpu_group)
        tips = Adw.PreferencesGroup(title="In Steam")
        self.opts = Adw.ActionRow(title="Launch options", subtitle="", subtitle_selectable=True)
        self.opts.set_subtitle_lines(2)
        copy = Gtk.Button(icon_name="edit-copy-symbolic", tooltip_text="Copy", valign=Gtk.Align.CENTER,
                          css_classes=["flat"])
        copy.connect("clicked", lambda *_: (self.get_display().get_clipboard().set(self.opts.get_subtitle()),
                                            ui.toast(self, "Copied: paste it in a game’s Properties → Launch Options")))
        self.opts.add_suffix(copy)
        tips.add(self.opts)
        proton = Adw.ActionRow(title="Play Windows games",
                               subtitle="Steam → Settings → Compatibility → turn on “Enable Steam Play for all "
                                        "other titles”.")
        proton.set_subtitle_lines(3)
        tips.add(proton)
        setup.add(tips)
        self.stack.add_titled_with_icon(setup, "setup", "Setup", "emblem-system-symbolic")

        tv = Adw.ToolbarView(content=self.stack)
        tv.add_top_bar(hb)
        bar = Adw.ViewSwitcherBar(stack=self.stack)
        tv.add_bottom_bar(bar)
        bp = Adw.Breakpoint.new(Adw.BreakpointCondition.parse("max-width: 560sp"))
        bp.add_setter(bar, "reveal", True)
        bp.add_setter(hb, "title-widget", Adw.WindowTitle(title="Games"))
        self.add_breakpoint(bp)
        self._toasts.set_child(tv)
        self.set_content(self._toasts)
        for name, cb in {"refresh": self.refresh, "store": lambda: ui.spawn(["orbit-store"]),
                         "about": lambda: ui.about(self, "Orbit Games", "orbit-games",
                                                   "Set up gaming and launch your games.")}.items():
            a = Gio.SimpleAction.new(name, None)
            a.connect("activate", lambda *_a, cb=cb: cb())
            self.add_action(a)
        self.refresh()

    def refresh(self):
        self._fill_library(games.library())
        state = games.ready()
        for key, (row, img) in self.ready_rows.items():
            ok = state[key]
            img.set_from_icon_name("emblem-ok-symbolic" if ok else "list-remove-symbolic")
            img.set_css_classes(["orbit-ok"] if ok else ["dim-label"])
        self.setup_btn.set_visible(not all(state.values()))
        if all(state.values()):
            self.ready_group.set_description("Everything is installed.")
        else:
            self.ready_group.set_description("One click installs the missing parts. Asks for your password.")
        self.opts.set_subtitle(games.launch_options(state))
        cards = games.gpus()
        self.gpu_row.set_title(" + ".join(cards) if cards else "Graphics card")
        if "NVIDIA" in cards and not games.nvidia_driver_loaded():
            self.gpu_row.set_subtitle("Running on the open NVIDIA driver, which is slower in games. NVIDIA’s own "
                                      "driver isn’t part of Orbit yet.")
        elif cards:
            self.gpu_row.set_subtitle("Drivers are built in and kept up to date by Orbit updates.")
        else:
            self.gpu_row.set_subtitle("No graphics card found.")

    def _fill_library(self, items):
        for grp, row in self._lib_rows:
            grp.remove(row)
        self._lib_rows = []
        for g in items:
            grp = self.stores if g["launcher"] else self.list
            row = Adw.ActionRow(title=GLib.markup_escape_text(g["name"]),
                                subtitle=GLib.markup_escape_text(g["comment"]))
            row.add_prefix(Gtk.Image(icon_name=g["icon"], pixel_size=40))
            play = Gtk.Button(label="Open" if g["launcher"] else "Play", valign=Gtk.Align.CENTER,
                              css_classes=["pill"] + ([] if g["launcher"] else ["suggested-action"]))
            play.connect("clicked", lambda *_b, gid=g["id"]: self._launch(gid))
            row.add_suffix(play)
            grp.add(row)
            self._lib_rows.append((grp, row))
        if not any(not g["launcher"] for g in items):
            row = Adw.ActionRow(title="No games yet",
                                subtitle="Install Steam on the Setup page, or get games from the Store.")
            self.list.add(row)
            self._lib_rows.append((self.list, row))
        self.stores.set_visible(any(g["launcher"] for g in items))

    def _launch(self, gid):
        info = Gio.DesktopAppInfo.new(gid)
        if info is None or not info.launch([], None):
            ui.toast(self, "Couldn’t start it")

    def _toggle_mode(self, row, _pspec):
        on = row.get_active()
        ui.run_async(lambda: games.set_game_mode(on),
                     lambda changed: ui.toast(self, ("Game Mode on: " if on else "Game Mode off: ") + ", ".join(changed)
                                              if changed else "Game Mode was already on", 4))

    def _ask_setup(self):
        d = Adw.AlertDialog(heading="Set up gaming?",
                            body="Orbit turns on 32-bit support and installs Steam, the 32-bit graphics drivers, "
                                 "GameMode and MangoHud (about 1 GB). Installing Steam means you accept Valve’s "
                                 "Steam Subscriber Agreement.")
        d.add_response("cancel", "Cancel")
        d.add_response("ok", "Accept and Install")
        d.set_response_appearance("ok", Adw.ResponseAppearance.SUGGESTED)
        d.connect("response", lambda _d, r: self._setup() if r == "ok" else None)
        d.present(self)

    def _setup(self):
        self.setup_btn.set_sensitive(False)
        self.setup_btn.set_label("Installing…")

        def done(rc):
            self.setup_btn.set_sensitive(True)
            self.setup_btn.set_label("Set Up Gaming")
            ui.toast(self, "Gaming is set up. Open Steam to sign in." if rc == 0 else
                     "Setup didn’t finish. Check the internet connection and try again.", 5)
            self.refresh()
        ui.run_async(lambda: subprocess.run(games.setup_argv(), capture_output=True).returncode, done,
                     lambda e: done(1))


class GamesApp(ui.OrbitApp):
    def __init__(self):
        super().__init__("org.orbit_os.Games", lambda app: GamesWindow(app))
        self.connect("startup", lambda *_: ui.add_shortcuts(self, {"win.refresh": ["F5"]}))


def main():
    return GamesApp().run_main()
