#!/bin/bash
# Boot an Orbit OS ISO in QEMU (UEFI), take screenshots, fail if no desktop appears.
#
#   tests/vm-boot-test.sh out/orbit-os-1.0.0-full-amd64.iso [timeout_s]
#
# Pass criterion: two consecutive screenshots (20 s apart) both look like a
# rendered desktop: not mostly black, many colors, mid-tones from the wallpaper
# (tests/screen_check.py). The live kernel does not log to ttyS0, so the
# serial log is kept as evidence (GRUB output) but is not required.
# Uses KVM when /dev/kvm exists; otherwise TCG (slow: allow 20+ min).
# Never attaches a real disk: the only disk is a throwaway qcow2 in a temp dir.
set -euo pipefail
ISO=${1:?usage: vm-boot-test.sh ISO [timeout_s]}
HERE="$(cd "$(dirname "$0")" && pwd)"
OUTD="$HERE/screenshots/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUTD"
T=$(mktemp -d); trap 'kill $QPID 2>/dev/null || true; rm -rf "$T"' EXIT
OVMF=""
for f in /usr/share/OVMF/OVMF_CODE_4M.fd /usr/share/OVMF/OVMF_CODE.fd /usr/share/qemu/OVMF.fd; do [ -f "$f" ] && OVMF=$f && break; done
accel=tcg; cpu=max; [ -w /dev/kvm ] && accel=kvm && cpu=host
TIMEOUT=${2:-$([ $accel = kvm ] && echo 300 || echo 1800)}
qemu-img create -q -f qcow2 "$T/scratch.qcow2" 30G
# shellcheck disable=SC2054  # commas belong to QEMU option values
args=(-machine "q35,accel=$accel" -cpu "$cpu" -smp 4 -m 6144 -vga virtio -display none
      -cdrom "$ISO" -drive file="$T/scratch.qcow2",if=virtio,format=qcow2
      -boot d -serial file:"$OUTD/serial.log" -monitor unix:"$T/mon",server,nowait
      -netdev user,id=n0 -device virtio-net-pci,netdev=n0 -device virtio-tablet-pci)
# shellcheck disable=SC2054
[ -n "$OVMF" ] && args+=(-drive if=pflash,format=raw,readonly=on,file="$OVMF")
echo "[vm-test] accel=$accel timeout=${TIMEOUT}s firmware=${OVMF:-BIOS}"
qemu-system-x86_64 "${args[@]}" &
QPID=$!
shot() { echo "screendump $1" | socat - UNIX-CONNECT:"$T/mon" >/dev/null 2>&1 || true; }
# GRUB: the default entry boots after its timeout; nothing to type.
start=$(date +%s); i=0; graphical=0; streak=0
while :; do
  sleep 20; i=$((i+1))
  shot "$T/s.ppm"
  [ -s "$T/s.ppm" ] && python3 -c "from PIL import Image;import sys;Image.open(sys.argv[1]).save(sys.argv[2])" "$T/s.ppm" "$OUTD/shot-$(printf %03d $i).png"
  grep -q "graphical.target" "$OUTD/serial.log" 2>/dev/null && graphical=1
  if [ -f "$OUTD/shot-$(printf %03d $i).png" ] && python3 "$HERE/screen_check.py" "$OUTD/shot-$(printf %03d $i).png"; then
    streak=$((streak+1))
  else
    streak=0
  fi
  if [ $streak -ge 2 ]; then
    echo "[vm-test] PASS: desktop after $(( $(date +%s) - start ))s — screenshots in $OUTD"; exit 0
  fi
  if [ $(( $(date +%s) - start )) -gt "$TIMEOUT" ]; then
    echo "[vm-test] FAIL: no desktop within ${TIMEOUT}s (graphical.target seen: $graphical). See $OUTD"; exit 1
  fi
  kill -0 $QPID 2>/dev/null || { echo "[vm-test] FAIL: QEMU exited"; exit 1; }
done
