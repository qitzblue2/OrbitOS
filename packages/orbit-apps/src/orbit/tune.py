"""GTK-free logic behind Orbit Optimizer and Orbit Performance.

Optimizer: what can be cleaned (sizes first, nothing deleted until asked) and
which apps start at login. Performance: CPU, memory and temperature read
straight from /proc and /sys, the heaviest apps, and the power profile.
"""
import configparser
import os
import pathlib
import shutil
import subprocess

from . import paths

HOME = paths.HOME
CACHE = pathlib.Path(os.environ.get("XDG_CACHE_HOME", HOME / ".cache"))
DATA_HOME = pathlib.Path(os.environ.get("XDG_DATA_HOME", HOME / ".local/share"))
HELPER = "/usr/lib/orbit-os/orbit-tune-helper"


# ---------------------------------------------------------------- sizes
def dir_size(path):
    """Bytes used by a file or folder (symlinks not followed, unreadable parts skipped)."""
    p = pathlib.Path(path)
    try:
        if p.is_symlink() or p.is_file():
            return p.lstat().st_size
    except OSError:
        return 0
    total = 0
    for root, dirs, files in os.walk(p, onerror=lambda _e: None):
        for name in files:
            try:
                total += os.lstat(os.path.join(root, name)).st_size
            except OSError:
                pass
    return total


def empty_dir(path, keep=()):
    """Delete everything inside path (not path itself), except the names in keep. Returns bytes freed."""
    p = pathlib.Path(path)
    if not p.is_dir() or p.is_symlink():
        return 0
    freed = 0
    for child in p.iterdir():
        if child.name in keep:
            continue
        size = dir_size(child)
        try:
            if child.is_dir() and not child.is_symlink():
                shutil.rmtree(child)
            else:
                child.unlink()
            freed += size
        except OSError:
            pass
    return freed


# ---------------------------------------------------------------- cleanup
# id, title, explanation, where (user) or helper action (system)
USER_TARGETS = [
    ("cache", "App caches", "Temporary files apps rebuild when needed", CACHE, ("thumbnails",)),
    ("thumbnails", "Thumbnails", "Picture previews; remade when you open a folder", CACHE / "thumbnails", ()),
    ("trash", "Trash", "Files you deleted", DATA_HOME / "Trash", ()),
]
SYSTEM_TARGETS = [
    ("apt", "Downloaded updates", "Installer files kept after updates", "/var/cache/apt/archives"),
    ("journal", "Old system logs", "Keeps the last 50 MB of logs", "/var/log/journal"),
    ("crash", "Crash reports", "Saved crash dumps", "/var/crash"),
    ("autoremove", "Unused packages", "Libraries nothing needs any more", None),
]


def scan():
    """[{id, title, detail, size, system}] for everything the Optimizer can clean."""
    out = []
    for tid, title, detail, where, keep in USER_TARGETS:
        size = dir_size(where) - sum(dir_size(pathlib.Path(where) / k) for k in keep)
        out.append({"id": tid, "title": title, "detail": detail, "size": max(size, 0), "system": False})
    for tid, title, detail, where in SYSTEM_TARGETS:
        size = dir_size(where) if where else 0
        if tid == "journal":
            size = max(size - 50_000_000, 0)
        out.append({"id": tid, "title": title, "detail": detail, "size": size, "system": True})
    return out


def clean_user(tid):
    for t, _title, _detail, where, keep in USER_TARGETS:
        if t == tid:
            return empty_dir(where, keep)
    raise ValueError(f"unknown target {tid}")


def clean_system_argv(tids):
    """argv that cleans the system targets as root (through pkexec and the helper)."""
    allowed = {t[0] for t in SYSTEM_TARGETS}
    bad = [t for t in tids if t not in allowed]
    if bad:
        raise ValueError(f"unknown targets {bad}")
    return ["pkexec", HELPER, "clean", *tids]


# ---------------------------------------------------------------- startup apps
SYSTEM_AUTOSTART = [pathlib.Path("/etc/xdg/autostart")]
USER_AUTOSTART = paths.CONFIG.parent / "autostart"


def _read_desktop(path):
    cp = configparser.ConfigParser(interpolation=None, strict=False)
    cp.optionxform = str
    try:
        cp.read(path, encoding="utf-8")
    except (configparser.Error, UnicodeDecodeError):
        return None
    return dict(cp["Desktop Entry"]) if cp.has_section("Desktop Entry") else None


