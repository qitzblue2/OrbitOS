#!/bin/bash
# Orbit OS: turn a prepared live tree into a bootable hybrid ISO.
#
#   tools/make-iso.sh ROOTFS ISODIR OUT.iso VOLUME_ID
#
# ROOTFS   the built system (boot files are taken from it: Debian's signed shim + GRUB,
#          the Orbit GRUB theme, so they always match the system's versions)
# ISODIR   the medium tree: live/vmlinuz, live/initrd.img, live/filesystem.squashfs, .disk/info
# Boots in BIOS (GRUB El Torito, hybrid MBR) and UEFI (shim -> signed GRUB, so Secure Boot
# works), from DVD and from a USB stick written byte for byte.
set -euo pipefail
ROOT="$1" X="$2" OUTISO="$3" VOLID="${4:-ORBIT_OS}"
GRUB_PC="${GRUB_PC_DIR:-/usr/lib/grub/i386-pc}"   # BIOS GRUB modules (package grub-pc-bin)
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
log() { printf '\033[1m[orbit-iso] %s\033[0m\n' "$*"; }
die() { printf '\033[31m[orbit-iso] ERROR: %s\033[0m\n' "$*" >&2; exit 1; }
[ -f "$X/.disk/info" ] || die "$X/.disk/info missing (the boot loaders find the medium by it)"
[ -f "$X/live/vmlinuz" ] && [ -f "$X/live/initrd.img" ] || die "$X/live/vmlinuz or initrd.img missing"
mkdir -p "$X/EFI/boot"

log "boot menu"
mkdir -p "$X/boot/grub/fonts" "$X/boot/grub/themes"
cp -a "$ROOT/usr/share/grub/themes/orbit" "$X/boot/grub/themes/"
cp "$ROOT/usr/share/grub/unicode.pf2" "$X/boot/grub/fonts/" 2>/dev/null || cp /usr/share/grub/unicode.pf2 "$X/boot/grub/fonts/"
LIVE="boot=live components username=orbit hostname=orbit"
cat > "$X/boot/grub/grub.cfg" <<EOF
# Orbit OS live USB / DVD
search --no-floppy --set=root --file /.disk/info
set prefix=(\$root)/boot/grub
insmod all_video
insmod gfxterm
insmod png
if loadfont \$prefix/fonts/unicode.pf2; then
  set gfxmode=auto
  terminal_output gfxterm
  set theme=\$prefix/themes/orbit/theme.txt
fi
set timeout=8
set default=0

menuentry "Try or Install Orbit OS" {
  linux /live/vmlinuz $LIVE quiet splash ---
  initrd /live/initrd.img
}
menuentry "Orbit OS (safe graphics)" {
  linux /live/vmlinuz $LIVE nomodeset quiet splash ---
  initrd /live/initrd.img
}
menuentry "Orbit OS (verbose, safe graphics)" {
  linux /live/vmlinuz $LIVE nomodeset systemd.show_status=1 plymouth.enable=0 ---
  initrd /live/initrd.img
}
menuentry "Orbit OS (run from memory)" {
  linux /live/vmlinuz $LIVE toram quiet splash ---
  initrd /live/initrd.img
}
if [ "\$grub_platform" = "efi" ]; then
  menuentry "UEFI firmware settings" { fwsetup }
fi
EOF

log "BIOS: GRUB El Torito image"
mkdir -p "$X/boot/grub/i386-pc"
cp "$GRUB_PC"/*.mod "$GRUB_PC"/*.lst "$X/boot/grub/i386-pc/"
"${GRUB_MKIMAGE:-grub-mkimage}" -O i386-pc-eltorito -d "$GRUB_PC" -p /boot/grub -o "$X/boot/grub/i386-pc/eltorito.img" \
  biosdisk iso9660 part_msdos part_gpt fat ext2 search search_fs_file configfile normal linux echo test all_video gfxterm png

log "UEFI: Debian's signed shim + GRUB (Secure Boot), fallback path EFI/BOOT/BOOTX64.EFI"
SHIM="$ROOT/usr/lib/shim/shimx64.efi.signed"
MOK="$ROOT/usr/lib/shim/mmx64.efi.signed"
GRUBEFI="$ROOT/usr/lib/grub/x86_64-efi-signed/gcdx64.efi.signed"
for f in "$SHIM" "$MOK" "$GRUBEFI"; do [ -f "$f" ] || die "missing $f (shim-signed / grub-efi-amd64-signed in the system)"; done
# the signed GRUB finds the medium by /.disk/info and reads /boot/grub/grub.cfg (see grub2 build-efi-images)
cp "$SHIM" "$X/EFI/boot/bootx64.efi"; cp "$MOK" "$X/EFI/boot/mmx64.efi"; cp "$GRUBEFI" "$X/EFI/boot/grubx64.efi"
EFIIMG="$WORK/efi.img"
rm -f "$EFIIMG"
mkfs.vfat -C -n ORBIT_EFI "$EFIIMG" 8192 >/dev/null
mmd -i "$EFIIMG" ::/EFI ::/EFI/boot ::/EFI/debian
mcopy -i "$EFIIMG" "$SHIM" ::/EFI/boot/bootx64.efi
mcopy -i "$EFIIMG" "$MOK" ::/EFI/boot/mmx64.efi
mcopy -i "$EFIIMG" "$GRUBEFI" ::/EFI/boot/grubx64.efi
printf 'search --no-floppy --set=root --file /.disk/info\nset prefix=($root)/boot/grub\nconfigfile $prefix/grub.cfg\n' > "$WORK/efi-grub.cfg"
mcopy -i "$EFIIMG" "$WORK/efi-grub.cfg" ::/EFI/boot/grub.cfg
mcopy -i "$EFIIMG" "$WORK/efi-grub.cfg" ::/EFI/debian/grub.cfg
cp "$EFIIMG" "$X/boot/grub/efi.img"

(cd "$X" && find . -type f ! -name md5sum.txt ! -path './boot/grub/*' ! -path './EFI/*' -print0 | xargs -0 md5sum > md5sum.txt)

log "writing $OUTISO (BIOS + UEFI, DVD + USB hybrid)"
xorriso -as mkisofs -r -J -joliet-long -l -iso-level 3 \
  -V "$VOLID" -o "$OUTISO" \
  --grub2-mbr "$GRUB_PC/boot_hybrid.img" \
  -partition_offset 16 --mbr-force-bootable \
  -append_partition 2 0xef "$EFIIMG" -appended_part_as_gpt \
  -c boot/boot.cat \
  -b boot/grub/i386-pc/eltorito.img -no-emul-boot -boot-load-size 4 -boot-info-table --grub2-boot-info \
  -eltorito-alt-boot -e '--interval:appended_partition_2:all::' -no-emul-boot \
  "$X" 2>&1 | tail -n 3
