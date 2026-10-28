"""Spaces: Personal / Work / Study (and any you add).

A space bundles a folder under ~/Home/Spaces, a color, a wallpaper, the apps
pinned in the dock, and whether notifications show banners. Switching a space
applies all of it at once through gsettings. Config: ~/.config/orbit/spaces.json
"""
import json
import pathlib
import re
import subprocess

from . import paths

DEFAULT = [
    {"name": "Personal", "color": "#f28dc4", "wallpaper": "orbit-glass", "dnd": False,
     "apps": ["orbit-files.desktop", "firefox-esr.desktop", "orbit-notes.desktop", "org.gnome.Totem.desktop"]},
    {"name": "Work", "color": "#5aa6ff", "wallpaper": "orbit-graphite", "dnd": True,
     "apps": ["orbit-files.desktop", "firefox-esr.desktop", "org.gnome.Terminal.desktop",
              "org.gnome.TextEditor.desktop", "libreoffice-writer.desktop", "org.gnome.Calendar.desktop"]},
    {"name": "Study", "color": "#4fd1c0", "wallpaper": "orbit-lagoon", "dnd": True,
     "apps": ["orbit-files.desktop", "firefox-esr.desktop", "orbit-notes.desktop", "org.gnome.Calculator.desktop"]},
]
WALLPAPER_DIR = pathlib.Path("/usr/share/backgrounds/orbit")
COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")


def config_file():
    return paths.CONFIG / "spaces.json"


def load():
    try:
        data = json.loads(config_file().read_text())
        spaces = [validate(s) for s in data.get("spaces", [])]
        return spaces or [dict(s) for s in DEFAULT], data.get("current")
    except (OSError, ValueError):
        return [dict(s) for s in DEFAULT], None


def save(spaces, current):
    paths.ensure(paths.CONFIG)
    tmp = config_file().with_suffix(".tmp")
    tmp.write_text(json.dumps({"spaces": spaces, "current": current}, indent=2))
    tmp.replace(config_file())


def validate(s):
    name = str(s.get("name", "")).strip()
    if not name or "/" in name or name in (".", ".."):
        raise ValueError(f"bad space name: {name!r}")
    color = s.get("color", "#888888")
    if not COLOR_RE.match(color):
        color = "#888888"
    apps = [a for a in s.get("apps", []) if isinstance(a, str) and a.endswith(".desktop")]
    wp = re.sub(r"[^A-Za-z0-9_.-]", "", str(s.get("wallpaper", "orbit-glass")))
    return {"name": name, "color": color, "wallpaper": wp or "orbit-glass",
            "dnd": bool(s.get("dnd", False)), "apps": apps}


def folder(space):
    return paths.orbit_home() / "Spaces" / space["name"]


def wallpaper_uri(space):
    p = pathlib.Path(space["wallpaper"])
    if not p.is_absolute():
        p = WALLPAPER_DIR / f"{space['wallpaper']}.png"
    return p.as_uri()


def apply_commands(space):
    """The gsettings calls that switch to `space` (pure: returns argv lists)."""
    apps = "[" + ", ".join(f"'{a}'" for a in space["apps"]) + "]"
    uri = wallpaper_uri(space)
    return [
        ["gsettings", "set", "org.gnome.shell", "favorite-apps", apps],
        ["gsettings", "set", "org.gnome.desktop.background", "picture-uri", uri],
        ["gsettings", "set", "org.gnome.desktop.background", "picture-uri-dark", uri],
        ["gsettings", "set", "org.gnome.desktop.notifications", "show-banners",
         "false" if space["dnd"] else "true"],
    ]


def switch(name, run=None):
    run = run or subprocess.run
    spaces, _ = load()
    match = [s for s in spaces if s["name"].lower() == name.lower()]
    if not match:
        raise KeyError(f"no space named {name!r}; have: {', '.join(s['name'] for s in spaces)}")
    space = match[0]
    folder(space).mkdir(parents=True, exist_ok=True)
    for argv in apply_commands(space):
        run(argv, check=False)
    save(spaces, space["name"])
    return space
