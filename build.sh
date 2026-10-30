#!/bin/bash
# Orbit OS — build the live/install ISO from Debian 13, from scratch.
#
#   ./build.sh                 # full image, inside a privileged debian:trixie container
#   ORBIT_VARIANT=lite ./build.sh
#   sudo ./build.sh --host     # directly on a Debian 13 / Ubuntu 24.04 machine or VM
#   ./build.sh --debs-only     # only the Orbit .deb packages (no root needed)
#
# Stages
#   A  theme + icons from branding/tokens.json
#   B  Orbit .debs (branding, desktop, apps, shell extensions, launcher, installer) + Aphelion
#   C  the system: mmdebstrap bootstraps Debian 13 from a pinned archive snapshot with
#      every package in config/packages/, then config/hooks/*.sh run inside it
#   D  live medium: kernel, initrd (live-boot), compressed system image
#   E  ISO: GRUB for BIOS and UEFI (Debian's Microsoft-signed shim, so Secure Boot
#      works), hybrid so the same file boots from DVD and USB stick
# Never writes to a block device. Output: out/orbit-os-<version>-<variant>-amd64.iso
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/config/build.conf"
VARIANT="${ORBIT_VARIANT:-full}"
WORK="${ORBIT_WORK:-$HERE/work}"
OUT="$HERE/out"
log() { printf '\033[1m[orbit] %s\033[0m\n' "$*"; }
die() { printf '\033[31m[orbit] ERROR: %s\033[0m\n' "$*" >&2; exit 1; }

case "$VARIANT" in full|lite) ;; *) die "ORBIT_VARIANT must be full or lite" ;; esac

# ---------- container re-exec ----------
if [ "${1:-}" != "--host" ] && [ "${1:-}" != "--debs-only" ] && [ -z "${ORBIT_IN_CONTAINER:-}" ]; then
  command -v docker >/dev/null || command -v podman >/dev/null || \
    die "need docker or podman (or run: sudo ./build.sh --host on a Debian 13 / Ubuntu 24.04 VM)"
  engine=$(command -v docker || command -v podman)
  log "running the build in a clean $BUILD_CONTAINER container ($engine)"
  exec "$engine" run --rm --privileged -e ORBIT_IN_CONTAINER=1 -e ORBIT_VARIANT="$VARIANT" \
    -e ORBIT_APHELION_DEB="${ORBIT_APHELION_DEB:-}" -v "$HERE:/src" -w /src "$BUILD_CONTAINER" bash -c \
    "apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq $HOST_DEPS >/dev/null && ./build.sh --host"
fi
[ "${1:-}" = "--host" ] && shift

# ---------- stage A: generated assets ----------
build_assets() {
  log "generating theme files from branding/tokens.json"
  python3 "$HERE/branding/generate.py" --out "$WORK/branding"
  log "generating icon themes"
  python3 "$HERE/icons/generate_icons.py" --out "$WORK/icons"
  python3 "$HERE/icons/check_and_raster.py" --themes "$WORK/icons" --sheet "$HERE/tests/icon-contact-sheet.png"
}

# ---------- stage B: Orbit packages ----------
pack() {  # pack <name> <staging dir with files/ and DEBIAN/>
  local s="$1" root name
  name=$(basename "$1")
  root="$WORK/debs/$name.root"
  rm -rf "$root"; mkdir -p "$root"
  cp -a "$s/files/." "$root/"; cp -a "$s/DEBIAN" "$root/"
  sed -i "s/@VERSION@/$ORBIT_VERSION/g; s/@RECOMMENDS@/$REC/" "$root/DEBIAN/control"
  dpkg-deb --root-owner-group -Zxz --build "$root" "$OUT/${name}_${ORBIT_VERSION}_all.deb" >/dev/null
  cp "$OUT/${name}_${ORBIT_VERSION}_all.deb" "$PKGS/"
  log "built $OUT/${name}_${ORBIT_VERSION}_all.deb"
}

