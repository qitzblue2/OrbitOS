"""GTK-free logic behind Orbit Sharing: share folders with Windows PCs (SMB).

The user picks folders in their own home; root (orbit-sharing-helper) turns
the list into /etc/samba/orbit-shares.conf, where every share is only open
to that user with their sharing password. Windows 11 refuses password-less
(guest) shares, so there are none. The same validation runs on both sides.
"""
import json
import pathlib
import re

from . import paths

HELPER = "/usr/lib/orbit-os/orbit-sharing-helper"
CONF = "/etc/samba/orbit-shares.conf"
STATE_FILE = paths.CONFIG / "sharing.json"
# letters, digits, space, - and _; Windows share names are at most 80 chars, keep them short
NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 _-]{0,39}$")
RESERVED = {"global", "homes", "printers", "print$", "ipc$", "admin$", "c$"}


class ShareError(ValueError):
    pass


def suggest_name(path, taken=()):
    base = re.sub(r"[^A-Za-z0-9 _-]", "", pathlib.Path(path).name).strip()[:32] or "Shared"
    name, n = base, 2
    while name.lower() in {t.lower() for t in taken} or name.lower() in RESERVED:
        name, n = f"{base} {n}", n + 1
    return name


def validate(shares, home):
    """Check a share list for one user. Returns it cleaned up, or raises ShareError."""
    home = pathlib.Path(home).resolve()
    out, seen = [], set()
    if not isinstance(shares, list) or len(shares) > 32:
        raise ShareError("too many shares")
    for s in shares:
        name, path, writable = s.get("name", ""), s.get("path", ""), bool(s.get("writable"))
        if not NAME.match(name) or name.lower() in RESERVED:
            raise ShareError(f"“{name}” can’t be a share name: use letters, digits, spaces, - and _")
        if name.lower() in seen:
            raise ShareError(f"two shares are called “{name}”")
        seen.add(name.lower())
        p = pathlib.Path(path)
        if not p.is_absolute():
            raise ShareError(f"{path} is not a full path")
        real = p.resolve()
        if real != home and home not in real.parents:
            raise ShareError(f"{path} is outside your home folder")
        if not real.is_dir():
            raise ShareError(f"{path} is not a folder")
        if any(part.startswith(".") for part in real.relative_to(home).parts):
            raise ShareError(f"{path} is a hidden folder (it may hold passwords or keys)")
        out.append({"name": name, "path": str(real), "writable": writable})
    return out


def _quote(v):
    if any(c in v for c in "\n\r[]") or v != v.strip():
        raise ShareError(f"unsafe value {v!r}")
    return v


def conf_text(shares, user):
    """smb.conf fragment for the validated shares of one user."""
    lines = ["# Written by Orbit Sharing (orbit-sharing-helper). Changes here are overwritten.", ""]
    for s in shares:
        lines += [f"[{_quote(s['name'])}]",
                  f"   path = {_quote(s['path'])}",
                  f"   valid users = {_quote(user)}",
                  f"   force user = {_quote(user)}",
                  f"   read only = {'no' if s['writable'] else 'yes'}",
                  "   guest ok = no",
                  "   browseable = yes",
                  "   follow symlinks = no",
                  "   wide links = no",
                  "   veto files = /.*/",
                  "   hide dot files = yes",
                  ""]
    return "\n".join(lines)


def load():
    try:
        return json.loads(STATE_FILE.read_text())
    except (OSError, ValueError):
        return []


def save(shares):
    paths.ensure(STATE_FILE.parent)
    STATE_FILE.write_text(json.dumps(shares, indent=1))


def password_ok(pw):
    """Sharing passwords: at least 8 characters, no line breaks (smbpasswd reads lines)."""
    return len(pw) >= 8 and "\n" not in pw and "\r" not in pw
