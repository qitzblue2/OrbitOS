"""Orbit add-on for GNOME Files (Nautilus 46): "Move to Space" and "Sort Inbox Now".

Same behaviour as Orbit Files, for people who prefer the stock file manager.
Needs python3-nautilus (installed by orbit-apps as a recommendation).
"""
import json
import os
import pathlib
import shutil
import subprocess
from urllib.parse import unquote, urlparse

import gi

gi.require_version("Nautilus", "4.0")
from gi.repository import GObject, Nautilus  # noqa: E402

HOME = pathlib.Path.home() / "Home"
CONFIG = pathlib.Path(os.environ.get("XDG_CONFIG_HOME", pathlib.Path.home() / ".config")) / "orbit/spaces.json"


def space_names():
    try:
        return [s["name"] for s in json.loads(CONFIG.read_text())["spaces"] if "/" not in s["name"]]
    except (OSError, ValueError, KeyError, TypeError):
        return ["Personal", "Work", "Study"]


def unique(dest_dir, name):
    t = dest_dir / name
    n = 2
    p = pathlib.Path(name)
    while t.exists():
        t = dest_dir / f"{p.stem} ({n}){p.suffix}"
        n += 1
    return t


def local_path(file_info):
    uri = file_info.get_uri()
    return pathlib.Path(unquote(urlparse(uri).path)) if uri.startswith("file://") else None


class OrbitSpacesMenu(GObject.GObject, Nautilus.MenuProvider):
    def get_file_items(self, files):
        paths = [p for p in (local_path(f) for f in files) if p]
        if not paths:
            return []
        top = Nautilus.MenuItem(name="Orbit::MoveToSpace", label="Move to Space")
        sub = Nautilus.Menu()
        top.set_submenu(sub)
        for name in space_names():
            item = Nautilus.MenuItem(name=f"Orbit::Space::{name}", label=name)
            item.connect("activate", self._move, paths, name)
            sub.append_item(item)
        return [top]

    def get_background_items(self, folder):
        p = local_path(folder)
        if p != HOME / "Inbox" or not os.path.exists("/usr/lib/orbit-os/orbit-inbox-sorter"):
            return []
        item = Nautilus.MenuItem(name="Orbit::SortInbox", label="Sort Inbox Now")
        item.connect("activate", lambda *_: subprocess.Popen(["/usr/lib/orbit-os/orbit-inbox-sorter"]))
        return [item]

    @staticmethod
    def _move(_item, paths, name):
        dest = HOME / "Spaces" / name
        dest.mkdir(parents=True, exist_ok=True)
        for p in paths:
            if p.parent == dest or dest.resolve().is_relative_to(p.resolve()):
                continue  # already there, or a folder into itself
            shutil.move(str(p), str(unique(dest, p.name)))
