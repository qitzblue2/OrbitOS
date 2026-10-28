#!/usr/bin/env python3
"""Package checks: required files present, nothing secret or setuid shipped."""
import pathlib, subprocess, sys

out = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "out")
need = {
    "orbit-os-branding": ["./usr/share/icons/orbit/index.theme", "./usr/share/backgrounds/orbit/orbit-glass.png",
                          "./usr/share/plymouth/themes/orbit/orbit.plymouth", "./usr/share/grub/themes/orbit/theme.txt",
                          "./usr/lib/orbit-os/os-release", "./usr/share/themes/Orbit-graphite/gtk-4.0/gtk.css"],
    "orbit-launcher": ["./usr/share/gnome-shell/extensions/orbit-launcher@orbit-os/extension.js"],
    "orbit-os-desktop": ["./etc/dconf/db/local.d/00-orbit", "./etc/skel/Home/Inbox/.keep",
                         "./etc/skel/.config/user-dirs.dirs", "./etc/firefox/policies/policies.json",
                         "./usr/share/glib-2.0/schemas/org.orbit-os.desktop.gschema.xml"],
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
        if "s" in perms[1:10].replace("-", ""):
            print(f"FAIL {pkg}: setuid/setgid file {name}"); bad = 1
        if any(k in name for k in ("id_rsa", ".pem", "shadow", "authorized_keys", ".netrc")):
            print(f"FAIL {pkg}: secret-looking file {name}"); bad = 1
    print(f"ok {deb.name}: {len(names)} entries")
sys.exit(bad)
