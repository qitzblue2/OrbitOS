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
KEY="$ORBIT_SIGNING_KEY"
# a key pasted without its first and last line still works
if ! grep -q -- '-----BEGIN PGP PRIVATE KEY BLOCK-----' <<<"$KEY"; then
  KEY=$(printf -- '-----BEGIN PGP PRIVATE KEY BLOCK-----\n\n%s\n-----END PGP PRIVATE KEY BLOCK-----\n' "$(sed '/^[[:space:]]*$/d' <<<"$KEY")")
fi
printf '%s\n' "$KEY" | gpg --batch --quiet --import || { echo "ORBIT_SIGNING_KEY is not a valid private key" >&2; exit 1; }
FPR=$(gpg --batch --with-colons --list-secret-keys | awk -F: '/^fpr/{print $10; exit}')
# the secret must belong to the public key every Orbit system trusts
HERE="$(cd "$(dirname "$0")/.." && pwd)"
if [ -f "$HERE/config/keys/orbit-archive.asc" ]; then
  WANT=$(gpg --batch --with-colons --show-keys "$HERE/config/keys/orbit-archive.asc" | awk -F: '/^fpr/{print $10; exit}')
  [ "$FPR" = "$WANT" ] || { echo "ORBIT_SIGNING_KEY ($FPR) is not the key in config/keys/orbit-archive.asc ($WANT): installed systems would reject these updates" >&2; exit 1; }
fi

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
