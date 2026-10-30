#!/usr/bin/env python3
"""Unit tests for the GTK-free logic of the Orbit apps. Run: python3 tests/test_orbit_apps.py"""
import datetime as dt
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "packages/orbit-apps/src"))
TMP = pathlib.Path(tempfile.mkdtemp(prefix="orbit-test-"))
os.environ["HOME"] = str(TMP / "home")
os.environ["XDG_CONFIG_HOME"] = str(TMP / "home/.config")
os.environ["XDG_STATE_HOME"] = str(TMP / "home/.local/state")
(TMP / "home/Home").mkdir(parents=True)

from orbit import backup, catalog, fileops, hardware, games, notes, spaces, tune, sharing, sync, updater, winapps  # noqa: E402


class FileOps(unittest.TestCase):
    def setUp(self):
        self.d = pathlib.Path(tempfile.mkdtemp(dir=TMP))

    def test_kinds(self):
        self.assertEqual(fileops.kind_of("a.png"), "Images")
        self.assertEqual(fileops.kind_of("a.py"), "Code")
        self.assertEqual(fileops.kind_of("a.pdf"), "Documents")
        self.assertEqual(fileops.kind_of("a.mp3"), "Audio")
        self.assertEqual(fileops.kind_of("a.zip"), "Archives")
        self.assertEqual(fileops.kind_of("x", is_dir=True), "Folders")
        self.assertEqual(fileops.kind_of("noext"), "Other")

    def test_unique_name(self):
        (self.d / "a.txt").write_text("x")
        self.assertEqual(fileops.unique_name(self.d, "a.txt").name, "a (2).txt")
        (self.d / "a (2).txt").write_text("x")
        self.assertEqual(fileops.unique_name(self.d, "a.txt").name, "a (3).txt")
        (self.d / ".bashrc").write_text("x")
        self.assertEqual(fileops.unique_name(self.d, ".bashrc").name, ".bashrc (2)")
        self.assertEqual(fileops.unique_name(self.d, "new.txt").name, "new.txt")

    def test_valid_name(self):
        self.assertIsNone(fileops.valid_name("ok name.txt"))
        for bad in ("", "  ", "a/b", ".", "..", "x" * 300):
            self.assertIsNotNone(fileops.valid_name(bad), bad)

    def test_plan_rejects_into_itself(self):
        (self.d / "f").mkdir()
        with self.assertRaises(ValueError):
            fileops.plan_transfer([self.d / "f"], self.d / "f" / "sub")

    def test_copy_and_move(self):
        src = self.d / "src"
        (src / "deep").mkdir(parents=True)
        (src / "deep/file.bin").write_bytes(os.urandom(3_000_000))
        os.symlink("deep/file.bin", src / "link")
        dst = self.d / "dst"
        dst.mkdir()
        seen = []
        plan = fileops.plan_transfer([src], dst)
        self.assertTrue(fileops.copy_with_progress(plan, progress=seen.append))
        self.assertEqual((dst / "src/deep/file.bin").read_bytes(), (src / "deep/file.bin").read_bytes())
        self.assertTrue((dst / "src/link").is_symlink())
        self.assertEqual(seen[-1], 3_000_000)
        # second copy collides -> renamed, original untouched
        plan2 = fileops.plan_transfer([src], dst)
        self.assertEqual(plan2[0][1].name, "src (2)")
        # move within same parent is a no-op
        self.assertEqual(fileops.plan_transfer([src], self.d, move=True), [])
        fileops.copy_with_progress(fileops.plan_transfer([src], dst, move=True), move=True)
        self.assertFalse(src.exists())
        self.assertTrue((dst / "src (2)/deep/file.bin").exists())

    def test_search(self):
        (self.d / "Alpha/beta").mkdir(parents=True)
        (self.d / "Alpha/beta/Report.PDF").write_text("x")
        (self.d / ".hidden").mkdir()
        (self.d / ".hidden/report2").write_text("x")
        names = [p.name for p in fileops.search(self.d, "report")]
        self.assertEqual(names, ["Report.PDF"])
        self.assertEqual(len(fileops.search(self.d, "report", show_hidden=True)), 2)


