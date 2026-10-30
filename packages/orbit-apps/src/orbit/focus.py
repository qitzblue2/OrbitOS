"""GTK-free logic behind Orbit Focus: a timer that keeps distractions away.

Starting a focus session writes ~/.config/orbit/focus.json:
  {"until": <unix time>, "sites": ["youtube.com", ...], "banners": "<previous setting>"}
Notifications are held back (GNOME's show-banners) and Aphelion refuses the listed
sites (and their subdomains) until `until`. A systemd user timer runs
`orbit-focus --end` at that moment: it puts notifications back and says the session
is over. Ending early does the same.
"""
import json
import re
import subprocess
import time

from . import paths

STATE = paths.CONFIG / "focus.json"
DEFAULT_SITES = ["youtube.com", "tiktok.com", "instagram.com", "facebook.com", "x.com", "twitter.com",
                 "reddit.com", "twitch.tv", "netflix.com"]
LENGTHS = [25, 50, 90]
HOST = re.compile(r"^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$")


def clean_sites(text_or_list):
    """'YouTube.com, https://www.reddit.com/r/x' -> ['youtube.com', 'reddit.com'] (valid hosts, no www.)."""
    items = text_or_list if isinstance(text_or_list, list) else re.split(r"[\s,]+", text_or_list or "")
    out = []
    for it in items:
        h = re.sub(r"^[a-z]+://", "", it.strip().lower()).split("/")[0].split(":")[0]
        h = h[4:] if h.startswith("www.") else h
        if HOST.match(h) and h not in out:
            out.append(h)
    return out[:100]


def blocked(host, sites):
    """True when host is one of the sites or a subdomain of one."""
    host = (host or "").lower().rstrip(".")
    return any(host == s or host.endswith("." + s) for s in sites)


def load(now=None):
    """The running session, or None (also None once it has run out)."""
    try:
        s = json.loads(STATE.read_text())
    except (OSError, ValueError):
        return None
    if not isinstance(s, dict) or s.get("until", 0) <= (now or time.time()):
        return None
    return s


def remaining(s, now=None):
    return max(0, int(s["until"] - (now or time.time()))) if s else 0


def _gs(*args):
    try:
        r = subprocess.run(["gsettings", *args], capture_output=True, text=True, timeout=5)
        return r.stdout.strip() if r.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired):
        return None


def start(minutes, sites, gs=_gs, schedule=None, now=None):
    now = now or time.time()
    if not 1 <= int(minutes) <= 600:
        raise ValueError("between 1 minute and 10 hours")
    prev = load(now)
    banners = prev["banners"] if prev else gs("get", "org.gnome.desktop.notifications", "show-banners")
    s = {"until": now + int(minutes) * 60, "minutes": int(minutes), "sites": clean_sites(sites),
         "banners": banners or "true"}
    paths.ensure(STATE.parent)
    tmp = STATE.with_suffix(".tmp")
    tmp.write_text(json.dumps(s))
    tmp.replace(STATE)
    gs("set", "org.gnome.desktop.notifications", "show-banners", "false")
    (schedule or _schedule)(int(minutes) * 60)
    return s


def end(gs=_gs, notify=None, finished=True):
    try:
        s = json.loads(STATE.read_text())
    except (OSError, ValueError):
        s = None
    if s is None:
        return False
    gs("set", "org.gnome.desktop.notifications", "show-banners", s.get("banners") or "true")
    STATE.unlink(missing_ok=True)
    subprocess.run(["systemctl", "--user", "stop", "orbit-focus-end.timer"], capture_output=True)
    if finished:
        (notify or _notify)("Focus time is over", f"{s.get('minutes', '')} minutes done. Take a break.")
    return True


def _schedule(seconds):
    subprocess.run(["systemctl", "--user", "stop", "orbit-focus-end.timer"], capture_output=True)
    subprocess.run(["systemd-run", "--user", "--unit=orbit-focus-end", f"--on-active={seconds}",
                    "--timer-property=AccuracySec=1s", "/usr/bin/orbit-focus", "--end"], capture_output=True)


def _notify(title, body):
    subprocess.run(["notify-send", "--app-name=Orbit Focus", "--icon=orbit-focus", "--urgency=critical",
                    "--hint=string:desktop-entry:orbit-focus", title, body], capture_output=True)
