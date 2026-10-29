#!/bin/bash
# Runs in the chroot of the minimal.standard.live layer (live session only, not installed).
set -euo pipefail
say() { echo "[chroot-live] $*"; }

say "installer gate: typed confirmation before the installer opens"
install -m 755 /tmp/orbit/config/overlay/usr/local/bin/orbit-install-gate /usr/local/bin/orbit-install-gate
n=0
for f in /usr/share/applications/*.desktop /etc/xdg/autostart/*.desktop /var/lib/snapd/desktop/applications/*.desktop \
         /usr/share/gnome-shell/extensions/*/*.desktop; do
  [ -f "$f" ] || continue
  if grep -q '^Exec=.*ubuntu-desktop-bootstrap' "$f"; then
    sed -i 's|^Exec=\(.*\)$|Exec=/usr/local/bin/orbit-install-gate \1|' "$f"
    sed -i 's/Install Ubuntu[^\n]*/Install Orbit OS/' "$f"
    n=$((n+1)); say "gated $f"
  fi
done
[ "$n" -gt 0 ] || say "WARNING: no installer launcher found to gate; installer still has its own review page"
say "done"

if [ "${ORBIT_LIVE_INITRD:-0}" = 1 ]; then
  say "live initrd with the Orbit boot splash (build.sh checks it matches casper/vmlinuz)"
  kver=$(ls /lib/modules | sort -V | tail -1)
  update-initramfs -c -k "$kver" >/dev/null
  say "done (initrd)"
fi
