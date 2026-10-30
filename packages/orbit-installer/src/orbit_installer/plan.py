"""Disk planning for the Orbit installer: pure functions, no disk access.

The planner turns a probed disk (see probe.py) and the user's choice into a list of
steps with exact sector numbers. Nothing here runs a command, so every layout can be
checked in unit tests before the engine ever touches a real disk.

Layouts
  erase, UEFI     GPT: 1 GiB EFI system partition, rest Orbit (ext4)
  erase, BIOS     GPT: 1 MiB BIOS boot partition, rest Orbit (ext4)
  + encryption    an extra 1 GiB /boot (ext4) before the encrypted root (LUKS2):
                  GRUB cannot read LUKS2 with argon2id, so /boot stays outside
  alongside       shrink a Windows NTFS partition, put Orbit in the freed space,
                  reuse the existing EFI system partition
  free space      put Orbit in an unused gap; an EFI system partition is created
                  in the gap too if the disk has none
"""
from dataclasses import dataclass, field, asdict

MiB = 1024 * 1024
GiB = 1024 * MiB

MIN_ROOT = 20 * GiB          # smallest Orbit root partition the installer will make
RECOMMENDED_ROOT = 40 * GiB
ESP_SIZE = 1 * GiB
BOOT_SIZE = 1 * GiB
BIOS_BOOT_SIZE = 1 * MiB
WINDOWS_KEEP_FREE = 20 * GiB  # free space Windows keeps after shrinking, on top of what it uses
ALIGN = 1 * MiB

GPT_TYPE = {
    "esp": "C12A7328-F81F-11D2-BA4B-00A0C93EC93B",
    "bios": "21686148-6449-6E6F-744E-656564454649",
    "linux": "0FC63DAF-8483-4772-8E79-3D69D8477DE4",
    "xbootldr": "BC13C2FF-59E6-4262-A352-B275FD6F7172",
}
MBR_TYPE = {"linux": "83", "esp": "ef"}


class PlanError(ValueError):
    """The choice cannot be carried out on this disk; the message is shown to the user."""


@dataclass
class Part:
    """A partition as the planner sees it (sizes and positions in bytes)."""
    number: int
    start: int
    size: int
    fstype: str = ""
    type: str = ""          # GPT type GUID or MBR type id, upper-case
    label: str = ""
    path: str = ""
    windows: bool = False   # contains a Windows installation (probe decided)
    esp_has_windows: bool = False
    min_size: int = 0       # smallest size an NTFS partition can be shrunk to (0 = unknown)

    @property
    def end(self):
        return self.start + self.size


@dataclass
class Disk:
    path: str
    size: int
    model: str = ""
    table: str = ""          # "gpt", "dos" or "" (empty disk)
    sector: int = 512
    parts: list = field(default_factory=list)
    first_usable: int = 0    # bytes; 0 = derive from the table type
    last_usable: int = 0     # bytes, inclusive end; 0 = derive

    def usable(self):
        first = self.first_usable or ALIGN
        last = self.last_usable or (self.size - (33 * self.sector if self.table != "dos" else 0))
        return first, last

    def esp(self):
        return next((p for p in self.parts if is_esp(p)), None)


def is_esp(p):
    return p.type.upper() in (GPT_TYPE["esp"], "EF") or (p.fstype == "vfat" and p.label.upper() in ("EFI", "ESP", "SYSTEM"))


