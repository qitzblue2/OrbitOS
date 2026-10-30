"""Setting up the freshly copied system in /target: accounts, language, boot."""
import os
import re
import shutil
from dataclasses import dataclass

TARGET = "/target"
POOL = "/usr/share/orbit-installer/pool"   # bootloader packages for the other firmware type
LIVE_PACKAGES = ["live-boot", "live-boot-initramfs-tools", "live-config", "live-config-systemd", "live-tools", "orbit-installer"]
USER_GROUPS = ["sudo", "adm", "audio", "video", "plugdev", "netdev", "bluetooth", "lpadmin", "scanner", "render"]
RESERVED_USERS = {"root", "daemon", "bin", "sys", "sync", "games", "man", "lp", "mail", "news", "uucp", "proxy",
                  "www-data", "backup", "list", "irc", "nobody", "systemd-network", "messagebus", "gdm", "admin"}


@dataclass
class Settings:
    fullname: str
    username: str
    password: str
    hostname: str
    autologin: bool
    locale: str
    keyboard: str
    variant: str
    timezone: str

    @classmethod
    def from_json(cls, d):
        s = cls(fullname=str(d.get("fullname", "")).strip()[:80], username=str(d.get("username", "")),
                password=str(d.get("password", "")), hostname=str(d.get("hostname", "")),
                autologin=bool(d.get("autologin")), locale=str(d.get("locale", "en_US.UTF-8")),
                keyboard=str(d.get("keyboard", "us")), variant=str(d.get("variant", "")),
                timezone=str(d.get("timezone", "UTC")))
        s.check()
        return s

    def check(self):
        from .plan import PlanError
        problems = validate(self)
        if problems:
            raise PlanError(problems[0])


def validate(s):
    """Human-readable problems with the settings (empty list = fine). Shared with the frontend."""
    out = []
    if not re.fullmatch(r"[a-z][a-z0-9_-]{0,30}", s.username or ""):
        out.append("The username must start with a small letter and use only small letters, digits, - and _.")
    elif s.username in RESERVED_USERS:
        out.append(f"“{s.username}” is reserved by the system. Pick another username.")
    if any(c in s.fullname for c in ":,\n="):
        out.append("Your name cannot contain : , or =.")
    if len(s.password) < 6:
        out.append("The password must be at least 6 characters.")
    if "\n" in s.password:
        out.append("The password cannot contain a line break.")
    if not re.fullmatch(r"[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?", s.hostname or ""):
        out.append("The computer name may use letters, digits and - (not at the start or end), up to 63 characters.")
    if not re.fullmatch(r"[a-z]{2,3}(_[A-Z]{2})?(@[a-z]+)?\.UTF-8", s.locale):
        out.append("Unknown language.")
    if not re.fullmatch(r"[a-z]{2,10}", s.keyboard) or not re.fullmatch(r"[a-zA-Z0-9_-]{0,30}", s.variant):
        out.append("Unknown keyboard layout.")
    if not re.fullmatch(r"[A-Za-z0-9_+-]+(/[A-Za-z0-9_+-]+){0,2}", s.timezone) or ".." in s.timezone:
        out.append("Unknown time zone.")
    return out


def write(path, text, mode=0o644):
    full = TARGET + path
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "w") as f:
        f.write(text)
    os.chmod(full, mode)


def uuid(eng, device, kind="UUID"):
    if eng.dry:
        return f"DRY-{os.path.basename(device)}"
    return eng.run(["blkid", "-s", kind, "-o", "value", device]).stdout.strip()


