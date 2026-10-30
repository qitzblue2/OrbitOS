#!/bin/bash
# Create the key that signs Orbit OS updates. Run this ONCE, on your own machine or VPS.
#
#   tools/make-signing-key.sh
#
# It writes the public half to config/keys/orbit-archive.asc (commit that: every Orbit
# system trusts it) and prints the private half, which you paste into GitHub:
# repository Settings → Secrets and variables → Actions → New repository secret,
# name ORBIT_SIGNING_KEY. Keep a copy offline: whoever has it can publish Orbit updates.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "$HERE/config/keys/orbit-archive.asc" ] && { echo "config/keys/orbit-archive.asc already exists; a new key would cut off every installed Orbit" >&2; exit 1; }
GNUPGHOME="$(mktemp -d)"; export GNUPGHOME
trap 'rm -rf "$GNUPGHOME"' EXIT
gpg --batch --quiet --passphrase '' --quick-gen-key "Orbit OS updates <orbit-updates@users.noreply.github.com>" ed25519 sign 5y
FPR=$(gpg --batch --with-colons --list-secret-keys | awk -F: '/^fpr/{print $10; exit}')
mkdir -p "$HERE/config/keys"
gpg --batch --armor --export "$FPR" > "$HERE/config/keys/orbit-archive.asc"
echo "public key: config/keys/orbit-archive.asc (fingerprint $FPR)"
echo
echo "=== copy everything between the lines into the GitHub secret ORBIT_SIGNING_KEY ==="
gpg --batch --armor --export-secret-keys "$FPR"
echo "=== end ==="
