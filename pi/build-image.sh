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
apt-get update -qq
apt-get install -y -qq parted e2fsprogs xz-utils curl rsync file >/dev/null
# The arm64 emulator: called qemu-user-static on older Ubuntu, merged into qemu-user (+ qemu-user-binfmt) on newer.
apt-get install -y -qq qemu-user-static >/dev/null 2>&1 || apt-get install -y -qq qemu-user qemu-user-binfmt >/dev/null
QEMU=$(command -v qemu-aarch64-static || command -v qemu-aarch64)
[ -n "$QEMU" ] || { echo "No arm64 emulator found"; exit 1; }
# Make sure the kernel runs arm64 programs through it (systemd-binfmt or binfmt-support, whichever exists).
systemctl restart systemd-binfmt 2>/dev/null || update-binfmts --enable qemu-aarch64 2>/dev/null || true
ls /proc/sys/fs/binfmt_misc/ | grep -q aarch64 || { echo "arm64 emulation isn't registered"; exit 1; }
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
cp "$QEMU" "$ROOT/usr/bin/qemu-aarch64-static"; [ "$(basename "$QEMU")" = qemu-aarch64 ] && cp "$QEMU" "$ROOT/usr/bin/qemu-aarch64" || true
cp -P "$ROOT/etc/resolv.conf" "$WORK/resolv.conf.orig" 2>/dev/null || true
rm -f "$ROOT/etc/resolv.conf"; cp /etc/resolv.conf "$ROOT/etc/resolv.conf"

echo "==> Copying ORBIT"
mkdir -p "$ROOT/opt/orbit"
rsync -a --delete --exclude node_modules --exclude models --exclude release --exclude 'pi/work' --exclude 'pi/*.img*' --exclude mobile --exclude .git "$REPO/" "$ROOT/opt/orbit/"
cp -r "$HERE/files/." "$ROOT/"

echo "==> Installing inside the image (this takes a while under emulation)"
chroot "$ROOT" /bin/bash /opt/orbit/pi/setup-in-image.sh

echo "==> Smoke test: ORBIT starts inside the image"
chroot "$ROOT" /bin/bash -c 'cd /opt/orbit && ORBIT_DATA_DIR=/tmp/orbit-smoke ORBIT_PORT=7799 timeout 60 node server/index.js >/tmp/smoke.log 2>&1 & for i in $(seq 1 50); do curl -fs http://127.0.0.1:7799/api/health && exit 0; sleep 1; done; cat /tmp/smoke.log; exit 1'
rm -rf "$ROOT/tmp/orbit-smoke" "$ROOT/tmp/smoke.log"

rm -f "$ROOT/usr/bin/qemu-aarch64-static" "$ROOT/usr/bin/qemu-aarch64"
# Give the Pi back its own resolv.conf (NetworkManager manages it); a dangling symlink here broke DNS.
rm -f "$ROOT/etc/resolv.conf"
if [ -e "$WORK/resolv.conf.orig" ] || [ -L "$WORK/resolv.conf.orig" ]; then cp -P "$WORK/resolv.conf.orig" "$ROOT/etc/resolv.conf"; else : > "$ROOT/etc/resolv.conf"; fi
cleanup; trap - EXIT

echo "==> Compressing"
rm -f "$OUT.xz"; xz -T0 -6 "$OUT"
ls -lh "$OUT.xz"
echo "Done: $OUT.xz"
