#!/usr/bin/env python3
"""Run the real installer engine against throwaway disk images (loop devices).

Needs root and: sfdisk, mkfs.ext4, mkfs.vfat, mkntfs, ntfsresize, cryptsetup, mksquashfs.
    sudo python3 tests/installer_integration.py

Covers the disk work end to end (partitioning, Windows shrink, encryption, file
systems, copying the system image). The final configure step (accounts, boot loader)
needs a full Orbit system in the image and is replaced by a check of what got mounted.
"""
import io
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "packages", "orbit-installer", "src"))
os.environ["ORBIT_INSTALLER_ALLOW_LOOP"] = "1"

from orbit_installer import engine as E  # noqa: E402
from orbit_installer import plan as P  # noqa: E402
from orbit_installer import probe  # noqa: E402
from orbit_installer import target as T  # noqa: E402

GiB, MiB = P.GiB, P.MiB
FAIL = []
HAS_VFAT = "vfat" in open("/proc/filesystems").read()
WORK = tempfile.mkdtemp(prefix="orbit-inst-")


def sh(*cmd, stdin=None):
    return subprocess.run(cmd, input=stdin, capture_output=True, text=True, check=True).stdout


def check(ok, what):
    print(("ok   " if ok else "FAIL ") + what, flush=True)
    if not ok:
        FAIL.append(what)


def loop_disk(name, size):
    img = os.path.join(WORK, name)
    with open(img, "wb") as f:
        f.truncate(size)
    return sh("losetup", "-f", "--show", "-P", img).strip()


def tiny_system():
    root = os.path.join(WORK, "rootfs")
    os.makedirs(f"{root}/etc", exist_ok=True)
    with open(f"{root}/etc/os-release", "w") as f:
        f.write('NAME="Orbit OS"\nID=orbit\nID_LIKE=debian\n')
    os.makedirs(f"{root}/usr/bin", exist_ok=True)
    with open(f"{root}/usr/bin/hello", "w") as f:
        f.write("#!/bin/sh\necho hi\n")
    sq = os.path.join(WORK, "filesystem.squashfs")
    sh("mksquashfs", root, sq, "-quiet", "-noappend")
    return sq


def run_install(choice, firmware="uefi"):
    seen = {}

    def fake_configure(eng, plan, settings):
        seen["root_mounted"] = os.path.ismount(E.TARGET)
        seen["esp_mounted"] = os.path.ismount(f"{E.TARGET}/boot/efi")
        seen["boot_mounted"] = os.path.ismount(f"{E.TARGET}/boot")
        seen["copied"] = open(f"{E.TARGET}/etc/os-release").read()
        seen["plan"] = plan

    out = io.StringIO()
    eng = E.Engine(out=out, log_path=os.path.join(WORK, "install.log"))
    if not HAS_VFAT:
        # sandbox kernels without FAT support cannot mount the EFI partition; real PCs always can
        real_run = eng.run

        def run(cmd, *a, **kw):
            if cmd[:1] == ["mount"] and cmd[-1].endswith("/boot/efi"):
                eng.note("(test) skipped EFI mount: kernel without vfat")
                return subprocess.CompletedProcess(cmd, 0, "", "")
            return real_run(cmd, *a, **kw)
        eng.run = run
    real_conf, real_fw = T.configure, probe.firmware
    T.configure, probe.firmware = fake_configure, (lambda: firmware)
    E.T.configure = fake_configure
    try:
        settings = {"fullname": "Test", "username": "test", "password": "secret12", "hostname": "orbit-test",
                    "locale": "en_US.UTF-8", "keyboard": "us", "timezone": "UTC"}
        eng.do_install({"choice": choice, "settings": settings})
    finally:
        T.configure, probe.firmware = real_conf, real_fw
        E.T.configure = real_conf
    events = [json.loads(line) for line in out.getvalue().splitlines()]
    return seen, events


def fstypes(dev):
    """File system per partition, read from the disk itself (blkid works without udev)."""
    out = {}
    for line in sh("lsblk", "-n", "-p", "-o", "PATH", dev).split():
        r = subprocess.run(["blkid", "-p", "-s", "TYPE", "-o", "value", line], capture_output=True, text=True)
        out[line] = r.stdout.strip()
    return out


def test_encrypted(loops):
    d = loop_disk("crypt.img", 40 * GiB)
    loops.append(d)
    seen, ev = run_install({"mode": "erase", "disk": d, "encrypt": True, "key": "correct horse battery"})
    check(ev[-1].get("event") == "done", "encrypted: install finishes")
    check(seen.get("boot_mounted") and seen["plan"].root == "/dev/mapper/orbit-root", "encrypted: /boot separate, root inside LUKS")
    check(fstypes(d).get(f"{d}p3") == "crypto_LUKS", "encrypted: Orbit partition is LUKS")
    r = subprocess.run(["cryptsetup", "open", "--test-passphrase", "--key-file", "-", f"{d}p3"], input="correct horse battery",
                       capture_output=True, text=True)
    check(r.returncode == 0, "encrypted: the chosen security key opens it")
    log = open(os.path.join(WORK, "install.log")).read()
    check("correct horse battery" not in log and "secret12" not in log, "secrets never reach the log")



