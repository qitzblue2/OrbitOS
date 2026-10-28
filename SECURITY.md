# Security

## Defaults
- **Firewall:** ufw is on. Incoming traffic is denied, outgoing is allowed, and no ports are open.
- **Remote login:** `openssh-server` is purged and ssh is disabled.
- **Accounts:** root is locked (`passwd -l root`) and nothing has a default password. The live session user has no password, which is Ubuntu's standard live behavior, and nothing listens on the network.
- **Updates:** unattended-upgrades installs packages from Ubuntu's `noble-security` pocket daily, with no automatic reboot.
- **Disk encryption:** full-disk encryption (LUKS) is offered by the installer under *Advanced features → Use LVM and encryption*.
- **No telemetry:** ubuntu-report, popularity-contest, apport, whoopsie and kerneloops are removed, and Firefox telemetry is disabled by policy.
- **No hidden network calls at boot:** the NetworkManager connectivity check and motd-news are disabled, the fwupd refresh timer is off, and snap auto-refresh is held.

  What still goes on the network, and when:
  - apt list refresh and security updates, daily, through `apt-daily.timer`
  - the Firefox uBlock Origin install, on first browser start
  - Flathub and the Software app, when the user opens them

## Package sources (every repository)
| Repository | Signed by | Why |
|---|---|---|
| `archive.ubuntu.com` / `security.ubuntu.com` noble, noble-updates, noble-security (main, restricted, universe, multiverse) | Ubuntu archive key | base system |
| `packages.mozilla.org/apt` (`firefox-esr` only, pinned by origin) | Mozilla key `35BAA0B33E9EB396F59CA838C0BA5CE6DC6315A3` | Firefox as a .deb |
| Flathub (full image only, optional) | Flathub GPG key | sandboxed apps |

The build uses `snapshot.ubuntu.com` to pin versions. The installed system uses the live archive.

## Build integrity
1. `SHA256SUMS.gpg` is verified with `gpgv` against the Ubuntu CD Image key, fingerprint `843938DF228D22F7B3742BC0D94AA3F0EFE21092` (pinned in `config/build.conf`).
2. The ISO is checked against the signed `SHA256SUMS` and against a SHA-256 pinned in the repo.
3. The output ISO gets a `.sha256` file.
4. `tests/check_debs.py` rejects setuid files and secret-looking files in the Orbit packages.
5. `icons/check_and_raster.py` rejects SVGs that contain scripts, event handlers, external references, embedded raster images or filters.

The build is not yet bit-for-bit reproducible: squashfs and ISO timestamps vary between runs. Setting `SOURCE_DATE_EPOCH` and adding `-mkfs-time`/`-all-time` to mksquashfs is the next step.

## Reporting
This is a personal project: there is no security team. Security fixes for the base system come from Ubuntu. Report Orbit-specific problems as issues on the repository.
