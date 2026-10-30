"""GTK-free logic behind Orbit Windows Apps: run .exe/.msi files with Wine.

Wine keeps a pretend Windows drive in ~/.wine (drive_c is C:). Programs
installed there get start-menu entries that Wine itself exports to
~/.local/share/applications/wine/Programs, which is what the library lists.
"""
import configparser
import pathlib
import shutil
import subprocess

from . import paths

HELPER = "/usr/lib/orbit-os/orbit-windows-helper"
PREFIX = paths.HOME / ".wine"
MENU = paths.HOME / ".local/share/applications/wine/Programs"
WINE32_MARKERS = [pathlib.Path("/usr/lib/wine/wine"),               # Debian's wine32 loader
                  pathlib.Path("/usr/lib/i386-linux-gnu/wine")]
# Windows programs that are uninstallers, readmes or web links clutter the list
NOISE = ("uninstall", "uninst", "readme", "website", "help", "license", "manual", "release notes")


def ready():
    """{'wine': 64-bit Windows programs, 'wine32': 32-bit ones (most installers)}."""
    return {"wine": shutil.which("wine") is not None,
            "wine32": any(p.exists() for p in WINE32_MARKERS)}


def kind(path):
    """'msi', 'exe', 'bat' or None for things Orbit can run with Wine."""
    ext = pathlib.Path(path).suffix.lower()
    return {".exe": "exe", ".msi": "msi", ".bat": "bat", ".cmd": "bat", ".lnk": "lnk"}.get(ext)


def is_32bit(path):
    """True for a 32-bit Windows program (PE machine i386), False for 64-bit, None if unknown."""
    try:
        with open(path, "rb") as f:
            head = f.read(4096)
    except OSError:
        return None
    if head[:2] != b"MZ" or len(head) < 64:
        return None
    pe = int.from_bytes(head[60:64], "little")
    if pe + 6 > len(head) or head[pe:pe + 4] != b"PE\0\0":
        return None
    machine = int.from_bytes(head[pe + 4:pe + 6], "little")
    return {0x14c: True, 0x8664: False, 0xaa64: False}.get(machine)


def run_argv(path):
    """argv that runs a Windows file the way double-clicking it does on Windows."""
    k = kind(path)
    if k is None:
        raise ValueError(f"not a Windows program: {path}")
    p = str(pathlib.Path(path).resolve())
    if k == "msi":
        return ["wine", "msiexec", "/i", p]
    return ["wine", "start", "/unix", p]


def library(menu=None):
    """[{'name', 'icon', 'desktop', 'exec'}] for Windows programs installed under Wine."""
    out = {}
    root = pathlib.Path(menu or MENU)
    for f in sorted(root.rglob("*.desktop")) if root.is_dir() else []:
        cp = configparser.ConfigParser(interpolation=None, strict=False)
        cp.optionxform = str
        try:
            cp.read(f, encoding="utf-8")
            e = cp["Desktop Entry"]
        except (configparser.Error, KeyError, UnicodeDecodeError):
            continue
        name = e.get("Name", f.stem)
        if any(n in name.lower() for n in NOISE) or name in out:
            continue
        out[name] = {"name": name, "icon": e.get("Icon", "application-x-ms-dos-executable"),
                     "desktop": str(f), "exec": e.get("Exec", "")}
    return sorted(out.values(), key=lambda a: a["name"].lower())


def c_drive():
    return PREFIX / "drive_c"


def setup_argv():
    return ["pkexec", HELPER, "setup"]


def explain_failure(path, state):
    """Plain-language reason a Windows program didn't start, or None."""
    if not state.get("wine"):
        return "Windows support isn’t installed yet. Use Set Up in Windows Apps."
    if is_32bit(path) and not state.get("wine32"):
        return "This is a 32-bit Windows program. Turn on full Windows support in Windows Apps first."
    return None


def start(path):
    """Run a Windows file detached; returns the Popen (or raises OSError)."""
    return subprocess.Popen(run_argv(path), start_new_session=True,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
