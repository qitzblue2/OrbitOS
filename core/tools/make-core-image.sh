#!/bin/bash
# Turn the Orbit Core tree (work/orbit) into a bootable UEFI disk image.
#
#   sudo core/tools/make-core-image.sh [OUT.img] [SIZE]      default: work/orbit-core.img, 8G
#
# The image is GPT: a 256 MiB EFI system partition with Orbit's own GRUB (made by the
# grub-mkimage that forge built inside Orbit) and an ext4 root with the whole system.
# The host only lays out the disk (sfdisk, mkfs, mtools, dd), like packing files into a tar;
# everything that boots and runs was built from source by forge.
# Write it to a USB stick or disk (dd, Etcher) or boot it in QEMU with UEFI firmware (OVMF).
set -euo pipefail

HERE=$(cd "$(dirname "$0")/../.." && pwd)
ORBIT="$HERE/work/orbit"
OUT="${1:-$HERE/work/orbit-core.img}"
SIZE="${2:-8G}"
ESP_MIB=256
ROOT_PARTUUID=0b1700c0-0000-4000-8000-000000000002   # fixed, so grub.cfg can name it
die() { echo "make-core-image: $*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "run as root (it chroots into the Orbit tree)"
KVER=$(cd "$ORBIT/boot" && ls vmlinuz-* | head -1 | sed 's/^vmlinuz-//')
[ -n "$KVER" ] || die "no kernel in $ORBIT/boot: run forge stage boot first"
[ -x "$ORBIT/usr/bin/grub-mkimage" ] || die "Orbit's GRUB is not built: forge build grub"

TMP=$(mktemp -d)
PARKED="$HERE/work/tools.parked"
cleanup() {
  # put the cross toolchain back if it was moved aside for the image
  if [ -d "$PARKED" ] && [ ! -e "$ORBIT/tools" ]; then mv "$PARKED" "$ORBIT/tools"; fi
  rm -f "$TMP"/*; rmdir "$TMP"
}
trap cleanup EXIT

# 1. Orbit's GRUB as a removable-media UEFI program (EFI/BOOT/BOOTX64.EFI)
chroot "$ORBIT" /usr/bin/env -i PATH=/usr/bin:/usr/sbin grub-mkimage -O x86_64-efi -p /EFI/BOOT \
  -o /var/tmp/BOOTX64.EFI part_gpt fat ext2 normal linux search search_fs_uuid search_label \
  echo all_video gfxterm configfile gzio test
mv "$ORBIT/var/tmp/BOOTX64.EFI" "$TMP/BOOTX64.EFI"
cat > "$TMP/grub.cfg" <<EOF
set timeout=3
set default=0
insmod all_video
menuentry "Orbit OS Core" {
  search --no-floppy --label OrbitCore --set=root
  linux /boot/vmlinuz-$KVER root=PARTUUID=$ROOT_PARTUUID rw quiet console=tty0 console=ttyS0
}
menuentry "Orbit OS Core (all messages)" {
  search --no-floppy --label OrbitCore --set=root
  linux /boot/vmlinuz-$KVER root=PARTUUID=$ROOT_PARTUUID rw console=tty0 console=ttyS0
}
EOF

# 2. the EFI system partition, as its own image
truncate -s "${ESP_MIB}M" "$TMP/esp.img"
mkfs.vfat -F 32 -n ORBIT-EFI "$TMP/esp.img" >/dev/null
mmd -i "$TMP/esp.img" ::/EFI ::/EFI/BOOT
mcopy -i "$TMP/esp.img" "$TMP/BOOTX64.EFI" "$TMP/grub.cfg" ::/EFI/BOOT/

# 3. the disk: GPT with the ESP and the root partition
rm -f "$OUT"
truncate -s "$SIZE" "$OUT"
sfdisk -q "$OUT" <<EOF
label: gpt
start=2048, size=$((ESP_MIB * 2048)), type=U, name="EFI"
start=$((2048 + ESP_MIB * 2048)), type=L, uuid=$ROOT_PARTUUID, name="OrbitCore"
EOF
dd if="$TMP/esp.img" of="$OUT" bs=1M seek=1 conv=notrunc status=none

# 4. the root file system, straight from the tree (without the cross toolchain in /tools)
ROOT_START=$((2048 + ESP_MIB * 2048))
ROOT_SECTORS=$(sfdisk -l -o Start,Sectors "$OUT" | awk -v s="$ROOT_START" '$1 == s {print $2}')
truncate -s $((ROOT_SECTORS * 512)) "$TMP/root.img"
[ -d "$ORBIT/tools" ] && mv "$ORBIT/tools" "$PARKED"     # 1.8 GB the running system never uses
mkfs.ext4 -q -F -L OrbitCore -E root_owner=0:0 -d "$ORBIT" "$TMP/root.img"
[ -d "$PARKED" ] && mv "$PARKED" "$ORBIT/tools"
dd if="$TMP/root.img" of="$OUT" bs=1M seek=$((ROOT_START / 2048)) conv=notrunc,sparse status=none
echo "Orbit Core image: $OUT ($SIZE, kernel $KVER)"
