#!/bin/bash
# Orbit OS hardware report. Read-only: changes nothing, sends nothing anywhere.
#   tools/hardware-check.sh            # print report
#   tools/hardware-check.sh > hw.txt   # save it, then copy results into HARDWARE-TEST.md
# Some lines need sudo for full detail (fwupd, powertop); it works without, with less detail.
set -u
ok()   { printf '  \033[32m[ OK ]\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m[WARN]\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m[FAIL]\033[0m %s\n' "$*"; }
info() { printf '  [info] %s\n' "$*"; }
sec()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

sec "System"
info "$(. /etc/os-release; echo "$PRETTY_NAME")"
info "kernel $(uname -r)"
info "model: $(cat /sys/class/dmi/id/sys_vendor 2>/dev/null) $(cat /sys/class/dmi/id/product_name 2>/dev/null)"
info "CPU: $(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2- | sed 's/^ //')"
info "RAM: $(free -m | awk '/Mem:/{print $2" MB total, "$3" MB used"}')"
if [ -d /sys/firmware/efi ]; then ok "booted in UEFI mode"; else warn "booted in legacy BIOS mode"; fi
if have mokutil; then
  sb=$(mokutil --sb-state 2>/dev/null); case "$sb" in *enabled*) ok "Secure Boot enabled";; *) info "Secure Boot: ${sb:-unknown}";; esac
fi
grep -q boot=casper /proc/cmdline && info "running in LIVE mode (nothing installed)"

sec "Graphics"
gpu=$(lspci 2>/dev/null | grep -Ei 'vga|3d|display')
info "${gpu:-no PCI GPU listed}"
info "session: ${XDG_SESSION_TYPE:-unknown}"
if have vainfo; then
  vainfo 2>/dev/null | grep -q VAProfileH264 && ok "VA-API hardware video decode available" || warn "VA-API: no H.264 profile (intel-media-va-driver installed?)"
else warn "vainfo not installed (sudo apt install vainfo) — cannot check hardware video decode"; fi
for c in /sys/class/drm/card*-*; do
  [ -f "$c/status" ] && info "display $(basename "$c"): $(cat "$c/status")"
done

sec "Network"
if have nmcli; then
  nmcli -t -f DEVICE,TYPE,STATE device 2>/dev/null | while IFS=: read -r d t s; do
    [ "$t" = loopback ] && continue; info "$d ($t): $s"; done
  nmcli -t -f WIFI radio 2>/dev/null | grep -q enabled && ok "Wi-Fi radio on" || warn "Wi-Fi radio off or absent"
fi
lspci -k 2>/dev/null | grep -A3 -i 'network controller' | grep -i 'driver in use' | sed 's/^\s*/  [info] wifi /'

sec "Bluetooth"
if have bluetoothctl; then
  bluetoothctl show 2>/dev/null | grep -q 'Powered: yes' && ok "Bluetooth controller powered" || warn "no powered Bluetooth controller"
else warn "bluez not installed"; fi

sec "Audio"
if have wpctl; then
  wpctl status 2>/dev/null | sed -n '/Sinks:/,/Sources:/p' | grep -E '[0-9]+\.' | head -5 | sed 's/^/  [info] sink /'
  wpctl status 2>/dev/null | sed -n '/Sources:/,/Filters:/p' | grep -E '[0-9]+\.' | head -5 | sed 's/^/  [info] source /'
  info "test speakers: speaker-test -c2 -t wav -l1 ; headphone jack: plug in and rerun"
fi

sec "Camera"
ls /dev/video* >/dev/null 2>&1 && ok "video devices: $(ls /dev/video* | tr '\n' ' ')" || warn "no /dev/video* (camera off, privacy switch, or unsupported)"

sec "Fingerprint reader"
fp=$(lsusb 2>/dev/null | grep -iE 'fingerprint|synaptics|goodix|validity|elan.*fp|egis|upek' )
if [ -n "$fp" ]; then info "USB: $fp"; else warn "no fingerprint reader recognised in lsusb"; fi
if have fprintd-list; then
  out=$(fprintd-list "$(id -un)" 2>&1)
  case "$out" in *"No devices"*|*"no devices"*) bad "fprintd sees no supported device (check libfprint supported list for the USB ID above)";;
                 *found*|*Device*|*Fingerprints*) ok "fprintd sees a reader: $(echo "$out" | grep -m1 -i device)";;
                 *) warn "fprintd: $out";; esac
else warn "fprintd not installed"; fi
grep -q pam_fprintd /etc/pam.d/common-auth 2>/dev/null && ok "PAM: fingerprint enabled for login/sudo" || info "PAM: fingerprint not enabled (sudo pam-auth-update --enable fprintd)"

sec "Power"
for b in /sys/class/power_supply/BAT*; do
  [ -d "$b" ] || continue
  info "$(basename "$b"): $(cat "$b/status") $(cat "$b/capacity")% health $(( $(cat "$b/energy_full" 2>/dev/null || cat "$b/charge_full") * 100 / $(cat "$b/energy_full_design" 2>/dev/null || cat "$b/charge_full_design") ))%"
  [ -f "$b/power_now" ] && info "  draw now: $(awk '{printf "%.1f W", $1/1e6}' "$b/power_now")"
done
have powerprofilesctl && info "power profile: $(powerprofilesctl get 2>/dev/null)"
systemctl is-active -q thermald && ok "thermald running" || warn "thermald not running"
info "suspend modes: $(cat /sys/power/mem_sleep 2>/dev/null)"
info "measure idle draw: sudo powertop --time=60 --html=powertop.html (on battery, screen at 50%)"

sec "Firmware"
if have fwupdmgr; then fwupdmgr get-devices --no-unreported-check 2>/dev/null | grep -E '^├|^└|Current version' | head -20 | sed 's/^/  [info] /'
else warn "fwupd not installed"; fi

sec "Input"
grep -l -i touchpad /sys/class/input/*/device/name 2>/dev/null | head -1 | grep -q . && ok "touchpad present" || info "no touchpad"
grep -qi 'hp wmi hotkeys' /proc/bus/input/devices && ok "HP WMI hotkeys driver loaded (function keys)" || info "HP WMI hotkeys not present (expected on non-HP)"

sec "Security"
have ufw && { sudo -n ufw status 2>/dev/null | head -1 | sed 's/^/  [info] firewall: /' || info "firewall: run 'sudo ufw status'"; }
ss -tlnH 2>/dev/null | grep -vE '127\.0\.0\.|\[::1\]' | grep -q . && warn "listening on non-loopback TCP: $(ss -tlnH | grep -vE '127\.0\.0\.|\[::1\]' | awk '{print $4}' | tr '\n' ' ')" || ok "no TCP ports open to the network"
systemctl is-enabled -q ssh 2>/dev/null && warn "ssh enabled" || ok "ssh disabled"

sec "Boot time"
have systemd-analyze && systemd-analyze 2>/dev/null | head -1 | sed 's/^/  [info] /'
echo
echo "Copy the lines above into HARDWARE-TEST.md. Items needing a human: keys, lid, sleep, headphones, external monitor."