class Spaces(unittest.TestCase):
    def test_defaults_and_switch(self):
        sp, cur = spaces.load()
        self.assertEqual([s["name"] for s in sp], ["Personal", "Work", "Study"])
        self.assertIsNone(cur)
        calls = []
        s = spaces.switch("work", run=lambda argv, check: calls.append(argv))
        self.assertEqual(s["name"], "Work")
        self.assertTrue((TMP / "home/Home/Spaces/Work").is_dir())
        fav = [c for c in calls if c[3] == "favorite-apps"][0]
        self.assertTrue(fav[4].startswith("['orbit-files.desktop'"))
        self.assertIn(["gsettings", "set", "org.gnome.desktop.notifications", "show-banners", "false"], calls)
        self.assertEqual(spaces.load()[1], "Work")
        with self.assertRaises(KeyError):
            spaces.switch("nope", run=lambda *a, **k: None)

    def test_validate(self):
        v = spaces.validate({"name": "Gaming", "color": "red", "wallpaper": "../../etc/x", "apps": ["a.desktop", 3, "b"]})
        self.assertEqual(v["color"], "#888888")
        self.assertNotIn("/", v["wallpaper"])
        self.assertEqual(v["apps"], ["a.desktop"])
        with self.assertRaises(ValueError):
            spaces.validate({"name": "../x"})


class Notes(unittest.TestCase):
    def setUp(self):
        self.s = notes.NoteStore(tempfile.mkdtemp(dir=TMP))

    def test_create_pin_sort_search_rename(self):
        a = self.s.create("Shopping list")
        time.sleep(0.01)
        b = self.s.create("Ideas", folder="Work")
        self.s.save(b, "# Ideas\n\nbuild orbit store")
        self.assertEqual(self.s.notes()[0], b)       # most recent first
        self.s.set_pinned(a, True)
        self.assertEqual(self.s.notes()[0], a)       # pinned beats recent
        self.assertEqual(self.s.notes(query="orbit store"), [b])
        self.assertEqual(self.s.notes(folder="Work"), [b])
        self.assertIn("Work", self.s.folders())
        a2 = self.s.rename(a, "Groceries")
        self.assertTrue(self.s.is_pinned(a2))
        self.assertEqual(self.s.create("Groceries").name, "Groceries 2.md")
        with self.assertRaises(FileExistsError):
            self.s.rename(self.s.create("X"), "Groceries")

    def test_markdown(self):
        out = notes.markdown_to_pango("# Title\n**bold** and *it* `code` <tag>\n- [x] done\n- item\n[l](https://a.b)")
        self.assertIn('<span size="xx-large" weight="bold">Title</span>', out)
        self.assertIn("<b>bold</b>", out)
        self.assertIn("<i>it</i>", out)
        self.assertIn("&lt;tag&gt;", out)            # escaped, never markup injection
        self.assertIn("☑ done", out)
        self.assertIn('<a href="https://a.b">l</a>', out)
        self.assertNotIn("javascript", notes.markdown_to_pango("[x](javascript:alert(1))").replace("javascript:alert(1)", ""))
        self.assertEqual(notes.title_of("\n\n## Hello\nbody", "f"), "Hello")
        self.assertEqual(notes.word_count("one two, three"), 3)
        self.assertEqual(notes.snippet("# T\nNotes are **plain** in `~/x`.\n- [x] done\n```\nls\n```"),
                         "Notes are plain in ~/x. · done · ls")
        self.assertEqual(notes.safe_filename("a/b:c?"), "a b c")


