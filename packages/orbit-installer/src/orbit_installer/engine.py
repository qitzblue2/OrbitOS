"""The part of the installer that runs as root.

Started once by the frontend through pkexec and driven with one JSON object per line
on stdin; every answer and progress event is one JSON object per line on stdout:

    {"cmd": "probe"}                         -> {"event": "probe", "firmware": ..., "disks": [...]}
    {"cmd": "plan", "choice": {...}}         -> {"event": "plan", "plan": {...}} or {"event": "error", ...}
    {"cmd": "install", "choice": {...}, "settings": {...}}
                                             -> {"event": "progress", "percent": .., "say": ..} ... {"event": "done"}

Secrets (account password, encryption key) only travel on this pipe, never on a
command line, and are never logged. The plan is recomputed here from a fresh probe;
the frontend never sends partition numbers or commands of its own.
"""
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import time
import traceback

from . import plan as P
from . import probe
from . import target as T

LOG = "/var/log/orbit-installer.log"
SQUASHFS = ["/run/live/medium/live/filesystem.squashfs", "/lib/live/mount/medium/live/filesystem.squashfs"]
TARGET = "/target"


class InstallError(RuntimeError):
    pass


class Engine:
    def __init__(self, out=sys.stdout, dry_run=False, log_path=LOG):
        self.out = out
        self.dry = dry_run
        self.secrets = []
        try:
            self.log = open(log_path, "a", buffering=1)
        except OSError:
            self.log = open(os.devnull, "w")
        self.percent = 0

    # ---------------------------------------------------------------- output
    def emit(self, **ev):
        self.out.write(json.dumps(ev) + "\n")
        self.out.flush()

    def note(self, text):
        for s in self.secrets:
            if s:
                text = text.replace(s, "••••")
        self.log.write(time.strftime("%H:%M:%S ") + text + "\n")

    def progress(self, percent, say):
        self.percent = max(self.percent, int(percent))
        self.note(f"[{self.percent:3d}%] {say}")
        self.emit(event="progress", percent=self.percent, say=say)

    def run(self, cmd, stdin=None, check=True, chroot=False):
        if chroot:
            cmd = ["chroot", TARGET] + cmd
        self.note("$ " + " ".join(shlex.quote(c) for c in cmd))
        if self.dry:
            return subprocess.CompletedProcess(cmd, 0, "", "")
        r = subprocess.run(cmd, input=stdin, capture_output=True, text=True,
                           env={**os.environ, "LC_ALL": "C.UTF-8", "DEBIAN_FRONTEND": "noninteractive"})
        if r.stdout.strip():
            self.note(r.stdout.strip()[-4000:])
        if r.stderr.strip():
            self.note("stderr: " + r.stderr.strip()[-4000:])
        if check and r.returncode != 0:
            raise InstallError(f"{cmd[0] if not chroot else cmd[2]} failed ({r.returncode}): {(r.stderr or r.stdout).strip()[-400:]}")
        return r

    # ---------------------------------------------------------------- commands
    # disks: real ones, or (dry run only, for screenshots and demos) a layout from a JSON file
    def firmware(self):
        fx = self.fixture()
        return fx["firmware"] if fx else probe.firmware()

    def fixture(self):
        path = os.environ.get("ORBIT_INSTALLER_FIXTURE")
        if not (self.dry and path):
            return None
        with open(path) as f:
            return json.load(f)

    def disks(self):
        fx = self.fixture()
        if fx:
            return [P.Disk(**{**d, "parts": [P.Part(**p) for p in d["parts"]]}) for d in fx["disks"]]
        out = []
        for d in probe.disks():
            probe.detect_windows(d)
            out.append(d)
        return out

    def in_use(self, path):
        return [] if self.fixture() else probe.mounted_inside(path)

    def do_probe(self, _msg):
        fw = self.firmware()
        out = []
        for d in self.disks():
            out.append({"disk": disk_json(d), "options": P.options(d, fw), "in_use": self.in_use(d.path)})
        self.emit(event="probe", firmware=fw, disks=out, ram=probe.ram_bytes())

    def make_plan(self, choice):
        fw = self.firmware()
        disk = next((d for d in self.disks() if d.path == choice.get("disk")), None)
        if not disk:
            raise P.PlanError("That disk is not available any more.")
        if self.in_use(disk.path):
            raise P.PlanError("Part of this disk is in use (mounted). Close any open files on it and try again.")
        enc = bool(choice.get("encrypt"))
        mode = choice.get("mode")
        if mode == "erase":
            return P.plan_erase(disk, fw, enc)
        if mode == "alongside":
            win = P.windows_partition(disk)
            if not win:
                raise P.PlanError("No Windows installation was found on this disk.")
            return P.plan_alongside(disk, fw, win.number, int(choice.get("size") or 0), enc)
        if mode == "free":
            return P.plan_free_space(disk, fw, int(choice.get("gap")), enc)
        raise P.PlanError("Unknown installation type.")

    def do_plan(self, msg):
        self.emit(event="plan", plan=self.make_plan(msg.get("choice") or {}).to_json())

    def do_install(self, msg):
        settings = T.Settings.from_json(msg.get("settings") or {})
        self.secrets = [settings.password, msg.get("choice", {}).get("key", "")]
        plan = self.make_plan(msg.get("choice") or {})
        if plan.encrypted and len(msg["choice"].get("key", "")) < 8:
            raise P.PlanError("The security key must be at least 8 characters.")
        src = next((p for p in SQUASHFS if os.path.exists(p)), None) or (None if not self.dry else "/dev/null")
        if not src:
            raise InstallError("The Orbit system image was not found. Are you running the installer from the Orbit live USB?")
        self.note(f"install: mode={plan.mode} disk={plan.disk} firmware={plan.firmware} encrypted={plan.encrypted}")
        try:
            # 0-15 %: disks
            n = len(plan.steps)
            for i, step in enumerate(plan.steps):
                self.progress(1 + 14 * i / max(1, n), step.say)
                getattr(self, f"step_{step.do}")(key=msg["choice"].get("key", ""), **step.args)
            # 15-75 %: copy the system
            self.mount_target(plan)
            self.copy_system(src)
            # 75-98 %: set it up
            T.configure(self, plan, settings)
            self.progress(98, "Finishing")
        finally:
            self.unmount_target(plan)
        self.progress(100, "Orbit OS is installed")
        self.emit(event="done")

    # ---------------------------------------------------------------- disk steps
    def step_wipe(self, disk, **_):
        for part in self.partitions_of(disk):
            self.run(["wipefs", "-a", "-q", part], check=False)
        self.run(["wipefs", "-a", "-q", disk])

    def step_new_table(self, disk, label, parts, **_):
        lines = [f"label: {label}", "unit: sectors", ""]
        for p in parts:
            size = f", size={p['size']}" if p["size"] else ""
            lines.append(f"start={p['start']}{size}, type={p['type']}, name=\"{p['name']}\"")
        self.run(["sfdisk", "--no-reread", "--wipe", "always", "--wipe-partitions", "always", disk], stdin="\n".join(lines) + "\n")

    def step_ntfs_check(self, device, **_):
        r = self.run(["ntfsresize", "--info", "--no-progress-bar", device], check=False)
        text = (r.stdout + r.stderr).lower()
        if "hibernat" in text or "unsafe state" in text:
            raise InstallError("Windows was not shut down fully (Fast Startup or hibernation). Start Windows, turn off "
                               "Fast Startup in Power Options, choose Shut down, then try again.")

    def step_ntfs_shrink(self, device, size, **_):
        self.run(["ntfsresize", "--no-action", "--force", "--no-progress-bar", "--size", str(size), device])
        self.run(["ntfsresize", "--force", "--force", "--no-progress-bar", "--size", str(size), device], stdin="y\n")

    def step_resize_part(self, disk, number, size, **_):
        self.run(["sfdisk", "--no-reread", "-N", str(number), disk], stdin=f", {size}\n")

    def step_add_part(self, disk, table, number, start, size, type, name, **_):
        if table == "dos":
            typ = P.MBR_TYPE.get(type, "83")
            line = f"start={start}, size={size}, type={typ}"
        else:
            typ = P.GPT_TYPE.get(type, P.GPT_TYPE["linux"])
            line = f"start={start}, size={size}, type={typ}, name=\"{name}\""
        self.run(["sfdisk", "--no-reread", "--append", disk], stdin=line + "\n")

    def step_settle(self, disk, **_):
        self.run(["partx", "-u", disk], check=False)
        self.run(["partprobe", disk], check=False)
        self.run(["udevadm", "settle", "--timeout=30"], check=False)
        if not self.dry:
            time.sleep(1)

    def step_luks_format(self, device, name, key="", **_):
        if not key:
            raise InstallError("No security key was given for encryption.")
        self.run(["cryptsetup", "luksFormat", "--batch-mode", "--type", "luks2", "--pbkdf", "argon2id",
                  "--label", "Orbit", "--key-file", "-", device], stdin=key)
        self.run(["cryptsetup", "open", "--key-file", "-", device, name], stdin=key)

    def step_mkfs(self, device, fs, label, **_):
        if fs == "vfat":
            self.run(["mkfs.vfat", "-F", "32", "-n", label[:11], device])
        else:
            self.run(["mkfs.ext4", "-F", "-q", "-L", label, device])

    def partitions_of(self, disk):
        r = subprocess.run(["lsblk", "-n", "-p", "-o", "PATH,TYPE", disk], capture_output=True, text=True)
        return [line.split()[0] for line in r.stdout.splitlines() if line.split()[-1:] == ["part"]]

    # ---------------------------------------------------------------- copy
    def mount_target(self, plan):
        self.progress(15, "Mounting the new system")
        os.makedirs(TARGET, exist_ok=True)
        self.run(["mount", plan.root, TARGET])
        if plan.boot:
            os.makedirs(f"{TARGET}/boot", exist_ok=True)
            self.run(["mount", plan.boot, f"{TARGET}/boot"])
        if plan.esp:
            os.makedirs(f"{TARGET}/boot/efi", exist_ok=True)
            self.run(["mount", plan.esp, f"{TARGET}/boot/efi"])

    def copy_system(self, src):
        self.progress(16, "Copying Orbit OS")
        if self.dry:
            self.note(f"$ unsquashfs -f -d {TARGET} {src}")
            return
        cmd = ["unsquashfs", "-f", "-percentage", "-d", TARGET, src]
        self.note("$ " + " ".join(cmd))
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        last = 0
        for line in p.stdout:
            m = re.match(r"\s*(\d+)", line)
            if m and int(m.group(1)) != last:
                last = int(m.group(1))
                self.progress(16 + last * 0.59, f"Copying Orbit OS ({last}%)")
        err = p.stderr.read()
        if p.wait() != 0:
            raise InstallError(f"Copying the system failed: {err.strip()[-400:]}")
        self.progress(75, "System copied")

    def unmount_target(self, plan):
        for sub in ("dev/pts", "dev", "proc", "sys/firmware/efi/efivars", "sys", "run", "boot/efi", "boot", ""):
            path = f"{TARGET}/{sub}".rstrip("/")
            if os.path.ismount(path) and not self.dry:
                self.run(["umount", "-l", path], check=False)
        if plan.encrypted and not self.dry and os.path.exists("/dev/mapper/orbit-root"):
            self.run(["cryptsetup", "close", "orbit-root"], check=False)
        if not self.dry:
            self.run(["sync"], check=False)


