#!/bin/bash
# Orbit VPN server: turn your own VPS (Debian or Ubuntu) into a WireGuard VPN.
#
#   sudo ./tools/orbit-vpn-server.sh setup          once: install WireGuard, keys, firewall, start
#   sudo ./tools/orbit-vpn-server.sh add laptop     a config for one device (prints it, a QR code, and saves it)
#   sudo ./tools/orbit-vpn-server.sh remove laptop  that device can't connect any more
#   sudo ./tools/orbit-vpn-server.sh list           devices and when they last connected
#
# All traffic of a connected device (IPv4 and IPv6) goes through the VPS. Each device gets
# its own key, so removing one never affects the others. Device configs are kept in
# /etc/wireguard/orbit-clients (readable by root only); copy one to the device, e.g.
#   scp root@your-vps:/etc/wireguard/orbit-clients/laptop.conf .
# and import it in Orbit VPN. The private key in it is the device's password: keep it private.
set -euo pipefail

WG_DIR="${ORBIT_WG_DIR:-/etc/wireguard}"   # ORBIT_WG_DIR / ORBIT_VPN_NO_SYSTEM are for tests only
IFACE=wg0
PORT="${ORBIT_VPN_PORT:-51820}"
NET4=10.66.66
NET6=fd42:66:66
CLIENTS="$WG_DIR/orbit-clients"
CONF="$WG_DIR/$IFACE.conf"
DNS="${ORBIT_VPN_DNS:-1.1.1.1, 2606:4700:4700::1111}"

die() { echo "orbit-vpn-server: $*" >&2; exit 1; }
system() { [ -z "${ORBIT_VPN_NO_SYSTEM:-}" ]; }

[ "$(id -u)" = 0 ] || die "run it with sudo"
umask 077

wan_iface() { { ip -4 route show default 2>/dev/null || true; } | awk '{for (i=1;i<NF;i++) if ($i=="dev") {print $(i+1); exit}}'; }

public_address() {
  local a="${ORBIT_VPN_ENDPOINT:-}"
  [ -n "$a" ] && { echo "$a"; return; }
  a=$(curl -4 -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)
  [ -n "$a" ] || a=$({ ip -4 addr show "$(wan_iface)" 2>/dev/null || true; } | awk '/inet /{sub(/\/.*/,"",$2); print $2; exit}')
  [ -n "$a" ] || die "could not find this server's public address; set ORBIT_VPN_ENDPOINT=1.2.3.4"
  echo "$a"
}

setup() {
  if system; then
    command -v wg >/dev/null || { apt-get update -q && DEBIAN_FRONTEND=noninteractive apt-get install -y -q wireguard-tools qrencode nftables; }
  fi
  mkdir -p "$CLIENTS"
  if [ -f "$CONF" ]; then echo "already set up ($CONF)"; return; fi
  local wan key
  wan=$(wan_iface); [ -n "$wan" ] || wan=eth0
  key=$(wg genkey)
  echo "$key" | wg pubkey > "$WG_DIR/server.pub"
  public_address > "$WG_DIR/endpoint"
  cat > "$CONF" <<EOF
# Orbit VPN server (tools/orbit-vpn-server.sh). Devices are added below by "add".
[Interface]
Address = $NET4.1/24, $NET6::1/64
ListenPort = $PORT
PrivateKey = $key
PostUp = nft -f $WG_DIR/orbit-nat.nft
PostDown = nft delete table inet orbit_vpn
EOF
  cat > "$WG_DIR/orbit-nat.nft" <<EOF
# Orbit VPN: let devices reach the internet through this server ($wan)
table inet orbit_vpn {
  chain forward {
    type filter hook forward priority 0; policy accept;
    iifname "$IFACE" accept
    oifname "$IFACE" ct state established,related accept
    oifname "$IFACE" drop
  }
  chain postrouting {
    type nat hook postrouting priority 100;
    oifname "$wan" ip saddr $NET4.0/24 masquerade
    oifname "$wan" ip6 saddr $NET6::/64 masquerade
  }
}
EOF
  if system; then
    printf 'net.ipv4.ip_forward = 1\nnet.ipv6.conf.all.forwarding = 1\n' > /etc/sysctl.d/90-orbit-vpn.conf
    sysctl -q -p /etc/sysctl.d/90-orbit-vpn.conf
    if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
      ufw allow "$PORT/udp" comment "Orbit VPN" >/dev/null
      ufw route allow in on "$IFACE" out on "$wan" comment "Orbit VPN" >/dev/null
    fi
    systemctl enable --now "wg-quick@$IFACE" >/dev/null
  fi
  echo "Orbit VPN server is running on $(cat "$WG_DIR/endpoint"):$PORT (udp)."
  echo "If your VPS provider has its own firewall, allow UDP port $PORT there too."
  echo "Next: sudo $0 add laptop"
}

