# Decisions

Each entry lists what was chosen, why, and what it costs. When a choice in the brief was ambiguous, the safest default was picked and written down here.

## Build and base

**D-01 Remaster the official ISO with a script, not Cubic.** `build.sh` is non-interactive and reproducible, and it can run in CI. Cubic is a GUI tool, so its steps cannot be reviewed in git.

**D-02 Base: `ubuntu-24.04.5.1-desktop-amd64.iso`.** This was the newest 24.04 desktop point release on releases.ubuntu.com at build time. It already ships the HWE kernel, which suits the 11th-gen Intel laptop. Ubuntu's kernel, shim, GRUB and signed EFI binaries are not touched (D-05).

**D-03 Edit the stacked squashfs layers in place.** 24.04 ships `minimal`, `minimal.standard` and `minimal.standard.live`:
- `minimal.standard` is the installed system plus the live system. All Orbit changes go here.
- `minimal.standard.live` holds the live-session-only parts, such as the installer. Only the installer gate (D-09) goes here.

Each layer is changed through an overlayfs mount and a chroot. `tools/merge-overlay-upper.py` then folds the overlay's upper dir back into that layer, keeping whiteouts and opaque dirs correct. `tests/test_merge_overlay.sh` tests this.

The ISO also has per-language layers (`minimal.en.squashfs`, `minimal.standard.de.squashfs`, and others). They only add translations and are left untouched. A file Orbit changes is never shadowed by them, because they contain only locale data.

Cost: the installer's "Default selection" (minimal only) does **not** get the Orbit customizations. Choose **"Extended selection"** in the installer. INSTALL.md says so.

**D-04 Pinning.** The ISO is checked in three ways:
- `SHA256SUMS` must carry a valid GPG signature from the pinned Ubuntu CD key (`843938DF…E21092`).
- The ISO must match its line in `SHA256SUMS`.
- The ISO must also match the SHA-256 pinned in `config/build.conf`.

apt runs with `--snapshot $ORBIT_SNAPSHOT` (snapshot.ubuntu.com), and the build refuses to continue if the snapshot service is unreachable. Mozilla's repo has no snapshot service, so `firefox-esr` is the one unpinned package. Its version is recorded in `casper/minimal.standard.manifest`.

**D-05 Secure Boot: the boot records are replayed, not rebuilt.** `xorriso -report_el_torito as_mkisofs` reads the original ISO's El Torito, EFI and MBR layout, and the output ISO is written with the same layout. Ubuntu's signed shim, GRUB and kernel are reused byte for byte. Only `grub.cfg` menu text changes, and that file is not signed. The GRUB *theme* is applied on installed systems only (`orbit-os-branding` postinst), not on the ISO menu.

## Desktop

**D-06 GNOME 46 customized, not forked.** The customization uses:
- dconf defaults in `/etc/dconf/db/local.d/00-orbit` (nothing locked)
- generated GTK 3/4 color sheets
- a shell theme loaded through the `user-theme` extension from `gnome-shell-extensions`
- Ubuntu Dock configured as a slim left sidebar
- Blur my Shell
- the Orbit Launcher extension

Upstream security updates keep applying, and nothing has to be rebased.

**D-07 Blur my Shell.** The build installs the archive package when it exists for noble. Otherwise it uses a vendored zip from `config/vendor/`, checked by SHA-256. If neither is available, the build continues without blur, glass surfaces fall back to solid, and the log prints a WARNING. The meta-package only *Recommends* it, so a missing package never blocks installation.

**D-08 The launcher is a GNOME Shell extension (GJS), pinned to `shell-version: ["46"]`.** A separate GTK 4 app would need a global hotkey, which Wayland does not give ordinary apps. It would also pay a process start-up delay on every key press. The extension does three things:
- It binds `Super+Space`.
- When `replace-overview-key` is on (the default), it wraps `Main.overview.toggle`, so a tap of Super opens the launcher. `Super+A` (app grid) and the dock still reach the overview.
- File search is a bounded walk: depth 3, at most 400 entries, under `~/Home`. It does not depend on the Tracker indexer.

Calculations use a small parser with no `eval`. `tests/calc.test.mjs` covers it.

**D-09 Installer: Ubuntu's own `ubuntu-desktop-bootstrap` (Flutter) snap, unmodified.** Changing the snap would break its signature.
- Branding of the installer itself is therefore **not done**: it still says "Ubuntu" in places. This is a known trademark limitation, see LICENSES.md.
- The installer already shows a review page listing every disk change and needs an explicit click. On top of that, the live layer routes every installer launcher through `orbit-install-gate`, which requires typing `I HAVE A BACKUP`.
- No autoinstall file is shipped. Storage choices stay interactive, LUKS (full-disk encryption) stays offered, and "Try Orbit OS" stays available.

