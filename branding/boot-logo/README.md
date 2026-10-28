# Your boot logo

Put your own startup logo here as **`logo.png`** (or **`logo.svg`**). The next `./build.sh` puts it on the boot splash of the live USB and the installed system. If neither file exists, the Orbit launcher glyph is used.

- Use a transparent background. The splash background color comes from `canvas` in `branding/tokens.json`.
- Size: about 128–256 px square. SVGs are rendered at 192 px.
- The logo fades in and out gently: only its opacity changes.

To change the logo on an already installed system, with no rebuild:
```bash
sudo orbit-set-boot-logo ~/Pictures/my-logo.png
```
Then reboot.
