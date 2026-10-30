# Orbit Core: Orbit OS built from source

Branch `Orbit-Scratch`. Orbit uses the **Linux kernel** and nothing from any other
distribution: no Debian, no Ubuntu, no Arch. Every program is compiled from its
original source code with Orbit's own tools, packaged in Orbit's own format, and managed
by Orbit's own package manager. This is how Arch, Gentoo and Linux From Scratch started.

The Debian-based Orbit 2.0 (`build.sh`, `config/`) stays in this branch untouched, as the
version you can use today. `core/` is the from-scratch Orbit.

## Pieces
| | |
|---|---|
| `core/opm/opm` | **opm**, the Orbit package manager. A package (`.opk`) is an xz tar plus `.ORBIT/meta.json` with every file's SHA-256. Install, upgrade, remove, list, verify, owns. Refuses file conflicts, missing dependencies, damaged or unsafe packages. Python standard library only. |
| `core/forge/forge` | **forge**, the builder. Reads recipes, downloads and checks sources (SHA-256), builds in dependency order with a clean environment, packs each result as an `.opk` and installs it with opm. |
| `core/recipes/<name>/recipe` | One bash file per program: name, version, stage, sources, checksums, dependencies, `build()`. |
| target triplet | `x86_64-orbit-linux-gnu`: Orbit's own toolchain name. |

```bash
python3 core/forge/forge check          # validate every recipe
python3 core/forge/forge list           # what exists and what is built
python3 core/forge/forge stage cross    # build stage 1 (about 1 hour on 4 cores)
```
Output goes to `work/orbit` (the new system tree), `work/opk` (packages), `work/logs`.

## Roadmap
Each stage only uses what the stage before it built, so in the end nothing from the
build machine is left in Orbit.

| Stage | What | Status |
|---|---|---|
| 1. cross | Orbit's own cross toolchain: binutils, GCC (C/C++), Linux API headers, glibc, libstdc++ | **built and checked** (about 42 min on 4 cores): `x86_64-orbit-linux-gnu-gcc` 15.3.0 compiles and links against Orbit's glibc 2.44 |
| 2. temp | temporary tools cross-compiled with it: m4, ncurses, bash, coreutils, diffutils, file, findutils, gawk, grep, gzip, make, patch, sed, tar, xz, binutils/GCC pass 2 | **built** (about 45 min): 17 tools; inside the tree Orbit's own gcc compiles and runs programs |
| 3. system | inside the new tree (chroot), with only Orbit's own tools. 3a (tools the rest needs: gettext, bison, Perl, Python, Texinfo, util-linux) **built**. 3b "base", the final system (about 80 programs): **built so far:** zlib, bzip2, xz, zstd, file, readline, m4, bc, flex, and the final toolchain: binutils 2.47, GMP, MPFR, MPC, gawk, attr, acl, libcap, libxcrypt, pkgconf and **GCC 15.3 built by Orbit inside Orbit** (C and C++ programs compile and run; PIE by default). then the final shell and core utilities (bash, coreutils, ncurses, grep, sed, tar, gzip, diffutils, findutils, make, patch). Next: the remaining tools (gettext, Perl, Python, Texinfo, util-linux finals), OpenSSL, then systemd, … | in progress |
| 4. boot | Linux kernel with Orbit's config, initramfs, GRUB from source, Orbit boot menu, a bootable ISO (reuse `tools/make-iso.sh`) | to do |
| 5. graphics | Mesa, Wayland, libinput, fonts, GTK 4, libadwaita | to do |
| 6. desktop | GNOME Shell + the Orbit extensions, theme, icons, Orbit apps, Orbit installer (adapted to opm) | to do |
| 7. apps | Aphelion (Electron needs Chromium's toolchain: the heaviest single item), NetworkManager, PipeWire, CUPS, … | to do |
| 8. updates | an Orbit package server: forge builds signed `.opk` files, opm downloads and verifies them | to do |

Honest size: a desktop like Orbit 2.0 is roughly 500–700 source packages. That is weeks of
recipe work and many hours of compiling per full build. Secure Boot needs a key signed by
Microsoft, which a from-source system does not have, so Orbit Core will boot with Secure
Boot **off** (or with your own enrolled key) until that is solved.
