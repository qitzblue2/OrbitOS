"""Orbit Store catalog: a curated list of apps from Ubuntu's archive or Flathub.

Only packages listed in the catalog can be installed through the privileged
helper (/usr/lib/orbit-os/orbit-store-helper re-checks the catalog itself).
"""
import json
import pathlib
import re
import shutil
import subprocess

CATALOG_PATHS = [pathlib.Path("/usr/share/orbit-os/store-catalog.json"),
                 pathlib.Path(__file__).resolve().parents[2] / "data" / "store-catalog.json"]
APT_NAME = re.compile(r"^[a-z0-9][a-z0-9+.-]{1,62}$")
FLATPAK_ID = re.compile(r"^[A-Za-z][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+){2,}$")


def load():
    for p in CATALOG_PATHS:
        if p.is_file():
            data = json.loads(p.read_text())
            return [validate(a) for a in data["apps"]], data.get("categories", [])
    raise FileNotFoundError("store catalog missing")


def validate(a):
    src = a["source"]
    if src == "apt":
        for pkg in a["packages"]:
            if not APT_NAME.match(pkg):
                raise ValueError(f"bad apt package name {pkg!r}")
    elif src == "flathub":
        if not FLATPAK_ID.match(a["id"]):
            raise ValueError(f"bad flatpak id {a['id']!r}")
    else:
        raise ValueError(f"unknown source {src!r}")
    return a


def search(apps, query="", category=None):
    q = query.lower().strip()
    out = []
    for a in apps:
        if category and category != "All" and a["category"] != category:
            continue
        hay = " ".join([a["name"], a["summary"], a.get("description", ""), " ".join(a.get("keywords", []))]).lower()
        if q and q not in hay:
            continue
        out.append(a)
    return sorted(out, key=lambda a: (not a.get("featured", False), a["name"].lower()))


def installed_apt(packages, run=subprocess.run):
    if not shutil.which("dpkg-query"):
        return False
    r = run(["dpkg-query", "-W", "-f=${db:Status-Abbrev}\n", *packages], capture_output=True, text=True)
    lines = [l for l in r.stdout.splitlines() if l.strip()]
    return len(lines) == len(packages) and all(l.startswith("ii") for l in lines)


def installed_flatpak(app_id, run=subprocess.run):
    if not shutil.which("flatpak"):
        return False
    r = run(["flatpak", "info", app_id], capture_output=True, text=True)
    return r.returncode == 0


def is_installed(a, run=subprocess.run):
    return installed_apt(a["packages"], run) if a["source"] == "apt" else installed_flatpak(a["id"], run)


def installed_map(apps, run=subprocess.run):
    """{app name: bool} with one dpkg-query and one flatpak call for the whole catalog."""
    out = {}
    apt_pkgs = sorted({p for a in apps if a["source"] == "apt" for p in a["packages"]})
    status = {}
    if apt_pkgs and shutil.which("dpkg-query"):
        r = run(["dpkg-query", "-W", "-f=${Package} ${db:Status-Abbrev}\n", *apt_pkgs],
                capture_output=True, text=True)
        for line in r.stdout.splitlines():
            parts = line.split()
            if len(parts) >= 2:
                status[parts[0]] = parts[1].startswith("ii")
    flat = set()
    if any(a["source"] == "flathub" for a in apps) and shutil.which("flatpak"):
        r = run(["flatpak", "list", "--app", "--columns=application"], capture_output=True, text=True)
        flat = {l.strip() for l in r.stdout.splitlines() if l.strip()}
    for a in apps:
        if a["source"] == "apt":
            out[a["name"]] = all(status.get(p, False) for p in a["packages"])
        else:
            out[a["name"]] = a["id"] in flat
    return out


def flathub_enabled(run=subprocess.run):
    if not shutil.which("flatpak"):
        return False
    r = run(["flatpak", "remotes", "--columns=name"], capture_output=True, text=True)
    return "flathub" in r.stdout.split()


ENABLE_FLATHUB = ["flatpak", "remote-add", "--user", "--if-not-exists", "flathub",
                  "https://dl.flathub.org/repo/flathub.flatpakrepo"]


def action_command(a, action):
    """argv to install/remove an app. apt goes through the polkit helper; Flatpak is per-user."""
    if action not in ("install", "remove"):
        raise ValueError(action)
    if a["source"] == "apt":
        return ["pkexec", "/usr/lib/orbit-os/orbit-store-helper", action, *a["packages"]]
    if action == "install":
        return ["flatpak", "install", "--user", "--noninteractive", "-y", "flathub", a["id"]]
    return ["flatpak", "uninstall", "--user", "--noninteractive", "-y", a["id"]]


def launch_command(a):
    if a["source"] == "flathub":
        return ["flatpak", "run", a["id"]]
    return ["gtk-launch", a.get("desktop", a["packages"][0])]
