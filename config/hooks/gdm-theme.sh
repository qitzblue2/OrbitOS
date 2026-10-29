#!/bin/bash
# Build an Orbit GDM theme: stock Ubuntu shell gresource + Orbit color overrides
# appended to its stylesheets, registered as the gdm-theme.gresource alternative.
set -euo pipefail
# The recompiled login-screen gresource is opt-in (ORBIT_GDM_THEME=1): a broken
# one leaves GDM on a black screen. By default only the dconf settings below apply.
if [ "${ORBIT_GDM_THEME:-0}" = 1 ]; then
src=$(readlink -f /usr/share/gnome-shell/gdm-theme.gresource 2>/dev/null || echo /usr/share/gnome-shell/gnome-shell-theme.gresource)
[ -f "$src" ] || { echo "no stock gresource found; GDM keeps the default theme"; exit 0; }
css=/usr/share/themes/Orbit-graphite/gnome-shell/gnome-shell.css
# build-only tool; removed again below so it does not ship
tmp_tool=0
if ! command -v glib-compile-resources >/dev/null; then
  apt-get -y -qq --snapshot "$ORBIT_SNAPSHOT" install --no-install-recommends libglib2.0-dev-bin >/dev/null
  tmp_tool=1
fi
T=$(mktemp -d)
cleanup() { rm -rf "$T"; [ $tmp_tool = 1 ] && apt-get -y -qq purge --auto-remove libglib2.0-dev-bin >/dev/null; return 0; }
trap cleanup EXIT
for r in $(gresource list "$src"); do
  mkdir -p "$T/$(dirname "$r")"
  gresource extract "$src" "$r" > "$T/$r"
done
for f in $(gresource list "$src" | grep -E '/(gdm|gnome-shell)[^/]*\.css$' | grep -v high-contrast); do
  printf '\n/* Orbit OS overrides */\n' >> "$T/$f"
  grep -v '^@import' "$css" >> "$T/$f"
done
{
  echo '<?xml version="1.0" encoding="UTF-8"?><gresources><gresource>'
  gresource list "$src" | sed 's|^/||; s|^\(.*\)$|<file>\1</file>|'
  echo '</gresource></gresources>'
} > "$T/orbit.gresource.xml"
# gresource prefixes are absolute; compile with the extracted tree as sourcedir
glib-compile-resources --sourcedir="$T" --target=/usr/share/gnome-shell/theme/orbit-gdm.gresource "$T/orbit.gresource.xml"
update-alternatives --install /usr/share/gnome-shell/gdm-theme.gresource gdm-theme.gresource \
  /usr/share/gnome-shell/theme/orbit-gdm.gresource 150
update-alternatives --set gdm-theme.gresource /usr/share/gnome-shell/theme/orbit-gdm.gresource
fi

install -d /etc/dconf/db/gdm.d /etc/dconf/profile
[ -f /etc/dconf/profile/gdm ] || printf 'user-db:user\nsystem-db:gdm\nfile-db:/usr/share/gdm/greeter-dconf-defaults\n' > /etc/dconf/profile/gdm
cat > /etc/dconf/db/gdm.d/00-orbit <<'EOF'
[org/gnome/desktop/interface]
icon-theme='orbit'
font-name='Inter 10'
color-scheme='prefer-dark'

[org/gnome/login-screen]
logo=''
disable-user-list=false
EOF
dconf update
