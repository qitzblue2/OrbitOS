#!/usr/bin/env python3
"""Package checks: required files present, nothing secret or setuid shipped."""
import pathlib, subprocess, sys

out = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "out")
need = {
    "orbit-os-branding": ["./usr/share/icons/orbit/index.theme", "./usr/share/backgrounds/orbit/orbit-glass.png",
                          "./usr/share/plymouth/themes/orbit/orbit.plymouth", "./usr/share/grub/themes/orbit/theme.txt",
                          "./usr/lib/orbit-os/os-release", "./usr/share/themes/Orbit-graphite/gtk-4.0/gtk.css",
                          "./usr/share/orbit-os/tokens.json", "./usr/share/icons/orbit/scalable/apps/orbit-files.svg",
                          "./usr/share/icons/orbit/symbolic/actions/orbit-tool-crop-symbolic.svg"],
    "orbit-launcher": ["./usr/share/gnome-shell/extensions/orbit-launcher@orbit-os/extension.js"],
    "orbit-apps": ["./usr/bin/orbit-files", "./usr/bin/orbit-notes", "./usr/bin/orbit-spaces", "./usr/bin/orbit-screenshot",
                   "./usr/bin/orbit-store", "./usr/bin/orbit-hardware", "./usr/bin/orbit-backup",
                   "./usr/bin/orbit-optimizer", "./usr/bin/orbit-performance", "./usr/lib/orbit-os/orbit-tune-helper",
                   "./usr/bin/orbit-games", "./usr/lib/orbit-os/orbit-games-helper",
                   "./usr/share/polkit-1/actions/org.orbit-os.tune.policy",
                   "./usr/lib/orbit-os/python/orbit/files.py", "./usr/lib/orbit-os/orbit-store-helper",
                   "./usr/share/orbit-os/store-catalog.json", "./usr/share/polkit-1/actions/org.orbit-os.store.policy",
                   "./usr/share/applications/orbit-files.desktop", "./etc/xdg/mimeapps.list"],
    "orbit-shell-extensions": ["./usr/share/gnome-shell/extensions/orbit-control-center@orbit-os/extension.js",
                               "./usr/share/gnome-shell/extensions/orbit-widgets@orbit-os/schemas/gschemas.compiled",
                               "./usr/share/gnome-shell/extensions/orbit-clipboard@orbit-os/extension.js"],
    "orbit-os-desktop": ["./etc/dconf/db/local.d/00-orbit", "./etc/skel/Home/Inbox/.keep",
                         "./etc/skel/.config/user-dirs.dirs", "./etc/apt/apt.conf.d/52orbit-unattended",
                         "./etc/skel/.config/gtk-4.0/gtk.css", "./usr/bin/orbit-hardware-check",
                         "./usr/share/glib-2.0/schemas/org.orbit-os.desktop.gschema.xml", "./usr/bin/orbit-update"],
    "orbit-installer": ["./usr/bin/orbit-installer", "./usr/lib/orbit-installer/orbit-install-engine",
                        "./usr/lib/orbit-installer/python/orbit_installer/engine.py",
                        "./usr/lib/orbit-installer/python/orbit_installer/plan.py",
                        "./usr/share/polkit-1/actions/org.orbitos.installer.policy",
                        "./usr/share/polkit-1/rules.d/49-orbit-installer-live.rules",
                        "./usr/share/applications/orbit-installer.desktop", "./etc/xdg/autostart/orbit-installer.desktop"],
}
bad = 0
for pkg, files in need.items():
    deb = next(out.glob(f"{pkg}_*_all.deb"), None)
    if not deb:
        print(f"FAIL missing {pkg} deb"); bad = 1; continue
    listing = subprocess.run(["dpkg-deb", "-c", str(deb)], capture_output=True, text=True, check=True).stdout
    names = {l.split()[5] for l in listing.splitlines()}
    for f in files:
        if f not in names:
            print(f"FAIL {pkg}: {f} not packaged"); bad = 1
    for l in listing.splitlines():
        perms, name = l.split()[0], l.split()[5]
        if "__pycache__" in name or name.endswith(".pyc"):
            print(f"FAIL {pkg}: compiled bytecode shipped: {name}"); bad = 1
        if perms[3] in "sS" or perms[6] in "sS":
            print(f"FAIL {pkg}: setuid/setgid file {name}"); bad = 1
        if any(k in name for k in ("id_rsa", ".pem", "shadow", "authorized_keys", ".netrc")):
            print(f"FAIL {pkg}: secret-looking file {name}"); bad = 1
    print(f"ok {deb.name}: {len(names)} entries")
sys.exit(bad)
