"""GTK-free logic behind Orbit Assistant: Claude, with a few safe actions on this PC.

The assistant talks to Claude (Anthropic's API) with the user's own API key,
kept in the GNOME keyring. It can only use the tools defined here: open an
app or a website, find files in ~/Home, read system status, switch the power
mode or dark mode, and start Orbit Focus. There is no shell or file-writing
tool. The Anthropic Python SDK is installed on first use into the user's own
folder (~/.local/share/orbit/assistant-venv), not system-wide.
"""
import configparser
import json
import os
import pathlib
import subprocess
import sys
import webbrowser

from . import focus, paths, tune

MODEL = "claude-opus-5-5"
VENV = paths.DATA / "assistant-venv"
SYSTEM = (
    "You are Orbit Assistant, built into Orbit OS, a Linux desktop. Answer briefly and plainly; the user is "
    "not necessarily technical. You can act on this PC only through the tools you are given. When the user "
    "asks for something a tool can do, use the tool rather than explaining how. When nothing fits, say so "
    "and, if useful, say where in Orbit it is done (Orbit Settings, Optimizer, Performance, Games, VPN, Sync, "
    "Sharing, Focus, Orbit Updater, Windows Apps). Never claim to have done something a tool did not report."
)
KEY_SCHEMA = None  # Secret.Schema, made on first use (needs gi)


# ---------------------------------------------------------------- the SDK, installed per user
def sdk_ready():
    return (VENV / "bin/python").exists() and any(VENV.glob("lib/python3*/site-packages/anthropic/__init__.py"))


def install_sdk():
    """Create the per-user venv and install the Anthropic SDK into it. Raises on failure."""
    paths.ensure(VENV.parent)
    if not (VENV / "bin/python").exists():
        subprocess.run([sys.executable, "-m", "venv", str(VENV)], check=True, capture_output=True)
    r = subprocess.run([str(VENV / "bin/pip"), "install", "-q", "--disable-pip-version-check", "anthropic>=2,<3"],
                       capture_output=True, text=True)
    if r.returncode:
        raise RuntimeError((r.stderr.strip().splitlines() or ["pip failed"])[-1])


def load_sdk():
    for sp in VENV.glob("lib/python3*/site-packages"):
        if str(sp) not in sys.path:
            sys.path.append(str(sp))
    import anthropic  # noqa: PLC0415 - only available after install_sdk()
    return anthropic


# ---------------------------------------------------------------- the API key, in the GNOME keyring
def _secret():
    global KEY_SCHEMA
    import gi  # noqa: PLC0415
    gi.require_version("Secret", "1")
    from gi.repository import Secret  # noqa: PLC0415
    if KEY_SCHEMA is None:
        KEY_SCHEMA = Secret.Schema.new("org.orbit_os.Assistant", Secret.SchemaFlags.NONE,
                                       {"service": Secret.SchemaAttributeType.STRING})
    return Secret


def get_key():
    try:
        Secret = _secret()
        return Secret.password_lookup_sync(KEY_SCHEMA, {"service": "anthropic"}, None)
    except Exception:  # noqa: BLE001 - no keyring: no key
        return None


def set_key(key):
    Secret = _secret()
    Secret.password_store_sync(KEY_SCHEMA, {"service": "anthropic"}, Secret.COLLECTION_DEFAULT,
                               "Orbit Assistant: Anthropic API key", key, None)


def forget_key():
    Secret = _secret()
    Secret.password_clear_sync(KEY_SCHEMA, {"service": "anthropic"}, None)


def key_looks_valid(key):
    return bool(key) and key.startswith("sk-ant-") and len(key) > 30 and " " not in key


# ---------------------------------------------------------------- tools
def _schema(props, required):
    return {"type": "object", "properties": props, "required": required, "additionalProperties": False}


TOOLS = [
    {"name": "open_app", "strict": True,
     "description": "Open an installed app by its name, e.g. 'Files', 'Aphelion', 'Steam', 'Settings'.",
     "input_schema": _schema({"name": {"type": "string", "description": "The app's name as people say it"}},
                             ["name"])},
    {"name": "open_website", "strict": True,
     "description": "Open a website in the user's browser (Aphelion). Only http(s) addresses.",
     "input_schema": _schema({"url": {"type": "string"}}, ["url"])},
    {"name": "find_files", "strict": True,
     "description": "Find files and folders in the user's home folder whose name contains the given text. "
                    "Returns at most 20 paths.",
     "input_schema": _schema({"text": {"type": "string"}}, ["text"])},
    {"name": "system_status", "strict": True,
     "description": "Current processor load, memory, temperature, free disk space and power mode.",
     "input_schema": _schema({}, [])},
    {"name": "set_power_mode", "strict": True,
     "description": "Switch the power mode.",
     "input_schema": _schema({"mode": {"type": "string", "enum": ["power-saver", "balanced", "performance"]}},
                             ["mode"])},
    {"name": "set_dark_mode", "strict": True,
     "description": "Turn dark mode on or off for the whole desktop.",
     "input_schema": _schema({"on": {"type": "boolean"}}, ["on"])},
    {"name": "start_focus", "strict": True,
     "description": "Start an Orbit Focus session: notifications wait and distracting sites stay closed.",
     "input_schema": _schema({"minutes": {"type": "integer", "description": "5 to 240"}}, ["minutes"])},
]


