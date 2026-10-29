#!/usr/bin/env python3
"""Add an 'Orbit OS (verbose, safe graphics)' entry after the safe-graphics one in a GRUB config."""
import re
import sys

path = sys.argv[1]
cfg = open(path).read()
m = re.search(r'menuentry "Orbit OS \(safe graphics\)".*?\n\}\n', cfg, re.S)
if not m:
    sys.exit(0)
entry = m.group(0).replace('Orbit OS (safe graphics)', 'Orbit OS (verbose, safe graphics)')
entry = entry.replace('quiet splash', 'systemd.show_status=1 plymouth.enable=0')
open(path, 'w').write(cfg[:m.end()] + entry + cfg[m.end():])
