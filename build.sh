#!/bin/bash
# Orbit OS — one-command ISO build.
#
#   ./build.sh                 # full image, runs inside a privileged ubuntu:24.04 container
#   ORBIT_VARIANT=lite ./build.sh
#   ./build.sh --host          # run directly on an Ubuntu 24.04 host/VM (needs root)
#   ./build.sh --debs-only     # only build the .deb packages (no root needed)
#
# Stages: verify official ISO -> generate theme/icons -> build .debs ->
# unpack squashfs layers -> chroot customize -> fold changes back into
# layers -> repack ISO with the original (signed) boot chain -> SHA-256.
# Never writes to a block device. Output: out/orbit-os-<ver>-<variant>-amd64.iso
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
    die "need docker or podman (or run ./build.sh --host on an Ubuntu 24.04 VM)"
  engine=$(command -v docker || command -v podman)
  log "running build in a clean ubuntu:24.04 container ($engine)"
  exec "$engine" run --rm --privileged -e ORBIT_IN_CONTAINER=1 -e ORBIT_VARIANT="$VARIANT" \
    -v "$HERE:/src" -w /src "$BUILD_CONTAINER" bash -c \
    "apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq $HOST_DEPS >/dev/null && ./build.sh --host"
fi
[ "${1:-}" = "--host" ] && shift

# ---------- stage A: generated assets + debs (no root) ----------
build_assets() {
  log "generating theme files from branding/tokens.json"
  python3 "$HERE/branding/generate.py" --out "$WORK/branding"
  log "generating icon themes"
  python3 "$HERE/icons/generate_icons.py" --out "$WORK/icons"
  python3 "$HERE/icons/check_and_raster.py" --themes "$WORK/icons" --sheet "$HERE/tests/icon-contact-sheet.png"
}