def _apps():
    found = {}
    for d in [pathlib.Path("/usr/share/applications"), paths.HOME / ".local/share/applications",
              pathlib.Path("/var/lib/flatpak/exports/share/applications")]:
        for f in d.glob("*.desktop") if d.is_dir() else []:
            cp = configparser.ConfigParser(interpolation=None, strict=False)
            cp.optionxform = str
            try:
                cp.read(f, encoding="utf-8")
                e = cp["Desktop Entry"]
            except (configparser.Error, KeyError, UnicodeDecodeError):
                continue
            if e.get("NoDisplay") == "true" or e.get("Type", "Application") != "Application":
                continue
            names = [e.get("Name", ""), e.get("GenericName", ""), f.stem] + e.get("Keywords", "").split(";")
            found[f.name] = [n.strip().lower() for n in names if n.strip()]
    return found


def match_app(name, apps):
    """Best .desktop id for a spoken app name: exact name, then prefix, then contains."""
    q = name.strip().lower()
    for test in (lambda n: n == q, lambda n: n.startswith(q), lambda n: q in n):
        for fid, names in sorted(apps.items()):
            if any(test(n) for n in names):
                return fid
    return None


def run_tool(name, args, launch=None):
    """Run one tool; returns (text result, is_error). Never raises."""
    try:
        if name == "open_app":
            fid = match_app(args["name"], _apps())
            if not fid:
                return f"No installed app matches “{args['name']}”.", True
            (launch or _launch)(fid)
            return f"Opened {fid[:-8]}.", False
        if name == "open_website":
            url = args["url"].strip()
            if not url.startswith(("https://", "http://")):
                url = "https://" + url
            webbrowser.open(url)
            return f"Opened {url}.", False
        if name == "find_files":
            text = args["text"].strip().lower()
            if len(text) < 2:
                return "Give at least 2 letters to search for.", True
            hits = []
            root = paths.orbit_home()
            for dirpath, dirs, files in os.walk(root):
                dirs[:] = [d for d in dirs if not d.startswith(".")]
                for n in dirs + files:
                    if text in n.lower():
                        hits.append(str(pathlib.Path(dirpath, n)).replace(str(paths.HOME), "~", 1))
                        if len(hits) >= 20:
                            return "\n".join(hits), False
            return "\n".join(hits) or "Nothing found.", False
        if name == "system_status":
            mem = tune.read_memory()
            st = os.statvfs(str(paths.HOME))
            temp = tune.read_temperature()
            return json.dumps({"memory_used_percent": round(100 * mem["used"] / max(mem["total"], 1)),
                               "memory_total_gb": round(mem["total"] / 1e9, 1),
                               "disk_free_gb": round(st.f_bavail * st.f_frsize / 1e9, 1),
                               "cpu_temperature_c": round(temp) if temp else None,
                               "load_1min": os.getloadavg()[0], "cores": os.cpu_count(),
                               "power_mode": tune.power_profile()}), False
        if name == "set_power_mode":
            return ("Power mode set." if tune.set_power_profile(args["mode"]) else "That power mode isn’t available."), False
        if name == "set_dark_mode":
            scheme = "prefer-dark" if args["on"] else "default"
            r = subprocess.run(["gsettings", "set", "org.gnome.desktop.interface", "color-scheme", scheme],
                               capture_output=True)
            return ("Done." if r.returncode == 0 else "Couldn’t change it."), r.returncode != 0
        if name == "start_focus":
            minutes = max(5, min(240, int(args["minutes"])))
            s = focus.start(minutes, focus.DEFAULT_SITES if not focus.load() else focus.load()["sites"])
            return f"Focus started for {s['minutes']} minutes.", False
    except (KeyError, TypeError, ValueError, OSError) as e:
        return f"That didn’t work: {e}", True
    return f"Unknown tool {name}.", True


def _launch(fid):
    subprocess.Popen(["gtk-launch", fid[:-8]], start_new_session=True,
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


# ---------------------------------------------------------------- the conversation
class Chat:
    """One conversation. history holds the exact content blocks the API returned (never edited)."""

    def __init__(self, client, tool_runner=run_tool):
        self.client, self.history, self.run_tool = client, [], tool_runner

    def send(self, text, on_tool=lambda name, args: None):
        """Ask Claude; runs tools until Claude answers. Returns the reply text.

        On any error the turn is taken out again, so the next question starts from a valid history.
        """
        start = len(self.history)
        try:
            return self._turn(text, on_tool, start)
        except BaseException:
            del self.history[start:]
            raise

    def _turn(self, text, on_tool, start):
        self.history.append({"role": "user", "content": text})
        for _ in range(8):  # a handful of tool rounds is plenty for a desktop request
            r = self.client.beta.messages.create(
                model=MODEL, max_tokens=16000, system=SYSTEM, tools=TOOLS, messages=self.history,
                output_config={"effort": "low"},            # quick chat answers
                betas=["server-side-fallback-2026-07-01"], fallbacks="default")
            if r.stop_reason == "refusal":
                del self.history[start:]                     # drop this whole turn, nothing half-answered
                return "I can’t help with that one."
            self.history.append({"role": "assistant", "content": r.content})
            if r.stop_reason == "pause_turn":
                continue
            calls = [b for b in r.content if b.type == "tool_use"]
            if not calls or r.stop_reason != "tool_use":
                return "".join(b.text for b in r.content if b.type == "text").strip() or "Done."
            results = []
            for b in calls:
                on_tool(b.name, b.input)
                out, err = self.run_tool(b.name, b.input if isinstance(b.input, dict) else {})
                results.append({"type": "tool_result", "tool_use_id": b.id, "content": out, "is_error": err})
            self.history.append({"role": "user", "content": results})
        return "That took too many steps; try asking in a simpler way."
