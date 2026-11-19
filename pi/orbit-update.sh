#!/bin/sh
# Updates ORBIT OS on this Raspberry Pi to the newest version (keeps your settings, keys and memory).
#   sudo orbit-update
set -e
[ "$(id -u)" = 0 ] || { echo "Run with sudo: sudo orbit-update"; exit 1; }
BRANCH="${ORBIT_BRANCH:-OrbitAI}"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
echo "==> Downloading the newest ORBIT"
curl -fsSL "https://codeload.github.com/qitzblue2/OrbitOS/tar.gz/refs/heads/$BRANCH" | tar -xz -C "$TMP"
SRC=$(find "$TMP" -mindepth 1 -maxdepth 1 -type d | head -1)
echo "==> Installing"
command -v rsync >/dev/null || apt-get install -y -qq rsync
rsync -a --delete --exclude node_modules --exclude models --exclude mobile --exclude release "$SRC/" /opt/orbit/
cp -r "$SRC/pi/files/." /
chmod +x /usr/local/bin/orbit-*
(cd /opt/orbit && npm ci --omit=dev --no-audit --no-fund && node app/models.js)
systemctl daemon-reload
systemctl enable orbit-hotkey >/dev/null 2>&1 || true
systemctl restart orbit orbit-companion orbit-kiosk
systemctl restart orbit-hotkey || true
echo "==> ORBIT updated."
