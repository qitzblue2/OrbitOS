#!/usr/bin/env python3
"""Click through the Orbit installer (dry run, fake Windows laptop) and save screenshots.

    xvfb-run -a python3 tests/gui/installer_shots.py OUTDIR
"""
import json
import os
import pathlib
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
SRC = ROOT / "packages/orbit-installer/src"
sys.path.insert(0, str(SRC))
sys.path.insert(0, str(ROOT / "tests"))

from test_installer_plan import windows_laptop  # noqa: E402
from orbit_installer.engine import disk_json  # noqa: F401,E402

fixture = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
d = windows_laptop()
json.dump({"firmware": "uefi", "disks": [{
    "path": d.path, "size": d.size, "model": "Samsung SSD 980 PRO", "table": d.table, "sector": d.sector,
    "first_usable": d.first_usable, "last_usable": d.last_usable,
    "parts": [p.__dict__ for p in d.parts]}]}, fixture)
fixture.close()
os.environ.update(ORBIT_INSTALLER_DRY="1", ORBIT_INSTALLER_FIXTURE=fixture.name,
                  PYTHONPATH=f"{SRC}:{os.environ.get('PYTHONPATH', '')}")

import harness  # noqa: E402  (after the env, it imports Gtk)
from orbit_installer import app as A  # noqa: E402
from orbit_installer import engine as E  # noqa: E402
from gi.repository import Adw  # noqa: E402

E.TARGET = tempfile.mkdtemp(prefix="orbit-dry-target-")
OUT = sys.argv[1] if len(sys.argv) > 1 else "installer-shots"
application = Adw.Application(application_id="org.orbitos.InstallerTest")
application.connect("activate", lambda a: A.Window(a).present())


def w(fn):
    return lambda win: fn(win)


def wait(cond, name):
    def step(win):
        if not cond(win):
            raise harness.Retry(name)
    return step


steps = [
    (None, w(lambda win: None)),
    ("01-welcome", w(lambda win: None)),
    (None, w(lambda win: win.forward())),
    ("02-keyboard", w(lambda win: None)),
    (None, w(lambda win: win.forward())),
    (None, wait(lambda win: win.probe is not None, "probe")),
    ("03-disk-alongside", w(lambda win: None)),
    (None, w(lambda win: (win.choice.update(mode="erase"), win.draw_disks()))),
    ("04-disk-erase", w(lambda win: None)),
    (None, w(lambda win: (win.choice.update(mode="alongside", encrypt=True), win.draw_disks(),
                          win.key1.set_text("orbit-secret"), win.key2.set_text("orbit-secret")))),
    ("05-disk-encrypt", w(lambda win: None)),
    (None, w(lambda win: win.forward())),
    (None, w(lambda win: (win.e_name.set_text("Sam Visser"), win.e_pw1.set_text("orbit123"), win.e_pw2.set_text("orbit123")))),
    ("06-account", w(lambda win: None)),
    (None, w(lambda win: win.forward())),
    (None, w(lambda win: setattr(win, "zone", "Europe/Amsterdam"))),
    ("07-timezone", w(lambda win: None)),
    (None, w(lambda win: win.forward())),
    (None, wait(lambda win: win.plan is not None, "plan")),
    ("08-review", w(lambda win: None)),
    (None, w(lambda win: win.forward())),
    (None, wait(lambda win: win.pbar.get_fraction() > 0.3, "progress")),
    ("09-progress", w(lambda win: None)),
    (None, wait(lambda win: win.stack.get_visible_child_name() == "done", "done")),
    ("10-done", w(lambda win: None)),
]
sys.exit(harness.run(application, steps, OUT))
