"""GTK-free logic behind Orbit Games: the library, graphics drivers, Game Mode.

Game Mode is a bundle of things that each undo cleanly: the Performance power
profile, notifications held back (Do Not Disturb), and the Orbit background
jobs paused. Whatever was set before is saved and put back when it's turned off.
"""
import configparser
import json
import os
import pathlib
import shutil
import subprocess

from . import paths

HELPER = "/usr/lib/orbit-os/orbit-games-helper"
STATE_FILE = paths.STATE / "game-mode.json"
APP_DIRS = [pathlib.Path("/usr/share/applications"), pathlib.Path("/usr/local/share/applications"),
            pathlib.Path("/var/lib/flatpak/exports/share/applications"),
            paths.HOME / ".local/share/flatpak/exports/share/applications",
            paths.HOME / ".local/share/applications"]
# shown as stores/launchers, above the games themselves
LAUNCHERS = {"steam.desktop", "com.valvesoftware.Steam.desktop", "net.lutris.Lutris.desktop",
             "com.heroicgameslauncher.hgl.desktop", "com.usebottles.bottles.desktop"}
VENDORS = {"0x10de": "NVIDIA", "0x1002": "AMD", "0x8086": "Intel"}


def _entry(path):
    cp = configparser.ConfigParser(interpolation=None, strict=False)
    cp.optionxform = str
    try:
        cp.read(path, encoding="utf-8")
    except (configparser.Error, UnicodeDecodeError):
        return None
    return dict(cp["Desktop Entry"]) if cp.has_section("Desktop Entry") else None


def library(dirs=None):
    """[{id, name, icon, comment, launcher}] for installed games and game stores, launchers first."""
    found = {}
    for d in dirs or APP_DIRS:
        if not d.is_dir():
            continue
        for f in d.glob("*.desktop"):
            e = _entry(f)
            if not e or e.get("Type", "Application") != "Application":
                continue
            if e.get("NoDisplay") == "true" or e.get("Hidden") == "true":
                found.pop(f.name, None)  # a user copy that hides a system entry
                continue
            cats = [c for c in e.get("Categories", "").split(";") if c]
            if f.name.startswith("orbit-") or ("Game" not in cats and f.name not in LAUNCHERS):
                continue
            found[f.name] = {"id": f.name, "name": e.get("Name", f.stem), "icon": e.get("Icon", "applications-games"),
                             "comment": e.get("Comment", ""), "launcher": f.name in LAUNCHERS}
    return sorted(found.values(), key=lambda g: (not g["launcher"], g["name"].lower()))


def gpus(sys_root="/sys"):
    """['AMD', 'NVIDIA', ...] for every graphics card the kernel sees."""
    out = []
    for card in sorted(pathlib.Path(sys_root).glob("class/drm/card[0-9]")):
        try:
            v = (card / "device/vendor").read_text().strip()
        except OSError:
            continue
        name = VENDORS.get(v, v)
        if name not in out:
            out.append(name)
    return out


def nvidia_driver_loaded(proc="/proc"):
    return pathlib.Path(proc, "driver/nvidia/version").exists()


def has_32bit(dpkg_dir="/var/lib/dpkg"):
    """True when Debian's 32-bit (i386) packages are enabled; Steam needs them."""
    try:
        return "i386" in pathlib.Path(dpkg_dir, "arch").read_text().split()
    except OSError:
        return False


def is_installed(cmd):
    return shutil.which(cmd) is not None


def ready(dpkg_dir="/var/lib/dpkg"):
    """{'32bit', 'steam', 'gamemode', 'mangohud'} -> bool."""
    return {"32bit": has_32bit(dpkg_dir), "steam": is_installed("steam"),
            "gamemode": is_installed("gamemoderun"), "mangohud": is_installed("mangohud")}


def setup_argv():
    return ["pkexec", HELPER, "setup"]


def launch_options(state):
    """The Steam launch options that turn on what is installed."""
    parts = [p for p, ok in (("gamemoderun", state.get("gamemode")), ("mangohud", state.get("mangohud"))) if ok]
    return " ".join(parts + ["%command%"])


# ---------------------------------------------------------------- Game Mode
def _gs(*args):
    try:
        r = subprocess.run(["gsettings", *args], capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return r.stdout.strip() if r.returncode == 0 else None


def _profile(name=None):
    try:
        if name is None:
            r = subprocess.run(["powerprofilesctl", "get"], capture_output=True, text=True, timeout=5)
            return r.stdout.strip() if r.returncode == 0 else None
        subprocess.run(["powerprofilesctl", "set", name], capture_output=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return name


def _user_timers(action):
    subprocess.run(["systemctl", "--user", action, "orbit-inbox-sorter.timer"], capture_output=True, timeout=10)


def game_mode_on():
    return STATE_FILE.exists()


def set_game_mode(on, gs=_gs, profile=_profile, timers=_user_timers):
    """Turn Game Mode on or off. Returns what changed, for the toast."""
    if on:
        if STATE_FILE.exists():
            return []
        saved = {"profile": profile(), "banners": gs("get", "org.gnome.desktop.notifications", "show-banners")}
        paths.ensure(STATE_FILE.parent)
        STATE_FILE.write_text(json.dumps(saved))
        changed = []
        if saved["profile"] and saved["profile"] != "performance" and profile("performance"):
            changed.append("Performance power mode")
        gs("set", "org.gnome.desktop.notifications", "show-banners", "false")
        changed.append("notifications held back")
        timers("stop")
        changed.append("background jobs paused")
        return changed
    try:
        saved = json.loads(STATE_FILE.read_text())
    except (OSError, ValueError):
        saved = {}
    if saved.get("profile"):
        profile(saved["profile"])
    gs("set", "org.gnome.desktop.notifications", "show-banners", saved.get("banners") or "true")
    timers("start")
    try:
        os.unlink(STATE_FILE)
    except OSError:
        pass
    return ["everything back to normal"]