def disk_json(d):
    return {"path": d.path, "size": d.size, "model": d.model, "table": d.table, "sector": d.sector,
            "parts": [{"number": p.number, "start": p.start, "size": p.size, "fstype": p.fstype, "label": p.label,
                       "windows": p.windows, "esp": P.is_esp(p), "esp_has_windows": p.esp_has_windows,
                       "min_size": p.min_size} for p in d.parts],
            "gaps": [{"start": s, "size": e - s} for s, e in P.gaps(d)]}


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if os.geteuid() != 0 and "--dry-run" not in argv:
        print(json.dumps({"event": "error", "message": "The installer engine must run as root."}), flush=True)
        return 1
    eng = Engine(dry_run="--dry-run" in argv)
    eng.note("engine started")
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
            cmd = msg.get("cmd")
            if cmd == "quit":
                break
            handler = {"probe": eng.do_probe, "plan": eng.do_plan, "install": eng.do_install}.get(cmd)
            if not handler:
                raise P.PlanError(f"unknown command {cmd!r}")
            handler(msg)
        except P.PlanError as e:
            eng.note(f"plan error: {e}")
            eng.emit(event="error", message=str(e), fatal=False)
        except Exception as e:  # noqa: BLE001 - everything else is reported, logged and ends the install
            eng.note("".join(traceback.format_exception(e)))
            eng.emit(event="error", message=str(e), fatal=True, log=LOG)
    return 0


if __name__ == "__main__":
    sys.exit(main())
