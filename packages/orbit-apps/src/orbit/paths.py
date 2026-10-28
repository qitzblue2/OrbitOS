"""Where Orbit keeps things. All user data lives under ~/Home (see skel/)."""
import os
import pathlib

HOME = pathlib.Path.home()
ORBIT_HOME = HOME / "Home"
CONFIG = pathlib.Path(os.environ.get("XDG_CONFIG_HOME", HOME / ".config")) / "orbit"
STATE = pathlib.Path(os.environ.get("XDG_STATE_HOME", HOME / ".local/state")) / "orbit"
DATA = pathlib.Path(os.environ.get("XDG_DATA_HOME", HOME / ".local/share")) / "orbit"

PLACES = [  # (label, relative path under ~/Home, icon)
    ("Home", "", "user-home-symbolic"),
    ("Desktop", "Desktop", "user-desktop-symbolic"),
    ("Documents", "Documents", "folder-documents-symbolic"),
    ("Downloads", "Downloads", "folder-download-symbolic"),
    ("Pictures", "Pictures", "folder-pictures-symbolic"),
    ("Music", "Music", "folder-music-symbolic"),
    ("Videos", "Videos", "folder-videos-symbolic"),
    ("Projects", "Projects", "folder-projects-symbolic"),
    ("Notes", "Notes", "folder-notes-symbolic"),
    ("Inbox", "Inbox", "folder-inbox-symbolic"),
]


def orbit_home():
    """~/Home if it exists (Orbit layout), else plain $HOME (converted Ubuntu installs)."""
    return ORBIT_HOME if ORBIT_HOME.is_dir() else HOME


def ensure(*dirs):
    for d in dirs:
        pathlib.Path(d).mkdir(parents=True, exist_ok=True)
