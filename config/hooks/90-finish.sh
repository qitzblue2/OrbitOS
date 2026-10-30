#!/bin/bash
# Runs inside the new system (chroot) last: point apt at the live Debian archive,
# check the icon mapping, rebuild the boot image, clean up.
set -euo pipefail
say() { echo "[orbit-finish] $*"; }

say "apt: the build used a pinned snapshot; installed systems follow Debian 13 and its security archive"
rm -f /etc/apt/sources.list
install -d /etc/apt/sources.list.d
cat > /etc/apt/sources.list.d/debian.sources <<'EOF'
Types: deb
URIs: https://deb.debian.org/debian
Suites: trixie trixie-updates
Components: main contrib non-free-firmware
Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg

Types: deb
URIs: https://security.debian.org/debian-security
Suites: trixie-security
Components: main contrib non-free-firmware
Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg
EOF

say "verifying icon-name mapping against installed .desktop files"
python3 - <<'PY' | tee /var/log/orbit-icon-map.txt
import configparser, glob, os
names = {}
for f in glob.glob("/usr/share/applications/*.desktop"):
    cp = configparser.RawConfigParser(strict=False)
    try: cp.read(f, encoding="utf-8")
    except Exception: continue
    if cp.has_option("Desktop Entry", "Icon"):
        names[os.path.basename(f)] = cp.get("Desktop Entry", "Icon")
themed = {os.path.basename(p)[:-4] for p in glob.glob("/usr/share/icons/orbit/scalable/apps/*.svg")}
for desk, icon in sorted(names.items()):
    if icon in themed:
        print(f"OK      {desk:55} {icon}")
for want in ["org.gnome.Nautilus", "org.gnome.Terminal", "org.gnome.Settings", "org.gnome.Calculator",
             "org.gnome.TextEditor", "org.gnome.FileRoller", "org.gnome.SystemMonitor",
             "org.keepassxc.KeePassXC", "aphelion", "org.gnome.Software", "orbit-installer"]:
    if want not in names.values():
        print(f"MISSING no installed .desktop uses Icon={want} (symlink or mapping needed)")
PY

say "boot image with the Orbit splash and live-boot"
update-initramfs -u -k all

say "clean up"
apt-get clean
rm -rf /var/lib/apt/lists/* /var/cache/apt/*.bin /var/log/apt/*.log /var/log/*.log.* /tmp/orbit
: > /etc/machine-id
rm -f /var/lib/dbus/machine-id /etc/ssh/ssh_host_* 2>/dev/null || true
say "done"
