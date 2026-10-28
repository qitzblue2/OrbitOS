"""Orbit Hardware — what works on this computer, in plain language.

"Automatic" runs the hardware report (orbit-hardware-check) and shows each
check with a green / amber / red mark. "Guided tests" walks through the things
a script can't judge (keys, lid, sleep, headphones, fingerprint) and saves the
answers as a Markdown table for HARDWARE-TEST.md.
"""
import json
import pathlib
import shutil
import socket
import subprocess

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Adw", "1")
from gi.repository import Adw, Gio, GLib, Gtk, Pango  # noqa: E402

from . import hardware, paths, ui  # noqa: E402

ICON = {"ok": ("emblem-ok-symbolic", "orbit-ok"), "warn": ("dialog-warning-symbolic", "orbit-warn"),
        "fail": ("dialog-error-symbolic", "orbit-fail"), "info": ("dialog-information-symbolic", "dim-label")}
SECTION_ICON = {"System": "computer-symbolic", "Graphics": "video-display-symbolic",
                "Network": "network-wireless-symbolic", "Bluetooth": "bluetooth-symbolic",
                "Audio": "audio-speakers-symbolic", "Camera": "camera-web-symbolic",
                "Fingerprint reader": "fingerprint-symbolic", "Power": "battery-symbolic",
                "Firmware": "software-update-available-symbolic", "Input": "input-keyboard-symbolic",
                "Security": "security-high-symbolic", "Boot time": "alarm-symbolic"}


def report_command():
    for p in ("/usr/bin/orbit-hardware-check",
              str(pathlib.Path(__file__).resolve().parents[4] / "tools/hardware-check.sh")):
        if pathlib.Path(p).exists():
            return ["bash", p]
    return None


def machine_name():
    try:
        vendor = pathlib.Path("/sys/class/dmi/id/sys_vendor").read_text().strip()
        model = pathlib.Path("/sys/class/dmi/id/product_name").read_text().strip()
        if model:
            return f"{vendor} {model}".strip()
    except OSError:
        pass
    return socket.gethostname()


