"""GTK-free logic behind Orbit Sync: keep folders the same on all your PCs.

Orbit Sync drives Syncthing (running as your user, listening on 127.0.0.1
only) through its REST API. PCs talk to each other directly, encrypted with
TLS and identified by their device ID; there is no account and no server that
can read anything. Each Orbit folder uses a fixed folder ID, so turning on
"Notes" on two paired PCs is all it takes for them to find each other's copy.
"""
import json
import pathlib
import re
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET

from . import paths

API = "http://127.0.0.1:8384"
CONFIG_DIRS = [paths.HOME / ".local/state/syncthing", paths.HOME / ".config/syncthing"]
DEVICE_ID = re.compile(r"^[A-Z2-7]{7}(-[A-Z2-7]{7}){7}$")
# folder id, label, folder under ~/Home, icon
ITEMS = [("orbit-notes", "Notes", "Notes", "folder-notes-symbolic"),
         ("orbit-documents", "Documents", "Documents", "folder-documents-symbolic"),
         ("orbit-desktop", "Desktop", "Desktop", "user-desktop-symbolic"),
         ("orbit-pictures", "Pictures", "Pictures", "folder-pictures-symbolic"),
         ("orbit-projects", "Projects", "Projects", "folder-symbolic"),
         ("orbit-music", "Music", "Music", "folder-music-symbolic")]


class SyncError(Exception):
    pass


def normalize_id(text):
    """Accept an ID typed with spaces, lowercase or without dashes. -> canonical ID or None."""
    raw = re.sub(r"[^A-Za-z2-7]", "", text or "").upper()
    if len(raw) != 56:
        return None
    did = "-".join(raw[i:i + 7] for i in range(0, 56, 7))
    return did if DEVICE_ID.match(did) else None


def api_key(config_dirs=None):
    for d in config_dirs or CONFIG_DIRS:
        f = pathlib.Path(d) / "config.xml"
        try:
            gui = ET.parse(f).getroot().find("gui")
        except (OSError, ET.ParseError):
            continue
        if gui is not None and gui.findtext("apikey"):
            return gui.findtext("apikey")
    return None


def folder_config(item_id, path, devices, label):
    """Syncthing folder config for one Orbit folder shared with the given device IDs."""
    return {"id": item_id, "label": f"Orbit {label}", "path": str(path), "type": "sendreceive",
            "devices": [{"deviceID": d} for d in devices], "rescanIntervalS": 3600, "fsWatcherEnabled": True,
            "versioning": {"type": "trashcan", "params": {"cleanoutDays": "30"}},
            "ignorePerms": False, "autoNormalize": True}


def device_config(device_id, name):
    return {"deviceID": device_id, "name": name, "addresses": ["dynamic"], "compression": "metadata",
            "autoAcceptFolders": False, "introducer": False}


class Client:
    def __init__(self, key=None, base=API, opener=urllib.request.urlopen):
        self.key, self.base, self._open = key or api_key(), base, opener

    def _call(self, method, path, body=None):
        if not self.key:
            raise SyncError("Sync isn’t running yet")
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method,
                                     headers={"X-API-Key": self.key, "Content-Type": "application/json"})
        try:
            with self._open(req, timeout=5) as r:
                raw = r.read()
        except (urllib.error.URLError, OSError) as e:
            raise SyncError(f"Sync isn’t answering ({e})") from e
        return json.loads(raw) if raw else None

    # ---- this PC
    def my_id(self):
        return self._call("GET", "/rest/system/status")["myID"]

    # ---- other PCs
    def devices(self, me=None):
        me = me or self.my_id()
        conns = (self._call("GET", "/rest/system/connections") or {}).get("connections", {})
        return [{"id": d["deviceID"], "name": d.get("name") or d["deviceID"][:7],
                 "connected": conns.get(d["deviceID"], {}).get("connected", False)}
                for d in self._call("GET", "/rest/config/devices") if d["deviceID"] != me]

    def pending(self):
        """Other PCs that asked to pair: [{'id', 'name', 'address'}]."""
        p = self._call("GET", "/rest/cluster/pending/devices") or {}
        return [{"id": did, "name": v.get("name") or did[:7], "address": v.get("address", "")} for did, v in p.items()]

    def add_device(self, device_id, name):
        did = normalize_id(device_id)
        if not did:
            raise SyncError("That doesn’t look like a PC’s sync ID")
        if did == self.my_id():
            raise SyncError("That is this PC’s own ID")
        self._call("PUT", f"/rest/config/devices/{did}", device_config(did, name or "Orbit PC"))
        self._reshare()

    def remove_device(self, device_id):
        self._call("DELETE", f"/rest/config/devices/{device_id}")
        self._reshare()

    def ignore_pending(self, device_id):
        self._call("DELETE", f"/rest/cluster/pending/devices?device={device_id}")

    # ---- folders
    def enabled_items(self):
        ids = {f["id"] for f in self._call("GET", "/rest/config/folders")}
        return {i for i, *_ in ITEMS if i in ids}

    def set_item(self, item_id, on, home=None):
        item = next((it for it in ITEMS if it[0] == item_id), None)
        if item is None:
            raise SyncError(item_id)
        if not on:
            self._call("DELETE", f"/rest/config/folders/{item_id}")
            return
        path = pathlib.Path(home or paths.orbit_home()) / item[2]
        path.mkdir(parents=True, exist_ok=True)
        others = [d["id"] for d in self.devices()]
        self._call("PUT", f"/rest/config/folders/{item_id}", folder_config(item_id, path, others, item[1]))

    def _reshare(self):
        """Share every enabled Orbit folder with every paired PC."""
        others = [d["id"] for d in self.devices()]
        for f in self._call("GET", "/rest/config/folders"):
            if f["id"].startswith("orbit-"):
                f["devices"] = [{"deviceID": d} for d in others]
                self._call("PUT", f"/rest/config/folders/{f['id']}", f)

    def status(self):
        """'idle' | 'syncing' | 'offline' summary across Orbit folders."""
        states = []
        for f in self._call("GET", "/rest/config/folders"):
            if f["id"].startswith("orbit-"):
                s = self._call("GET", f"/rest/db/status?folder={f['id']}") or {}
                states.append(s.get("state", ""))
        return "syncing" if any(s in ("syncing", "scanning", "sync-preparing") for s in states) else "idle"