class Backup(unittest.TestCase):
    def test_commands(self):
        home = TMP / "bh"
        (home / "Documents").mkdir(parents=True)
        argv = backup.rsync_command(home, ["Documents", "Missing"], "/d", ["*.tmp"], previous="/d/p", target="/d/t")
        self.assertIn(f"{home}/./Documents", argv)
        self.assertNotIn(f"{home}/./Missing", argv)
        self.assertIn("--link-dest=/d/p", argv)
        self.assertEqual(argv[-1], "/d/t/")
        with self.assertRaises(ValueError):
            backup.rsync_command(home, ["Nope"], "/d", [])
        self.assertEqual(backup.parse_progress("  1,234,567  42%   10.00MB/s    0:00:12"), (1234567, 42))
        self.assertIsNone(backup.parse_progress("sending incremental file list"))
        self.assertEqual(backup.prune_plan([1, 2, 3, 4], 2), [1, 2])
        self.assertEqual(backup.prune_plan([1], 2), [])
        svc, tmr = backup.timer_units("daily")
        self.assertIn("OnCalendar=daily", tmr)

    @unittest.skipUnless(shutil.which("rsync"), "rsync not installed")
    def test_real_snapshots_hardlink(self):
        home = TMP / "rh"
        (home / "Documents").mkdir(parents=True)
        (home / "Documents/a.txt").write_text("v1")
        (home / "Documents/big.bin").write_bytes(os.urandom(200_000))
        dest = TMP / "drive"
        dest.mkdir()
        cfg = dict(backup.default_config(), destination=str(dest), keep=2)
        s1 = backup.run_backup(cfg, home=home, now=dt.datetime(2026, 1, 1, 10, 0, 0))
        (home / "Documents/a.txt").write_text("v2")
        # rsync's quick check compares size + mtime; a same-size edit within the same
        # second would look unchanged. Real edits are seconds apart; simulate that.
        later = time.time() + 5
        os.utime(home / "Documents/a.txt", (later, later))
        s2 = backup.run_backup(cfg, home=home, now=dt.datetime(2026, 1, 2, 10, 0, 0))
        self.assertEqual((s1 / "Documents/a.txt").read_text(), "v1")
        self.assertEqual((s2 / "Documents/a.txt").read_text(), "v2")
        # unchanged file is a hard link, not a second copy
        self.assertEqual((s1 / "Documents/big.bin").stat().st_ino, (s2 / "Documents/big.bin").stat().st_ino)
        backup.run_backup(cfg, home=home, now=dt.datetime(2026, 1, 3, 10, 0, 0))
        self.assertEqual([p.name for p in backup.snapshots(dest)], ["2026-01-02_100000", "2026-01-03_100000"])
        # destination inside home is refused
        with self.assertRaises(RuntimeError):
            backup.run_backup(dict(cfg, destination=str(home / "Documents")), home=home)
        # restore never deletes extra files and keeps a .before-restore copy
        (home / "Documents/a.txt").write_text("v3")
        (home / "Documents/new.txt").write_text("keep me")
        oldest = backup.snapshots(dest)[0]  # 01-01 was pruned; 01-02 holds "v2"
        subprocess.run(backup.restore_command(oldest, home, "Documents"), check=True, capture_output=True)
        self.assertEqual((home / "Documents/a.txt").read_text(), "v2")
        self.assertTrue((home / "Documents/new.txt").exists())
        self.assertEqual((home / "Documents/a.txt.before-restore").read_text(), "v3")


class Annotate(unittest.TestCase):
    def test_render_crop_pixelate_undo(self):
        try:
            import cairo
        except ImportError:
            self.skipTest("python3-cairo not installed")
        from orbit import annotate
        base = cairo.ImageSurface(cairo.FORMAT_ARGB32, 200, 100)
        cr = cairo.Context(base)
        for x in range(0, 200, 2):          # fine stripes: pixelate must blur them away
            cr.set_source_rgb(x % 4 == 0, 0, 1)
            cr.rectangle(x, 0, 1, 100)
            cr.fill()
        h = annotate.History()
        h.add(annotate.Shape("arrow", "#ff0000", 4, [(10, 10), (90, 60)]))
        h.add(annotate.Shape("pixelate", "#000000", 4, [(100, 0), (200, 100)]))
        h.add(annotate.Shape("crop", points=[(5, 5), (195, 95)]))
        out = annotate.render(base, h.shapes, h.crop)
        self.assertEqual((out.get_width(), out.get_height()), (190, 90))
        h.undo()
        self.assertIsNone(h.crop)
        self.assertEqual(annotate.render(base, h.shapes, h.crop).get_width(), 200)
        h.redo()
        self.assertEqual(h.crop, (5, 5, 190, 90))
        # pixelated half has far fewer distinct columns than the striped original
        full = annotate.render(base, h.shapes[:2])
        data = bytes(full.get_data())
        stride = full.get_stride()
        cols = {data[50 * stride + x * 4: 50 * stride + x * 4 + 4] for x in range(100, 200)}
        self.assertLessEqual(len(cols), 12)
        w1, w2 = annotate.arrow_head((0, 0), (100, 0), 4)
        self.assertLess(w1[0], 100)
        self.assertAlmostEqual(w1[1], -w2[1])


