"""Parse tools/hardware-check.sh output into sections and checks."""
import re

ANSI = re.compile(r"\x1b\[[0-9;]*m")
SECTION = re.compile(r"^== (.+)$")
ITEM = re.compile(r"^\s+\[\s*(OK|WARN|FAIL|info)\s*\]\s+(.*)$")


def parse(text):
    """-> [{'name': 'Network', 'items': [{'status': 'ok'|'warn'|'fail'|'info', 'text': ...}]}]"""
    sections, cur = [], None
    for raw in text.splitlines():
        line = ANSI.sub("", raw).rstrip()
        m = SECTION.match(line)
        if m:
            cur = {"name": m.group(1).strip(), "items": []}
            sections.append(cur)
            continue
        m = ITEM.match(line)
        if m and cur is not None:
            cur["items"].append({"status": m.group(1).lower(), "text": m.group(2).strip()})
    return sections


def summary(sections):
    counts = {"ok": 0, "warn": 0, "fail": 0, "info": 0}
    for s in sections:
        for i in s["items"]:
            counts[i["status"]] += 1
    return counts


def section_status(section):
    st = {i["status"] for i in section["items"]}
    return "fail" if "fail" in st else "warn" if "warn" in st else "ok" if "ok" in st else "info"


MANUAL_TESTS = [
    ("Brightness keys", "Press the brightness up and down keys. Does the screen change?"),
    ("Volume keys", "Press volume up, down and mute. Does the on-screen indicator react?"),
    ("Mic-mute key", "Press the microphone mute key. Does its light toggle?"),
    ("Lid close", "Close the lid for 30 seconds, then open it. Did it sleep and wake up?"),
    ("Suspend from menu", "Choose Suspend in the power menu, then press a key. Did it wake properly?"),
    ("Headphone jack", "Plug in headphones and play a sound. Does it switch to them?"),
    ("Speakers", "Unplug headphones and play a sound. Do both speakers work?"),
    ("Microphone", "Settings → Sound → Input: speak. Does the level meter move?"),
    ("Webcam", "Open Cheese or a video call test page. Do you see yourself?"),
    ("Touchpad gestures", "Swipe three fingers up and sideways. Do overview / workspaces react?"),
    ("External monitor", "Connect a monitor via HDMI or USB-C. Does it show a picture?"),
    ("Bluetooth device", "Pair headphones or a mouse. Does it connect and work?"),
    ("Fingerprint", "Settings → Users → Fingerprint Login: enroll, then lock (Super+L) and unlock with it."),
]


def report_markdown(machine, sections, manual_results):
    lines = [f"## {machine}", "", "| Item | Result | Notes |", "|---|---|---|"]
    icon = {"ok": "✅", "warn": "⚠️", "fail": "❌", "untested": "⏳"}
    for name, (res, note) in manual_results.items():
        lines.append(f"| {name} | {icon.get(res, '⏳')} | {note.replace('|', '/')} |")
    lines += ["", "### Automatic checks", ""]
    for s in sections:
        lines.append(f"**{s['name']}**")
        for i in s["items"]:
            lines.append(f"- [{i['status'].upper()}] {i['text']}")
        lines.append("")
    return "\n".join(lines)
