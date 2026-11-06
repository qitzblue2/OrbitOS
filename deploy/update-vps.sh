#!/usr/bin/env bash
# Updates ORBIT on the VPS to the latest version of its branch.
set -euo pipefail
APP=/opt/orbit; BRANCH="${ORBIT_BRANCH:-OrbitAI}"
[ "$(id -u)" = 0 ] || { echo "Run as root: sudo bash $0"; exit 1; }
git -C "$APP" fetch -q origin "$BRANCH"
git -C "$APP" checkout -q -B "$BRANCH" "origin/$BRANCH"
(cd "$APP" && npm ci --omit=dev --no-audit --no-fund)
# ORBIT's own speech engine for phones and browsers (~150 MB, downloaded once)
(cd "$APP" && node app/models.js) || echo "!!  Speech models could not be downloaded; phones will use browser speech until they are."
systemctl restart orbit
echo "ORBIT updated to $(git -C "$APP" log --oneline -1)"