class Catalog(unittest.TestCase):
    def test_catalog(self):
        apps, cats = catalog.load()
        self.assertGreater(len(apps), 30)
        self.assertIn("Utilities", cats)
        self.assertEqual(len({a["name"] for a in apps}), len(apps))
        vlc = catalog.search(apps, "video player")[0]
        self.assertEqual(vlc["name"], "VLC")
        self.assertEqual(catalog.action_command(vlc, "install")[:2], ["pkexec", "/usr/lib/orbit-os/orbit-store-helper"])
        b = [a for a in apps if a["source"] == "flathub"][0]
        self.assertIn("--user", catalog.action_command(b, "install"))
        with self.assertRaises(ValueError):
            catalog.validate({"source": "apt", "packages": ["evil; rm -rf /"]})
        with self.assertRaises(ValueError):
            catalog.action_command(vlc, "purge-everything")

    def test_installed_map(self):
        apps, _ = catalog.load()

        class R:
            def __init__(self, out):
                self.stdout, self.returncode = out, 0

        def fake(argv, **kw):
            if argv[0] == "dpkg-query":
                return R("vlc ii \ngimp un \n")
            return R("com.usebottles.bottles\n")
        m = catalog.installed_map(apps, run=fake) if shutil.which("dpkg-query") else {}
        if m:
            self.assertTrue(m["VLC"])
            self.assertFalse(m["GIMP"])

    def test_helper_refuses_unlisted(self):
        helper = ROOT / "packages/orbit-apps/files/usr/lib/orbit-os/orbit-store-helper"
        src = helper.read_text()
        self.assertIn("not in the Orbit Store catalog", src)
        self.assertIn('"--"', src)  # package names can never be read as apt options


class Hardware(unittest.TestCase):
    def test_parse_real_output(self):
        script = ROOT / "tools/hardware-check.sh"
        out = subprocess.run(["bash", str(script)], capture_output=True, text=True, timeout=120).stdout
        secs = hardware.parse(out)
        names = [s["name"] for s in secs]
        for want in ("System", "Network", "Fingerprint reader", "Power", "Security"):
            self.assertIn(want, names)
        self.assertGreater(sum(hardware.summary(secs).values()), 5)
        md = hardware.report_markdown("Test PC", secs, {"Lid close": ("ok", "fine")})
        self.assertIn("| Lid close | ✅ | fine |", md)