valid_name() { [[ "$1" =~ ^[a-z0-9][a-z0-9-]{0,14}$ ]] || die "device name: lowercase letters, digits and -, at most 15 (e.g. laptop)"; }

add() {
  local name="$1" key pub psk n ip4 ip6
  valid_name "$name"
  [ -f "$CONF" ] || die "run setup first"
  [ -f "$CLIENTS/$name.conf" ] && die "$name already exists (remove it first to make a new one)"
  for n in $(seq 2 254); do grep -q "AllowedIPs = $NET4.$n/32" "$CONF" || break; done
  grep -q "AllowedIPs = $NET4.$n/32" "$CONF" && die "no free addresses left"
  ip4="$NET4.$n"; ip6="$NET6::$n"
  key=$(wg genkey); pub=$(echo "$key" | wg pubkey); psk=$(wg genpsk)
  cat >> "$CONF" <<EOF

# device: $name
[Peer]
PublicKey = $pub
PresharedKey = $psk
AllowedIPs = $ip4/32, $ip6/128
EOF
  cat > "$CLIENTS/$name.conf" <<EOF
# Orbit VPN: $name. Import this file in Orbit VPN (or any WireGuard app).
[Interface]
PrivateKey = $key
Address = $ip4/32, $ip6/128
DNS = $DNS

[Peer]
PublicKey = $(cat "$WG_DIR/server.pub")
PresharedKey = $psk
Endpoint = $(cat "$WG_DIR/endpoint"):$PORT
AllowedIPs = 0.0.0.0/0, ::/0
PersistentKeepalive = 25
EOF
  system && wg syncconf "$IFACE" <(wg-quick strip "$IFACE")
  echo "Device '$name' added. Its config ($CLIENTS/$name.conf):"
  echo
  cat "$CLIENTS/$name.conf"
  echo
  command -v qrencode >/dev/null && { echo "Phone: scan this in the WireGuard app"; qrencode -t ansiutf8 < "$CLIENTS/$name.conf"; }
  echo "Laptop: copy the file over, e.g.  scp root@$(cat "$WG_DIR/endpoint"):$CLIENTS/$name.conf ."
}

remove() {
  local name="$1" tmp
  valid_name "$name"
  grep -q "^# device: $name\$" "$CONF" || die "no device called $name"
  tmp=$(mktemp)
  # drop the "# device: NAME" block (comment + its [Peer] section, up to the next blank line)
  awk -v n="# device: $name" '$0==n{skip=1; next} skip&&/^$/{skip=0; next} !skip' "$CONF" > "$tmp"
  cat "$tmp" > "$CONF"; rm -f "$tmp" "$CLIENTS/$name.conf"
  system && wg syncconf "$IFACE" <(wg-quick strip "$IFACE")
  echo "Device '$name' removed; it can't connect any more."
}

list() {
  [ -f "$CONF" ] || die "run setup first"
  grep "^# device: " "$CONF" | sed 's/^# device: /  /' || echo "  (no devices yet)"
  system && wg show "$IFACE" latest-handshakes 2>/dev/null | while read -r pub ts; do
    [ "$ts" = 0 ] && continue
    echo "  last connected $(date -d "@$ts" '+%Y-%m-%d %H:%M'): ${pub:0:8}…"
  done || true
}

case "${1:-}" in
  setup) setup ;;
  add) [ -n "${2:-}" ] || die "usage: $0 add NAME"; add "$2" ;;
  remove) [ -n "${2:-}" ] || die "usage: $0 remove NAME"; remove "$2" ;;
  list) list ;;
  *) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