def configure(eng, plan, s):
    if not eng.dry:
        bind_mounts(eng)
    eng.progress(76, "Writing the file system table")
    fstab = ["# /etc/fstab: written by the Orbit installer", f"UUID={uuid(eng, plan.root)}  /  ext4  errors=remount-ro  0 1"]
    if plan.boot:
        fstab.append(f"UUID={uuid(eng, plan.boot)}  /boot  ext4  defaults  0 2")
    if plan.esp:
        fstab.append(f"UUID={uuid(eng, plan.esp)}  /boot/efi  vfat  umask=0077  0 1")
    fstab.append("/swapfile  none  swap  sw  0 0")
    if not eng.dry:
        write("/etc/fstab", "\n".join(fstab) + "\n")
        if plan.encrypted:
            write("/etc/crypttab", f"orbit-root  UUID={uuid(eng, plan.luks)}  none  luks,discard\n", 0o600)
        elif os.path.exists(TARGET + "/etc/crypttab"):
            write("/etc/crypttab", "")

    eng.progress(78, "Creating swap space")
    swap_mib = max(1024, min(4096, ram_mib()))
    if not eng.dry:
        eng.run(["fallocate", "-l", f"{swap_mib}M", f"{TARGET}/swapfile"])
        os.chmod(f"{TARGET}/swapfile", 0o600)
        eng.run(["mkswap", f"{TARGET}/swapfile"])

    eng.progress(80, "Setting the computer name, language and keyboard")
    if not eng.dry:
        write("/etc/hostname", s.hostname + "\n")
        write("/etc/hosts", f"127.0.0.1\tlocalhost\n127.0.1.1\t{s.hostname}\n::1\tlocalhost ip6-localhost ip6-loopback\n"
                            "ff02::1\tip6-allnodes\nff02::2\tip6-allrouters\n")
        langs = sorted({s.locale, "en_US.UTF-8"})
        write("/etc/locale.gen", "".join(f"{l} UTF-8\n" for l in langs))
        write("/etc/default/locale", f"LANG={s.locale}\n")
        write("/etc/default/keyboard", f'XKBMODEL="pc105"\nXKBLAYOUT="{s.keyboard}"\nXKBVARIANT="{s.variant}"\nXKBOPTIONS=""\nBACKSPACE="guess"\n')
        src = s.keyboard + (f"+{s.variant}" if s.variant else "")
        write("/etc/dconf/db/local.d/01-orbit-installer", f"[org/gnome/desktop/input-sources]\nsources=[('xkb', '{src}')]\n")
    eng.run(["locale-gen"], chroot=True)
    eng.run(["dconf", "update"], chroot=True, check=False)
    if not eng.dry:
        zone = f"/usr/share/zoneinfo/{s.timezone}"
        if not os.path.exists(TARGET + zone):
            zone, s.timezone = "/usr/share/zoneinfo/UTC", "UTC"
        if os.path.lexists(TARGET + "/etc/localtime"):
            os.remove(TARGET + "/etc/localtime")
        os.symlink(zone, TARGET + "/etc/localtime")
        write("/etc/timezone", s.timezone + "\n")

    eng.progress(83, "Creating your account")
    groups = [g for g in USER_GROUPS if eng.dry or eng.run(["getent", "group", g], chroot=True, check=False).returncode == 0]
    eng.run(["useradd", "--create-home", "--shell", "/bin/bash", "--comment", s.fullname or s.username,
             "--groups", ",".join(groups), s.username], chroot=True)
    eng.run(["chpasswd"], stdin=f"{s.username}:{s.password}\n", chroot=True)
    eng.run(["passwd", "--lock", "root"], chroot=True, check=False)
    if s.autologin and not eng.dry:
        set_gdm_autologin(s.username)

    eng.progress(86, "Removing the live-session parts")
    eng.run(["apt-get", "-y", "-q", "purge"] + LIVE_PACKAGES, chroot=True, check=False)
    for leftover in ("/usr/share/polkit-1/rules.d/49-orbit-installer-live.rules", "/etc/sudoers.d/live",
                     "/etc/xdg/autostart/orbit-installer.desktop"):
        if os.path.exists(TARGET + leftover) and not eng.dry:
            os.remove(TARGET + leftover)
    if not eng.dry:
        shutil.rmtree(TARGET + "/etc/live", ignore_errors=True)   # live-config settings (live user name, ...)
        write("/etc/machine-id", "")
        if os.path.exists(TARGET + "/var/lib/dbus/machine-id"):
            os.remove(TARGET + "/var/lib/dbus/machine-id")

    eng.progress(88, "Installing the boot loader")
    install_bootloader(eng, plan)

    eng.progress(94, "Preparing the first start")
    eng.run(["update-initramfs", "-u", "-k", "all"], chroot=True)
    eng.run(["update-grub"], chroot=True)
    if not eng.dry:
        os.makedirs(TARGET + "/var/log/installer", exist_ok=True)
        try:
            with open("/var/log/orbit-installer.log") as src, open(TARGET + "/var/log/installer/orbit-installer.log", "w") as dst:
                dst.write(src.read())
        except OSError:
            pass