build_debs() {
  local stage="$WORK/debs" ver="$ORBIT_VERSION"
  rm -rf "$stage"; mkdir -p "$stage" "$OUT"
  # orbit-os-branding
  local b="$stage/orbit-os-branding"
  cp -a "$HERE/packages/orbit-os-branding" "$b"
  mkdir -p "$b/files/usr/share/"{themes,icons,backgrounds/orbit,plymouth/themes,grub/themes,gnome-background-properties}
  cp -a "$WORK/branding/themes/"* "$b/files/usr/share/themes/"
  cp -a "$WORK/icons/"orbit* "$b/files/usr/share/icons/"
  cp -a "$WORK/branding/wallpapers/"*.png "$b/files/usr/share/backgrounds/orbit/"
  cp -a "$WORK/branding/plymouth/orbit" "$b/files/usr/share/plymouth/themes/"
  cp -a "$WORK/branding/grub/orbit" "$b/files/usr/share/grub/themes/"
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
  # orbit-apps (Python/GTK apps) + orbit-shell-extensions
  local oa="$stage/orbit-apps"
  cp -a "$HERE/packages/orbit-apps" "$oa"
  mkdir -p "$oa/files/usr/lib/orbit-os/python" "$oa/files/usr/share/orbit-os"
  cp -a "$HERE/packages/orbit-apps/src/orbit" "$oa/files/usr/lib/orbit-os/python/"
  find "$oa/files/usr/lib/orbit-os/python" -name __pycache__ -prune -exec rm -rf {} +
  cp "$HERE/packages/orbit-apps/data/store-catalog.json" "$oa/files/usr/share/orbit-os/"
  mkdir -p "$b/files/usr/share/orbit-os"
  cp "$HERE/branding/tokens.json" "$b/files/usr/share/orbit-os/tokens.json"
  local se="$stage/orbit-shell-extensions"
  mkdir -p "$se/files/usr/share/gnome-shell/extensions"
  cp -a "$HERE/packages/orbit-shell-extensions/DEBIAN" "$se/"
  for ext in "$HERE"/packages/orbit-shell-extensions/*@orbit-os; do
    cp -a "$ext" "$se/files/usr/share/gnome-shell/extensions/"
    [ -d "$ext/schemas" ] && glib-compile-schemas "$se/files/usr/share/gnome-shell/extensions/$(basename "$ext")/schemas"
  done
  # orbit-os-desktop (+ skel)
  local d="$stage/orbit-os-desktop"
  cp -a "$HERE/packages/orbit-os-desktop" "$d"
  mkdir -p "$d/files/etc/skel"
  cp -a "$HERE/skel/." "$d/files/etc/skel/"
  install -D -m 755 "$HERE/tools/hardware-check.sh" "$d/files/usr/bin/orbit-hardware-check"
  # single source of truth for desktop defaults: config/dconf
  install -D -m 644 "$HERE/config/dconf/db/local.d/00-orbit" "$d/files/etc/dconf/db/local.d/00-orbit"
  install -D -m 644 "$HERE/config/dconf/profile/user" "$d/files/etc/dconf/profile/user"
  local rec="keepassxc, gnome-calendar, loupe, evince"
  [ "$VARIANT" = full ] && rec="$rec, flatpak, libreoffice-writer"
  for p in orbit-os-branding orbit-launcher orbit-apps orbit-shell-extensions orbit-os-desktop; do
    local s="$stage/$p" root="$stage/$p.root"
    mkdir -p "$root"; cp -a "$s/files/." "$root/"; cp -a "$s/DEBIAN" "$root/"
    sed -i "s/@VERSION@/$ver/g; s/@RECOMMENDS@/$rec/" "$root/DEBIAN/control"
    dpkg-deb --root-owner-group -Zxz --build "$root" "$OUT/${p}_${ver}_all.deb" >/dev/null
    log "built $OUT/${p}_${ver}_all.deb"
  done
}

if [ "${1:-}" = "--debs-only" ]; then
  build_assets; build_debs; exit 0
fi

[ "$(id -u)" = 0 ] || die "the ISO stage needs root (run inside the container or a throwaway VM)"
for t in xorriso unsquashfs mksquashfs gpgv sha256sum python3 dpkg-deb; do
  command -v "$t" >/dev/null || die "missing tool: $t (apt install $HOST_DEPS)"
done

# ---------- stage B: fetch + verify the official ISO ----------
mkdir -p "$WORK/iso-src" "$OUT"
ISO="$WORK/iso-src/$UBUNTU_ISO"
cd "$WORK/iso-src"
[ -f SHA256SUMS ] || curl -fsSLO "$UBUNTU_ISO_BASE/SHA256SUMS"
[ -f SHA256SUMS.gpg ] || curl -fsSLO "$UBUNTU_ISO_BASE/SHA256SUMS.gpg"
log "verifying SHA256SUMS signature (Ubuntu CD Image Automatic Signing Key)"
mkdir -p -m 700 "$WORK/gnupg"
gpg --batch --homedir "$WORK/gnupg" --import "$HERE/config/keys/ubuntu-cdimage.asc"
fpr=$(gpg --batch --homedir "$WORK/gnupg" --with-colons --fingerprint | awk -F: '/^fpr/{print $10; exit}')
[ "$fpr" = "$UBUNTU_CDIMAGE_KEY_FPR" ] || die "keyring fingerprint $fpr != pinned $UBUNTU_CDIMAGE_KEY_FPR"
gpg --batch --homedir "$WORK/gnupg" --export > "$WORK/ubuntu-cdimage.gpg"
gpgv --keyring "$WORK/ubuntu-cdimage.gpg" SHA256SUMS.gpg SHA256SUMS || die "SHA256SUMS signature invalid"
[ -f "$ISO" ] || { log "downloading $UBUNTU_ISO"; curl -fL --retry 3 -o "$ISO.part" "$UBUNTU_ISO_BASE/$UBUNTU_ISO" && mv "$ISO.part" "$ISO"; }
grep " \*\?$UBUNTU_ISO\$" SHA256SUMS | sed 's/ \*/  /' | sha256sum -c - || die "ISO checksum mismatch"
echo "$UBUNTU_ISO_SHA256  $UBUNTU_ISO" | sha256sum -c - >/dev/null || die "ISO does not match the hash pinned in config/build.conf"
cd "$HERE"

# ---------- stage C: assets + debs ----------
build_assets
build_debs

# ---------- stage D: unpack ----------
X="$WORK/iso"; L="$WORK/layers"
if [ "${ORBIT_REUSE_EXTRACT:-0}" = 1 ] && [ -f "$WORK/.extracted" ]; then
  log "reusing pristine extracted ISO + layers from a previous failed run"
else
  rm -rf "$X" "$L" "$WORK/.extracted"; mkdir -p "$X" "$L"
  log "extracting ISO"
  xorriso -osirrox on -indev "$ISO" -extract / "$X" >/dev/null 2>&1
  chmod -R u+w "$X"
  for sq in minimal minimal.standard minimal.standard.live; do
    [ -f "$X/casper/$sq.squashfs" ] || die "expected casper/$sq.squashfs (Ubuntu 24.04 layered layout)"
    unsquashfs -q -f -d "$L/$sq" "$X/casper/$sq.squashfs"
    # the rebuilt layers replace these; free the space now (minimal is kept as-is)
    [ "$sq" != minimal ] && rm -f "$X/casper/$sq.squashfs"
  done
  touch "$WORK/.extracted"
fi

cleanup_mounts() {
  for m in "$WORK/root/dev/pts" "$WORK/root/dev" "$WORK/root/proc" "$WORK/root/sys" "$WORK/root/run" "$WORK/root"; do
    mountpoint -q "$m" 2>/dev/null && umount -l "$m"
  done
  return 0
}
trap cleanup_mounts EXIT

# customize_layer NAME HOOK LOWER...: overlay over the layer stack, chroot, fold back.
customize_layer() {
  local name="$1" hook="$2"; shift 2
  local lowers="$L/$name" l
  for l in "$@"; do lowers="$lowers:$L/$l"; done
  rm -rf "$WORK/upper" "$WORK/ovl-work" "$WORK/root"; mkdir -p "$WORK/upper" "$WORK/ovl-work" "$WORK/root"
  mount -t overlay overlay -o "lowerdir=$lowers,upperdir=$WORK/upper,workdir=$WORK/ovl-work" "$WORK/root"
  mount --bind /dev "$WORK/root/dev"; mount --bind /dev/pts "$WORK/root/dev/pts"
  mount -t proc proc "$WORK/root/proc"; mount -t sysfs sys "$WORK/root/sys"; mount -t tmpfs tmpfs "$WORK/root/run"
  mkdir -p "$WORK/root/tmp/orbit"
  cp "$OUT"/*_"$ORBIT_VERSION"_all.deb "$WORK/root/tmp/orbit/"
  cp -a "$HERE/config/." "$WORK/root/tmp/orbit/config/"
  # DNS: Ubuntu's /etc/resolv.conf is a symlink into /run, which is a fresh tmpfs here.
  mkdir -p "$WORK/root/run/systemd/resolve"
  cp -L /etc/resolv.conf "$WORK/root/run/systemd/resolve/stub-resolv.conf"
  # Build-host proxy / TLS-inspecting CA (only if the host needs one). Used for the
  # build only: lives in /tmp/orbit, which is deleted before the layer is packed.
  : > "$WORK/root/tmp/orbit/apt.conf"
  local proxyenv=()
  for v in http_proxy https_proxy HTTP_PROXY HTTPS_PROXY no_proxy NO_PROXY; do
    [ -n "${!v:-}" ] && proxyenv+=("$v=${!v}")
  done
  if [ -n "${ORBIT_BUILD_CA:-}" ]; then
    cp "$ORBIT_BUILD_CA" "$WORK/root/tmp/orbit/build-ca.crt"
    echo 'Acquire::https::CAInfo "/tmp/orbit/build-ca.crt";' >> "$WORK/root/tmp/orbit/apt.conf"
    proxyenv+=(SSL_CERT_FILE=/tmp/orbit/build-ca.crt CURL_CA_BUNDLE=/tmp/orbit/build-ca.crt)
  fi
  [ -n "${https_proxy:-${HTTPS_PROXY:-}}" ] && \
    echo "Acquire::https::Proxy \"${https_proxy:-$HTTPS_PROXY}\"; Acquire::http::Proxy \"${http_proxy:-${HTTP_PROXY:-${https_proxy:-$HTTPS_PROXY}}}\";" >> "$WORK/root/tmp/orbit/apt.conf"
  log "chroot: $hook on layer $name"
  chroot "$WORK/root" env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin HOME=/root LANG=C.UTF-8 \
    ORBIT_VARIANT="$VARIANT" ORBIT_SNAPSHOT="$ORBIT_SNAPSHOT" \
    ORBIT_LIVE_INITRD="${ORBIT_LIVE_INITRD:-0}" ORBIT_GDM_THEME="${ORBIT_GDM_THEME:-0}" DEBIAN_FRONTEND=noninteractive \
    APT_CONFIG=/tmp/orbit/apt.conf "${proxyenv[@]}" \
    /bin/bash "/tmp/orbit/config/hooks/$hook"
  chroot "$WORK/root" dpkg-query -W --showformat='${Package}\t${Version}\n' > "$WORK/$name.manifest"
  rm -rf "$WORK/root/tmp/orbit"
  cleanup_mounts
  rm -f "$WORK/.extracted"   # layers are modified from here on; never reuse them
  python3 "$HERE/tools/merge-overlay-upper.py" "$WORK/upper" "$L/$name" "$@"
}

customize_layer minimal.standard 10-desktop.chroot.sh minimal
customize_layer minimal.standard.live 20-live.chroot.sh minimal.standard minimal

# casper/initrd: keep Ubuntu's own, known-good live initrd by default (a
# regenerated one is the easiest way to end up with a black screen).
# ORBIT_LIVE_INITRD=1 opts in to the initrd rebuilt in the live chroot (Orbit
# splash during live boot); it is used only if built for casper/vmlinuz's kernel.
newinitrd=$(ls -t "$L/minimal.standard.live"/boot/initrd.img-* 2>/dev/null | head -1 || true)
if [ "${ORBIT_LIVE_INITRD:-0}" = 1 ] && [ -n "$newinitrd" ]; then
  kv=$(file -bL "$X/casper/vmlinuz" | grep -o 'version [^ ]*' | cut -d' ' -f2)
  if [ "${newinitrd##*/initrd.img-}" = "$kv" ]; then
    log "using the Orbit live initrd for kernel $kv"
    cp "$newinitrd" "$X/casper/initrd"
  else
    log "WARNING: live initrd is for ${newinitrd##*/initrd.img-}, casper kernel is $kv: keeping Ubuntu's"
  fi
else
  log "keeping Ubuntu's live initrd"
fi
rm -f "$L/minimal.standard.live"/boot/initrd.img-*

# ---------- stage E: repack ----------
for sq in minimal.standard minimal.standard.live; do
  log "repacking $sq.squashfs"
  rm -f "$X/casper/$sq.squashfs"
  mksquashfs "$L/$sq" "$X/casper/$sq.squashfs" -comp xz -b 1M -noappend -xattrs -quiet
  printf '%s' "$(du -sx --block-size=1 "$L/$sq" | cut -f1)" > "$X/casper/$sq.size"
  # manifests tell the installer which packages each layer stack contains
  cp "$WORK/$sq.manifest" "$X/casper/$sq.manifest"
done

# Live-boot menu: names plus a verbose entry (no splash, boot messages on
# screen) so a stuck boot shows where it stops. Signed shim/GRUB/kernel untouched.
for cfg in "$X/boot/grub/grub.cfg" "$X/boot/grub/loopback.cfg"; do
  [ -f "$cfg" ] || continue
  sed -i "s/Try or Install Ubuntu/Try or Install Orbit OS/g; s/Ubuntu (safe graphics)/Orbit OS (safe graphics)/g" "$cfg"
  grep -q 'Orbit OS (verbose' "$cfg" || python3 "$HERE/tools/add-verbose-entry.py" "$cfg"
done
install -D -m 755 "$HERE/tools/hardware-check.sh" "$X/tools/hardware-check.sh"
printf 'Orbit OS %s (based on Ubuntu 24.04 LTS) - %s amd64\n' "$ORBIT_VERSION" "$VARIANT" > "$X/.disk/info"

if [ "$VARIANT" = lite ]; then
  log "lite: dropping the offline driver pool (proprietary GPU drivers stay installable online)"
  rm -rf "$X/pool/restricted" "$X/pool/multiverse" 2>/dev/null || true
fi

(cd "$X" && find . -type f ! -name md5sum.txt ! -path './boot/grub/*' ! -path './EFI/*' -print0 | xargs -0 md5sum > md5sum.txt)

OUTISO="$OUT/orbit-os-$ORBIT_VERSION-$VARIANT-amd64.iso"
log "writing $OUTISO (boot records replayed from the official ISO)"
# Replays the exact El Torito/EFI/MBR layout of the signed original.
mapfile -t RAW < <(xorriso -indev "$ISO" -report_el_torito as_mkisofs 2>/dev/null | xargs -n1 printf '%s\n')
BOOTARGS=(); skip=0
for a in "${RAW[@]}"; do
  if [ $skip = 1 ]; then skip=0; continue; fi
  [ "$a" = -V ] && { skip=1; continue; }   # we set our own volume label
  BOOTARGS+=("$a")
done
xorriso -as mkisofs -r -V "ORBIT_OS_${ORBIT_VERSION//./_}" -o "$OUTISO" "${BOOTARGS[@]}" "$X" 2>&1 | tail -n 3
(cd "$OUT" && sha256sum "$(basename "$OUTISO")" > "$(basename "$OUTISO").sha256")
log "done: $OUTISO ($(du -h "$OUTISO" | cut -f1))"
cat "$OUTISO.sha256"