def _shown_in_desktop(e, desktop):
    only = [d for d in e.get("OnlyShowIn", "").split(";") if d]
    nots = [d for d in e.get("NotShowIn", "").split(";") if d]
    return (not only or desktop in only) and desktop not in nots


def autostart_apps(desktop="GNOME"):
    """[{id, name, comment, icon, enabled, user_only}] for apps that start at login.

    Orbit's own session helpers (orbit-*) are left out: turning them off breaks the desktop.
    """
    apps, in_system = {}, set()
    for d in [*SYSTEM_AUTOSTART, USER_AUTOSTART]:  # the user's copy overrides the system one
        if not d.is_dir():
            continue
        for f in sorted(d.glob("*.desktop")):
            e = _read_desktop(f)
            if e is None:
                continue
            apps[f.name] = e
            if d != USER_AUTOSTART:
                in_system.add(f.name)
    out = []
    for fid, e in sorted(apps.items()):
        if fid.startswith("orbit-") or not _shown_in_desktop(e, desktop):
            continue
        if e.get("X-GNOME-AutoRestart") == "true" or e.get("X-GNOME-Autostart-Phase"):
            continue  # parts of the GNOME session itself
        enabled = e.get("Hidden", "false") != "true" and e.get("X-GNOME-Autostart-enabled", "true") != "false"
        out.append({"id": fid, "name": e.get("Name", fid[:-8]), "comment": e.get("Comment", ""),
                    "icon": e.get("Icon", "application-x-executable"), "enabled": enabled,
                    "user_only": fid not in in_system})
    return out


def set_autostart(fid, enabled):
    """Turn an app's start-at-login on or off with a per-user override."""
    if "/" in fid or not fid.endswith(".desktop"):
        raise ValueError(fid)
    user = USER_AUTOSTART / fid
    src = user if user.exists() else next((d / fid for d in SYSTEM_AUTOSTART if (d / fid).exists()), None)
    if src is None:
        raise FileNotFoundError(fid)
    lines = src.read_text(encoding="utf-8").splitlines()
    lines = [ln for ln in lines if not ln.startswith(("Hidden=", "X-GNOME-Autostart-enabled="))]
    at = next((i + 1 for i, ln in enumerate(lines) if ln.strip() == "[Desktop Entry]"), len(lines))
    lines.insert(at, f"X-GNOME-Autostart-enabled={'true' if enabled else 'false'}")
    lines.insert(at, f"Hidden={'false' if enabled else 'true'}")
    paths.ensure(USER_AUTOSTART)
    user.write_text("\n".join(lines) + "\n", encoding="utf-8")


# ---------------------------------------------------------------- live stats
def read_cpu(stat="/proc/stat"):
    """(busy, total) jiffies over all CPUs."""
    with open(stat) as f:
        v = [int(x) for x in f.readline().split()[1:]]
    idle = v[3] + (v[4] if len(v) > 4 else 0)
    total = sum(v[:8])
    return total - idle, total


def cpu_percent(prev, cur):
    db, dt = cur[0] - prev[0], cur[1] - prev[1]
    return 0.0 if dt <= 0 else max(0.0, min(100.0, 100.0 * db / dt))


def read_memory(meminfo="/proc/meminfo"):
    """{'total', 'used', 'available', 'swap_total', 'swap_used'} in bytes."""
    m = {}
    with open(meminfo) as f:
        for line in f:
            k, _, rest = line.partition(":")
            m[k] = int(rest.split()[0]) * 1024
    total, avail = m.get("MemTotal", 0), m.get("MemAvailable", m.get("MemFree", 0))
    return {"total": total, "available": avail, "used": total - avail,
            "swap_total": m.get("SwapTotal", 0), "swap_used": m.get("SwapTotal", 0) - m.get("SwapFree", 0)}


def read_temperature(sys_root="/sys"):
    """Hottest CPU-ish sensor in °C, or None."""
    best = None
    root = pathlib.Path(sys_root)
    want = ("coretemp", "k10temp", "zenpower", "cpu", "acpitz", "x86_pkg_temp", "soc")
    for hw in root.glob("class/hwmon/hwmon*"):
        try:
            name = (hw / "name").read_text().strip()
        except OSError:
            continue
        if not name.startswith(want):
            continue
        for t in hw.glob("temp*_input"):
            try:
                c = int(t.read_text()) / 1000
            except (OSError, ValueError):
                continue
            if 0 < c < 130:
                best = c if best is None else max(best, c)
    if best is None:
        for z in root.glob("class/thermal/thermal_zone*"):
            try:
                c = int((z / "temp").read_text()) / 1000
            except (OSError, ValueError):
                continue
            if 0 < c < 130:
                best = c if best is None else max(best, c)
    return best


