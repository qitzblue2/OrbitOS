"""Snapshot backups of ~/Home with rsync.

Each run creates DEST/orbit-backup/<host>/<YYYY-MM-DD_HHMMSS>/ . Unchanged files
are hard-linked to the previous snapshot (--link-dest), so every snapshot is a
complete, browsable copy but only changed files take new space.

Change detection is rsync's quick check (size + modification time), like most
backup tools: fast, but a same-size edit within the same second as the previous
backup is not seen until the file changes again.
"""
import datetime as dt
import json
import pathlib
import re
import shutil
import socket
import subprocess

from . import paths

SNAP_RE = re.compile(r"^\d{4}-\d{2}-\d{2}_\d{6}$")
DEFAULT_EXCLUDES = [".cache/", "*.tmp", "*.part", "*.crdownload", "node_modules/", ".venv/",
                    "__pycache__/", "Trash/"]
PROGRESS_RE = re.compile(r"^\s*([\d,]+)\s+(\d+)%\s+(\S+)\s+(\S+)")


def config_file():
    return paths.CONFIG / "backup.json"


def default_config():
    return {"destination": "", "sources": ["Documents", "Pictures", "Music", "Videos", "Projects",
                                           "Notes", "Spaces", "Desktop"],
            "excludes": list(DEFAULT_EXCLUDES), "keep": 10, "schedule": "off"}


def load_config():
    cfg = default_config()
    try:
        cfg.update(json.loads(config_file().read_text()))
    except (OSError, ValueError):
        pass
    cfg["keep"] = max(1, int(cfg.get("keep", 10)))
    return cfg


def save_config(cfg):
    paths.ensure(paths.CONFIG)
    config_file().write_text(json.dumps(cfg, indent=2))


def repo(dest, host=None):
    return pathlib.Path(dest) / "orbit-backup" / (host or socket.gethostname())


def snapshots(dest, host=None):
    r = repo(dest, host)
    if not r.is_dir():
        return []
    return sorted((p for p in r.iterdir() if p.is_dir() and SNAP_RE.match(p.name)), key=lambda p: p.name)


def snapshot_time(p):
    return dt.datetime.strptime(pathlib.Path(p).name, "%Y-%m-%d_%H%M%S")


def new_snapshot_name(now=None):
    return (now or dt.datetime.now()).strftime("%Y-%m-%d_%H%M%S")


def rsync_command(home, sources, dest, excludes, previous=None, target=None):
    """argv for one backup run. Sources are paths relative to `home`."""
    home = pathlib.Path(home)
    srcs = [s for s in sources if (home / s).exists()]
    if not srcs:
        raise ValueError("nothing to back up: none of the chosen folders exist")
    argv = ["rsync", "-aHAX", "--relative", "--delete", "--info=progress2", "--no-inc-recursive",
            "--partial-dir=.rsync-partial"]
    for e in excludes:
        argv += ["--exclude", e]
    if previous:
        argv.append(f"--link-dest={previous}")
    argv += [f"{home}/./{s}" for s in srcs]
    argv.append(str(target) + "/")
    return argv


def restore_command(snapshot, home, subpath=""):
    """Copy a snapshot (or part of it) back. Never deletes anything at the destination."""
    src = pathlib.Path(snapshot) / subpath
    dst = pathlib.Path(home) / subpath
    return ["rsync", "-aHAX", "--info=progress2", "--backup", "--suffix=.before-restore",
            f"{src}/" if src.is_dir() else str(src), f"{dst}/" if src.is_dir() else str(dst)]


def parse_progress(line):
    """'  1,234,567  42%   10.00MB/s    0:00:12' -> (bytes, percent)."""
    m = PROGRESS_RE.match(line)
    if not m:
        return None
    return int(m.group(1).replace(",", "")), int(m.group(2))


def prune_plan(snaps, keep):
    """Which snapshots to delete to keep the newest `keep`."""
    return list(snaps[:-keep]) if keep and len(snaps) > keep else []


def free_space(path):
    try:
        return shutil.disk_usage(path).free
    except OSError:
        return 0


def run_backup(cfg, home=None, progress=None, now=None, popen=subprocess.Popen):
    """Run one backup. Returns the snapshot path. Raises RuntimeError on rsync failure."""
    home = pathlib.Path(home or paths.orbit_home())
    dest = cfg["destination"]
    if not dest or not pathlib.Path(dest).is_dir():
        raise RuntimeError("choose a backup destination that exists (is the drive plugged in?)")
    if pathlib.Path(dest).resolve().is_relative_to(home.resolve()):
        raise RuntimeError("the backup destination cannot be inside the folders being backed up")
    snaps = snapshots(dest)
    target = repo(dest) / (new_snapshot_name(now) + ".in-progress")
    target.mkdir(parents=True, exist_ok=True)
    argv = rsync_command(home, cfg["sources"], dest, cfg["excludes"],
                         previous=snaps[-1] if snaps else None, target=target)
    proc = popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
    for line in iter(proc.stdout.readline, ""):
        for part in line.split("\r"):
            p = parse_progress(part)
            if p and progress:
                progress(*p)
    err = proc.stderr.read()
    rc = proc.wait()
    proc.stdout.close()
    proc.stderr.close()
    if rc not in (0, 24):  # 24 = some files vanished while copying: still a good snapshot
        raise RuntimeError(f"rsync failed ({rc}): {err.strip()[-400:]}")
    final = target.with_name(target.name.replace(".in-progress", ""))
    target.rename(final)
    for old in prune_plan(snapshots(dest), cfg["keep"]):
        shutil.rmtree(old, ignore_errors=True)
    return final


def timer_units(schedule):
    """systemd --user service + timer text for 'daily' / 'weekly'."""
    if schedule not in ("daily", "weekly"):
        raise ValueError(schedule)
    service = ("[Unit]\nDescription=Orbit Backup\n\n[Service]\nType=oneshot\n"
               "ExecStart=/usr/bin/orbit-backup --run-now\nNice=10\nIOSchedulingClass=idle\n")
    timer = (f"[Unit]\nDescription=Orbit Backup ({schedule})\n\n[Timer]\nOnCalendar={schedule}\n"
             "Persistent=true\nRandomizedDelaySec=15min\n\n[Install]\nWantedBy=timers.target\n")
    return service, timer
