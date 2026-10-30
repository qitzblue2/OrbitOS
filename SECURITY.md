# Security

## Defaults
- **Firewall:** ufw is on. Incoming traffic is denied, outgoing is allowed, and no ports are open.
- **Remote login:** `openssh-server` is purged and ssh is disabled.
- **Accounts:** root is locked (`passwd -l root`) and nothing has a default password. The live session user `orbit` has no password (standard for live media), and nothing listens on the network. The live-only parts (that user's settings, the installer and its no-password rule) are removed from installed systems by the installer.
- **Updates:** unattended-upgrades installs updates from Debian's `trixie-security` archive and Debian point releases daily, with no automatic reboot.
- **Disk encryption:** the Orbit installer offers full-disk encryption (LUKS2, argon2id key derivation) for every install type. `/boot` stays outside the encrypted part because GRUB cannot read LUKS2 with argon2id; the kernel and initrd there are not secret.
- **No telemetry:** Debian ships none by default; Orbit adds none. popularity-contest is not installed. Aphelion sends nothing.
- **No hidden network calls at boot:** the NetworkManager connectivity check and motd-news are disabled, and the fwupd refresh timer is off. There are no snaps.

  What still goes on the network, and when:
  - apt list refresh and security updates, daily, through `apt-daily.timer`
  - Aphelion's filter-list update, only when you press *Update now* in its settings
  - Flathub and the Software app, when the user opens them

## Package sources (every repository)
| Repository | Signed by | Why |
|---|---|---|
| `deb.debian.org` trixie, trixie-updates and `security.debian.org` trixie-security (main, contrib, non-free-firmware) | Debian archive keys (`debian-archive-keyring`) | the whole system |
| Flathub (full image only, optional) | Flathub GPG key | sandboxed apps |

The build uses `snapshot.debian.org` (date pinned in `config/build.conf`) so every build gets the same versions; mmdebstrap checks every package against Debian's archive keys. The installed system uses the live archive.

## Build integrity
1. No third-party ISO is used: the system is bootstrapped from Debian's signed archive (`debian-archive-keyring`).
2. Secure Boot: the ISO and installed systems boot Debian's shim (signed by Microsoft) and GRUB and kernels signed by Debian. Orbit does not sign anything itself.
3. The output ISO gets a `.sha256` file.
4. `tests/check_debs.py` rejects setuid files and secret-looking files in the Orbit packages.
5. `icons/check_and_raster.py` rejects SVGs that contain scripts, event handlers, external references, embedded raster images or filters.

The build is not yet bit-for-bit reproducible: squashfs and ISO timestamps vary between runs. Setting `SOURCE_DATE_EPOCH` and adding `-mkfs-time`/`-all-time` to mksquashfs is the next step.

## Reporting
This is a personal project: there is no security team. Security fixes for the base system come from Debian. Report Orbit-specific problems as issues on the repository.

## Orbit apps
- **Orbit Store:** apt installs go through `pkexec /usr/lib/orbit-os/orbit-store-helper`, which:
  - only accepts packages listed in the shipped catalog;
  - validates package names;
  - passes them after `--`;
  - runs apt with a fixed environment.

  The polkit action is `org.orbit-os.store.helper` and asks for the admin password. Flathub installs are per-user.
- **Orbit Clipboard:** password-manager copies are skipped, nothing is recorded while the screen is locked, and only pinned items are stored on disk (mode 0600).
- **Orbit Widgets:** weather is off by default. When on, it sends a rounded location to `api.open-meteo.com` every 30 minutes, with no key and no account.
- **Orbit Files:** extracting an archive refuses entries that would write outside the target folder (zip-slip). tar archives use Python's `filter="data"`, which blocks links, devices and absolute paths.
- **Orbit Backup:** restores never delete anything; files that would be replaced are kept as `*.before-restore`. A backup destination inside the folders being backed up is refused.
- **GNOME extension updates:** GNOME Shell checks extensions.gnome.org for updates only for extensions *you* install in `~/.local/share/gnome-shell/extensions`. Orbit's are system-wide and are updated through its packages.