PAGE = os.sysconf("SC_PAGE_SIZE") if hasattr(os, "sysconf") else 4096


def read_processes(proc="/proc", uid=None):
    """{pid: {'name', 'cpu_ticks', 'rss', 'uid'}} for every readable process."""
    out = {}
    for d in pathlib.Path(proc).iterdir():
        if not d.name.isdigit():
            continue
        try:
            stat = (d / "stat").read_text()
            statm = (d / "statm").read_text().split()
            owner = d.stat().st_uid
        except OSError:
            continue
        if uid is not None and owner != uid:
            continue
        name = stat[stat.index("(") + 1:stat.rindex(")")]
        fields = stat[stat.rindex(")") + 2:].split()
        out[int(d.name)] = {"name": name, "cpu_ticks": int(fields[11]) + int(fields[12]),
                            "rss": int(statm[1]) * PAGE, "uid": owner}
    return out


def top_apps(prev, cur, seconds, limit=8, hz=None):
    """Group processes by name -> [{'name', 'cpu', 'rss', 'pids'}], heaviest first (CPU, then memory)."""
    hz = hz or (os.sysconf("SC_CLK_TCK") if hasattr(os, "sysconf") else 100)
    groups = {}
    for pid, p in cur.items():
        g = groups.setdefault(p["name"], {"name": p["name"], "cpu": 0.0, "rss": 0, "pids": []})
        before = prev.get(pid)
        if before and before["name"] == p["name"] and seconds > 0:
            g["cpu"] += 100.0 * max(p["cpu_ticks"] - before["cpu_ticks"], 0) / hz / seconds
        g["rss"] += p["rss"]
        g["pids"].append(pid)
    ranked = sorted(groups.values(), key=lambda g: (round(g["cpu"]), g["rss"]), reverse=True)
    return ranked[:limit]


# ---------------------------------------------------------------- power profile
PROFILES = [("power-saver", "Battery Saver", "Quieter and cooler, longest battery life"),
            ("balanced", "Balanced", "Fast when needed, efficient the rest of the time"),
            ("performance", "Performance", "Highest speed; uses more power and runs warmer")]


def power_profile():
    try:
        r = subprocess.run(["powerprofilesctl", "get"], capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return r.stdout.strip() if r.returncode == 0 else None


def available_profiles():
    try:
        r = subprocess.run(["powerprofilesctl", "list"], capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.TimeoutExpired):
        return []
    names = {ln.strip().lstrip("* ").rstrip(":") for ln in r.stdout.splitlines() if ln.strip().endswith(":")}
    return [p for p in PROFILES if p[0] in names]


def set_power_profile(name):
    if name not in {p[0] for p in PROFILES}:
        raise ValueError(name)
    return subprocess.run(["powerprofilesctl", "set", name], timeout=10).returncode == 0


# ---------------------------------------------------------------- advice
def advice(mem, temp, cpu, profile, startup_on, cleanable):
    """Plain-language tips from the current numbers. -> [(level, text)]"""
    tips = []
    if mem["total"] and mem["used"] / mem["total"] > 0.85:
        tips.append(("warn", "Memory is almost full. Close apps you don’t use; the heaviest are listed below."))
    if mem["swap_total"] and mem["swap_used"] / mem["swap_total"] > 0.5:
        tips.append(("warn", "A lot of memory is swapped out. More RAM or fewer open apps will make Orbit faster."))
    if temp is not None and temp >= 90:
        tips.append(("fail", f"The processor is very hot ({temp:.0f} °C). Check the vents aren’t blocked."))
    elif temp is not None and temp >= 80:
        tips.append(("warn", f"The processor is warm ({temp:.0f} °C)."))
    if cpu > 90:
        tips.append(("warn", "The processor is fully busy. See which app is using it below."))
    if profile == "power-saver":
        tips.append(("info", "Battery Saver is on, which slows Orbit down on purpose."))
    if startup_on > 6:
        tips.append(("info", f"{startup_on} apps start when you log in. Turning some off in Optimizer speeds up login."))
    if cleanable > 2_000_000_000:
        tips.append(("info", "More than 2 GB can be cleaned up in Optimizer."))
    return tips
