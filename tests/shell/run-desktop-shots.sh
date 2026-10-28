#!/bin/bash
# Boot the Orbit desktop in a headless GNOME Shell 46 and screenshot it.
#   tests/shell/run-desktop-shots.sh OUTDIR
# Needs (Ubuntu 24.04): gnome-shell, gnome-shell-extensions, gnome-shell-extension-ubuntu-dock,
# dconf-cli, dbus, and the Orbit .debs in out/ (./build.sh --debs-only). The Orbit packages'
# files are unpacked into a throwaway prefix that XDG_DATA_DIRS points at; nothing is
# installed system-wide and no package scripts run.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/../.." && pwd)"
OUT=$(realpath -m "${1:?usage: run-desktop-shots.sh OUTDIR}")
mkdir -p "$OUT"
T=$(mktemp -d /tmp/orbit-shell-XXXX)
PREFIX="$T/prefix"
mkdir -p "$PREFIX" "$T/home/.local/share/gnome-shell/extensions"
for d in "$HERE"/out/orbit-os-branding_*.deb "$HERE"/out/orbit-launcher_*.deb "$HERE"/out/orbit-apps_*.deb \
         "$HERE"/out/orbit-shell-extensions_*.deb "$HERE"/out/orbit-os-desktop_*.deb; do
  dpkg-deb -x "$d" "$PREFIX"
done
glib-compile-schemas "$PREFIX/usr/share/glib-2.0/schemas"
# GNOME Shell only loads system extensions from XDG data dirs: point it at the prefix
EXT="$T/home/.local/share/gnome-shell/extensions"
cp -a "$PREFIX"/usr/share/gnome-shell/extensions/*@orbit-os "$EXT/"
cp -a "$HERE/tests/shell/orbit-test-driver@orbit-os" "$EXT/"
python3 -c "import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])" \
  "$HERE/config/vendor/blur-my-shell@aunetx.shell-extension.zip" "$EXT/blur-my-shell@aunetx"
for e in "$EXT"/*/schemas; do glib-compile-schemas "$e"; done
# Point theme/wallpaper paths at the prefix instead of /usr/share
sed "s#/usr/share/backgrounds/orbit#$PREFIX/usr/share/backgrounds/orbit#g" \
  "$HERE/config/dconf/db/local.d/00-orbit" > "$T/orbit.dconf"
cat >> "$T/orbit.dconf" <<EOF

[org/gnome/shell]
enabled-extensions=['ubuntu-dock@ubuntu.com', 'blur-my-shell@aunetx', 'orbit-launcher@orbit-os', 'orbit-control-center@orbit-os', 'orbit-widgets@orbit-os', 'orbit-clipboard@orbit-os', 'user-theme@gnome-shell-extensions.gcampax.github.com', 'orbit-test-driver@orbit-os']
favorite-apps=['orbit-files.desktop', 'firefox-esr.desktop', 'orbit-notes.desktop', 'org.gnome.Terminal.desktop', 'orbit-store.desktop', 'org.keepassxc.KeePassXC.desktop', 'orbit-settings.desktop']
disable-extension-version-validation=true
welcome-dialog-last-shown-version='999'
EOF
# debugging aid: ORBIT_SHELL_CSS=/path/file.css replaces the generated shell stylesheet
if [ -n "${ORBIT_SHELL_CSS:-}" ]; then cp "$ORBIT_SHELL_CSS" "$PREFIX/usr/share/themes/Orbit-graphite/gnome-shell/gnome-shell.css"; fi
mkdir -p "$T/home/.local/share/themes"
ln -s "$PREFIX/usr/share/themes/Orbit-graphite" "$T/home/.local/share/themes/Orbit-graphite"
mkdir -p "$T/home/.local/share/icons"
for i in orbit orbit-graphite orbit-light; do ln -s "$PREFIX/usr/share/icons/$i" "$T/home/.local/share/icons/$i"; done
export HOME="$T/home" XDG_CONFIG_HOME="$T/home/.config" XDG_DATA_HOME="$T/home/.local/share" \
       XDG_RUNTIME_DIR="$T/run" XDG_DATA_DIRS="$PREFIX/usr/share:/usr/local/share:/usr/share" \
       ORBIT_SHOT_DIR="$OUT" \
       PATH="$PREFIX/usr/bin:$PATH" XDG_SESSION_TYPE=wayland XDG_CURRENT_DESKTOP=ubuntu:GNOME
mkdir -p -m 700 "$XDG_RUNTIME_DIR"
python3 "$HERE/tests/gui/demo_home.py" "$HOME" >/dev/null 2>&1 || true
# a private bus stands in for the system bus (logind/upower lookups just find nobody there)
SYSBUS=$(dbus-daemon --session --fork --print-address=1)
export DBUS_SYSTEM_BUS_ADDRESS="$SYSBUS"
dbus-run-session -- bash -c "
  dconf load / < '$T/orbit.dconf'
  timeout 150 gnome-shell --headless --virtual-monitor 1920x1080 --wayland --no-x11 > '$OUT/shell.log' 2>&1
  echo \"gnome-shell exit \$?\" >> '$OUT/shell.log'
"
tail -n 3 "$OUT/shell.log"
cat "$OUT/report.json" 2>/dev/null || { echo "no report: see $OUT/shell.log"; exit 1; }
