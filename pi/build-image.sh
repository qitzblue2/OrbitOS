#!/usr/bin/env bash
# Builds ORBIT OS for Raspberry Pi 4: Raspberry Pi OS Lite (64-bit) with ORBIT installed,
# booting straight into the ORBIT dashboard. Run on an x86-64 Linux machine with sudo
# (GitHub's ubuntu runners work). Output: orbit-os-pi4.img.xz
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
WORK="${WORK:-$REPO/pi/work}"
BASE_URL="${BASE_URL:-https://downloads.raspberrypi.com/raspios_lite_arm64_latest}"
EXTRA_MB="${EXTRA_MB:-3500}"
OUT="${OUT:-$REPO/pi/orbit-os-pi4.img}"

[ "$(id -u)" = 0 ] || { echo "Run with sudo"; exit 1; }
apt-get install -y -qq qemu-user-static binfmt-support parted e2fsprogs xz-utils curl rsync >/dev/null
mkdir -p "$WORK"

echo "==> Downloading Raspberry Pi OS Lite (64-bit)"
[ -f "$WORK/base.img.xz" ] || curl -fsSL "$BASE_URL" -o "$WORK/base.img.xz"
xz -dc "$WORK/base.img.xz" > "$OUT"

echo "==> Making room for ORBIT (+${EXTRA_MB} MB)"
truncate -s +"${EXTRA_MB}M" "$OUT"
parted -s "$OUT" resizepart 2 100%
LOOP=$(losetup -fP --show "$OUT")
cleanup() { set +e; umount -R "$WORK/root" 2>/dev/null; losetup -d "$LOOP" 2>/dev/null; }
trap cleanup EXIT
e2fsck -fy "${LOOP}p2" >/dev/null || true
resize2fs "${LOOP}p2" >/dev/null

echo "==> Mounting"
ROOT="$WORK/root"; mkdir -p "$ROOT"
mount "${LOOP}p2" "$ROOT"
mkdir -p "$ROOT/boot/firmware" && mount "${LOOP}p1" "$ROOT/boot/firmware"
for d in proc sys dev dev/pts; do mount --bind "/$d" "$ROOT/$d"; done
cp /usr/bin/qemu-aarch64-static "$ROOT/usr/bin/"
cp /etc/resolv.conf "$ROOT/etc/resolv.conf"

echo "==> Copying ORBIT"
mkdir -p "$ROOT/opt/orbit"
rsync -a --delete --exclude node_modules --exclude models --exclude release --exclude 'pi/work' --exclude 'pi/*.img*' --exclude mobile --exclude .git "$REPO/" "$ROOT/opt/orbit/"
cp -r "$HERE/files/." "$ROOT/"

echo "==> Installing inside the image (this takes a while under emulation)"
chroot "$ROOT" /bin/bash /opt/orbit/pi/setup-in-image.sh

echo "==> Smoke test: ORBIT starts inside the image"
chroot "$ROOT" /bin/bash -c 'cd /opt/orbit && ORBIT_DATA_DIR=/tmp/orbit-smoke ORBIT_PORT=7799 timeout 60 node server/index.js >/tmp/smoke.log 2>&1 & for i in $(seq 1 50); do curl -fs http://127.0.0.1:7799/api/health && exit 0; sleep 1; done; cat /tmp/smoke.log; exit 1'
rm -rf "$ROOT/tmp/orbit-smoke" "$ROOT/tmp/smoke.log"

rm -f "$ROOT/usr/bin/qemu-aarch64-static"
ln -sf /run/systemd/resolve/stub-resolv.conf "$ROOT/etc/resolv.conf" 2>/dev/null || : > "$ROOT/etc/resolv.conf"
cleanup; trap - EXIT

echo "==> Compressing"
rm -f "$OUT.xz"; xz -T0 -6 "$OUT"
ls -lh "$OUT.xz"
echo "Done: $OUT.xz"
