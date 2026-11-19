#!/usr/bin/env bash
# Runs inside the Raspberry Pi OS image (chroot). Installs Node.js, ORBIT, the speech models,
# and a full-screen kiosk that shows ORBIT on boot.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg git xz-utils bzip2 jq \
  cage seatd rsync fonts-dejavu-core pipewire pipewire-pulse wireplumber alsa-utils >/dev/null
apt-get install -y -qq chromium-browser >/dev/null 2>&1 || apt-get install -y -qq chromium >/dev/null
# Bluetooth speakers and cameras (Pi camera module or USB webcam)
apt-get install -y -qq bluez libspa-0.2-bluetooth fswebcam >/dev/null || true
apt-get install -y -qq rpicam-apps-lite >/dev/null 2>&1 || apt-get install -y -qq libcamera-apps-lite >/dev/null 2>&1 || true

# Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
apt-get install -y -qq nodejs >/dev/null

# ORBIT and its on-device speech engine (wake word, recognition, voice)
cd /opt/orbit
npm ci --omit=dev --no-audit --no-fund
node app/models.js
chown -R root:root /opt/orbit

# "orbitd" runs the ORBIT server; "orbitui" shows it on the screen (no password, no login shell use).
id orbitd >/dev/null 2>&1 || useradd --system --home /var/lib/orbit --shell /usr/sbin/nologin orbitd
mkdir -p /var/lib/orbit && chown orbitd:orbitd /var/lib/orbit && chmod 750 /var/lib/orbit
getent group _seatd >/dev/null && SEAT=,_seatd || SEAT=
id orbitui >/dev/null 2>&1 || useradd -m -s /usr/sbin/nologin -G "video,render,input,audio$SEAT" orbitui
usermod -aG orbitd orbitui   # lets the screen read the dashboard sign-in token
# "orbitagent" is the Pi's own Companion: what ORBIT's AI may do on this Pi (files in its ORBIT Workspace, commands).
id orbitagent >/dev/null 2>&1 || useradd -m -d /var/lib/orbit-companion -s /bin/bash orbitagent
usermod -aG audio orbitagent
usermod -aG bluetooth,video orbitagent 2>/dev/null || true
mkdir -p /var/lib/systemd/linger && touch /var/lib/systemd/linger/orbitui   # sound (PipeWire) for the screen

# First-boot login so Raspberry Pi OS doesn't stop at its setup wizard (which would cover ORBIT):
# user "orbit", password "orbit". Raspberry Pi Imager's settings replace it with your own.
[ -f /boot/firmware/userconf.txt ] || echo "orbit:$(openssl passwd -6 orbit)" > /boot/firmware/userconf.txt

systemctl enable orbit.service orbit-companion.service orbit-kiosk.service seatd.service orbit-hotkey.service
systemctl disable getty@tty1.service || true
# Quiet, fast boot to the dashboard
sed -i 's/$/ quiet loglevel=3 logo.nologo vt.global_cursor_default=0/' /boot/firmware/cmdline.txt
grep -q '^disable_splash' /boot/firmware/config.txt || echo 'disable_splash=1' >> /boot/firmware/config.txt
echo orbit > /etc/hostname
sed -i 's/raspberrypi/orbit/g' /etc/hosts
apt-get clean
