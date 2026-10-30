# Performance

Only numbers that were actually measured go here. Everything else is marked **not measured**.

## Measured for Orbit 1.0 (Ubuntu 24.04 remix; 2.0 is Debian-based and has not been built yet)
Build machine: cloud VM, 4 vCPU Xeon 2.8 GHz, no KVM.
| What | Result | How |
|---|---|---|
| Full ISO size | **6.46 GB** (6,463,322,112 bytes) | `out/orbit-os-1.0.0-full-amd64.iso`, first build, before the Orbit apps were added |
| Base Ubuntu ISO | 6.25 GB | `ubuntu-24.04.5.1-desktop-amd64.iso` |
| Full build time | about 35 min, plus about 3 min downloads | `./build.sh --host`; most of the time goes on squashfs xz compression |
| `.deb` build only | about 12 s | `./build.sh --debs-only` |
| Orbit packages | branding 3.4 MB · apps about 0.1 MB · extensions about 0.03 MB · desktop 0.02 MB | `out/*.deb` |
| Unit tests | 17 Python tests + 3 JS suites, under 1 s | `tests/test_orbit_apps.py`, `tests/*.test.mjs` |
| Desktop in headless GNOME Shell 46 | all 7 extensions enabled, 0 JS errors | `tests/shell/run-desktop-shots.sh`, see `report.json` |

## Not measured yet (needs real hardware: fill in from HARDWARE-TEST.md runs)
| Goal | Target | Result |
|---|---|---|
| Cold boot to desktop, EliteBook SSD | < 15 s (`systemd-analyze`) | not measured |
| Idle RAM after 5 min, desktop session | < 1 GB (`free -m`) | not measured |
| Idle CPU / GPU with blur vs. Reduce transparency | report both | not measured |
| Idle battery draw (powertop) | report W | not measured |
| Lite ISO size | < 3 GB | not built yet; dropping LibreOffice, Wine, Flatpak and the driver pool will not reach 3 GB (DECISIONS D-12) |

## Known performance notes
- **Blur radius:** Blur my Shell v76 uses blur "pipelines". Its default popup blur is sigma 30, above the ≤ 24 px goal, and the old `sigma=14` key in Orbit's dconf is only read for migration. Setting a pipeline from dconf is still to do.
- **Reduce transparency** turns Blur my Shell off entirely and makes the dock opaque.
- **Orbit Files** loads folders asynchronously (`Gtk.DirectoryList`). It decodes picture thumbnails one at a time in a background thread, newest request first, with an in-memory cache of up to 2,000 images.
- **Widgets:** the system widget reads `/proc` every 2 s at low priority. The clock ticks every second and the calendar every minute.