class Tune(unittest.TestCase):
    def setUp(self):
        self.d = pathlib.Path(tempfile.mkdtemp(dir=TMP))

    def test_sizes_and_empty_dir_keep(self):
        (self.d / "a").mkdir()
        (self.d / "a/x").write_bytes(b"1" * 100)
        (self.d / "thumbnails").mkdir()
        (self.d / "thumbnails/t").write_bytes(b"2" * 50)
        (self.d / "link").symlink_to("/etc")
        self.assertEqual(tune.dir_size(self.d), 150)  # links to folders are not followed
        tune.empty_dir(self.d, keep=("thumbnails",))
        self.assertEqual(sorted(p.name for p in self.d.iterdir()), ["thumbnails"])
        self.assertTrue(pathlib.Path("/etc").is_dir())

    def test_system_clean_is_fixed_jobs_only(self):
        self.assertEqual(tune.clean_system_argv(["apt", "journal"])[1:], [tune.HELPER, "clean", "apt", "journal"])
        with self.assertRaises(ValueError):
            tune.clean_system_argv(["apt", "/home"])

    def test_autostart_override(self):
        sysdir = self.d / "sys"
        sysdir.mkdir()
        (sysdir / "chat.desktop").write_text("[Desktop Entry]\nName=Chat\nExec=chat\n")
        (sysdir / "orbit-welcome.desktop").write_text("[Desktop Entry]\nName=Welcome\nExec=w\n")
        (sysdir / "kde.desktop").write_text("[Desktop Entry]\nName=K\nExec=k\nOnlyShowIn=KDE;\n")
        old = tune.SYSTEM_AUTOSTART, tune.USER_AUTOSTART
        tune.SYSTEM_AUTOSTART, tune.USER_AUTOSTART = [sysdir], self.d / "user"
        try:
            apps = tune.autostart_apps()
            self.assertEqual([a["id"] for a in apps], ["chat.desktop"])
            self.assertTrue(apps[0]["enabled"])
            tune.set_autostart("chat.desktop", False)
            self.assertFalse(tune.autostart_apps()[0]["enabled"])
            self.assertIn("Name=Chat", (sysdir / "chat.desktop").read_text())  # system copy untouched
            tune.set_autostart("chat.desktop", True)
            self.assertTrue(tune.autostart_apps()[0]["enabled"])
            with self.assertRaises(ValueError):
                tune.set_autostart("../x.desktop", False)
        finally:
            tune.SYSTEM_AUTOSTART, tune.USER_AUTOSTART = old

    def test_cpu_memory_processes(self):
        stat = self.d / "stat"
        stat.write_text("cpu  100 0 100 700 100 0 0 0 0 0\n")
        a = tune.read_cpu(stat)
        stat.write_text("cpu  200 0 200 800 100 0 0 0 0 0\n")
        self.assertAlmostEqual(tune.cpu_percent(a, tune.read_cpu(stat)), 200 / 3)
        mi = self.d / "meminfo"
        mi.write_text("MemTotal: 1000 kB\nMemFree: 100 kB\nMemAvailable: 400 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n")
        m = tune.read_memory(mi)
        self.assertEqual((m["total"], m["used"]), (1024000, 614400))
        me = tune.read_processes(uid=os.getuid())
        self.assertIn(os.getpid(), me)
        prev = {1: {"name": "game", "cpu_ticks": 0, "rss": 1, "uid": 0}}
        cur = {1: {"name": "game", "cpu_ticks": 200, "rss": 5, "uid": 0},
               2: {"name": "game", "cpu_ticks": 9, "rss": 5, "uid": 0},
               3: {"name": "idle", "cpu_ticks": 0, "rss": 99, "uid": 0}}
        top = tune.top_apps(prev, cur, 2, hz=100)
        self.assertEqual(top[0]["name"], "game")
        self.assertAlmostEqual(top[0]["cpu"], 100.0)
        self.assertEqual(sorted(top[0]["pids"]), [1, 2])

    def test_temperature_and_advice(self):
        hw = self.d / "class/hwmon/hwmon0"
        hw.mkdir(parents=True)
        (hw / "name").write_text("k10temp\n")
        (hw / "temp1_input").write_text("84000\n")
        self.assertEqual(tune.read_temperature(self.d), 84.0)
        mem = {"total": 100, "used": 90, "available": 10, "swap_total": 0, "swap_used": 0}
        levels = [lvl for lvl, _ in tune.advice(mem, 84.0, 10, "power-saver", 9, 3_000_000_000)]
        self.assertEqual(levels, ["warn", "warn", "info", "info", "info"])
        ok = {"total": 100, "used": 10, "available": 90, "swap_total": 0, "swap_used": 0}
        self.assertEqual(tune.advice(ok, 50, 5, "balanced", 1, 0), [])


