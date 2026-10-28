#!/usr/bin/env python3
"""Screenshot every Orbit app with the real Orbit theme, icons and demo files.

  python3 tests/gui/screenshots.py OUTDIR [app ...]

Needs: xvfb-run, dbus-run-session, python3-gi + GTK 4 + libadwaita 1.5 (Ubuntu 24.04).
Each app runs in its own process with a throwaway HOME; a scenario drives the
window (navigate, select, open panes) and the harness saves PNGs. The run fails
if any scenario raises, so this doubles as a GUI smoke test.
"""
import os
import pathlib
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
PY = os.environ.get("ORBIT_GUI_PYTHON", "python3")


def prepare_home(style="graphite"):
    home = pathlib.Path(tempfile.mkdtemp(prefix="orbit-shots-"))
    sys.path.insert(0, str(ROOT / "tests/gui"))
    import demo_home
    demo_home.make(home)
    share = home / ".local/share"
    subprocess.run([PY, str(ROOT / "branding/generate.py"), "--out", str(home / "brand"), "--wallpaper-size",
                    "1280x720"], check=True, capture_output=True)
    subprocess.run([PY, str(ROOT / "icons/generate_icons.py"), "--out", str(share / "icons")], check=True,
                   capture_output=True)
    (share / "themes").mkdir(parents=True)
    for t in (home / "brand/themes").iterdir():
        t.rename(share / "themes" / t.name)
    gtk4 = home / ".config/gtk-4.0"
    gtk4.mkdir(parents=True)
    theme = "Orbit-light" if style == "light" else "Orbit-graphite"
    (gtk4 / "gtk.css").write_text(f'@import url("file://{share}/themes/{theme}/gtk-4.0/gtk.css");\n')
    (gtk4 / "settings.ini").write_text("[Settings]\ngtk-icon-theme-name=orbit\ngtk-font-name=Inter 10\n")
    return home


def main():
    out = pathlib.Path(sys.argv[1]).resolve()
    only = sys.argv[2:]
    scen = sorted((ROOT / "tests/gui/scenarios").glob("*.py"))
    failed = []
    for s in scen:
        if only and s.stem not in only:
            continue
        for style in ("graphite",):
            home = prepare_home(style)
            env = dict(os.environ, HOME=str(home), XDG_CONFIG_HOME=str(home / ".config"),
                       XDG_DATA_HOME=str(home / ".local/share"), XDG_STATE_HOME=str(home / ".local/state"),
                       GSK_RENDERER="cairo", GDK_BACKEND="x11", GTK_A11Y="none", NO_AT_BRIDGE="1",
                       ADW_DEBUG_COLOR_SCHEME="prefer-light" if style == "light" else "prefer-dark",
                       ORBIT_TOKENS=str(ROOT / "branding/tokens.json"), LANG="C.UTF-8")
            r = subprocess.run(["xvfb-run", "-a", "-s", "-screen 0 1600x1000x24", "dbus-run-session", PY,
                                str(s), str(out)], env=env, capture_output=True, text=True, timeout=180)
            ok = r.returncode == 0 and "SCENARIO OK" in r.stdout
            print(f"{'ok  ' if ok else 'FAIL'} {s.stem}")
            if not ok:
                failed.append(s.stem)
                print(r.stdout[-3000:], r.stderr[-3000:])
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
