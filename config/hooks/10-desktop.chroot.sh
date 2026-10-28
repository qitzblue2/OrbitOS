#!/bin/bash
# Runs inside the chroot of the minimal.standard layer (= the installed system).
set -euo pipefail
C=/tmp/orbit/config
say() { echo "[chroot] $*"; }
list() { grep -vE '^\s*(#|$)' "$1"; }

say "apt sources: Ubuntu archive (main restricted universe multiverse), pinned via snapshot $ORBIT_SNAPSHOT"
sed -i -e "s/^Components:.*/Components: main restricted universe multiverse/" -e "s#http://archive.ubuntu.com#https://archive.ubuntu.com#g" -e "s#http://security.ubuntu.com#https://security.ubuntu.com#g" /etc/apt/sources.list.d/ubuntu.sources
install -d -m 755 /etc/apt/keyrings
install -m 644 "$C/keys/mozilla-apt.asc" /etc/apt/keyrings/packages.mozilla.org.asc
cat > /etc/apt/sources.list.d/mozilla.sources <<'EOF'
Types: deb
URIs: https://packages.mozilla.org/apt
Suites: mozilla
Components: main
Signed-By: /etc/apt/keyrings/packages.mozilla.org.asc
EOF
cat > /etc/apt/preferences.d/mozilla <<'EOF'
Package: *
Pin: origin packages.mozilla.org
Pin-Priority: 100

Package: firefox-esr*
Pin: origin packages.mozilla.org
Pin-Priority: 1000
EOF
apt-get update -qq --error-on=any --snapshot "$ORBIT_SNAPSHOT" || { say "archive/snapshot unreachable: refusing an unpinned build"; exit 1; }
APT="apt-get -y -qq --snapshot $ORBIT_SNAPSHOT -o Dpkg::Options::=--force-confnew"

say "removing telemetry, crash reporting, Ubuntu branding (simulated first: never cascade into the desktop)"
mapfile -t RM < <(list "$C/packages.remove.list")
for p in "${RM[@]}"; do
  dpkg -s "$p" >/dev/null 2>&1 || continue
  mapfile -t gone < <(apt-get -s purge "$p" 2>/dev/null | awk '/^Purg/{print $2}')
  safe=1
  for g in "${gone[@]}"; do
    [[ " ${RM[*]} " == *" $g "* || "$g" == "$p"-* ]] || { safe=0; break; }
  done
  if [ $safe = 1 ]; then
    $APT purge "$p"
  else
    say "  keeping $p (purging it would also remove: ${gone[*]}); neutralized instead"
  fi
done
# ubuntu-session depends on ubuntu-wallpapers, so the package stays but its images do not
# (trademark: no Ubuntu artwork in the image). path-exclude keeps them out on upgrades too.
cat > /etc/dpkg/dpkg.cfg.d/orbit-no-ubuntu-artwork <<'EOF'
path-exclude=/usr/share/backgrounds/*
path-include=/usr/share/backgrounds/orbit/*
path-exclude=/usr/share/gnome-background-properties/ubuntu-wallpapers.xml
path-exclude=/usr/share/gnome-background-properties/noble-wallpapers.xml
EOF
find /usr/share/backgrounds -mindepth 1 -maxdepth 1 ! -name orbit -exec rm -rf {} +
rm -f /usr/share/gnome-background-properties/ubuntu-wallpapers.xml /usr/share/gnome-background-properties/noble-wallpapers.xml
systemctl mask apport.service whoopsie.service whoopsie.path 2>/dev/null || true

say "installing base apps ($ORBIT_VARIANT)"
mapfile -t PK < <(list "$C/packages.base.list"; [ "$ORBIT_VARIANT" = full ] && list "$C/packages.full.list")
$APT install --no-install-recommends "${PK[@]}" firefox-esr
if apt-cache show gnome-shell-extension-blur-my-shell >/dev/null 2>&1; then
  $APT install gnome-shell-extension-blur-my-shell
elif [ -f "$C/vendor/blur-my-shell@aunetx.shell-extension.zip" ]; then
  (cd "$C/vendor" && sha256sum -c SHA256SUMS)
  install -d /usr/share/gnome-shell/extensions/blur-my-shell@aunetx
  python3 -c "import zipfile,sys;zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])" \
    "$C/vendor/blur-my-shell@aunetx.shell-extension.zip" /usr/share/gnome-shell/extensions/blur-my-shell@aunetx
  glib-compile-schemas /usr/share/gnome-shell/extensions/blur-my-shell@aunetx/schemas
else
  say "WARNING: Blur my Shell not in archive and not vendored: glass surfaces fall back to solid (see DECISIONS.md D-07)"
fi

say "installing Orbit packages"
$APT install /tmp/orbit/orbit-os-branding_*.deb /tmp/orbit/orbit-launcher_*.deb /tmp/orbit/orbit-os-desktop_*.deb

say "Firefox: drop the snap seed (a .deb from Mozilla is installed instead); keep the snap store out of the way"
seed=/var/lib/snapd/seed/seed.yaml
if [ -f "$seed" ]; then
  python3 - "$seed" <<'PY'
import sys, re, pathlib
p = pathlib.Path(sys.argv[1]); drop = {"firefox", "snap-store"}
blocks = re.split(r"(?m)^(?=  - name: )", p.read_text())
keep = [b for b in blocks if not any(re.match(rf"  - name: {d}\s*$", b.splitlines()[0]) for d in drop)]
p.write_text("".join(keep))
PY
  rm -f /var/lib/snapd/seed/snaps/firefox_*.snap /var/lib/snapd/seed/snaps/snap-store_*.snap
fi

say "flatpak + Flathub ($ORBIT_VARIANT)"
if [ "$ORBIT_VARIANT" = full ]; then
  flatpak remote-add --system --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo
fi

say "no hidden network calls at boot"
sed -i 's/^ENABLED=.*/ENABLED=0/' /etc/default/motd-news 2>/dev/null || true
install -d /etc/NetworkManager/conf.d
printf '[connectivity]\nenabled=false\n' > /etc/NetworkManager/conf.d/90-orbit-no-connectivity-check.conf
systemctl disable fwupd-refresh.timer motd-news.timer 2>/dev/null || true
systemctl mask ubuntu-advantage.service apport.service whoopsie.service 2>/dev/null || true
# snapd stays (the installer and some optional apps are snaps) but auto-refresh is held;
# security updates for debs still come from unattended-upgrades.
install -d /etc/systemd/system
cat > /etc/systemd/system/orbit-snap-hold.service <<'EOF'
[Unit]
Description=Hold automatic snap refreshes (Orbit OS: updates are user-initiated)
After=snapd.seeded.service
Wants=snapd.seeded.service
ConditionPathExists=!/var/lib/orbit-os/snap-hold.done

