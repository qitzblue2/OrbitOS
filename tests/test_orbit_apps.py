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

from orbit import backup, catalog, fileops, hardware, notes, spaces  # noqa: E402


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


if __name__ == "__main__":
    unittest.main(verbosity=1)