build_debs() {
  local stage="$WORK/debs"
  PKGS="$WORK/packages"   # exactly the .debs that go into the system
  rm -rf "$stage" "$PKGS"; mkdir -p "$stage" "$PKGS" "$OUT"
  rm -f "$OUT"/orbit-*_all.deb
  REC="keepassxc, gnome-calendar, loupe, evince"
  [ "$VARIANT" = full ] && REC="$REC, flatpak, libreoffice-writer"
  # orbit-os-branding
  local b="$stage/orbit-os-branding"
  cp -a "$HERE/packages/orbit-os-branding" "$b"
  mkdir -p "$b/files/usr/share/"{themes,icons,backgrounds/orbit,plymouth/themes,grub/themes,gnome-background-properties,orbit-os}
  cp -a "$WORK/branding/themes/"* "$b/files/usr/share/themes/"
  cp -a "$WORK/icons/"orbit* "$b/files/usr/share/icons/"
  cp -a "$WORK/branding/wallpapers/"*.png "$b/files/usr/share/backgrounds/orbit/"
  cp -a "$WORK/branding/plymouth/orbit" "$b/files/usr/share/plymouth/themes/"
  cp -a "$WORK/branding/grub/orbit" "$b/files/usr/share/grub/themes/"
  cp "$HERE/branding/tokens.json" "$b/files/usr/share/orbit-os/tokens.json"
  # Boot logo: your own branding/boot-logo/logo.png|svg wins; else the launcher glyph.
  local logo_out="$b/files/usr/share/plymouth/themes/orbit/logo.png" logo_src
  if [ -f "$HERE/branding/boot-logo/logo.png" ]; then
    cp "$HERE/branding/boot-logo/logo.png" "$logo_out"; log "boot logo: branding/boot-logo/logo.png"
  else
    logo_src="$HERE/branding/boot-logo/logo.svg"
    [ -f "$logo_src" ] || logo_src="$WORK/icons/orbit/scalable/apps/orbit-launcher.svg"
    rsvg-convert -w 192 -h 192 "$logo_src" -o "$logo_out"; log "boot logo: $logo_src"
  fi
  python3 - "$b/files/usr/share/gnome-background-properties/orbit.xml" <<'PY'
import sys
names = ["glass", "lagoon", "graphite", "light"]
items = "".join(f"""  <wallpaper deleted="false"><name>Orbit {n.title()}</name>
    <filename>/usr/share/backgrounds/orbit/orbit-{n}.png</filename><options>zoom</options></wallpaper>\n""" for n in names)
open(sys.argv[1], "w").write(f'<?xml version="1.0"?>\n<!DOCTYPE wallpapers SYSTEM "gnome-wp-list.dtd">\n<wallpapers>\n{items}</wallpapers>\n')
PY
  # orbit-launcher
  local l="$stage/orbit-launcher"
  mkdir -p "$l/files/usr/share/gnome-shell/extensions"
  cp -a "$HERE/packages/orbit-launcher/DEBIAN" "$l/"
  cp -a "$HERE/packages/orbit-launcher/orbit-launcher@orbit-os" "$l/files/usr/share/gnome-shell/extensions/"
  glib-compile-schemas "$l/files/usr/share/gnome-shell/extensions/orbit-launcher@orbit-os/schemas" 2>/dev/null || true
  # orbit-apps (Python/GTK apps)
  local oa="$stage/orbit-apps"
  cp -a "$HERE/packages/orbit-apps" "$oa"
  mkdir -p "$oa/files/usr/lib/orbit-os/python" "$oa/files/usr/share/orbit-os"
  cp -a "$HERE/packages/orbit-apps/src/orbit" "$oa/files/usr/lib/orbit-os/python/"
  cp "$HERE/packages/orbit-apps/data/store-catalog.json" "$oa/files/usr/share/orbit-os/"
  # orbit-shell-extensions
  local se="$stage/orbit-shell-extensions"
  mkdir -p "$se/files/usr/share/gnome-shell/extensions"
  cp -a "$HERE/packages/orbit-shell-extensions/DEBIAN" "$se/"
  for ext in "$HERE"/packages/orbit-shell-extensions/*@orbit-os; do
    cp -a "$ext" "$se/files/usr/share/gnome-shell/extensions/"
    [ -d "$ext/schemas" ] && glib-compile-schemas "$se/files/usr/share/gnome-shell/extensions/$(basename "$ext")/schemas"
  done
  # orbit-os-desktop (+ the ~/Home layout for new accounts, desktop defaults)
  local d="$stage/orbit-os-desktop"
  cp -a "$HERE/packages/orbit-os-desktop" "$d"
  mkdir -p "$d/files/etc/skel"
  cp -a "$HERE/skel/." "$d/files/etc/skel/"
  install -D -m 755 "$HERE/tools/hardware-check.sh" "$d/files/usr/bin/orbit-hardware-check"
  install -D -m 644 "$HERE/config/dconf/db/local.d/00-orbit" "$d/files/etc/dconf/db/local.d/00-orbit"
  install -D -m 644 "$HERE/config/dconf/profile/user" "$d/files/etc/dconf/profile/user"
  # orbit-installer (live session only; removes itself from installed systems)
  local oi="$stage/orbit-installer"
  cp -a "$HERE/packages/orbit-installer" "$oi"
  mkdir -p "$oi/files/usr/lib/orbit-installer/python"
  cp -a "$HERE/packages/orbit-installer/src/orbit_installer" "$oi/files/usr/lib/orbit-installer/python/"
  find "$stage" -name __pycache__ -prune -exec rm -rf {} +
  for p in orbit-os-branding orbit-launcher orbit-apps orbit-shell-extensions orbit-os-desktop orbit-installer; do
    pack "$stage/$p"
  done
}

# Aphelion: a given .deb, one already in out/, or built from the Orbit-Apps branch.
get_aphelion() {
  local deb="${ORBIT_APHELION_DEB:-}"
  [ -n "$deb" ] || deb=$(ls -t "$OUT"/aphelion_*_amd64.deb 2>/dev/null | head -1 || true)
  if [ -z "$deb" ]; then
    log "building Aphelion from the $APHELION_BRANCH branch"
    command -v npm >/dev/null || die "Aphelion needs Node.js + npm to build (or set ORBIT_APHELION_DEB=/path/to/aphelion_*.deb)"
    local src="$WORK/aphelion-src"
    rm -rf "$src"
    git -C "$HERE" fetch -q origin "$APHELION_BRANCH"
    git -C "$HERE" archive "origin/$APHELION_BRANCH" Orbit-Web | tar -x -C "$WORK" && mv "$WORK/Orbit-Web" "$src"
    (cd "$src" && npm ci --no-audit --no-fund && npm run lists && npm run bundle && npx electron-builder --linux deb --x64)
    deb=$(ls -t "$src"/dist/aphelion_*_amd64.deb | head -1)
    cp "$deb" "$OUT/"
  fi
  [ -f "$deb" ] || die "Aphelion package not found: $deb"
  log "Aphelion: $deb"
  cp "$deb" "$PKGS/"
}

if [ "${1:-}" = "--debs-only" ]; then
  build_assets; build_debs; exit 0
fi

[ "$(id -u)" = 0 ] || die "building the system needs root (run inside the container or a throwaway VM)"
for t in mmdebstrap mksquashfs xorriso grub-mkimage mkfs.vfat mcopy lsinitramfs python3 dpkg-deb; do
  command -v "$t" >/dev/null || die "missing tool: $t (apt install $HOST_DEPS)"
done
[ -f /usr/share/keyrings/debian-archive-keyring.gpg ] || die "missing debian-archive-keyring (apt install debian-archive-keyring)"
[ -d /usr/lib/grub/i386-pc ] || die "missing grub-pc-bin (BIOS boot files for the ISO)"

build_assets
build_debs
get_aphelion

# ---------- stage C: the system ----------
ROOT="$WORK/rootfs"
log "bootstrapping Debian $DEBIAN_SUITE (snapshot $ORBIT_SNAPSHOT) with the Orbit package set ($VARIANT)"
if mountpoint -q "$ROOT/proc" 2>/dev/null; then die "$ROOT is still in use by an earlier build; reboot or unmount it"; fi
rm -rf "$ROOT"
lists=(system desktop live)
[ "$VARIANT" = full ] && lists+=(full)
INCLUDE=$(for l in "${lists[@]}"; do grep -vE '^\s*(#|$)' "$HERE/config/packages/$l.list"; done | sort -u | paste -sd, -)
HOOKENV="ORBIT_VARIANT=$VARIANT ORBIT_VERSION=$ORBIT_VERSION DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8"
mmdebstrap --mode=root --variant=apt --architectures=amd64 \
  --components="$DEBIAN_COMPONENTS" \
  --keyring=/usr/share/keyrings/debian-archive-keyring.gpg \
  --aptopt='Acquire::Check-Valid-Until "false"' \
  --aptopt='APT::Install-Recommends "true"' \
  --aptopt='Acquire::Retries "5"' \
  --include="$INCLUDE" \
  --customize-hook='mkdir -p "$1/tmp/orbit/debs"' \
  --customize-hook="copy-in $HERE/config /tmp/orbit" \
  --customize-hook="sync-in $PKGS /tmp/orbit/debs" \
  --customize-hook="chroot \"\$1\" env $HOOKENV bash /tmp/orbit/config/hooks/10-system.sh" \
  --customize-hook="chroot \"\$1\" env $HOOKENV bash /tmp/orbit/config/hooks/30-live.sh" \
  --customize-hook="chroot \"\$1\" env $HOOKENV bash /tmp/orbit/config/hooks/90-finish.sh" \
  --customize-hook='chroot "$1" dpkg-query -W --showformat="\${Package}\t\${Version}\n" > "$1/../system.manifest"' \
  "$DEBIAN_SUITE" "$ROOT" \
  "deb $DEBIAN_MIRROR $DEBIAN_SUITE $DEBIAN_COMPONENTS" \
  "deb $DEBIAN_MIRROR $DEBIAN_SUITE-updates $DEBIAN_COMPONENTS" \
  "deb $DEBIAN_SECURITY_MIRROR $DEBIAN_SUITE-security $DEBIAN_COMPONENTS"

# ---------- stage D: live medium ----------
X="$WORK/iso"
rm -rf "$X"; mkdir -p "$X/live" "$X/boot/grub" "$X/.disk" "$X/EFI/boot"
kver=$(ls "$ROOT/lib/modules" | sort -V | tail -1)
[ -f "$ROOT/boot/vmlinuz-$kver" ] && [ -f "$ROOT/boot/initrd.img-$kver" ] || die "no kernel/initrd for $kver in the system"
lsinitramfs "$ROOT/boot/initrd.img-$kver" | grep -q '^scripts/live$' || die "live-boot is not in the initrd"
cp "$ROOT/boot/vmlinuz-$kver" "$X/live/vmlinuz"
cp "$ROOT/boot/initrd.img-$kver" "$X/live/initrd.img"
log "compressing the system ($(du -sh "$ROOT" | cut -f1)) into live/filesystem.squashfs"
mksquashfs "$ROOT" "$X/live/filesystem.squashfs" -comp xz -b 1M -noappend -xattrs -quiet \
  -wildcards -e 'proc/*' 'sys/*' 'dev/*' 'run/*' 'tmp/*' 'boot/efi/*'
cp "$WORK/system.manifest" "$X/live/filesystem.packages"
printf '%s' "$(du -sx --block-size=1 "$ROOT" | cut -f1)" > "$X/live/filesystem.size"
printf 'Orbit OS %s "%s" - %s amd64 (Debian 13 base, built %s)\n' "$ORBIT_VERSION" "$ORBIT_CODENAME" "$VARIANT" "$(date -u +%F)" > "$X/.disk/info"
install -D -m 755 "$HERE/tools/hardware-check.sh" "$X/tools/hardware-check.sh"

# ---------- stage E: boot loaders + ISO ----------
OUTISO="$OUT/orbit-os-$ORBIT_VERSION-$VARIANT-amd64.iso"
bash "$HERE/tools/make-iso.sh" "$ROOT" "$X" "$OUTISO" "ORBIT_OS_${ORBIT_VERSION//./_}"
(cd "$OUT" && sha256sum "$(basename "$OUTISO")" > "$(basename "$OUTISO").sha256")
log "done: $OUTISO ($(du -h "$OUTISO" | cut -f1))"
cat "$OUTISO.sha256"