class Games(unittest.TestCase):
    def setUp(self):
        self.d = pathlib.Path(tempfile.mkdtemp(dir=TMP))

    def test_library(self):
        a, b = self.d / "sys", self.d / "user"
        a.mkdir(); b.mkdir()
        (a / "steam.desktop").write_text("[Desktop Entry]\nType=Application\nName=Steam\nCategories=Network;\n")
        (a / "tux.desktop").write_text("[Desktop Entry]\nType=Application\nName=Tux Kart\nCategories=Game;\n")
        (a / "chess.desktop").write_text("[Desktop Entry]\nType=Application\nName=Chess\nCategories=Game;\n")
        (a / "edit.desktop").write_text("[Desktop Entry]\nType=Application\nName=Editor\nCategories=Utility;\n")
        (a / "orbit-games.desktop").write_text("[Desktop Entry]\nType=Application\nName=Games\nCategories=Game;\n")
        (b / "chess.desktop").write_text("[Desktop Entry]\nType=Application\nName=Chess\nNoDisplay=true\n")
        lib = games.library([a, b])
        self.assertEqual([g["name"] for g in lib], ["Steam", "Tux Kart"])
        self.assertTrue(lib[0]["launcher"])

    def test_gpus_and_32bit(self):
        for i, v in enumerate(("0x1002", "0x10de", "0x1002")):
            p = self.d / f"class/drm/card{i}/device"
            p.mkdir(parents=True)
            (p / "vendor").write_text(v + "\n")
        self.assertEqual(games.gpus(self.d), ["AMD", "NVIDIA"])
        (self.d / "arch").write_text("amd64\ni386\n")
        self.assertTrue(games.has_32bit(self.d))
        self.assertFalse(games.has_32bit(self.d / "nope"))
        self.assertEqual(games.launch_options({"gamemode": True, "mangohud": False}), "gamemoderun %command%")

    def test_game_mode_restores_settings(self):
        calls, prof = [], {"now": "balanced"}

        def gs(*a):
            calls.append(a)
            return "true" if a[0] == "get" else ""

        def profile(name=None):
            if name:
                prof["now"] = name
            return prof["now"]
        timers = lambda action: calls.append(("timer", action))
        changed = games.set_game_mode(True, gs, profile, timers)
        self.assertIn("Performance power mode", changed)
        self.assertEqual(prof["now"], "performance")
        self.assertTrue(games.game_mode_on())
        self.assertEqual(games.set_game_mode(True, gs, profile, timers), [])
        games.set_game_mode(False, gs, profile, timers)
        self.assertEqual(prof["now"], "balanced")
        self.assertFalse(games.game_mode_on())
        self.assertIn(("set", "org.gnome.desktop.notifications", "show-banners", "true"), calls)
        self.assertEqual([c for c in calls if c[0] == "timer"], [("timer", "stop"), ("timer", "start")])


