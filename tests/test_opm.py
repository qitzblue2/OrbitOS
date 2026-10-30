"""opm, the Orbit package manager: pack, install, upgrade, conflicts, removal, verify.

Run: python3 -m unittest tests/test_opm.py
"""
import importlib.machinery
import importlib.util
import io
import json
import os
import tarfile
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
_loader = importlib.machinery.SourceFileLoader("opm", os.path.join(HERE, "..", "core", "opm", "opm"))
_spec = importlib.util.spec_from_loader("opm", _loader)
opm = importlib.util.module_from_spec(_spec)
_loader.exec_module(opm)


def tree(base, files):
    for rel, text in files.items():
        p = os.path.join(base, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        if text.startswith("->"):
            os.symlink(text[2:], p)
        else:
            with open(p, "w") as f:
                f.write(text)


class Opm(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.root = os.path.join(self.tmp, "root")
        os.makedirs(self.root)
        self.quiet = lambda *_: None

    def make(self, name, version, files, depends=()):
        d = tempfile.mkdtemp(dir=self.tmp)
        tree(d, files)
        out = os.path.join(self.tmp, f"{name}-{version}.opk")
        opm.pack(d, out, name, version, depends)
        return out

    def test_install_list_files_verify_remove(self):
        p = self.make("hello", "1.0", {"usr/bin/hello": "#!/bin/sh\necho hi\n", "usr/bin/hi": "->hello"})
        opm.install(self.root, [p], out=self.quiet)
        self.assertEqual(open(os.path.join(self.root, "usr/bin/hello")).read(), "#!/bin/sh\necho hi\n")
        self.assertEqual(os.readlink(os.path.join(self.root, "usr/bin/hi")), "hello")
        self.assertIn("hello", opm.installed(self.root))
        self.assertEqual(opm.owners(self.root)["usr/bin/hello"], "hello")
        self.assertEqual(opm.verify(self.root, out=self.quiet), 0)
        with open(os.path.join(self.root, "usr/bin/hello"), "a") as f:
            f.write("tampered")
        self.assertEqual(opm.verify(self.root, out=self.quiet), 1)
        opm.remove(self.root, ["hello"], out=self.quiet)
        self.assertFalse(os.path.exists(os.path.join(self.root, "usr/bin/hello")))
        self.assertEqual(opm.installed(self.root), {})

    def test_hard_links_are_packed_as_files(self):
        d = tempfile.mkdtemp(dir=self.tmp)
        tree(d, {"tools/bin/ld": "linker"})
        os.link(os.path.join(d, "tools/bin/ld"), os.path.join(d, "tools/bin/ld.bfd"))
        out = os.path.join(self.tmp, "ld.opk")
        opm.pack(d, out, "binutils", "1")
        opm.install(self.root, [out], out=self.quiet)
        self.assertEqual(open(os.path.join(self.root, "tools/bin/ld.bfd")).read(), "linker")
        self.assertEqual(opm.verify(self.root, out=self.quiet), 0)

    def test_upgrade_drops_old_files(self):
        opm.install(self.root, [self.make("app", "1", {"usr/lib/app/a": "1", "usr/lib/app/old": "x"})], out=self.quiet)
        opm.install(self.root, [self.make("app", "2", {"usr/lib/app/a": "2"})], out=self.quiet)
        self.assertEqual(open(os.path.join(self.root, "usr/lib/app/a")).read(), "2")
        self.assertFalse(os.path.exists(os.path.join(self.root, "usr/lib/app/old")))
        self.assertEqual(opm.installed(self.root)["app"]["version"], "2")

    def test_file_conflict_refused(self):
        opm.install(self.root, [self.make("one", "1", {"usr/bin/tool": "1"})], out=self.quiet)
        with self.assertRaises(opm.OpmError):
            opm.install(self.root, [self.make("two", "1", {"usr/bin/tool": "2"})], out=self.quiet)
        self.assertEqual(open(os.path.join(self.root, "usr/bin/tool")).read(), "1")

    def test_dependencies(self):
        lib = self.make("libfoo", "1", {"usr/lib/libfoo.so": "x"})
        app = self.make("app", "1", {"usr/bin/app": "x"}, depends=["libfoo"])
        with self.assertRaises(opm.OpmError):
            opm.install(self.root, [app], out=self.quiet)
        opm.install(self.root, [lib, app], out=self.quiet)
        with self.assertRaises(opm.OpmError):
            opm.remove(self.root, ["libfoo"], out=self.quiet)
        opm.remove(self.root, ["app", "libfoo"], out=self.quiet)

    def test_damaged_and_unsafe_packages(self):
        good = self.make("pkg", "1", {"usr/share/pkg/data": "real"})
        bad = os.path.join(self.tmp, "bad.opk")
        with tarfile.open(good, "r:xz") as src, tarfile.open(bad, "w:xz") as dst:
            for m in src.getmembers():
                data = src.extractfile(m).read() if m.isfile() else None
                if m.name == "usr/share/pkg/data":
                    data = b"evil"
                    m.size = len(data)
                dst.addfile(m, io.BytesIO(data) if data is not None else None)
        with self.assertRaises(opm.OpmError):
            opm.install(self.root, [bad], out=self.quiet)
        self.assertFalse(os.path.exists(os.path.join(self.root, "usr/share/pkg/data")))
        escape = os.path.join(self.tmp, "escape.opk")
        meta = json.dumps({"format": 1, "name": "x", "version": "1", "depends": [], "dirs": [], "files": []}).encode()
        with tarfile.open(escape, "w:xz") as t:
            ti = tarfile.TarInfo(opm.META)
            ti.size = len(meta)
            t.addfile(ti, io.BytesIO(meta))
            ti = tarfile.TarInfo("../../etc/evil")
            ti.size = 1
            t.addfile(ti, io.BytesIO(b"x"))
        with self.assertRaises(opm.OpmError):
            opm.install(self.root, [escape], out=self.quiet)


if __name__ == "__main__":
    unittest.main()
