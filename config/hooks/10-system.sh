#!/bin/bash
# Runs inside the new Orbit OS system (chroot) right after Debian is bootstrapped.
# Everything here ends up both in the live USB and on installed computers.
set -euo pipefail
C=/tmp/orbit/config
say() { echo "[orbit-system] $*"; }

say "identity: Orbit OS ${ORBIT_VERSION} (Debian 13 base)"
echo orbit > /etc/hostname
printf '127.0.0.1\tlocalhost\n127.0.1.1\torbit\n::1\tlocalhost ip6-localhost ip6-loopback\n' > /etc/hosts

say "language: en_US.UTF-8 (the installer adds the one you pick)"
sed -i 's/^# *en_US.UTF-8 UTF-8/en_US.UTF-8 UTF-8/' /etc/locale.gen
locale-gen >/dev/null
echo 'LANG=en_US.UTF-8' > /etc/default/locale

say "Orbit packages, the installer and Aphelion"
apt-get install -y -q /tmp/orbit/debs/*.deb

say "Aphelion is the default browser"
for alt in x-www-browser gnome-www-browser; do
  update-alternatives --install "/usr/bin/$alt" "$alt" /opt/Aphelion/aphelion 210
  update-alternatives --set "$alt" /opt/Aphelion/aphelion
done
# web links open in Aphelion: packages/orbit-apps/files/etc/xdg/mimeapps.list

say "boot: Orbit name and theme in GRUB, Orbit splash"
cat > /etc/default/grub <<'EOF'
GRUB_DEFAULT=0
GRUB_TIMEOUT=0
GRUB_TIMEOUT_STYLE=hidden
GRUB_DISTRIBUTOR="Orbit OS"
GRUB_CMDLINE_LINUX_DEFAULT="quiet splash"
GRUB_CMDLINE_LINUX=""
GRUB_THEME="/usr/share/grub/themes/orbit/theme.txt"
EOF

say "memory: compressed RAM swap (zram) besides the swap file the installer makes"
cat > /etc/systemd/zram-generator.conf <<'EOF'
[zram0]
zram-size = min(ram / 2, 8192)
compression-algorithm = zstd
EOF

say "firewall on: incoming blocked, outgoing allowed (written directly; iptables cannot run in a chroot)"
sed -i 's/^ENABLED=.*/ENABLED=yes/' /etc/ufw/ufw.conf
sed -i 's/^DEFAULT_INPUT_POLICY=.*/DEFAULT_INPUT_POLICY="DROP"/; s/^DEFAULT_OUTPUT_POLICY=.*/DEFAULT_OUTPUT_POLICY="ACCEPT"/' /etc/default/ufw
systemctl enable ufw.service

say "no hidden network calls, no remote login, root locked"
install -d /etc/NetworkManager/conf.d
printf '[connectivity]\nenabled=false\n' > /etc/NetworkManager/conf.d/90-orbit-no-connectivity-check.conf
systemctl disable fwupd-refresh.timer 2>/dev/null || true
passwd -l root >/dev/null
dpkg -s openssh-server >/dev/null 2>&1 && { say "removing openssh-server"; apt-get purge -y -q openssh-server; }

if [ "$ORBIT_VARIANT" = full ]; then
  say "Flathub for Orbit Store and GNOME Software"
  flatpak remote-add --system --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo
fi

say "BIOS boot loader packages for the installer (the image itself boots GRUB for UEFI)"
install -d /usr/share/orbit-installer/pool
(cd /usr/share/orbit-installer/pool && apt-get download -q grub-pc grub-pc-bin)

say "GDM: Orbit colours and icons on the login screen"
bash "$C/hooks/gdm-theme.sh"

say "TLP profile shipped but not active (power-profiles-daemon is the default, see DECISIONS.md D-15)"
install -D -m 644 "$C/tlp/orbit.conf" /usr/share/orbit-os/tlp/orbit.conf

say "done"
