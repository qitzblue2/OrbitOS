# Orbit OS

A personal Linux remix **based on Ubuntu 24.04 LTS**. It has a calm GNOME 46 desktop with a frosted-glass look, preinstalled apps, a `~/Home` folder layout, a launcher on Super/Super+Space, and sane power and security defaults. It keeps Ubuntu's kernel, signed boot chain, installer and apt updates.

> Status: personal project. See **[What was tested](#what-was-tested)** before you trust any of it on real hardware.

![Orbit OS desktop: glass widgets, slim dock, frosted top bar](docs/screenshots/desktop-desktop.png)

The screenshot is real: GNOME Shell 46 running headless with the Orbit packages, captured by `tests/shell/run-desktop-shots.sh`.

## Orbit's own apps
**Files**, **Notes**, **Spaces**, **Screenshot**, **Store**, **Hardware** and **Backup**, plus the **Launcher**, **Control Center**, **Widgets** and **Clipboard** in the shell. See **[APPS.md](APPS.md)** for what each does, shortcuts and screenshots.

| | | |
|---|---|---|
| ![Files](docs/screenshots/app-files-pictures.png) | ![Notes](docs/screenshots/app-notes-preview.png) | ![Store](docs/screenshots/app-store-featured.png) |

## Quick start
```bash
./build.sh
```
This builds the full ISO in a clean `ubuntu:24.04` container. Use `sudo ./build.sh --host` on an Ubuntu 24.04 VM instead.
```bash
tests/run-checks.sh
```
These are the fast checks (no root, no VM needed).
```bash
tests/vm-boot-test.sh out/orbit-os-1.0.0-full-amd64.iso
```
This boots the ISO in QEMU and passes only if the desktop appears.

```bash
tests/shell/run-desktop-shots.sh docs/screenshots-new
```
This boots the Orbit desktop in headless GNOME Shell and screenshots it. The run also reports whether each extension loaded.

Then follow **[INSTALL.md](INSTALL.md)**. It is written for beginners and covers USB writing, live testing, dual boot, recovery and troubleshooting.

## Layout
```
build.sh                 one-command ISO build (verify → generate → debs → remaster → ISO + sha256)
config/                  build.conf (pins), package lists, chroot hooks, dconf defaults, keys, TLP profile
branding/tokens.json     every color/size/timing; generate.py turns it into GTK, Shell/GDM, Plymouth, GRUB,
                         terminal, Qt themes and 4K wallpapers, and checks contrast
icons/                   generate_icons.py (16 glyphs + folders + file types, Glass/Graphite/Light),
                         check_and_raster.py (safety, completeness, 16 px legibility, PNG sizes, contact sheet)
packages/                orbit-os-branding, orbit-os-desktop (meta-package), orbit-launcher (GNOME 46 extension),
                         orbit-apps (the seven GTK apps), orbit-shell-extensions (Control Center, Widgets, Clipboard)
skel/                    the ~/Home layout for new users
tests/                   run-checks.sh (fast), test_orbit_apps.py, *.test.mjs, gui/ (app screenshots),
                         shell/ (real GNOME Shell run), vm-boot-test.sh (ISO in QEMU)
tools/                   hardware-check.sh, merge-overlay-upper.py
```

## Convert an existing Ubuntu 24.04 install
```bash
./build.sh --debs-only
```
```bash
sudo apt install ./out/orbit-os-branding_*.deb ./out/orbit-launcher_*.deb ./out/orbit-apps_*.deb ./out/orbit-shell-extensions_*.deb ./out/orbit-os-desktop_*.deb
```
Log out and back in. The Firefox ESR deb and the snap seed changes are only applied by the ISO build.

## Styles
`orbit-style glass|graphite|light` (also in **Orbit Settings**) switches the icons, shell theme and wallpaper together. **Reduce transparency** replaces every glass surface with solid token colors. It turns on automatically when animations are off, high contrast is on, or the GPU is software-rendered.

## What was tested
See [HARDWARE-TEST.md](HARDWARE-TEST.md) and [PERFORMANCE.md](PERFORMANCE.md). In short, real hardware is **untested**, and so are suspend, fingerprint, battery and boot time. The docs say "untested" wherever nobody has checked.

## Honest limits
- This is an Ubuntu 24.04 LTS remix. Canonical's standard security support for noble's `main` packages runs until **April 2029**; `universe` packages get community or Ubuntu Pro support. Check https://ubuntu.com/about/release-cycle.
- There is no support or security team beyond Ubuntu's own updates.
- Windows programs do not run natively. Wine helps with some of them, but anti-cheat games and many DRM apps will not run.
- Hardware support depends on the exact chips in each machine. Only what is marked ✅ in HARDWARE-TEST.md has been checked.
- Battery life may be lower than Windows with HP's tuning until it is measured and tuned. The TLP profile is provided but not active.
- The installer is Ubuntu's own, unmodified, and still shows Ubuntu branding (see LICENSES.md).
- Choose **Extended selection** in the installer, or the Orbit customizations are not installed (DECISIONS D-03).

Docs: [APPS](APPS.md) · [DECISIONS](DECISIONS.md) · [INSTALL](INSTALL.md) · [HARDWARE-TEST](HARDWARE-TEST.md) · [PERFORMANCE](PERFORMANCE.md) · [SECURITY](SECURITY.md) · [LICENSES](LICENSES.md)
