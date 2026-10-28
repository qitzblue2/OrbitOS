"""Orbit Backup — snapshot backups of ~/Home to a USB drive or folder.

Every backup is a complete, browsable copy (open it in Files), but unchanged
files are hard-linked to the previous one, so only changes use new space.
Restoring never deletes anything: replaced files are kept as *.before-restore.

  orbit-backup            open the app
  orbit-backup --run-now  back up once without a window (used by the schedule)
"""
import os
import pathlib
import subprocess
import sys

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Adw", "1")
from gi.repository import Adw, Gio, GLib, Gtk  # noqa: E402

from . import backup, notes, paths, ui  # noqa: E402

UNIT_DIR = pathlib.Path(os.environ.get("XDG_CONFIG_HOME", pathlib.Path.home() / ".config")) / "systemd/user"


def apply_schedule(schedule):
    """Write/enable (or disable) the systemd --user timer for daily/weekly backups."""
    timer = UNIT_DIR / "orbit-backup.timer"
    if schedule == "off":
        subprocess.run(["systemctl", "--user", "disable", "--now", "orbit-backup.timer"], capture_output=True)
        return
    svc, tmr = backup.timer_units(schedule)
    UNIT_DIR.mkdir(parents=True, exist_ok=True)
    (UNIT_DIR / "orbit-backup.service").write_text(svc)
    timer.write_text(tmr)
    subprocess.run(["systemctl", "--user", "daemon-reload"], capture_output=True)
    subprocess.run(["systemctl", "--user", "enable", "--now", "orbit-backup.timer"], capture_output=True)


class _Status(Gtk.Box):
    """Icon + title + description header (an Adw.StatusPage can't live inside a preferences page)."""

    def __init__(self):
        super().__init__(orientation=Gtk.Orientation.VERTICAL, spacing=10, margin_top=12, margin_bottom=12)
        self.append(Gtk.Image(icon_name="orbit-backup", pixel_size=96))
        self.title = Gtk.Label(css_classes=["title-2"], wrap=True, justify=Gtk.Justification.CENTER)
        self.desc = Gtk.Label(css_classes=["dim-label"], wrap=True, justify=Gtk.Justification.CENTER,
                              margin_bottom=8)
        self.append(self.title)
        self.append(self.desc)

    def set_title(self, t):
        self.title.set_label(t)

    def set_description(self, d):
        self.desc.set_label(d)


