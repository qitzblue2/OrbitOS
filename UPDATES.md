# Orbit OS updates

Orbit OS updates itself over the internet: Orbit's apps, desktop, theme and icons,
Aphelion, and Debian's security fixes. You only flash a USB stick once.

## How it works
1. You (or Claude) push a change to the `claude/sleepy-hopper-bb4tau` branch, or a new
   Aphelion version to `Orbit-Apps`.
2. The **Orbit updates** GitHub Action (`.github/workflows/orbit-updates.yml`) builds the
   Orbit packages with a higher version number (`2.0.0.<run>`), builds Aphelion, checks
   them, signs them with the Orbit key and publishes them on GitHub Pages:
   `https://qitzblue2.github.io/OrbitOS/apt/`. It also runs once a day.
3. Every Orbit system has that address and the Orbit public key (in `orbit-os-desktop`).
   It picks up the update:
   - automatically, the same day (unattended-upgrades), or
   - **Orbit Settings → Updates** / **Software → Updates**, or
   - in a terminal: `orbit-update`.

apt refuses anything not signed with the Orbit key, so nobody else can push updates.
The Orbit installer itself only runs from the USB stick; installer changes reach you on
the next ISO you make, and everything else arrives as an update.

## One-time setup (5 minutes)
1. Create the signing key, on your VPS or any Linux machine with the repo:
   ```bash
   cd ~/OrbitOS && git pull && tools/make-signing-key.sh
   ```
   It saves the public key to `config/keys/orbit-archive.asc` and prints the private key.
2. Put the private key in GitHub: repository **Settings → Secrets and variables → Actions
   → New repository secret**, name `ORBIT_SIGNING_KEY`, value: everything the script
   printed between the `===` lines. Keep an offline copy too.
3. Commit the public key:
   ```bash
   git add config/keys/orbit-archive.asc && git commit -m "Orbit update signing key" && git push
   ```
4. Turn on Pages: repository **Settings → Pages → Build and deployment → Source:
   GitHub Actions**.
5. The push in step 3 starts the first update build (tab **Actions**, about 10 minutes).

ISOs built after step 3 come with updates turned on.

## Systems installed before updates existed
Run once:
```bash
curl -fsSL https://qitzblue2.github.io/OrbitOS/setup.sh | sudo sh
```

## Orbit Core (branch Orbit-Scratch)
Orbit Core uses opm instead of apt. It will use the same server (an `opm upgrade`
that downloads signed `.opk` files) once Core boots; see `core/README.md`, stage 8.