def install_bootloader(eng, plan):
    grub = [
        'GRUB_DEFAULT=0',
        f'GRUB_TIMEOUT={5 if plan.dual_boot else 0}',
        f'GRUB_TIMEOUT_STYLE={"menu" if plan.dual_boot else "hidden"}',
        'GRUB_DISTRIBUTOR="Orbit OS"',
        'GRUB_CMDLINE_LINUX_DEFAULT="quiet splash"',
        'GRUB_CMDLINE_LINUX=""',
        f'GRUB_DISABLE_OS_PROBER={"false" if plan.dual_boot else "true"}',
    ]
    if os.path.exists(TARGET + "/usr/share/grub/themes/orbit/theme.txt") or eng.dry:
        grub.append('GRUB_THEME="/usr/share/grub/themes/orbit/theme.txt"')
    if plan.encrypted:
        grub.append('GRUB_ENABLE_CRYPTODISK=n')
    if not eng.dry:
        write("/etc/default/grub", "\n".join(grub) + "\n")
    if plan.firmware == "uefi":
        cmd = ["grub-install", "--target=x86_64-efi", "--efi-directory=/boot/efi", "--bootloader-id=orbit", "--recheck"]
        if plan.mode == "erase":
            # also EFI/BOOT/BOOTX64.EFI: firmware that forgets its boot entries (and VirtualBox) still starts Orbit;
            # never on a disk shared with Windows, whose own fallback lives there
            cmd.append("--force-extra-removable")
        eng.run(cmd, chroot=True)
    else:
        debs = sorted(f"{POOL}/{f}" for f in os.listdir(TARGET + POOL) if f.startswith("grub-pc")) if not eng.dry else ["grub-pc.deb"]
        if not debs:
            raise RuntimeError("The BIOS boot loader packages are missing from this image.")
        eng.run(["apt-get", "-y", "-q", "--no-download", "install"] + debs, chroot=True)
        eng.run(["grub-install", "--target=i386-pc", "--recheck", plan.disk], chroot=True)


def set_gdm_autologin(user):
    path = TARGET + "/etc/gdm3/daemon.conf"
    try:
        text = open(path).read()
    except OSError:
        text = "[daemon]\n"
    text = re.sub(r"(?m)^\s*#?\s*AutomaticLogin(Enable)?\s*=.*\n", "", text)
    if "[daemon]" not in text:
        text = "[daemon]\n" + text
    text = text.replace("[daemon]\n", f"[daemon]\nAutomaticLoginEnable=true\nAutomaticLogin={user}\n", 1)
    with open(path, "w") as f:
        f.write(text)


def bind_mounts(eng):
    for src, dst in (("/dev", "dev"), ("/dev/pts", "dev/pts"), ("/proc", "proc"), ("/sys", "sys"), ("/run", "run")):
        os.makedirs(f"{TARGET}/{dst}", exist_ok=True)
        eng.run(["mount", "--bind", src, f"{TARGET}/{dst}"])
    if os.path.isdir("/sys/firmware/efi/efivars"):
        eng.run(["mount", "--bind", "/sys/firmware/efi/efivars", f"{TARGET}/sys/firmware/efi/efivars"], check=False)


def ram_mib():
    try:
        with open("/proc/meminfo") as f:
            for line in f:
                if line.startswith("MemTotal:"):
                    return int(line.split()[1]) // 1024
    except OSError:
        pass
    return 4096