**D-10 Three styles: Glass (default), Graphite, Light.** `orbit-style` switches the icon theme, GTK and shell theme, and wallpaper together. Both Glass and Graphite use the dark Graphite GTK theme, because glass applies to the shell and icons, not to app windows. "Reduce transparency" disables Blur my Shell and makes the dock opaque. It switches on automatically at login in four cases:
- animations are disabled (GNOME's reduce-motion setting)
- high contrast is on
- GL is software-rendered (`llvmpipe`)
- the user turns it on

GNOME 46 has no separate reduce-transparency key.

**D-11 Folder layout under `~/Home`.** `user-dirs.dirs` points the XDG folders at `~/Home/*`, and `user-dirs.conf` disables automatic renaming. Folder icons are set through GIO metadata at first login, because Nautilus ignores `.directory` files. Spaces are bookmarks in the sidebar, with tinted folder icons.

## Apps (each from Ubuntu's archive unless noted)

| App | Package | Why |
|---|---|---|
| Browser | `firefox-esr` from Mozilla's signed APT repo | Ubuntu's `firefox` is a snap. ESR changes less often. Policies turn off telemetry, studies and Pocket, keep a clean new tab, and force-install uBlock Origin from addons.mozilla.org on first browser start. This network call is made by the browser, not at boot. The snap seed entry for Firefox is removed. |
| Files, Terminal, Text editor | nautilus, gnome-terminal, gnome-text-editor | GNOME defaults, maintained in main. |
| Image viewer | loupe (eog kept if present) | GTK 4 and fast |
| PDF | evince | default |
| Media | totem | default. Showtime needs GNOME 48+. |
| Screenshot | built into GNOME Shell 46 (PrtSc) | no extra package needed |
| Calculator, System monitor, Archives, Disks | gnome-calculator, gnome-system-monitor, file-roller, gnome-disk-utility | defaults |
| Passwords | keepassxc | offline, audited, no account |
| Notes | apostrophe | edits plain Markdown in `~/Home/Notes` |
| Calendar / tasks | gnome-calendar, endeavour (formerly GNOME To Do) | local-first |
| Updates | gnome-software + fwupd plugin, flatpak plugin (full image only) | one place for apt, Flatpak and firmware updates. The snap-store seed is removed, so the snap store stays out of the way. |
| Office | libreoffice-writer/calc/impress (**full only**) | the largest component, so the lite image leaves it out |
| Windows apps | wine64 (**full only**). Bottles comes from Flathub, on demand. | Bottles has no maintained deb in noble |

**D-12 Lite vs full.** Lite leaves out LibreOffice, Flatpak/Flathub and Wine, and drops the ISO's offline restricted-driver pool. The < 3 GB goal is **not reachable** this way: see PERFORMANCE.md for the measured size. Getting under 3 GB would need dropping the `standard` layer or the live layer's language packs, which is not done yet.

## Hardware and services

**D-13 Fingerprint.** `fprintd` and `libpam-fprintd` are installed, and the postinst runs `pam-auth-update --enable fprintd`. GNOME uses this for login and screen lock, and `sudo` uses it through `common-auth`. A password always works too. The welcome app only offers enrollment when `fprintd` sees a device.

**D-14 Services.** These changes are made against stock Ubuntu.

Removed or disabled:

| Item | Change | Reason |
|---|---|---|
| ubuntu-report, popularity-contest, apport, whoopsie, kerneloops | purged | telemetry and crash upload |
| ubuntu-advantage | masked | Pro nag and network call |
| motd-news | disabled | network call |
| NetworkManager connectivity check | disabled | network call at boot |
| `fwupd-refresh.timer` | disabled | metadata is refreshed when the user opens Software |
| snap auto-refresh | held through `orbit-snap-hold.service` | updates stay user-initiated |
| ssh | disabled, openssh-server purged | no remote login by default |
| root account | locked | no root login |

Enabled, beyond Ubuntu's defaults:
- ufw (deny incoming)
- unattended-upgrades (security pocket only)
- thermald
- power-profiles-daemon
- bluetooth
- fprintd (D-Bus activated)

Every other unit is Ubuntu's default. The full list on a booted system comes from `systemctl list-unit-files --state=enabled`, recorded in PERFORMANCE.md.

**D-15 power-profiles-daemon, not TLP.** PPD is Ubuntu's default, is wired into GNOME's power menu, and conflicts with TLP. An EliteBook-tuned TLP profile, with charge thresholds of 75/90, ships in `/usr/share/orbit-os/tlp/orbit.conf` with one-line switch instructions. It is not active.

**D-16 os-release.** `/usr/lib/os-release` is moved aside with `dpkg-divert`, not overwritten. The new file uses `ID=orbit`, `ID_LIKE="ubuntu debian"` and `UBUNTU_CODENAME=noble`, so tools that look for Ubuntu still work through `ID_LIKE`. Removing the package restores Ubuntu's file.