[Service]
Type=oneshot
ExecStart=/usr/bin/snap refresh --hold
ExecStartPost=/bin/sh -c 'mkdir -p /var/lib/orbit-os && touch /var/lib/orbit-os/snap-hold.done'

[Install]
WantedBy=multi-user.target
EOF
systemctl enable orbit-snap-hold.service

say "firewall on (written directly; iptables cannot run in a chroot)"
sed -i 's/^ENABLED=.*/ENABLED=yes/' /etc/ufw/ufw.conf
sed -i 's/^DEFAULT_INPUT_POLICY=.*/DEFAULT_INPUT_POLICY="DROP"/; s/^DEFAULT_OUTPUT_POLICY=.*/DEFAULT_OUTPUT_POLICY="ACCEPT"/' /etc/default/ufw
systemctl enable ufw.service

say "no root login, no ssh"
passwd -l root >/dev/null
systemctl disable ssh.service ssh.socket 2>/dev/null || true

say "GDM: Orbit shell styling + dconf"
bash "$C/hooks/gdm-theme.sh"

say "TLP profile shipped but not active (power-profiles-daemon is the default, see DECISIONS.md D-15)"
install -D -m 644 "$C/tlp/orbit.conf" /usr/share/orbit-os/tlp/orbit.conf

say "verifying icon-name mapping against installed .desktop files"
python3 - <<'PY' | tee /var/log/orbit-icon-map.txt
import configparser, glob, os
names = {}
for f in glob.glob("/usr/share/applications/*.desktop") + glob.glob("/var/lib/snapd/desktop/applications/*.desktop"):
    cp = configparser.RawConfigParser(strict=False)
    try: cp.read(f, encoding="utf-8")
    except Exception: continue
    if cp.has_option("Desktop Entry", "Icon"):
        names[os.path.basename(f)] = cp.get("Desktop Entry", "Icon")
themed = {os.path.basename(p)[:-4] for p in glob.glob("/usr/share/icons/orbit/scalable/apps/*.svg")}
for desk, icon in sorted(names.items()):
    if icon in themed:
        print(f"OK      {desk:55} {icon}")
for want in ["org.gnome.Nautilus", "org.gnome.Terminal", "org.gnome.Settings", "org.gnome.Calculator",
             "org.gnome.TextEditor", "org.gnome.FileRoller", "org.gnome.SystemMonitor",
             "org.keepassxc.KeePassXC", "firefox-esr", "org.gnome.Software"]:
    if want not in names.values():
        print(f"MISSING no installed .desktop uses Icon={want} (symlink or mapping needed)")
PY

apt-get clean
rm -rf /var/lib/apt/lists/* /var/cache/apt/*.bin /var/log/apt/*.log
say "done"
