"""GTK-free logic behind Orbit Updater: what can be updated, what was installed.

Updates come from two places: Orbit's own server (apps, desktop, Aphelion) and
Debian (security and bug fixes). The list comes from `apt list --upgradable`,
which needs no password; installing goes through pkexec and orbit-updater-helper.
Finished runs, including the automatic ones at night, are read back from
/var/log/apt/history.log so the background check can say what changed.
"""
import json
import re
import subprocess

from . import paths

HELPER = "/usr/lib/orbit-os/orbit-updater-helper"
HISTORY = "/var/log/apt/history.log"
STATE_FILE = paths.STATE / "updater.json"
ORBIT_PREFIXES = ("orbit-", "aphelion")
# "name/suite version arch [upgradable from: old]"
UPGRADABLE = re.compile(r"^(?P<name>[^/\s]+)/(?P<suite>\S+)\s+(?P<new>\S+)\s+\S+\s+\[upgradable from: (?P<old>[^\]]+)\]")


def parse_upgradable(text):
    """-> [{'name', 'new', 'old', 'kind': 'orbit'|'security'|'system'}] sorted Orbit first."""
    out = []
    for line in text.splitlines():
        m = UPGRADABLE.match(line.strip())
        if not m:
            continue
        name, suite = m.group("name"), m.group("suite")
        kind = "orbit" if name.startswith(ORBIT_PREFIXES) or suite.startswith("orbit") else \
            "security" if "security" in suite else "system"
        out.append({"name": name, "new": m.group("new"), "old": m.group("old"), "kind": kind})
    order = {"orbit": 0, "security": 1, "system": 2}
    return sorted(out, key=lambda u: (order[u["kind"]], u["name"]))


def upgradable():
    r = subprocess.run(["apt", "list", "--upgradable"], capture_output=True, text=True, timeout=60,
                       env={"LANG": "C.UTF-8", "PATH": "/usr/bin:/bin"})
    return parse_upgradable(r.stdout)


def parse_history(text):
    """apt's history.log -> [{'end': 'YYYY-MM-DD  HH:MM:SS', 'upgraded': [names], 'installed': [names],
    'error': bool}] oldest first."""
    runs, cur = [], None
    for line in text.splitlines():
        key, _, val = line.partition(": ")
        if key == "Start-Date":
            cur = {"start": val.strip(), "end": None, "upgraded": [], "installed": [], "error": False}
        elif cur is None:
            continue
        elif key in ("Upgrade", "Install"):
            # "pkg:arch (old, new), pkg2:arch (new, automatic)"
            names = [p.split(":")[0].strip() for p in re.split(r"\),\s*", val) if p.strip()]
            cur["upgraded" if key == "Upgrade" else "installed"] += names
        elif key == "Error":
            cur["error"] = True
        elif key == "End-Date":
            cur["end"] = val.strip()
            runs.append(cur)
            cur = None
    return runs


def history(path=HISTORY):
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return parse_history(f.read())
    except OSError:
        return []


def load_state():
    try:
        return json.loads(STATE_FILE.read_text())
    except (OSError, ValueError):
        return {}


def save_state(state):
    paths.ensure(STATE_FILE.parent)
    STATE_FILE.write_text(json.dumps(state))


def summary(names, limit=3):
    """'Aphelion, Orbit apps and 4 more' from package names."""
    nice = []
    for n in names:
        label = "Aphelion" if n.startswith("aphelion") else \
            "Orbit " + n[len("orbit-"):].removeprefix("os-").replace("-", " ") if n.startswith("orbit-") else n
        if label not in nice:
            nice.append(label)
    if len(nice) <= limit:
        return ", ".join(nice[:-1]) + (" and " if len(nice) > 1 else "") + nice[-1] if nice else ""
    return ", ".join(nice[:limit]) + f" and {len(nice) - limit} more"


def background_events(updates, runs, state):
    """What the background check should tell the user, and the new state.

    -> ([(title, body)], state). Says once per finished update run (also the automatic
    nightly ones) and once per new set of available updates, never the same thing twice.
    """
    events, new = [], dict(state)
    last_end = state.get("last_end")
    if runs:
        if last_end is not None and not state.get("window_upgrading"):  # the window says it itself
            for run in [r for r in runs if r["end"] > last_end]:
                changed = run["upgraded"] + run["installed"]
                if run["error"]:
                    events.append(("Updates didn’t finish", "Open Orbit Updater to try again."))
                elif changed:
                    events.append((f"Orbit updated {len(changed)} package{'s' * (len(changed) != 1)}",
                                   f"Installed {summary(changed)}."))
        new["last_end"] = runs[-1]["end"]
    key = sorted(f"{u['name']}={u['new']}" for u in updates)
    if updates and key != state.get("announced"):
        orbit = [u for u in updates if u["kind"] == "orbit"]
        sec = [u for u in updates if u["kind"] == "security"]
        body = summary([u["name"] for u in (orbit or updates)])
        if sec:
            body += f" · {len(sec)} security fix{'es' * (len(sec) != 1)}"
        events.append((f"{len(updates)} update{'s' * (len(updates) != 1)} ready", body + ". Click to install."))
    new["announced"] = key if updates else []
    return events, new


def mark_window_upgrading(on):
    state = load_state()
    if on:
        state["window_upgrading"] = True
    else:
        state.pop("window_upgrading", None)
        runs = history()
        if runs:
            state["last_end"] = runs[-1]["end"]
    save_state(state)


def notify(title, body, urgency="normal"):
    """Desktop notification; clicking it opens Orbit Updater."""
    try:
        subprocess.run(["notify-send", "--app-name=Orbit Updater", "--icon=orbit-updater", f"--urgency={urgency}",
                        "--hint=string:desktop-entry:orbit-updater", title, body], timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        pass