def align_up(n, a=ALIGN):
    return -(-n // a) * a


def align_down(n, a=ALIGN):
    return n // a * a


def gaps(disk, min_size=MiB):
    """Unused regions [start, end) of the disk, aligned to 1 MiB."""
    first, last = disk.usable()
    out, pos = [], align_up(first)
    for p in sorted(disk.parts, key=lambda p: p.start):
        if p.start - pos >= min_size:
            out.append((pos, align_down(p.start)))
        pos = max(pos, align_up(p.end))
    end = align_down(last)
    if end - pos >= min_size:
        out.append((pos, end))
    return [(s, e) for s, e in out if e - s >= min_size]


def part_path(disk_path, number):
    """/dev/sda + 3 -> /dev/sda3; /dev/nvme0n1 + 3 -> /dev/nvme0n1p3; /dev/mmcblk0 -> ...p3; /dev/loop0 -> loop0p3."""
    return f"{disk_path}p{number}" if disk_path[-1].isdigit() else f"{disk_path}{number}"


def next_number(disk):
    used = {p.number for p in disk.parts}
    if disk.table == "dos":
        for n in range(1, 5):
            if n not in used:
                return n
        raise PlanError("This disk uses the old MBR layout and already has four partitions, "
                        "so no room for Orbit. Free one up in Windows, or choose another disk.")
    return max(used, default=0) + 1


# ------------------------------------------------------------------------------- steps
@dataclass
class Step:
    """One engine action. `do` names the engine function; the rest are its arguments."""
    do: str
    args: dict
    say: str        # shown in the progress screen and the log

    def to_json(self):
        return asdict(self)


@dataclass
class Plan:
    mode: str
    disk: str
    firmware: str
    steps: list
    summary: list      # human sentences for the confirmation screen
    root: str          # partition (or LUKS inner device) that becomes /
    esp: str = ""
    boot: str = ""
    encrypted: bool = False
    luks: str = ""     # the LUKS partition when encrypted
    erases: list = field(default_factory=list)   # partitions/disks whose data is destroyed
    dual_boot: bool = False

    def to_json(self):
        d = asdict(self)
        d["steps"] = [s.to_json() for s in self.steps]
        return d


def _new_fs_steps(root, esp=None, boot=None, encrypted=False, format_esp=True):
    steps = []
    target = root
    if encrypted:
        steps.append(Step("luks_format", {"device": root, "name": "orbit-root"}, "Encrypting the Orbit partition"))
        target = "/dev/mapper/orbit-root"
    steps.append(Step("mkfs", {"device": target, "fs": "ext4", "label": "Orbit"}, "Creating the Orbit file system"))
    if boot:
        steps.append(Step("mkfs", {"device": boot, "fs": "ext4", "label": "OrbitBoot"}, "Creating the boot partition"))
    if esp and format_esp:
        steps.append(Step("mkfs", {"device": esp, "fs": "vfat", "label": "EFI"}, "Creating the EFI system partition"))
    return steps, target


def _human(n):
    return f"{n / GiB:.0f} GB" if n >= 10 * GiB else f"{n / GiB:.1f} GB"


def plan_erase(disk, firmware, encrypt=False):
    if disk.size < MIN_ROOT + ESP_SIZE + (BOOT_SIZE if encrypt else 0) + 2 * MiB:
        raise PlanError(f"{disk.model or disk.path} is too small: Orbit needs at least {_human(MIN_ROOT + ESP_SIZE)}.")
    sec = disk.sector
    layout = []   # (name, size or None for rest, gpt type)
    if firmware == "uefi":
        layout.append(("EFI", ESP_SIZE, GPT_TYPE["esp"]))
    else:
        layout.append(("BIOS boot", BIOS_BOOT_SIZE, GPT_TYPE["bios"]))
    if encrypt:
        layout.append(("Orbit boot", BOOT_SIZE, GPT_TYPE["xbootldr"] if firmware == "uefi" else GPT_TYPE["linux"]))
    layout.append(("Orbit", None, GPT_TYPE["linux"]))
    lines, pos = [], ALIGN
    for name, size, typ in layout:
        if size:
            lines.append({"start": pos // sec, "size": size // sec, "type": typ, "name": name})
            pos += size
        else:
            lines.append({"start": pos // sec, "size": None, "type": typ, "name": name})
    paths = [part_path(disk.path, i + 1) for i in range(len(layout))]
    esp = paths[0] if firmware == "uefi" else ""
    boot = paths[1] if encrypt else ""
    root = paths[-1]
    steps = [
        Step("wipe", {"disk": disk.path}, f"Clearing {disk.model or disk.path}"),
        Step("new_table", {"disk": disk.path, "label": "gpt", "parts": lines}, "Creating new partitions"),
        Step("settle", {"disk": disk.path}, "Waiting for the new partitions"),
    ]
    fs_steps, target = _new_fs_steps(root, esp or None, boot or None, encrypt)
    steps += fs_steps
    summary = [f"Everything on {disk.model or 'this disk'} ({disk.path}, {_human(disk.size)}) will be erased."]
    summary.append("Orbit will use the whole disk" + (", encrypted with your security key." if encrypt else "."))
    return Plan("erase", disk.path, firmware, steps, summary, root=target, esp=esp, boot=boot,
                encrypted=encrypt, luks=root if encrypt else "", erases=[disk.path])


def plan_alongside(disk, firmware, windows_part_number, orbit_size, encrypt=False):
    """Shrink the Windows partition by `orbit_size` bytes and install Orbit in the freed space."""
    win = next((p for p in disk.parts if p.number == windows_part_number), None)
    if not win:
        raise PlanError("That Windows partition was not found on the disk.")
    if win.fstype.lower() == "bitlocker":
        raise PlanError("Windows is encrypted with BitLocker, so Orbit cannot shrink it. In Windows, open "
                        "Disk Management, right-click C: and choose Shrink Volume, then pick “Use free space”.")
    if win.fstype != "ntfs":
        raise PlanError("Only NTFS (Windows) partitions can be shrunk.")
    if firmware == "uefi" and disk.table == "gpt" and not disk.esp():
        raise PlanError("This disk has no EFI system partition to share with Windows.")
    if firmware == "uefi" and disk.table == "dos":
        raise PlanError("Windows on this disk starts in legacy (BIOS) mode. Restart the computer, "
                        "switch the firmware to BIOS/CSM boot, and start the installer again.")
    need = (BOOT_SIZE if encrypt else 0) + MIN_ROOT
    orbit_size = align_down(orbit_size)
    if orbit_size < need:
        raise PlanError(f"Give Orbit at least {_human(need)}.")
    if not win.min_size:
        raise PlanError("Could not measure how far Windows can shrink (is Windows hibernated, or "
                        "Fast Startup on? Turn Fast Startup off in Windows and shut down fully).")
    new_win = align_down(win.size - orbit_size)
    if new_win < win.min_size + WINDOWS_KEEP_FREE:
        most = align_down(win.size - win.min_size - WINDOWS_KEEP_FREE)
        raise PlanError(f"Windows needs to keep {_human(win.min_size + WINDOWS_KEEP_FREE)}. "
                        f"Orbit can have at most {_human(max(0, most))} here.")
    sec = disk.sector
    start = align_up(win.start + new_win)
    end = align_down(win.end)
    # any partition directly after Windows (often the recovery partition) stays where it is
    after = [p for p in disk.parts if p.start >= win.end]
    if after and min(p.start for p in after) < end:
        raise PlanError("There is a partition in the way after Windows.")
    steps = [
        Step("ntfs_check", {"device": win.path or part_path(disk.path, win.number)}, "Checking the Windows partition"),
        Step("ntfs_shrink", {"device": win.path or part_path(disk.path, win.number), "size": new_win},
             f"Shrinking Windows to {_human(new_win)}"),
        Step("resize_part", {"disk": disk.path, "number": win.number, "size": new_win // sec}, "Updating the partition table"),
    ]
    numbers, created = [], []
    pos = start
    if encrypt:
        n = next_number(disk)
        numbers.append(n)
        created.append({"number": n, "start": pos // sec, "size": BOOT_SIZE // sec, "type": "linux", "name": "Orbit boot"})
        pos += BOOT_SIZE
        disk = _with_part(disk, n, pos - BOOT_SIZE, BOOT_SIZE)
    n = next_number(disk)
    created.append({"number": n, "start": pos // sec, "size": (end - pos) // sec, "type": "linux", "name": "Orbit"})
    for c in created:
        steps.append(Step("add_part", {"disk": disk.path, "table": disk.table, **c}, f"Adding the {c['name']} partition"))
    steps.append(Step("settle", {"disk": disk.path}, "Waiting for the new partitions"))
    root = part_path(disk.path, created[-1]["number"])
    boot = part_path(disk.path, created[0]["number"]) if encrypt else ""
    esp_part = disk.esp()
    esp = (esp_part.path or part_path(disk.path, esp_part.number)) if (esp_part and firmware == "uefi") else ""
    fs_steps, target = _new_fs_steps(root, esp or None, boot or None, encrypt, format_esp=False)
    steps += fs_steps
    summary = [f"Windows on {disk.model or disk.path} will be shrunk from {_human(win.size)} to {_human(new_win)}. Your files in Windows stay.",
               f"Orbit gets {_human(end - start)}" + (", encrypted with your security key." if encrypt else "."),
               "When the computer starts you can choose Orbit OS or Windows."]
    return Plan("alongside", disk.path, firmware, steps, summary, root=target, esp=esp, boot=boot, encrypted=encrypt,
                luks=root if encrypt else "", erases=[], dual_boot=True)


def plan_free_space(disk, firmware, gap_start, encrypt=False):
    """Install into the unused region that starts at `gap_start` (bytes)."""
    gap = next(((s, e) for s, e in gaps(disk) if s == gap_start), None)
    if not gap:
        raise PlanError("That free space is no longer there. Go back and pick again.")
    start, end = gap
    if disk.table == "":
        raise PlanError("This disk has no partition table. Choose “Erase disk” for it instead.")
    if firmware == "uefi" and disk.table == "dos":
        raise PlanError("This disk uses the old MBR layout, which this computer cannot start Orbit from in UEFI mode.")
    sec = disk.sector
    need_esp = firmware == "uefi" and not disk.esp()
    need = MIN_ROOT + (ESP_SIZE if need_esp else 0) + (BOOT_SIZE if encrypt else 0)
    if end - start < need:
        raise PlanError(f"This free space is {_human(end - start)}; Orbit needs at least {_human(need)}.")
    created, pos, d = [], start, disk
    if need_esp:
        n = next_number(d)
        created.append({"number": n, "start": pos // sec, "size": ESP_SIZE // sec, "type": "esp", "name": "EFI"})
        d = _with_part(d, n, pos, ESP_SIZE)
        pos += ESP_SIZE
    if encrypt:
        n = next_number(d)
        created.append({"number": n, "start": pos // sec, "size": BOOT_SIZE // sec, "type": "linux", "name": "Orbit boot"})
        d = _with_part(d, n, pos, BOOT_SIZE)
        pos += BOOT_SIZE
    n = next_number(d)
    created.append({"number": n, "start": pos // sec, "size": (end - pos) // sec, "type": "linux", "name": "Orbit"})
    if firmware == "bios" and disk.table == "gpt" and not any(p.type.upper() == GPT_TYPE["bios"] for p in disk.parts):
        raise PlanError("This GPT disk has no BIOS boot partition, so this computer could not start Orbit from it. "
                        "Use “Erase disk” or start the computer in UEFI mode.")
    steps = [Step("add_part", {"disk": disk.path, "table": disk.table, **c}, f"Adding the {c['name']} partition") for c in created]
    steps.append(Step("settle", {"disk": disk.path}, "Waiting for the new partitions"))
    by_name = {c["name"]: part_path(disk.path, c["number"]) for c in created}
    root, boot = by_name["Orbit"], by_name.get("Orbit boot", "")
    if need_esp:
        esp = by_name["EFI"]
    else:
        e = disk.esp()
        esp = (e.path or part_path(disk.path, e.number)) if (e and firmware == "uefi") else ""
    fs_steps, target = _new_fs_steps(root, esp or None, boot or None, encrypt, format_esp=need_esp)
    steps += fs_steps
    others = [p for p in disk.parts if p.windows or p.fstype in ("ntfs", "ext4", "btrfs", "xfs")]
    summary = [f"Orbit goes into {_human(end - start)} of free space on {disk.model or disk.path}. Nothing else on the disk changes."]
    if encrypt:
        summary.append("The Orbit partition is encrypted with your security key.")
    return Plan("free", disk.path, firmware, steps, summary, root=target, esp=esp, boot=boot, encrypted=encrypt,
                luks=root if encrypt else "", erases=[], dual_boot=bool(others))


def _with_part(disk, number, start, size):
    """Copy of `disk` with one more (planned) partition, so the next number and gaps stay right."""
    return Disk(disk.path, disk.size, disk.model, disk.table, disk.sector,
                disk.parts + [Part(number, start, size)], disk.first_usable, disk.last_usable)


def windows_partition(disk):
    """The NTFS partition that most likely holds Windows (the largest one marked by the probe)."""
    cands = [p for p in disk.parts if p.windows] or [p for p in disk.parts if p.fstype == "ntfs" and p.size > 30 * GiB]
    return max(cands, key=lambda p: p.size, default=None)


def options(disk, firmware):
    """What the disk screen offers for this disk: list of dicts with an id, a title and whether it is possible."""
    out = [{"id": "erase", "ok": disk.size >= MIN_ROOT + ESP_SIZE, "why": "" if disk.size >= MIN_ROOT + ESP_SIZE
            else f"The disk is smaller than {_human(MIN_ROOT + ESP_SIZE)}."}]
    win = windows_partition(disk)
    if win:
        try:
            plan_alongside(disk, firmware, win.number, MIN_ROOT + (BOOT_SIZE if False else 0))
            out.append({"id": "alongside", "ok": True, "why": "", "windows": win.number})
        except PlanError as e:
            out.append({"id": "alongside", "ok": False, "why": str(e), "windows": win.number})
    big = [(s, e) for s, e in gaps(disk) if e - s >= MIN_ROOT]
    if big and disk.table:
        s, e = max(big, key=lambda g: g[1] - g[0])
        out.append({"id": "free", "ok": True, "why": "", "gap": s, "size": e - s})
    return out
