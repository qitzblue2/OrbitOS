#!/usr/bin/env bash
# Installs ORBIT on an Ubuntu/Debian VPS as an always-on service with automatic HTTPS.
#
#   sudo bash install-vps.sh orbitos.xdevstudios.net
#
# Before running: point the domain's DNS "A" record at this server's IP address,
# and open ports 80 and 443 in your VPS provider's firewall.
set -euo pipefail

DOMAIN="${1:-orbitos.xdevstudios.net}"
REPO="${ORBIT_REPO:-https://github.com/qitzblue2/OrbitOS.git}"
BRANCH="${ORBIT_BRANCH:-OrbitAI}"
APP=/opt/orbit
DATA=/var/lib/orbit

[ "$(id -u)" = 0 ] || { echo "Run as root: sudo bash $0 $DOMAIN"; exit 1; }
command -v apt-get >/dev/null || { echo "This installer supports Ubuntu/Debian."; exit 1; }
echo "==> Installing ORBIT for https://$DOMAIN"

# Warn early if DNS doesn't point here yet (HTTPS certificates need it).
MYIP=$(curl -fsS4 https://api.ipify.org || true)
DNSIP=$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}' || true)
if [ -n "$MYIP" ] && [ "$DNSIP" != "$MYIP" ]; then
  echo "!!  $DOMAIN points to '${DNSIP:-nothing}', but this server is $MYIP."
  echo "!!  Add a DNS A record: $DOMAIN -> $MYIP. HTTPS will start working once it does."
fi

apt-get update -y
apt-get install -y curl git ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https

# Node.js 22
if ! node -v 2>/dev/null | grep -q '^v2[2-9]'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

# Caddy (web server with automatic HTTPS certificates)
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y && apt-get install -y caddy
fi

# Service user and code
id orbit >/dev/null 2>&1 || useradd --system --home "$DATA" --shell /usr/sbin/nologin orbit
mkdir -p "$DATA" && chown orbit:orbit "$DATA" && chmod 700 "$DATA"
if [ -d "$APP/.git" ]; then git -C "$APP" fetch -q origin "$BRANCH" && git -C "$APP" checkout -q -B "$BRANCH" "origin/$BRANCH"
else git clone -q --branch "$BRANCH" --depth 1 "$REPO" "$APP" || { echo "Couldn't download ORBIT from $REPO."; exit 1; }
fi
git -C "$APP" remote set-url origin "$(git -C "$APP" remote get-url origin | sed -E 's#https://[^@/]+@#https://#')" # never keep a token in the config
(cd "$APP" && npm ci --omit=dev --no-audit --no-fund)
# ORBIT's own speech engine for phones and browsers (~150 MB, downloaded once)
(cd "$APP" && node app/models.js) || echo "!!  Speech models could not be downloaded; phones will use browser speech until they are."
chown -R root:root "$APP"

# Settings (ORBIT listens only locally; Caddy handles the internet side)
mkdir -p /etc/orbit
cat > /etc/orbit/orbit.env <<ENV
ORBIT_HOST=127.0.0.1
ORBIT_PORT=7777
ORBIT_DATA_DIR=$DATA
ORBIT_ENV_FILE=$DATA/.env
ENV

cat > /etc/systemd/system/orbit.service <<UNIT
[Unit]
Description=ORBIT personal AI server
After=network-online.target
Wants=network-online.target

[Service]
User=orbit
EnvironmentFile=/etc/orbit/orbit.env
WorkingDirectory=$APP
ExecStart=/usr/bin/node $APP/server/index.js
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DATA

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN {
	encode gzip
	header Strict-Transport-Security "max-age=31536000"
	reverse_proxy 127.0.0.1:7777
}
CADDY

if command -v ufw >/dev/null && ufw status | grep -q active; then ufw allow 80/tcp; ufw allow 443/tcp; fi

systemctl daemon-reload
systemctl enable --now orbit
systemctl restart orbit

# Caddy needs ports 80 and 443. Explain clearly if something else already uses them.
BUSY=$(ss -ltnpH '( sport = :80 or sport = :443 )' 2>/dev/null | grep -v caddy || true)
if [ -n "$BUSY" ]; then
  echo "!!  Ports 80/443 are already used by another program:"
  echo "$BUSY" | sed 's/^/      /'
  echo "!!  Stop it (e.g. 'sudo systemctl disable --now nginx' or 'apache2'), then run: sudo systemctl restart caddy"
fi
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
systemctl enable caddy >/dev/null 2>&1 || true
if ! systemctl restart caddy; then
  echo "!!  Caddy (HTTPS) didn't start. Last lines of its log:"
  journalctl -u caddy -n 15 --no-pager | sed 's/^/      /'
  echo "!!  ORBIT itself is running; fix the issue above, then: sudo systemctl restart caddy"
fi

for i in $(seq 1 20); do [ -s "$DATA/admin-token" ] && break; sleep 0.5; done
echo
echo "==> ORBIT is running."
echo "    Open:        https://$DOMAIN"
echo "    Sign in with this token (keep it private):"
echo "      $(cat "$DATA/admin-token" 2>/dev/null || echo 'see /var/lib/orbit/admin-token')"
echo "    Logs:        journalctl -u orbit -f"
echo "    Update:      sudo bash $APP/deploy/update-vps.sh"