class Updater(unittest.TestCase):
    LIST = """Listing...
aphelion/orbit 1.1.1 amd64 [upgradable from: 1.1.0]
libssl3t64/trixie-security 3.5.1-1+deb13u1 amd64 [upgradable from: 3.5.1-1]
orbit-apps/orbit 2.0.0.5 all [upgradable from: 2.0.0.3]
nano/trixie 8.4-2 amd64 [upgradable from: 8.4-1]
"""
    HISTORY = """
Start-Date: 2026-10-30  03:10:01
Commandline: /usr/bin/unattended-upgrade
Upgrade: orbit-apps:amd64 (2.0.0.3, 2.0.0.5), aphelion:amd64 (1.1.0, 1.1.1)
End-Date: 2026-10-30  03:10:40

Start-Date: 2026-10-30  19:00:00
Commandline: apt-get -y full-upgrade
Install: gamemode:amd64 (1.8.2-1, automatic)
Upgrade: nano:amd64 (8.4-1, 8.4-2)
Error: Sub-process /usr/bin/dpkg returned an error code (1)
End-Date: 2026-10-30  19:00:09
"""

    def test_upgradable(self):
        u = updater.parse_upgradable(self.LIST)
        self.assertEqual([(x["name"], x["kind"]) for x in u],
                         [("aphelion", "orbit"), ("orbit-apps", "orbit"), ("libssl3t64", "security"),
                          ("nano", "system")])
        self.assertEqual(u[0]["old"], "1.1.0")

    def test_history_and_summary(self):
        runs = updater.parse_history(self.HISTORY)
        self.assertEqual(len(runs), 2)
        self.assertEqual(runs[0]["upgraded"], ["orbit-apps", "aphelion"])
        self.assertEqual(runs[1]["installed"], ["gamemode"])
        self.assertTrue(runs[1]["error"])
        self.assertEqual(updater.summary(["aphelion", "orbit-apps"]), "Aphelion and Orbit apps")
        self.assertEqual(updater.summary(["a", "b", "c", "d", "e"]), "a, b, c and 2 more")

    def test_background_says_each_thing_once(self):
        runs = updater.parse_history(self.HISTORY)
        ups = updater.parse_upgradable(self.LIST)
        ev, st = updater.background_events(ups, runs[:1], {})
        self.assertEqual([t for t, _ in ev], ["4 updates ready"])  # first run: no old history replayed
        self.assertIn("1 security fix", ev[0][1])
        ev, st = updater.background_events(ups, runs[:1], st)
        self.assertEqual(ev, [])
        ev, st = updater.background_events([], runs, st)
        self.assertEqual([t for t, _ in ev], ["Updates didn’t finish"])
        ev, _ = updater.background_events([], runs, dict(st, last_end=runs[0]["start"]))
        self.assertEqual(ev[0][0], "Orbit updated 2 packages")
        self.assertIn("Aphelion", ev[0][1])
        ev, _ = updater.background_events([], runs, dict(st, last_end=runs[0]["start"], window_upgrading=True))
        self.assertEqual(ev, [])


class WinApps(unittest.TestCase):
    def setUp(self):
        self.d = pathlib.Path(tempfile.mkdtemp(dir=TMP))

    def pe(self, name, machine):
        head = bytearray(512)
        head[0:2] = b"MZ"
        head[60:64] = (128).to_bytes(4, "little")
        head[128:132] = b"PE\0\0"
        head[132:134] = machine.to_bytes(2, "little")
        p = self.d / name
        p.write_bytes(bytes(head))
        return p

    def test_bitness_and_argv(self):
        x86, x64 = self.pe("Setup.EXE", 0x14c), self.pe("app.exe", 0x8664)
        (self.d / "notes.txt").write_text("MZ? no")
        self.assertTrue(winapps.is_32bit(x86))
        self.assertFalse(winapps.is_32bit(x64))
        self.assertIsNone(winapps.is_32bit(self.d / "notes.txt"))
        self.assertEqual(winapps.run_argv(x86), ["wine", "start", "/unix", str(x86.resolve())])
        self.assertEqual(winapps.run_argv(self.d / "Office.msi")[:3], ["wine", "msiexec", "/i"])
        with self.assertRaises(ValueError):
            winapps.run_argv(self.d / "notes.txt")

    def test_explain_failure(self):
        x86 = self.pe("setup.exe", 0x14c)
        self.assertIn("isn’t installed", winapps.explain_failure(x86, {"wine": False, "wine32": False}))
        self.assertIn("32-bit", winapps.explain_failure(x86, {"wine": True, "wine32": False}))
        self.assertIsNone(winapps.explain_failure(x86, {"wine": True, "wine32": True}))
        self.assertIsNone(winapps.explain_failure(self.pe("x.exe", 0x8664), {"wine": True, "wine32": False}))

    def test_library_skips_uninstallers(self):
        m = self.d / "Programs/Notepad++"
        m.mkdir(parents=True)
        (m / "Notepad++.desktop").write_text("[Desktop Entry]\nName=Notepad++\nExec=wine x\nIcon=ABCD_notepad\n")
        (m / "Uninstall.desktop").write_text("[Desktop Entry]\nName=Uninstall Notepad++\nExec=wine u\n")
        self.assertEqual([a["name"] for a in winapps.library(self.d / "Programs")], ["Notepad++"])
        self.assertEqual(winapps.library(self.d / "missing"), [])


