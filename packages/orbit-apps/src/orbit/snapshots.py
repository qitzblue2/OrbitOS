"""GTK-free logic behind Orbit's safety snapshots (Timeshift, rsync mode).

Before each update apt runs `orbit-snapshot pre-update` (apt.conf.d/40orbit-snapshot):
it takes a Timeshift snapshot of the system (not /home) tagged "Orbit: before
update", at most once an hour, only on an installed system with enough free
space, and keeps the newest KEEP of them. Orbit Updater lists them and can put
the newest one back ("Undo last update"), which takes effect after a restart.
"""
import json
import re

CONF = "/etc/orbit/snapshots.json"
COMMENT = "Orbit: before update"
KEEP = 3
MIN_FREE = 15 * 10**9          # don't start a snapshot with less free space than this
MIN_GAP = 3600                 # one snapshot per hour is enough when several apt runs follow each other
# "0    >  2026-10-30_19-00-01  O     Orbit: before update"
LINE = re.compile(r"^\s*\d+\s+>?\s*(?P<name>\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d)\s+(?P<tags>[OBHDWM]*)\s*(?P<comment>.*)$")


def parse_list(text):
    """`timeshift --list` -> [{'name', 'tags', 'comment', 'orbit'}] oldest first."""
    out = []
    for line in text.splitlines():
        m = LINE.match(line)
        if m:
            c = m.group("comment").strip()
            out.append({"name": m.group("name"), "tags": m.group("tags"), "comment": c, "orbit": c == COMMENT})
    return sorted(out, key=lambda s: s["name"])


def to_delete(snaps, keep=KEEP):
    """Names of Orbit snapshots beyond the newest `keep` (other snapshots are the user's own)."""
    mine = [s["name"] for s in snaps if s["orbit"]]
    return mine[:-keep] if len(mine) > keep else []


def nice_time(name):
    """'2026-10-30_19-00-01' -> '2026-10-30 19:00'."""
    d, t = name.split("_")
    return f"{d} {t[:5].replace('-', ':')}"


def should_snapshot(enabled, free_bytes, last_ts, now, live, chroot):
    """(yes, reason) for the pre-update hook."""
    if live or chroot:
        return False, "not an installed system"
    if not enabled:
        return False, "turned off"
    if free_bytes < MIN_FREE:
        return False, "not enough free space"
    if last_ts and now - last_ts < MIN_GAP:
        return False, "one was taken less than an hour ago"
    return True, ""


def load_conf(path=CONF):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {"enabled": True}
