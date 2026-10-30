"""Orbit Performance — what slows the computer down, and how fast it may run.

Reads CPU, memory and temperature every two seconds straight from /proc and
/sys (no daemon), lists the heaviest of your apps with a Quit button, gives
plain-language tips, and switches the power mode through power-profiles-daemon.
"""
import os
import signal
import time

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Adw", "1")
from gi.repository import Adw, Gio, GLib, Gtk  # noqa: E402

from . import tune, ui  # noqa: E402

TIP_ICON = {"fail": ("dialog-error-symbolic", "orbit-fail"), "warn": ("dialog-warning-symbolic", "orbit-warn"),
            "info": ("dialog-information-symbolic", "dim-label")}
PROFILE_ICON = {"power-saver": "power-profile-power-saver-symbolic", "balanced": "power-profile-balanced-symbolic",
                "performance": "power-profile-performance-symbolic"}
INTERVAL = 2


class Meter(Adw.ActionRow):
    def __init__(self, title, icon):
        super().__init__(title=title)
        self.add_prefix(Gtk.Image(icon_name=icon))
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4, valign=Gtk.Align.CENTER, width_request=220)
        self.value = Gtk.Label(xalign=1, css_classes=["numeric"])
        self.bar = Gtk.LevelBar(min_value=0, max_value=1)
        self.bar.add_offset_value("orbit-high", 0.85)
        box.append(self.value)
        box.append(self.bar)
        self.add_suffix(box)

    def set(self, fraction, text):
        self.bar.set_value(max(0.0, min(1.0, fraction)))
        self.value.set_label(text)