class Sharing(unittest.TestCase):
    def setUp(self):
        self.home = pathlib.Path(tempfile.mkdtemp(dir=TMP))
        for d in ("Music", "Projects/Game", ".ssh"):
            (self.home / d).mkdir(parents=True)

    def test_validate(self):
        ok = sharing.validate([{"name": "Music", "path": str(self.home / "Music"), "writable": 0},
                               {"name": "Game files", "path": str(self.home / "Projects/Game"), "writable": 1}],
                              self.home)
        self.assertEqual([s["writable"] for s in ok], [False, True])
        bad = [
            [{"name": "Etc", "path": "/etc"}],
            [{"name": "Keys", "path": str(self.home / ".ssh")}],
            [{"name": "x", "path": str(self.home / "Music/../../..")}],
            [{"name": "IPC$", "path": str(self.home / "Music")}],
            [{"name": "a]\npath = /", "path": str(self.home / "Music")}],
            [{"name": "Music", "path": "Music"}],
            [{"name": "Dup", "path": str(self.home / "Music")}, {"name": "dup", "path": str(self.home / "Music")}],
        ]
        for b in bad:
            with self.assertRaises(sharing.ShareError, msg=b):
                sharing.validate(b, self.home)
        (self.home / "Music/out").symlink_to("/etc")
        with self.assertRaises(sharing.ShareError):
            sharing.validate([{"name": "Out", "path": str(self.home / "Music/out")}], self.home)

    def test_conf_and_names(self):
        text = sharing.conf_text([{"name": "Music", "path": "/home/a/Music", "writable": False}], "a")
        self.assertIn("[Music]", text)
        self.assertIn("valid users = a", text)
        self.assertIn("read only = yes", text)
        self.assertIn("guest ok = no", text)
        self.assertIn("follow symlinks = no", text)
        self.assertEqual(sharing.suggest_name("/x/My Photos!", ["My Photos"]), "My Photos 2")
        self.assertEqual(sharing.suggest_name("/x/.."), "Shared")
        self.assertFalse(sharing.password_ok("short"))
        self.assertFalse(sharing.password_ok("long enough\nx"))
        self.assertTrue(sharing.password_ok("long enough"))


class Sync(unittest.TestCase):
    ID = "FIDKJCU-RDTAAK4-ABCDEFG-HIJKLMN-OPQRSTU-VWXYZ23-4567ABC-DEFGHIJ"

    def test_ids(self):
        self.assertEqual(sync.normalize_id(self.ID.lower().replace("-", " ")), self.ID)
        self.assertEqual(sync.normalize_id(self.ID.replace("-", "")), self.ID)
        self.assertIsNone(sync.normalize_id("hello"))
        self.assertIsNone(sync.normalize_id(self.ID[:-1] + "1"))  # 1 is not base32

    def test_api_key_and_configs(self):
        d = pathlib.Path(tempfile.mkdtemp(dir=TMP))
        (d / "config.xml").write_text("<configuration><gui><apikey>k3y</apikey></gui></configuration>")
        self.assertEqual(sync.api_key([d / "none", d]), "k3y")
        self.assertIsNone(sync.api_key([d / "none"]))
        f = sync.folder_config("orbit-notes", "/h/Notes", [self.ID], "Notes")
        self.assertEqual(f["devices"], [{"deviceID": self.ID}])
        self.assertEqual(f["versioning"]["type"], "trashcan")
        self.assertFalse(sync.device_config(self.ID, "Laptop")["autoAcceptFolders"])

    def test_client_without_key(self):
        with self.assertRaises(sync.SyncError):
            sync.Client(key=None, base="http://127.0.0.1:9").my_id()  # no Syncthing config in this HOME


if __name__ == "__main__":
    unittest.main(verbosity=1)
