# Hardware test record

Rule: a feature counts as working only once a person has tested it on that machine. Everything else stays **untested**.

Legend: ✅ works · ⚠️ works with caveats (note them) · ❌ broken · ⏳ untested

Paste `tools/hardware-check.sh` output under each machine.

## QEMU/KVM virtual machine (development)
| Item | Result | Notes |
|---|---|---|
| ISO boots (UEFI, OVMF) | see `tests/screenshots/` | automated by `tests/vm-boot-test.sh` |
| Live desktop appears | see PERFORMANCE.md | |
| Installer gate + installer opens | ⏳ | |
| Install to virtual disk, reboot into installed system | ⏳ | |

## Desktop PC — Intel Core i7-8700K, 32 GB RAM (first real-hardware test, live USB)
| Item | Result | Notes |
|---|---|---|
| Boots with Secure Boot ON | ⏳ | |
| Desktop appears, iGPU UHD 630 / dGPU | ⏳ | |
| Wired network / Wi-Fi | ⏳ | |
| Bluetooth | ⏳ | |
| Audio out / mic / headphone jack | ⏳ | |
| Suspend / resume | ⏳ | |
| External monitor(s) | ⏳ | |
| Boot time (`systemd-analyze`, installed only) | ⏳ | |
| Idle RAM after 5 min (`free -m`) | ⏳ | |

## HP EliteBook 830 G7 — i5-1145G7, 16 GB, Iris Xe (live USB first, then installed)
| Item | Result | Notes |
|---|---|---|
| Boots with Secure Boot ON | ⏳ | |
| Wi-Fi 6 (Intel AX201, `iwlwifi`) | ⏳ | |
| Bluetooth | ⏳ | |
| Suspend / resume, lid close | ⏳ | check `cat /sys/power/mem_sleep` |
| Brightness keys | ⏳ | |
| Volume / mute / mic-mute keys + LEDs | ⏳ | |
| Other HP function keys | ⏳ | |
| Touchpad + gestures (3/4-finger) | ⏳ | |
| Webcam | ⏳ | privacy shutter? |
| Microphone / speakers / headphone jack | ⏳ | |
| External monitor USB-C / HDMI | ⏳ | |
| Docking station basics | ⏳ | |
| Fingerprint: USB ID from `lsusb` | ⏳ | look up in libfprint supported list |
| Fingerprint: enroll / login / lock screen / sudo | ⏳ | **do not mark ✅ until all four work** |
| Hardware video decode (`vainfo`, iHD driver) | ⏳ | |
| Firmware listed by `fwupdmgr get-devices` | ⏳ | |
| Idle battery draw, `powertop` (W) | ⏳ | screen 50%, Wi-Fi on, 5 min idle |
| Same measurement on Windows (W) | ⏳ | for comparison |
| Cold boot to desktop (`systemd-analyze`) | ⏳ | goal < 15 s |
| Idle RAM after 5 min (`free -m`) | ⏳ | goal < 1 GB |