class BackupWindow(Adw.ApplicationWindow):
    def __init__(self, app):
        super().__init__(application=app, title="Backup", default_width=820, default_height=820)
        self._toasts = Adw.ToastOverlay()
        self.cfg = backup.load_config()
        self.running = False
        page = Adw.PreferencesPage()

        # ---- status
        self.status = _Status()
        self.now_btn = Gtk.Button(label="Back Up Now", css_classes=["suggested-action", "pill"],
                                  halign=Gtk.Align.CENTER)
        self.now_btn.connect("clicked", lambda *_: self.run_now())
        self.progress = Gtk.ProgressBar(show_text=True, visible=False, width_request=360,
                                        halign=Gtk.Align.CENTER)
        self.status.append(self.now_btn)
        self.status.append(self.progress)
        top = Adw.PreferencesGroup()
        top.add(self.status)
        page.add(top)

        # ---- destination
        g = Adw.PreferencesGroup(title="Where to", description="A USB drive is best: unplug it after a backup "
                                                               "and keep it somewhere safe.")
        self.dest_row = Adw.ActionRow(title="Backup location")
        choose = Gtk.Button(label="Choose…", valign=Gtk.Align.CENTER)
        choose.connect("clicked", lambda *_: self.choose_dest())
        self.dest_row.add_suffix(choose)
        g.add(self.dest_row)
        self.drives = Adw.ExpanderRow(title="Plugged-in drives", subtitle="Click one to use it")
        g.add(self.drives)
        page.add(g)
        self.vm = Gio.VolumeMonitor.get()
        for sig in ("mount-added", "mount-removed"):
            self.vm.connect(sig, lambda *_: (self._fill_drives(), self.update_status()))
        self._drive_rows = []
        self._fill_drives()

        # ---- what
        g2 = Adw.PreferencesGroup(title="What to back up")
        home = paths.orbit_home()
        folders = sorted({p.name for p in home.iterdir() if p.is_dir() and not p.name.startswith(".")}
                         | set(self.cfg["sources"])) if home.is_dir() else self.cfg["sources"]
        for name in folders:
            exists = (home / name).is_dir()
            size_hint = "" if exists else "folder not found"
            r = Adw.SwitchRow(title=name, subtitle=size_hint, active=name in self.cfg["sources"])
            r.connect("notify::active", self._toggle_source, name)
            g2.add(r)
        self.excl = Adw.EntryRow(title="Skip files matching (comma separated)",
                                 text=", ".join(self.cfg["excludes"]))
        self.excl.connect("changed", self._set_excludes)
        g2.add(self.excl)
        page.add(g2)

        # ---- schedule
        g3 = Adw.PreferencesGroup(title="Automatically")
        self.sched = Adw.ComboRow(title="Back up", model=Gtk.StringList.new(["Only when I click", "Every day",
                                                                             "Every week"]))
        self.sched.set_selected({"off": 0, "daily": 1, "weekly": 2}.get(self.cfg["schedule"], 0))
        self.sched.set_subtitle("Runs quietly when the drive is plugged in; skipped otherwise")
        self.sched.connect("notify::selected", self._set_schedule)
        g3.add(self.sched)
        self.keep = Adw.SpinRow.new_with_range(1, 100, 1)
        self.keep.set_title("Snapshots to keep")
        self.keep.set_subtitle("The oldest are removed after a new backup")
        self.keep.set_value(self.cfg["keep"])
        self.keep.connect("notify::value", lambda r, _p: self._save(keep=int(r.get_value())))
        g3.add(self.keep)
        page.add(g3)

        # ---- snapshots
        self.snaps = Adw.PreferencesGroup(title="Snapshots")
        page.add(self.snaps)
        self._snap_rows = []

        tv = Adw.ToolbarView(content=page)
        hb = Adw.HeaderBar()
        menu = Gio.Menu()
        menu.append("About Orbit Backup", "win.about")
        hb.pack_end(Gtk.MenuButton(icon_name="open-menu-symbolic", menu_model=menu))
        tv.add_top_bar(hb)
        self._toasts.set_child(tv)
        self.set_content(self._toasts)
        a = Gio.SimpleAction.new("about", None)
        a.connect("activate", lambda *_: ui.about(self, "Orbit Backup", "orbit-backup",
                                                  "Snapshot backups of your Home folder."))
        self.add_action(a)
        self.update_status()

    # ---- config helpers
    def _save(self, **kw):
        self.cfg.update(kw)
        backup.save_config(self.cfg)
        self.update_status()

    def _toggle_source(self, row, _p, name):
        src = [s for s in self.cfg["sources"] if s != name]
        if row.get_active():
            src.append(name)
        self._save(sources=sorted(src))

    def _set_excludes(self, row):
        self._save(excludes=[x.strip() for x in row.get_text().split(",") if x.strip()])

    def _set_schedule(self, row, _p):
        sched = ["off", "daily", "weekly"][row.get_selected()]
        self._save(schedule=sched)
        ui.run_async(lambda: apply_schedule(sched),
                     lambda _r: ui.toast(self, "Automatic backups off" if sched == "off" else
                                         f"Backing up {'every day' if sched == 'daily' else 'every week'}"))

    def _fill_drives(self):
        for r in self._drive_rows:
            self.drives.remove(r)
        self._drive_rows = []
        mounts = [m for m in self.vm.get_mounts() if m.get_root().get_path() and not m.is_shadowed()]
        for m in mounts:
            path = m.get_root().get_path()
            r = Adw.ActionRow(title=m.get_name(), subtitle=f"{path} · {ui.human_size(backup.free_space(path))} free",
                              activatable=True)
            r.add_prefix(Gtk.Image(gicon=m.get_symbolic_icon()))
            r.connect("activated", lambda _r, p=path: self._save(destination=p))
            self.drives.add_row(r)
            self._drive_rows.append(r)
        self.drives.set_subtitle("Click one to use it" if mounts else "None plugged in right now")
        self.drives.set_sensitive(bool(mounts))

    def choose_dest(self):
        dlg = Gtk.FileDialog(title="Choose Backup Location")

        def done(d, res):
            try:
                f = d.select_folder_finish(res)
            except GLib.Error:
                return
            p = pathlib.Path(f.get_path())
            if p.resolve().is_relative_to(paths.orbit_home().resolve()):
                ui.toast(self, "Pick a place outside your Home folder (ideally another drive)")
                return
            self._save(destination=str(p))
        dlg.select_folder(self, None, done)

    # ---- status + snapshots
    def update_status(self):
        dest = self.cfg["destination"]
        online = bool(dest) and pathlib.Path(dest).is_dir()
        self.dest_row.set_subtitle(dest + ("" if online else " (not connected)") if dest else "Not chosen yet")
        snaps = backup.snapshots(dest) if online else []
        if not dest:
            self.status.set_title("Set up backups")
            self.status.set_description("Choose a USB drive or folder below, then press Back Up Now.")
        elif not online:
            self.status.set_title("Backup drive not connected")
            self.status.set_description(f"Plug in the drive for {dest}.")
        elif snaps:
            t = backup.snapshot_time(snaps[-1]).timestamp()
            self.status.set_title(f"Last backup {notes.relative_time(t)}")
            self.status.set_description(f"{len(snaps)} snapshot{'s' if len(snaps) != 1 else ''} · "
                                        f"{ui.human_size(backup.free_space(dest))} free on the drive")
        else:
            self.status.set_title("No backups yet")
            self.status.set_description("Your first backup copies everything; later ones only copy changes.")
        self.now_btn.set_sensitive(online and not self.running and bool(self.cfg["sources"]))
        for r in self._snap_rows:
            self.snaps.remove(r)
        self._snap_rows = []
        for s in reversed(snaps):
            when = backup.snapshot_time(s)
            r = Adw.ActionRow(title=when.strftime("%A %e %B %Y, %H:%M"),
                              subtitle=notes.relative_time(when.timestamp()))
            browse = Gtk.Button(icon_name="folder-open-symbolic", tooltip_text="Browse in Files",
                                css_classes=["flat"], valign=Gtk.Align.CENTER)
            browse.connect("clicked", lambda *_a, s=s: ui.spawn(["orbit-files", str(s)]))
            restore = Gtk.Button(label="Restore…", valign=Gtk.Align.CENTER)
            restore.connect("clicked", lambda *_a, s=s: self.restore(s))
            r.add_suffix(browse)
            r.add_suffix(restore)
            self.snaps.add(r)
            self._snap_rows.append(r)
        self.snaps.set_description("" if snaps else "Snapshots appear here after your first backup.")

    # ---- run
    def run_now(self):
        self.running = True
        self.now_btn.set_sensitive(False)
        self.progress.set_visible(True)
        self.progress.set_fraction(0)
        self.progress.set_text("Starting…")

        def prog(done, pct):
            GLib.idle_add(lambda: (self.progress.set_fraction(pct / 100),
                                   self.progress.set_text(f"{pct}% · {ui.human_size(done)}"), False)[2])

        def finished(snap):
            self.running = False
            self.progress.set_fraction(1)
            self.progress.set_text("Done")
            ui.toast(self, "Backup finished")
            GLib.timeout_add(2500, lambda: (self.progress.set_visible(False), False)[1])
            self.update_status()

        def failed(e):
            self.running = False
            self.progress.set_visible(False)
            ui.toast(self, f"Backup failed: {e}", 8)
            self.update_status()
        ui.run_async(lambda: backup.run_backup(self.cfg, progress=prog), finished, failed)

    def restore(self, snap):
        d = Adw.AlertDialog(heading="Restore from this snapshot?",
                            body="Files are copied back into your Home folder. Nothing is deleted: files that "
                                 "would be replaced are kept next to them as “name.before-restore”.")
        choices = ["Everything in the snapshot"] + sorted(p.name for p in snap.iterdir() if p.is_dir())
        dd = Gtk.DropDown(model=Gtk.StringList.new(choices))
        d.set_extra_child(dd)
        d.add_response("cancel", "Cancel")
        d.add_response("ok", "Restore")
        d.set_response_appearance("ok", Adw.ResponseAppearance.SUGGESTED)

        def resp(_d, r):
            if r != "ok":
                return
            sub = "" if dd.get_selected() == 0 else choices[dd.get_selected()]
            argv = backup.restore_command(snap, paths.orbit_home(), sub)
            ui.toast(self, "Restoring…", 2)
            ui.run_async(lambda: subprocess.run(argv, capture_output=True, text=True),
                         lambda res: ui.toast(self, "Restore finished" if res.returncode in (0, 24) else
                                              f"Restore failed: {res.stderr.strip()[-200:]}", 6))
        d.connect("response", resp)
        d.present(self)


class BackupApp(ui.OrbitApp):
    def __init__(self):
        super().__init__("org.orbit_os.Backup", lambda app: BackupWindow(app))


def run_headless():
    """For the systemd timer: back up if the drive is there, tell the user either way."""
    cfg = backup.load_config()
    dest = cfg["destination"]
    if not dest or not pathlib.Path(dest).is_dir():
        return 0  # drive not plugged in: quietly try again next time
    try:
        snap = backup.run_backup(cfg)
        subprocess.run(["notify-send", "-i", "orbit-backup", "Backup finished", f"Snapshot {snap.name}"],
                       check=False)
        return 0
    except RuntimeError as e:
        subprocess.run(["notify-send", "-u", "critical", "-i", "orbit-backup", "Backup failed", str(e)],
                       check=False)
        return 1


def main():
    if "--run-now" in sys.argv:
        return run_headless()
    return BackupApp().run_main()
