# Decisions

Each entry lists what was chosen, why, and what it costs. When a choice in the brief was ambiguous, the safest default was picked and written down here.

## Orbit 2.0: own distribution on Debian 13, own installer

These replace the 1.0 entries about the Ubuntu remaster (D-01 to D-05, D-09 and anything else that names Ubuntu, casper, snaps or Ubuntu's installer). The 1.0 entries below are kept as history.

**D-30 Base: Debian 13 "trixie", bootstrapped, not remastered.** `build.sh` builds the system with `mmdebstrap` straight from Debian's signed archive, pinned to one date of snapshot.debian.org. No other distribution's ISO is downloaded or modified. Why Debian: it is the stable parent of Ubuntu without snaps, ads or a vendor installer, has security updates for years, and almost all of Orbit carries over. Cost: GNOME 48 instead of 46 (D-34), and Debian names some packages differently (all names checked against the trixie index).

**D-31 One system image for live and install.** The same `live/filesystem.squashfs` runs the live session (live-boot) and is copied to disk by the installer. Live-only parts (live-boot, live-config, the installer, its no-password rule, `/etc/live`) are purged from the copy by the installer. This keeps the image smaller and means what you try is exactly what you get.

**D-32 Installer written from scratch, with proven tools underneath.** `packages/orbit-installer` is Orbit's own: screens, disk planning, Windows detection, user setup and boot loader setup. Writing to disks goes through `sfdisk`, `ntfsresize`, `mkfs.*`, `cryptsetup`, `unsquashfs` and `grub-install`, the standard tools every installer uses, because re-implementing partition tables or file systems would only add ways to lose data.
- The disk planner (`plan.py`) is pure Python with exact sector numbers. It never touches a disk, so every layout is unit-tested.
- The window runs as the user. A root engine (`engine.py`, started through pkexec) re-probes the disks and re-plans from the user's choice; it never trusts partition numbers or commands from the window.
- Alongside Windows: shrink only NTFS that `ntfsresize` reports safe; refuse BitLocker, hibernated or Fast-Startup Windows; keep 20 GB free for Windows; never format the shared EFI partition; never write `EFI/BOOT/BOOTX64.EFI` on a disk shared with Windows.
- Erase needs the word `ERASE` typed. Secrets go over a pipe, never on a command line, and are masked in the log.

**D-33 Encryption: LUKS2 + argon2id, separate /boot.** GRUB cannot unlock LUKS2 with argon2id, so `/boot` (1 GB, ext4) stays outside; the root partition is encrypted. The key is asked by the initramfs at every start. No LVM: one root file system plus a swap file and zram are simpler to repair.

**D-34 GNOME 48 only.** Debian 13 ships GNOME 48.7. The Orbit extensions now declare `shell-version: ["48"]` and use `orientation` instead of the deprecated `vertical` on St.BoxLayout. Dash to Dock replaces Ubuntu Dock (same `dash-to-dock` settings keys). Blur my Shell comes from Debian (v67, GNOME 48); the vendored GNOME 46 copy is gone. Not yet run on GNOME 48 here: `tests/shell/run-desktop-shots.sh` needs a Debian 13 host.

**D-35 Boot: Debian's signed chain, Orbit's menu.** The ISO (`tools/make-iso.sh`) boots GRUB for BIOS (El Torito + hybrid MBR) and, for UEFI, Debian's shim (signed by Microsoft) loading Debian's signed GRUB, which finds the medium by `/.disk/info`. Tested in QEMU with Debian 13's real binaries: BIOS DVD/USB, UEFI DVD/USB and UEFI with Secure Boot (Microsoft keys) all reach the kernel. Under Secure Boot, GRUB's lockdown blocks custom fonts, so the menu is plain text there; without Secure Boot it shows the Orbit theme.

**D-36 Aphelion is the default browser; Firefox is not shipped.** The build takes `aphelion_*.deb` from `ORBIT_APHELION_DEB`, `out/`, or builds it from the `Orbit-Apps` branch. Links open in Aphelion (`/etc/xdg/mimeapps.list`, `x-www-browser`). Firefox ESR stays one click away in Orbit Store.

**D-37 Swap: swap file (1 to 4 GB) plus zram.** The installer makes `/swapfile`; `systemd-zram-generator` adds compressed RAM swap (half of RAM, at most 8 GB). Hibernation is not supported.

**D-38 Installer language.** The language you pick sets the system language and suggests a keyboard and time zone. The installer's own screens are English only for now (no translations shipped yet).

## Build and base (1.0, Ubuntu remaster: history)

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

## Orbit apps and shell extensions

**D-17 The apps are Python + GTK 4 + libadwaita 1.5,** exactly the versions Ubuntu 24.04 ships (`python3-gi`, `gir1.2-adw-1`), so nothing extra comes in from outside the archive. They follow GNOME's patterns, so keyboard access, Orca and large text work the same way as in GNOME's own apps. Each app keeps its logic separate from its window code (`orbit/fileops.py`, `notes.py`, `spaces.py`, `backup.py`, `catalog.py`, `hardware.py`, `annotate.py`), so the logic is unit-tested without a display.

**D-18 Orbit Files becomes the default file manager, and GNOME Files stays installed.** Orbit Files is set as the default for folders (`/etc/xdg/mimeapps.list`) and is in the dock. Nautilus remains because the desktop-icons extension and some portals use it. Nautilus also gets the same *Move to Space* and *Sort Inbox Now* items through `nautilus-python`, so whichever file manager you use behaves the same.

**D-19 The Store is catalog-locked.**
- Ubuntu packages are installed by `/usr/lib/orbit-os/orbit-store-helper` through `pkexec`, under the polkit action `org.orbit-os.store.helper` (admin password, kept briefly).
- The helper re-reads `/usr/share/orbit-os/store-catalog.json` and refuses any package that is not listed in it. A compromised user session therefore cannot use the Store to install arbitrary packages.
- Flathub installs are per-user (`--user`) and need no password.
- Every apt name in the catalog was checked against the Ubuntu 24.04 archive.

**D-20 Clipboard privacy.**
- Copies marked with `x-kde-passwordManagerHint` (set by KeePassXC and others) are never recorded.
- Nothing is recorded while the screen is locked.
- Only pinned items are written to disk, in a `0600` file. Unpinned history lives in memory unless *remember across sessions* is turned on.

**D-21 Widgets live in the background layer, and weather is opt-in.** The widgets sit in `Main.layoutManager._backgroundGroup`: above the wallpaper, below every window, never in the way. Weather is the only Orbit feature that contacts a server after boot (Open-Meteo, every 30 min, location rounded to 2 decimals), so it is off by default.

**D-22 How the shell theme is applied (bugs found by running real GNOME Shell).** Three bugs were found by `tests/shell/run-desktop-shots.sh` and fixed:
- GNOME 46 no longer has `gnome-shell.css`; it ships `-dark` and `-light` variants.
- The `user-theme` extension already loads the stock theme underneath ours, so `@import`-ing it again re-added every stock rule after Orbit's, and the stock copies won.
- A `stage …` descendant prefix matches nothing in St, so it silently disabled every rule it was added to.

The generated shell CSS is therefore plain override rules with no `@import`. Blur my Shell is set to `popup/preserve-shell-theme=true`, because its popup style otherwise forces GNOME-blue toggles with `!important`.

**D-23 libadwaita apps get Orbit colors through `~/.config/gtk-4.0/gtk.css`.** libadwaita ignores the `gtk-theme` setting, so the theme name alone only reached GTK 3 apps. The skel file imports the generated Orbit GTK 4 sheet.
- `orbit-style` rewrites that file, but only while it still carries the `orbit-managed` marker, so your own edits are never overwritten.
- Converted Ubuntu installs get the file at first login.

**D-24 Keyboard shortcuts.**
- Super+V opens Orbit Clipboard. GNOME's notification list keeps its other default key, Super+M.
- New bindings, all standard GNOME custom keybindings that you can change in Settings → Keyboard:
  - Shift+Super+S: screenshot an area
  - Super+E: Files
  - Super+Alt+1/2/3: switch Space

**D-25 Blur my Shell is vendored.** Ubuntu 24.04 has no package for it, so `config/vendor/` holds the extensions.gnome.org build for GNOME 46 (v76, GPL-3.0) with its SHA-256. The build verifies the hash before installing it.
