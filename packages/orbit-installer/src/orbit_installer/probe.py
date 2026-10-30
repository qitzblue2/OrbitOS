"""Read-only look at the computer: firmware type, disks, partitions, Windows.

Everything here only reads (lsblk, sfdisk --json, blkid, ntfsresize --info, a read-only
mount of an EFI partition). The results feed plan.py.
"""
import json
import os
import re
import subprocess
import tempfile

from .plan import Disk, Part, GPT_TYPE

RUN = {"capture_output": True, "text": True, "check": False}


def firmware():
    return "uefi" if os.path.isdir("/sys/firmware/efi") else "bios"


def live_medium_disk():
    """The disk the live system was started from: never offered as a target."""
    for mnt in ("/run/live/medium", "/lib/live/mount/medium"):
        r = subprocess.run(["findmnt", "-n", "-o", "SOURCE", mnt], **RUN)
        src = r.stdout.strip()
        if src:
            r = subprocess.run(["lsblk", "-n", "-o", "PKNAME", src], **RUN)
            parent = r.stdout.strip().splitlines()
            return f"/dev/{parent[0]}" if parent and parent[0] else src
    return ""


def lsblk():
    cols = "NAME,PATH,TYPE,SIZE,MODEL,TRAN,RM,RO,PTTYPE,PARTTYPE,PARTLABEL,FSTYPE,LABEL,UUID,MOUNTPOINTS,LOG-SEC"
    r = subprocess.run(["lsblk", "-J", "-b", "-o", cols], **RUN)
    return json.loads(r.stdout or '{"blockdevices": []}')["blockdevices"]


def sfdisk_table(path):
    r = subprocess.run(["sfdisk", "--json", path], **RUN)
    if r.returncode != 0 or not r.stdout.strip():
        return None
    return json.loads(r.stdout)["partitiontable"]


def disks(include_removable=True):
    """All disks that could take Orbit, as plan.Disk objects (without Windows details yet)."""
    skip = live_medium_disk()
    out = []
    for d in lsblk():
        # loop devices only in the test suite (ORBIT_INSTALLER_ALLOW_LOOP), never on a real install
        testing = bool(os.environ.get("ORBIT_INSTALLER_ALLOW_LOOP"))
        if d.get("type") not in (("disk", "loop") if testing else ("disk",)) or d.get("ro") in (True, "1") or d["path"] == skip:
            continue
        if re.match(r"^/dev/(zram|sr|ram)", d["path"]) or (d["path"].startswith("/dev/loop") and not testing):
            continue
        if not include_removable and d.get("rm") in (True, "1"):
            continue
        if int(d.get("size") or 0) < 4 * 1024 ** 3:
            continue
        out.append(disk_from(d))
    return out


def disk_from(d):
    sector = int(d.get("log-sec") or 512)
    t = sfdisk_table(d["path"])
    disk = Disk(path=d["path"], size=int(d["size"]), model=(d.get("model") or "").strip(),
                table=(t or {}).get("label", "") if t else "", sector=sector)
    if t:
        if "firstlba" in t:
            disk.first_usable = int(t["firstlba"]) * sector
        if "lastlba" in t:
            disk.last_usable = (int(t["lastlba"]) + 1) * sector
    kids = {c["path"]: c for c in d.get("children") or []}
    for p in (t or {}).get("partitions", []):
        num = int(re.search(r"(\d+)$", p["node"]).group(1))
        info = kids.get(p["node"], {})
        fstype, label = (info.get("fstype") or "").lower(), info.get("label") or ""
        if not fstype:
            # lsblk reads udev's cache, which can be empty or stale; ask the partition itself
            fstype, label = blkid(p["node"])
        disk.parts.append(Part(number=num, start=int(p["start"]) * sector, size=int(p["size"]) * sector,
                               fstype=fstype, type=str(p.get("type", "")).upper(),
                               label=label or info.get("partlabel") or p.get("name", ""), path=p["node"]))
    return disk


def blkid(dev):
    r = subprocess.run(["blkid", "-p", "-o", "export", dev], **RUN)
    vals = dict(line.split("=", 1) for line in r.stdout.splitlines() if "=" in line)
    fstype = vals.get("TYPE", "").lower()
    if fstype == "bitlocker" or vals.get("VERSION", "").lower().startswith("bitlocker"):
        fstype = "bitlocker"
    return fstype, vals.get("LABEL", "")


def mounted_inside(disk_path):
    """Mount points in use on this disk (a disk in use cannot be repartitioned)."""
    out = []
    for d in lsblk():
        if d["path"] != disk_path:
            continue
        for c in [d] + (d.get("children") or []):
            out += [m for m in (c.get("mountpoints") or []) if m]
    return out


def detect_windows(disk):
    """Mark Windows partitions and EFI partitions with the Windows boot manager; measure how far NTFS can shrink."""
    for p in disk.parts:
        if p.fstype == "ntfs" and p.size > 20 * 1024 ** 3:
            p.windows = True
            p.min_size = ntfs_min_size(p.path)
        elif p.fstype == "bitlocker":
            p.windows = True
        if p.type == GPT_TYPE["esp"] or p.fstype == "vfat" and p.label.upper() in ("EFI", "SYSTEM"):
            p.esp_has_windows = esp_has_windows(p.path)
    return disk


def ntfs_min_size(dev):
    """Smallest size `ntfsresize` can shrink this NTFS partition to, in bytes (0 if it refuses)."""
    r = subprocess.run(["ntfsresize", "--info", "--force", "--no-progress-bar", dev], **RUN)
    m = re.search(r"You might resize at (\d+) bytes", r.stdout)
    return int(m.group(1)) if m else 0


def esp_has_windows(dev):
    with tempfile.TemporaryDirectory(prefix="orbit-esp-") as mnt:
        if subprocess.run(["mount", "-o", "ro", dev, mnt], **RUN).returncode != 0:
            return False
        try:
            return os.path.exists(os.path.join(mnt, "EFI", "Microsoft", "Boot", "bootmgfw.efi"))
        finally:
            subprocess.run(["umount", mnt], **RUN)


def ram_bytes():
    with open("/proc/meminfo") as f:
        for line in f:
            if line.startswith("MemTotal:"):
                return int(line.split()[1]) * 1024
    return 0
