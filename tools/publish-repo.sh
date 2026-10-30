#!/bin/bash
# Orbit OS update server: turn a folder of .deb files into a signed APT repository.
#
#   tools/publish-repo.sh DEBS_DIR OUT_DIR
#
# The signing key comes from $ORBIT_SIGNING_KEY (an ASCII-armored private key, as stored
# in the GitHub secret of the same name). The result is a "flat" repository
# (Packages, Release, InRelease, Release.gpg in OUT_DIR/apt) plus setup.sh, which turns
# on Orbit updates on a system that was installed before they existed.
set -euo pipefail
DEBS="$1" OUT="$2"
[ -n "${ORBIT_SIGNING_KEY:-}" ] || { echo "ORBIT_SIGNING_KEY is empty: no key to sign the repository with" >&2; exit 1; }
for t in apt-ftparchive gpg; do command -v "$t" >/dev/null || { echo "missing $t" >&2; exit 1; }; done

GNUPGHOME="$(mktemp -d)"; export GNUPGHOME
trap 'rm -rf "$GNUPGHOME"' EXIT
printf '%s\n' "$ORBIT_SIGNING_KEY" | gpg --batch --quiet --import
FPR=$(gpg --batch --with-colons --list-secret-keys | awk -F: '/^fpr/{print $10; exit}')

rm -rf "$OUT/apt"; mkdir -p "$OUT/apt/pool"
cp "$DEBS"/*.deb "$OUT/apt/pool/"
cd "$OUT/apt"
apt-ftparchive packages pool > Packages
gzip -9kn Packages
apt-ftparchive \
  -o APT::FTPArchive::Release::Origin="Orbit OS" \
  -o APT::FTPArchive::Release::Label="Orbit OS" \
  -o APT::FTPArchive::Release::Suite="orbit" \
  -o APT::FTPArchive::Release::Codename="orbit" \
  -o APT::FTPArchive::Release::Description="Orbit OS updates: installer, apps, desktop, Aphelion" \
  release . > Release
gpg --batch --yes --local-user "$FPR" --clearsign -o InRelease Release
gpg --batch --yes --local-user "$FPR" -abs -o Release.gpg Release
gpg --batch --armor --export "$FPR" > orbit-archive-keyring.asc
cd - >/dev/null

# one-time switch for systems installed before updates existed
cat > "$OUT/setup.sh" <<SETUP
#!/bin/sh
# Turn on Orbit OS updates. Run once: curl -fsSL https://qitzblue2.github.io/OrbitOS/setup.sh | sudo sh
set -e
[ "\$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }
install -d /usr/share/keyrings
curl -fsSL https://qitzblue2.github.io/OrbitOS/apt/orbit-archive-keyring.asc -o /usr/share/keyrings/orbit-archive-keyring.asc
cat > /etc/apt/sources.list.d/orbit.sources <<'SRC'
Types: deb
URIs: https://qitzblue2.github.io/OrbitOS/apt/
Suites: ./
Signed-By: /usr/share/keyrings/orbit-archive-keyring.asc
SRC
apt-get update
apt-get -y full-upgrade
echo "Orbit OS updates are on. From now on they come through Software → Updates."
SETUP
echo "published $(ls "$OUT/apt/pool" | wc -l) packages to $OUT, signed by $FPR"