def main():
    if os.geteuid() != 0:
        print("run as root")
        return 2
    sq = tiny_system()
    E.SQUASHFS.insert(0, sq)
    loops = []
    try:
        # ---- 1. erase, UEFI
        d = loop_disk("erase.img", 40 * GiB)
        loops.append(d)
        seen, ev = run_install({"mode": "erase", "disk": d})
        check(ev[-1].get("event") == "done", "erase: install finishes")
        check(seen.get("root_mounted") and (seen.get("esp_mounted") or not HAS_VFAT),
              "erase: root and EFI partition mounted for setup" + ("" if HAS_VFAT else " (EFI mount skipped: no vfat in this kernel)"))
        check("Orbit OS" in seen.get("copied", ""), "erase: system image copied onto the new disk")
        fs = fstypes(d)
        check(fs.get(f"{d}p1") == "vfat" and fs.get(f"{d}p2") == "ext4", f"erase: partitions formatted ({fs})")
        pct = [e["percent"] for e in ev if e.get("event") == "progress"]
        check(pct == sorted(pct) and pct[-1] == 100, "erase: progress only goes up and ends at 100%")
        check(not os.path.ismount(E.TARGET), "erase: everything unmounted afterwards")

        # ---- 2. erase, encrypted (needs device-mapper in the kernel)
        if subprocess.run(["dmsetup", "version"], capture_output=True).returncode != 0:
            print("skip encrypted install: this kernel has no device-mapper (dm_mod)")
        else:
            test_encrypted(loops)

        # ---- 3. alongside Windows (real NTFS shrink), keeps the Windows files
        size = 120 * GiB
        d = loop_disk("windows.img", size)
        loops.append(d)
        sh("sfdisk", "-q", d, stdin="label: gpt\nsize=260MiB, type=U, name=\"EFI\"\nsize=16MiB, type=E3C9E316-0B5C-4DB8-817D-F92DF00215AE\n"
                                     "size=100GiB, type=EBD0A0A2-B9E5-4433-87C0-68B6B72699C7, name=\"Windows\"\n"
                                     "type=DE94BBA4-06D1-4D40-A16A-BFD50179D6AC, name=\"Recovery\"\n")
        sh("partx", "-u", d)
        sh("mkfs.vfat", "-F", "32", "-n", "SYSTEM", f"{d}p1")
        sh("mkntfs", "-f", "-q", "-L", "Windows", f"{d}p3")
        mnt = os.path.join(WORK, "win")
        os.makedirs(mnt)
        if subprocess.run(["mount", "-t", "ntfs3", f"{d}p3", mnt], capture_output=True).returncode:
            sh("ntfs-3g", f"{d}p3", mnt)
        with open(f"{mnt}/homework.txt", "w") as f:
            f.write("keep me")
        sh("umount", mnt)
        disk = next(x for x in probe.disks() if x.path == d)
        probe.detect_windows(disk)
        win = P.windows_partition(disk)
        check(win is not None and win.number == 3 and win.min_size > 0, f"alongside: Windows found, can shrink to {win and win.min_size}")
        seen, ev = run_install({"mode": "alongside", "disk": d, "size": 40 * GiB})
        check(ev[-1].get("event") == "done", f"alongside: install finishes ({ev[-1]})")
        sizes = {line.split()[0]: int(line.split()[1]) for line in sh("lsblk", "-n", "-b", "-p", "-o", "PATH,SIZE", d).splitlines()[1:]}
        check(sizes.get(f"{d}p3", 0) <= 60 * GiB + MiB, f"alongside: Windows partition shrunk ({sizes.get(f'{d}p3', 0) / GiB:.1f} GiB)")
        check(f"{d}p5" in sizes and sizes[f"{d}p5"] >= 39 * GiB, "alongside: Orbit partition created in the freed space")
        check(seen["plan"].esp == f"{d}p1" and fstypes(d).get(f"{d}p1") == "vfat", "alongside: Windows EFI partition reused, not reformatted")
        r = subprocess.run(["ntfsresize", "--info", "--force", "--no-progress-bar", f"{d}p3"], capture_output=True, text=True)
        check(r.returncode == 0, "alongside: shrunk NTFS is consistent")
        if subprocess.run(["mount", "-t", "ntfs3", "-o", "ro", f"{d}p3", mnt], capture_output=True).returncode:
            sh("ntfs-3g", "-o", "ro", f"{d}p3", mnt)
        check(open(f"{mnt}/homework.txt").read() == "keep me", "alongside: files in Windows are still there")
        sh("umount", mnt)
        check(fstypes(d).get(f"{d}p4", "") != "ext4", "alongside: recovery partition left alone")
    finally:
        for mp in (f"{E.TARGET}/boot/efi", f"{E.TARGET}/boot", E.TARGET):
            subprocess.run(["umount", "-l", mp], capture_output=True)
        subprocess.run(["cryptsetup", "close", "orbit-root"], capture_output=True)
        for d in loops:
            subprocess.run(["losetup", "-d", d], capture_output=True)
    print("\nINSTALLER INTEGRATION PASSED" if not FAIL else f"\n{len(FAIL)} FAILED: {FAIL}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