class PerformanceWindow(Adw.ApplicationWindow):
    def __init__(self, app):
        super().__init__(application=app, title="Performance", default_width=760, default_height=780)
        self._toasts = Adw.ToastOverlay()
        hb = Adw.HeaderBar()
        menu = Gio.Menu()
        menu.append("Open Optimizer", "win.optimizer")
        menu.append("About Orbit Performance", "win.about")
        hb.pack_end(Gtk.MenuButton(icon_name="open-menu-symbolic", menu_model=menu))

        page = Adw.PreferencesPage()
        now = Adw.PreferencesGroup(title="Right now")
        self.cpu = Meter("Processor", "computer-symbolic")
        self.mem = Meter("Memory", "media-flash-symbolic")
        self.swap = Meter("Swap", "drive-harddisk-symbolic")
        self.temp = Meter("Temperature", "weather-clear-symbolic")
        for m in (self.cpu, self.mem, self.swap, self.temp):
            now.add(m)
        page.add(now)

        self.power = Adw.PreferencesGroup(title="Power mode")
        self._profile_btns = {}
        self._profile_rows = []
        page.add(self.power)

        self.tips = Adw.PreferencesGroup(title="Tips")
        self._tip_rows = []
        page.add(self.tips)

        self.apps = Adw.PreferencesGroup(title="Your heaviest apps",
                                         description="Quit closes the app the normal way, so it can save first.")
        self._app_rows = []
        page.add(self.apps)

        tv = Adw.ToolbarView(content=page)
        tv.add_top_bar(hb)
        self._toasts.set_child(tv)
        self.set_content(self._toasts)
        for name, cb in {"optimizer": lambda: ui.spawn(["orbit-optimizer"]),
                         "about": lambda: ui.about(self, "Orbit Performance", "orbit-performance",
                                                   "See what slows your computer down.")}.items():
            a = Gio.SimpleAction.new(name, None)
            a.connect("activate", lambda *_a, cb=cb: cb())
            self.add_action(a)

        self.uid = os.getuid()
        self.prev_cpu = tune.read_cpu()
        self.prev_procs = tune.read_processes(uid=self.uid)
        self.prev_t = time.monotonic()
        self.startup_on = sum(a["enabled"] for a in tune.autostart_apps())
        self.cleanable = 0
        ui.run_async(lambda: sum(t["size"] for t in tune.scan()), lambda n: setattr(self, "cleanable", n))
        ui.run_async(lambda: (tune.available_profiles(), tune.power_profile()), self._build_power)
        self._timer = GLib.timeout_add_seconds(INTERVAL, self.tick)
        self.connect("close-request", lambda *_: GLib.source_remove(self._timer) and False)
        GLib.timeout_add(300, lambda: self.tick() and False)

    # ---- power
    def _build_power(self, res):
        profiles, current = res
        if not profiles:
            self.power.set_description("Power modes aren’t available on this computer.")
            return
        group = None
        for pid, title, sub in profiles:
            row = Adw.ActionRow(title=title, subtitle=sub)
            row.add_prefix(Gtk.Image(icon_name=PROFILE_ICON[pid]))
            btn = Gtk.CheckButton(group=group, active=pid == current, valign=Gtk.Align.CENTER)
            group = group or btn
            btn.connect("toggled", self._set_profile, pid)
            row.add_suffix(btn)
            row.set_activatable_widget(btn)
            self.power.add(row)
            self._profile_btns[pid] = btn
        self.profile = current

    def _set_profile(self, btn, pid):
        if not btn.get_active() or pid == getattr(self, "profile", None):
            return

        def done(ok):
            if ok:
                self.profile = pid
                ui.toast(self, f"Power mode: {dict((p[0], p[1]) for p in tune.PROFILES)[pid]}", 2)
            else:
                ui.toast(self, "Couldn’t change the power mode")
                if self.profile in self._profile_btns:
                    self._profile_btns[self.profile].set_active(True)
        ui.run_async(lambda: tune.set_power_profile(pid), done)

    # ---- live numbers
    def tick(self):
        now = time.monotonic()
        cpu = tune.read_cpu()
        pct = tune.cpu_percent(self.prev_cpu, cpu)
        mem = tune.read_memory()
        temp = tune.read_temperature()
        procs = tune.read_processes(uid=self.uid)
        top = tune.top_apps(self.prev_procs, procs, now - self.prev_t, limit=8)
        self.prev_cpu, self.prev_procs, self.prev_t = cpu, procs, now

        self.cpu.set(pct / 100, f"{pct:.0f} %  ·  {os.cpu_count()} cores")
        self.mem.set(mem["used"] / mem["total"] if mem["total"] else 0,
                     f"{ui.human_size(mem['used'])} of {ui.human_size(mem['total'])}")
        if mem["swap_total"]:
            self.swap.set(mem["swap_used"] / mem["swap_total"],
                          f"{ui.human_size(mem['swap_used'])} of {ui.human_size(mem['swap_total'])}")
        else:
            self.swap.set(0, "none")
        self.temp.set_visible(temp is not None)
        if temp is not None:
            self.temp.set((temp - 30) / 70, f"{temp:.0f} °C")

        tips = tune.advice(mem, temp, pct, getattr(self, "profile", None), self.startup_on, self.cleanable)
        for r in self._tip_rows:
            self.tips.remove(r)
        self._tip_rows = []
        for level, text in tips or [("info", "Everything looks good.")]:
            row = Adw.ActionRow(title=GLib.markup_escape_text(text))
            row.set_title_lines(3)
            icon, cls = TIP_ICON[level] if tips else ("emblem-ok-symbolic", "orbit-ok")
            row.add_prefix(Gtk.Image(icon_name=icon, css_classes=[cls]))
            self.tips.add(row)
            self._tip_rows.append(row)

        for r in self._app_rows:
            self.apps.remove(r)
        self._app_rows = []
        for a in top:
            row = Adw.ActionRow(title=GLib.markup_escape_text(a["name"]),
                                subtitle=f"{a['cpu']:.0f} % processor · {ui.human_size(a['rss'])} memory"
                                         + (f" · {len(a['pids'])} processes" if len(a["pids"]) > 1 else ""))
            quit_btn = Gtk.Button(label="Quit", valign=Gtk.Align.CENTER, css_classes=["flat"])
            quit_btn.connect("clicked", self._quit, a)
            row.add_suffix(quit_btn)
            self.apps.add(row)
            self._app_rows.append(row)
        return True

    def _quit(self, _btn, app):
        ui.confirm(self, f"Quit {app['name']}?", "Unsaved work in it may be lost.", "Quit",
                   lambda: self._send_term(app))

    def _send_term(self, app):
        me = os.getpid()
        n = 0
        for pid in app["pids"]:
            if pid == me:
                continue
            try:
                if os.stat(f"/proc/{pid}").st_uid == self.uid:
                    os.kill(pid, signal.SIGTERM)
                    n += 1
            except OSError:
                pass
        ui.toast(self, f"Asked {app['name']} to quit" if n else f"Couldn’t quit {app['name']}", 2)


class PerformanceApp(ui.OrbitApp):
    def __init__(self):
        super().__init__("org.orbit_os.Performance", lambda app: PerformanceWindow(app))


def main():
    return PerformanceApp().run_main()
