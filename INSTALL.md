# Installing Orbit OS — a beginner's guide

Read each step to the end before you type anything. Lines in grey boxes are commands: copy them exactly. "Expected" shows what you should see. "If it fails" tells you what to do.

> **Golden rule:** until step 7, nothing touches your disks. Steps 1–6 only build, test and boot *live*.

---

## 1. What you need
- A USB stick of **8 GB or more**. Everything on it will be erased. The full image is about 4 GB.
- A computer to build on: any Linux with Docker or Podman, or a Debian 13 VM, with about **30 GB free disk** and an internet connection (all packages come from Debian's archive).
- The **i7-8700K desktop**, used as the first real test machine, and the **EliteBook 830 G7**.
- For step 7: an external drive for **backups**, and your Windows **BitLocker recovery key**. To find the key, sign in at https://account.microsoft.com/devices/recoverykey and write it down.

## 2. Build the ISO and check it
```bash
git clone https://github.com/qitzblue2/OrbitOS.git
```
```bash
cd OrbitOS
```
```bash
./build.sh
```
- To build on a Debian 13 machine or VM without Docker, run `sudo ./build.sh --host`.
- Aphelion: the build uses `out/aphelion_*.deb` if it is there, else builds it from the `Orbit-Apps` branch (needs Node.js), or set `ORBIT_APHELION_DEB=/path/to/aphelion_*.deb`.
- For the smaller image, run `ORBIT_VARIANT=lite ./build.sh`.

The build takes 30–90 minutes. **Expected** at the end:
```
[orbit] done: out/orbit-os-2.0.0-full-amd64.iso (4.0G)
<64 hex characters>  orbit-os-2.0.0-full-amd64.iso
```
Check the result:
```bash
cd out && sha256sum -c orbit-os-2.0.0-full-amd64.iso.sha256
```
**Expected:** `orbit-os-2.0.0-full-amd64.iso: OK`

**If it fails:**

| Message | What to do |
|---|---|
| `mmdebstrap` fails to download | snapshot.debian.org is busy or your connection dropped. Run the build again; downloaded packages are reused. |
| `missing tool: …` | Install the build tools: `sudo apt install` the list in `config/build.conf` (HOST_DEPS), or build in Docker. |
| `no space left on device` | Free up disk space (30 GB is needed). Run `sudo rm -rf work/` to remove old build files. |
| `need docker or podman` | Install Docker, or use `sudo ./build.sh --host` on a Debian 13 VM. |

## 3. Test it in a virtual machine first
Automatic test:
```bash
sudo apt install qemu-system-x86 ovmf socat
```
```bash
tests/vm-boot-test.sh out/orbit-os-2.0.0-full-amd64.iso
```
**Expected:** `[vm-test] PASS: desktop after …s`. Screenshots are saved in `tests/screenshots/<date>/`.

By hand, with VirtualBox:
1. Create a new VM: type Linux, Debian (64-bit), **at least 4 GB RAM (6–8 GB is better)**, 2+ CPUs, 25 GB disk, and tick **Enable EFI**. Under Display: Graphics Controller **VMSVGA**, Video Memory **128 MB**, **Enable 3D Acceleration off**. In the new-VM wizard, tick **Skip Unattended Installation** (or leave the ISO empty there and attach it later under Storage).
2. Attach the ISO and start the VM.
3. You should see the boot menu ("Try or Install Orbit OS"), then the boot splash, then the desktop. The first boot in a VM can sit on a black or dark screen for **2–5 minutes** while the live system unpacks; wait before resetting. The desktop has a pink, purple and blue wallpaper, a slim dock on the left, and the installer window.
4. Close the installer window to keep exploring in live mode.

**If it fails (black screen):** go through these in order.
1. Power off the VM and check the settings above: EFI on, VMSVGA, 128 MB, 3D **off**, 4+ GB RAM. VirtualBox's default *unattended install* also breaks live ISOs: if the wizard used it, make a new VM without it.
2. In the boot menu, choose **Orbit OS (safe graphics)**.
3. Still black? Choose **Orbit OS (verbose, safe graphics)**: it prints boot messages instead of the splash. Take a photo of the last lines and send it, so the cause can be fixed.
4. On Windows hosts, turn off Hyper-V/"Virtual Machine Platform" if VirtualBox shows a green turtle icon in the status bar: VirtualBox then runs very slowly and can look frozen.

## 4. Write the USB stick safely
> ⚠️ **Writing to the wrong device erases it.** Unplug every other USB drive first.

- **Easiest (any OS):** use **balenaEtcher**. Choose *Flash from file* → the ISO → *Select target* → your USB stick (check the size matches!) → *Flash*.
- **Windows:** use **Rufus**. Pick the stick, pick the ISO, partition scheme **GPT**, write in **DD mode** if Rufus asks.
- **Linux (`dd`):** find the stick first:
  ```bash
  lsblk -d -o NAME,SIZE,MODEL,TRAN
  ```
  The stick is the line with `TRAN` = `usb` and the right size, for example `sdb 14.9G SanDisk usb`. Then write the image, replacing `sdX` with that name:
  ```bash
  sudo dd if=out/orbit-os-2.0.0-full-amd64.iso of=/dev/sdX bs=4M status=progress oflag=sync
  ```
  Never use `nvme0n1` or `sda` unless you are **certain** it is the stick.

## 5. Boot the desktop PC (i7-8700K) in live mode
1. Plug in the USB stick and power on the PC.
2. Open the boot menu by pressing the right key at power-on. It is usually **F12**, **F11** or **F8**; on ASUS boards it is **F8**, on MSI **F11**, on Gigabyte **F12**.
3. Choose the entry for the USB stick that starts with **UEFI**.
4. You can leave **Secure Boot on**: Orbit OS boots through Debian's signed boot loader (shim, signed by Microsoft). With Secure Boot on, the boot menu is plain text instead of themed; that is normal. If you see "Verification failed", see Troubleshooting.
5. Choose **Try or Install Orbit OS**. When the installer window appears, click **Keep trying Orbit OS**, or just close the window.
6. Open a terminal (the Terminal icon in the dock) and run:
   ```bash
   /run/live/medium/tools/hardware-check.sh 2>/dev/null || curl -fsSLO https://raw.githubusercontent.com/qitzblue2/OrbitOS/main/tools/hardware-check.sh && bash hardware-check.sh
   ```
   **Expected:** sections with `[ OK ]`, `[WARN]` and `[FAIL]` lines. Copy the output into `HARDWARE-TEST.md` under "Desktop".

## 6. Test the EliteBook in live mode only
1. Boot the laptop from the stick: press **F9** at the HP logo (or **Esc**, then F9). Do *not* install anything.
2. Go through the checklist in `HARDWARE-TEST.md`: Wi-Fi, Bluetooth, sleep (close the lid, wait 30 s, open it), fingerprint, camera, the brightness, volume and mute keys, and the battery.
3. Run `hardware-check.sh` as in step 5.
4. For battery draw, unplug the charger, set the screen to 50%, leave the laptop idle for 5 minutes, then run:
   ```bash
   sudo powertop --time=60
   ```
   Write down the "discharge rate" figure.

> Fingerprint enrollment does not persist in live mode. To test it, enroll in Settings → Users → Fingerprint Login, then lock the screen (Super+L) and unlock with your finger.

## 7. Install
### 7a. Required first: back up
- Copy your files to an external drive, **then unplug that drive**.
- On Windows, run *Create a recovery drive* (it needs a separate USB stick).
- **If BitLocker is on, suspend it:** open Control Panel → BitLocker → **Suspend protection**. Without this, Windows will ask for the recovery key after installing, and dual boot can fail. Make sure you have the recovery key written down (see step 1).

### 7b. Start the installer
The **Install Orbit OS** window opens by itself in the live session (or click it in the app list). Nothing is written to any disk until the last screen.
1. **Welcome:** pick your language.
2. **Keyboard:** pick your layout and type in the test box to check it.
3. **Disk:** the installer looks at your disks (this takes a few seconds) and only offers what is safe for that disk:
   - **Install next to Windows:** drag the slider to choose how much space Orbit gets. Windows keeps its files. The installer refuses if Windows is encrypted with BitLocker or was not fully shut down (Fast Startup), and tells you what to do.
   - **Use the free space:** if you already shrank Windows yourself in *Disk Management* (or the disk has unused space), Orbit goes there and nothing else changes. Use this if BitLocker is on.
   - **Erase disk and install Orbit OS:** deletes everything on that disk.
   - **Encrypt Orbit OS** (recommended for the laptop): choose a security key of 8+ characters. You type it at every start. If you forget it, the data is gone.
4. **Account:** your name, username, computer name and password. Turn on *Sign in automatically* only on a computer nobody else uses.
5. **Time zone.**
6. **Ready to install:** read the summary. When a disk will be erased you must type `ERASE`. Then click **Install now**.
7. It takes 5–20 minutes. When it says **Orbit OS is installed**, click **Restart now** and remove the USB stick when the screen goes dark.

If the installer stops with an error, nothing after that step was changed. The full log is in `/var/log/orbit-installer.log`; send it along with a photo of the message.

## 8. First boot
1. Log in. The **Welcome** window opens. Pick **Glass**, **Graphite** or **Light** and enroll a fingerprint (only offered if the reader is supported).
2. Open **Software → Updates** and install everything. Reboot if asked.
3. Your folders live in **~/Home**: Desktop, Documents, Downloads, Pictures, Music, Videos, Projects, Spaces (Personal, Work, Study), Notes and Inbox.
4. Optional: in **Orbit Settings**, turn on **Sort Inbox automatically**. Files dropped in Inbox are moved by type every two minutes. To undo all moves, run `/usr/lib/orbit-os/orbit-inbox-sorter --undo`.
5. Press **Super** or **Super+Space** for the launcher: type an app name, a file name, a setting, or a sum like `12*7`.
6. Other shortcuts:

   | Keys | What it does |
   |---|---|
   | Super+V | Clipboard history |
   | Super+E | Files |
   | Shift+Super+S | Screenshot an area |
   | Super+Alt+1/2/3 | Switch Space |
   | Super+M | Notifications |

   The apps are described in [APPS.md](APPS.md).
7. Open **Hardware** and run the *Guided tests*. *Copy Report* gives you the table for `HARDWARE-TEST.md`.
8. Open **Backup**, plug in a USB drive and press *Back Up Now*. Do this before you rely on the laptop.

## 9. Update, rebuild and customize
- **Updates:** security updates install automatically. For everything else, use Software → Updates, or `sudo apt update && sudo apt upgrade`.
- **Change colors:** edit `branding/tokens.json`. A whole new theme is three values under `seed_themes` (ground, ink, accent). Then run:
  ```bash
  ./build.sh --debs-only
  ```
  ```bash
  sudo apt install ./out/orbit-*.deb
  ```
- **Your own startup logo:** save it as `branding/boot-logo/logo.png` (transparent, about 192 px) or `logo.svg`, then run `./build.sh`. On an installed system, no rebuild is needed:
  ```bash
  sudo orbit-set-boot-logo ~/Pictures/my-logo.png
  ```
  Then reboot. See `branding/boot-logo/README.md`.
- **Add apps to the image:** add the package names to `config/packages/desktop.list` (or `full.list`), then run `./build.sh` again. Names must exist in Debian 13: check at https://packages.debian.org/trixie/.

## 10. Recovery
- **Rescue shell:** boot the USB stick → Try Orbit OS → open a terminal. Your installed disk can be mounted from Files.
- **Restore GRUB** (for example, after Windows overwrote it). From the live session:
  ```bash
  sudo mount /dev/nvme0n1pX /mnt
  ```
  Replace `X` with your root partition; check with `lsblk -f`.
  ```bash
  sudo mount /dev/nvme0n1p1 /mnt/boot/efi
  ```
  ```bash
  for d in dev proc sys run; do sudo mount --bind /$d /mnt/$d; done
  ```
  ```bash
  sudo chroot /mnt grub-install && sudo chroot /mnt update-grub
  ```
  With encryption, unlock first: `sudo cryptsetup open /dev/nvme0n1pX orbit-root`, then mount `/dev/mapper/orbit-root` on /mnt, and the separate boot partition (`OrbitBoot` in `lsblk -f`) on /mnt/boot before the EFI partition.
- **Get back to Windows:** in the firmware boot menu (F9 on HP), choose **Windows Boot Manager**. To make Windows the default, change the boot order in the BIOS setup. To remove Orbit OS completely, boot a Windows recovery drive, delete the Linux partitions in Disk Management, and run `bcdedit /enum firmware` to remove the leftover "orbit" boot entry.

## 11. Troubleshooting
| Problem | Try this |
|---|---|
| Black screen after boot menu | At the boot menu, choose **safe graphics**. Or press `e`, add `nomodeset` after `quiet splash`, then F10. |
| No Wi-Fi | Run `rfkill list`. If it says *blocked*, press the airplane-mode key, or run `rfkill unblock all`. Then check `hardware-check.sh` → Network for the driver. |
| No sound | Settings → Sound → choose the right output. Run `wpctl status`. Make sure the system is updated (`sudo apt update && sudo apt upgrade`). |
| Suspend does not work or does not wake | Run `cat /sys/power/mem_sleep`. If `s2idle` misbehaves, update the BIOS through Software → Updates (fwupd). Report the result in HARDWARE-TEST.md. |
| Fingerprint not detected | Run `lsusb` and note the ID (e.g. `06cb:00f9`), then look it up at https://fprint.freedesktop.org/supported-devices.html. Unsupported means password only. Do not install random drivers. |
| "Verification failed" / Secure Boot error | Make sure you wrote the ISO in DD mode. If the problem persists, check the date and time in the BIOS. As a **last** resort, turn Secure Boot off temporarily, then report it. |
| GRUB does not list Windows | Run `sudo sed -i 's/^#\?GRUB_DISABLE_OS_PROBER=.*/GRUB_DISABLE_OS_PROBER=false/' /etc/default/grub`, then `sudo update-grub`. |
| Glass looks laggy | Orbit Settings → **Reduce transparency**. |
