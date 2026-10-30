"""GTK-free logic behind Orbit VPN: WireGuard to your own server, through NetworkManager.

A device config made by tools/orbit-vpn-server.sh (or any WireGuard .conf) is
checked here, then imported with `nmcli connection import type wireguard`, which
stores the private key in NetworkManager's system settings (root-only files).
Connecting and disconnecting are nmcli up/down: no extra service, and the VPN
shows up in the top-bar network menu too.
"""
import configparser
import ipaddress
import os
import re
import subprocess
import tempfile

KEY = re.compile(r"^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw480]=$")      # 32-byte WireGuard key, base64
NAME = re.compile(r"^[a-z0-9][a-z0-9-]{0,14}$")                  # also the network interface name


class VpnError(ValueError):
    pass


def parse_conf(text):
    """Validate a WireGuard config. -> {'address', 'endpoint', 'full_tunnel', 'dns'} or raises VpnError."""
    cp = configparser.ConfigParser(interpolation=None, strict=False, delimiters=("=",))
    cp.optionxform = str.lower
    try:
        cp.read_string(text)
    except configparser.Error as e:
        raise VpnError(f"This isn’t a WireGuard config ({e.__class__.__name__})") from e
    if not cp.has_section("Interface") or not cp.has_section("Peer"):
        raise VpnError("This isn’t a WireGuard config: it needs an [Interface] and a [Peer] part")
    i, p = cp["Interface"], cp["Peer"]
    if not KEY.match(i.get("privatekey", "").strip()):
        raise VpnError("The config has no valid private key")
    if not KEY.match(p.get("publickey", "").strip()):
        raise VpnError("The config has no valid server key")
    endpoint = p.get("endpoint", "").strip()
    if not re.match(r"^(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+):\d{1,5}$", endpoint):
        raise VpnError("The config has no server address (Endpoint)")
    allowed = [a.strip() for a in p.get("allowedips", "").split(",") if a.strip()]
    try:
        nets = [ipaddress.ip_network(a, strict=False) for a in allowed]
        addrs = [ipaddress.ip_interface(a.strip()) for a in i.get("address", "").split(",") if a.strip()]
    except ValueError as e:
        raise VpnError(f"The config has a bad address: {e}") from e
    if not addrs:
        raise VpnError("The config has no Address")
    full = any(n.prefixlen == 0 for n in nets)
    return {"address": ", ".join(str(a) for a in addrs), "endpoint": endpoint, "full_tunnel": full,
            "ipv6": any(n.prefixlen == 0 and n.version == 6 for n in nets),
            "dns": i.get("dns", "").strip()}


def clean_name(text):
    n = re.sub(r"[^a-z0-9-]", "-", (text or "").lower()).strip("-")[:15]
    return n if NAME.match(n or "") else "orbit-vpn"


def _nmcli(*args, check=True):
    r = subprocess.run(["nmcli", *args], capture_output=True, text=True, timeout=30,
                       env={**os.environ, "LANG": "C.UTF-8"})
    if check and r.returncode:
        raise VpnError((r.stderr.strip() or r.stdout.strip() or "nmcli failed").splitlines()[-1])
    return r.stdout


def parse_connections(text):
    """`nmcli -t -f NAME,TYPE,DEVICE,ACTIVE connection show` -> [{'name', 'active'}] for WireGuard ones."""
    out = []
    for line in text.splitlines():
        parts = re.split(r"(?<!\\):", line)
        if len(parts) >= 4 and parts[1] == "wireguard":
            out.append({"name": parts[0].replace("\\:", ":"), "active": parts[3] == "yes"})
    return out


def connections():
    return parse_connections(_nmcli("-t", "-f", "NAME,TYPE,DEVICE,ACTIVE", "connection", "show"))


def import_conf(text, name):
    """Check and import a config as NetworkManager connection `name`. Returns the parse summary."""
    info = parse_conf(text)
    name = clean_name(name)
    if any(c["name"] == name for c in connections()):
        raise VpnError(f"There already is a VPN called {name}")
    with tempfile.TemporaryDirectory() as d:          # nmcli names the connection after the file
        path = os.path.join(d, f"{name}.conf")
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(text)
        _nmcli("connection", "import", "type", "wireguard", "file", path)
    _nmcli("connection", "modify", name, "connection.autoconnect", "no")
    return info


def up(name):
    _nmcli("connection", "up", "id", name)


def down(name):
    _nmcli("connection", "down", "id", name)


def delete(name):
    _nmcli("connection", "delete", "id", name)


def set_autoconnect(name, on):
    _nmcli("connection", "modify", name, "connection.autoconnect", "yes" if on else "no")


def autoconnect(name):
    out = _nmcli("-g", "connection.autoconnect", "connection", "show", "id", name, check=False)
    return out.strip() == "yes"


def public_ip(fetch=None):
    """The address websites see now (to show the VPN works). None when offline."""
    import urllib.request
    fetch = fetch or (lambda: urllib.request.urlopen("https://api.ipify.org", timeout=5).read().decode())
    try:
        ip = fetch().strip()
        ipaddress.ip_address(ip)
        return ip
    except (OSError, ValueError):
        return None