class HardwareWindow(Adw.ApplicationWindow):
    def __init__(self, app):
        super().__init__(application=app, title="Hardware", default_width=900, default_height=760)
        self._toasts = Adw.ToastOverlay()
        self.sections, self.raw = [], ""
        self.results_file = paths.STATE / "hardware-guided.json"
        try:
            self.manual = json.loads(self.results_file.read_text())
        except (OSError, ValueError):
            self.manual = {}

        self.stack = Adw.ViewStack()
        switcher = Adw.ViewSwitcher(stack=self.stack, policy=Adw.ViewSwitcherPolicy.WIDE)
        hb = Adw.HeaderBar(title_widget=switcher)
        self.rerun = Gtk.Button(icon_name="view-refresh-symbolic", tooltip_text="Run the checks again (F5)",
                                action_name="win.run")
        hb.pack_start(self.rerun)
        menu = Gio.Menu()
        menu.append("Copy Report", "win.copy")
        menu.append("Save Report…", "win.save")
        menu.append("About Orbit Hardware", "win.about")
        hb.pack_end(Gtk.MenuButton(icon_name="open-menu-symbolic", menu_model=menu))

        # automatic page
        self.auto = Adw.PreferencesPage()
        self.summary = Adw.PreferencesGroup()
        self.auto.add(self.summary)
        self.loading = Adw.StatusPage(icon_name="orbit-hardware", title="Checking your hardware…",
                                      description="This takes a few seconds and changes nothing.")
        self.loading.set_child(Gtk.Spinner(spinning=True, width_request=32, height_request=32))
        self.auto_stack = Gtk.Stack(transition_type=Gtk.StackTransitionType.CROSSFADE)
        self.auto_stack.add_named(self.loading, "loading")
        self.auto_stack.add_named(self.auto, "results")
        self.stack.add_titled_with_icon(self.auto_stack, "auto", "Automatic", "emblem-system-symbolic")

        # guided page
        guided = Adw.PreferencesPage()
        g = Adw.PreferencesGroup(title="Guided tests",
                                 description="Try each one and mark the result. Answers are kept, so you can do a few now "
                                             "and the rest later.")
        self.manual_rows = {}
        for name, howto in hardware.MANUAL_TESTS:
            row = Adw.ActionRow(title=name, subtitle=howto)
            row.set_subtitle_lines(3)
            box = Gtk.Box(css_classes=["linked"], valign=Gtk.Align.CENTER)
            group = None
            for res, icon, tip in (("ok", "emblem-ok-symbolic", "Works"), ("warn", "dialog-warning-symbolic",
                                                                           "Works with problems"),
                                   ("fail", "window-close-symbolic", "Doesn’t work")):
                b = Gtk.ToggleButton(icon_name=icon, tooltip_text=tip, group=group)
                group = group or b
                b.set_active(self.manual.get(name, ["untested"])[0] == res)
                b.connect("toggled", self._mark, name, res)
                box.append(b)
            row.add_suffix(box)
            g.add(row)
            note = Adw.EntryRow(title=f"Notes: {name}", text=self.manual.get(name, ["", ""])[1])
            note.connect("changed", self._note, name)
            g.add(note)
            self.manual_rows[name] = row
        guided.add(g)
        self.stack.add_titled_with_icon(guided, "guided", "Guided Tests", "checkbox-checked-symbolic")

        tv = Adw.ToolbarView(content=self.stack)
        tv.add_top_bar(hb)
        bar = Adw.ViewSwitcherBar(stack=self.stack)
        tv.add_bottom_bar(bar)
        bp = Adw.Breakpoint.new(Adw.BreakpointCondition.parse("max-width: 560sp"))
        bp.add_setter(bar, "reveal", True)
        bp.add_setter(hb, "title-widget", Adw.WindowTitle(title="Hardware"))
        self.add_breakpoint(bp)
        self._toasts.set_child(tv)
        self.set_content(self._toasts)
        for name, cb in {"run": self.run, "copy": self.copy, "save": self.save,
                         "about": lambda: ui.about(self, "Orbit Hardware", "orbit-hardware",
                                                   "See what works on this computer.")}.items():
            a = Gio.SimpleAction.new(name, None)
            a.connect("activate", lambda *_a, cb=cb: cb())
            self.add_action(a)
        self._groups = []
        self.run()

    # ---- automatic
    def run(self):
        cmd = report_command()
        if not cmd:
            self.loading.set_title("Hardware report not installed")
            return
        self.auto_stack.set_visible_child_name("loading")
        self.rerun.set_sensitive(False)
        ui.run_async(lambda: subprocess.run(cmd, capture_output=True, text=True, timeout=120).stdout,
                     self._show, lambda e: (ui.toast(self, f"Report failed: {e}"), self.rerun.set_sensitive(True)))

    def _show(self, text):
        self.raw = text
        self.sections = hardware.parse(text)
        self.rerun.set_sensitive(True)
        for grp in self._groups:
            self.auto.remove(grp)
        self._groups = []
        c = hardware.summary(self.sections)
        self.summary.set_title(machine_name())
        self.summary.set_description(f"{c['ok']} working · {c['warn']} to look at · {c['fail']} not working")
        for s in self.sections:
            st = hardware.section_status(s)
            grp = Adw.PreferencesGroup()
            exp = Adw.ExpanderRow(title=s["name"], subtitle=self._section_line(s),
                                  expanded=st in ("warn", "fail"))
            exp.add_prefix(Gtk.Image(icon_name=SECTION_ICON.get(s["name"], "emblem-system-symbolic")))
            icon, cls = ICON[st]
            badge = Gtk.Image(icon_name=icon, css_classes=[cls])
            exp.add_suffix(badge)
            for item in s["items"]:
                r = Adw.ActionRow(title=GLib.markup_escape_text(item["text"]))
                r.set_title_lines(3)
                ic, cl = ICON[item["status"]]
                r.add_prefix(Gtk.Image(icon_name=ic, css_classes=[cl]))
                exp.add_row(r)
            grp.add(exp)
            self.auto.add(grp)
            self._groups.append(grp)
        self.auto_stack.set_visible_child_name("results")

    @staticmethod
    def _section_line(s):
        firsts = [i["text"] for i in s["items"] if i["status"] != "info"] or [i["text"] for i in s["items"]]
        return GLib.markup_escape_text(firsts[0][:90]) if firsts else ""

    # ---- guided
    def _mark(self, btn, name, res):
        if btn.get_active():
            note = self.manual.get(name, ["", ""])[1]
            self.manual[name] = [res, note]
            self._save_manual()

    def _note(self, entry, name):
        res = self.manual.get(name, ["untested", ""])[0]
        self.manual[name] = [res, entry.get_text()]
        self._save_manual()

    def _save_manual(self):
        paths.ensure(paths.STATE)
        self.results_file.write_text(json.dumps(self.manual, indent=1))

    # ---- export
    def report(self):
        manual = {n: tuple(self.manual.get(n, ["untested", ""])) for n, _ in hardware.MANUAL_TESTS}
        return hardware.report_markdown(machine_name(), self.sections, manual)

    def copy(self):
        self.get_display().get_clipboard().set(self.report())
        ui.toast(self, "Report copied: paste it into HARDWARE-TEST.md", 3)

    def save(self):
        dlg = Gtk.FileDialog(title="Save Report", initial_name="hardware-report.md",
                             initial_folder=Gio.File.new_for_path(str(paths.orbit_home() / "Documents")))

        def done(d, res):
            try:
                f = d.save_finish(res)
            except GLib.Error:
                return
            pathlib.Path(f.get_path()).write_text(self.report())
            ui.toast(self, f"Saved {f.get_basename()}")
        dlg.save(self, None, done)


class HardwareApp(ui.OrbitApp):
    def __init__(self):
        super().__init__("org.orbit_os.Hardware", lambda app: HardwareWindow(app))
        self.connect("startup", lambda *_: ui.add_shortcuts(self, {"win.run": ["F5"], "win.copy": ["<Ctrl>c"]}))


def main():
    return HardwareApp().run_main()
