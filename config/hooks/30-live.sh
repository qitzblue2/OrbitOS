#!/bin/bash
# Runs inside the new system (chroot): settings for the live USB session only.
# The Orbit installer removes these (and the live packages) from installed computers.
set -euo pipefail
say() { echo "[orbit-live] $*"; }

say "live session: user 'orbit', no password, signed in automatically"
install -d /etc/live/config.conf.d
cat > /etc/live/config.conf.d/orbit.conf <<'EOF'
LIVE_HOSTNAME="orbit"
LIVE_USERNAME="orbit"
LIVE_USER_FULLNAME="Orbit Live"
LIVE_USER_DEFAULT_GROUPS="audio cdrom dip floppy video plugdev netdev powerdev scanner bluetooth sudo"
EOF
say "done"
