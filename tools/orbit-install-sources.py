#!/usr/bin/env python3
"""Rewrite casper/install-sources.yaml so the installer offers one source: Orbit OS.

Ubuntu's file offers 'minimal' (minimal.squashfs, untouched by Orbit) as the
default and 'full' (minimal.standard.squashfs, where Orbit lives) as the
second choice, with sizes for Ubuntu's own layers. Keep only the Orbit entry,
make it the default and give it the real installed size.

usage: orbit-install-sources.py INSTALL-SOURCES.YAML SIZE_BYTES VERSION
"""
import sys

import yaml

path, size, version = sys.argv[1], int(sys.argv[2]), sys.argv[3]
sources = yaml.safe_load(open(path))
orbit = [s for s in sources if s.get('path') == 'minimal.standard.squashfs']
if not orbit:
    sys.exit(f'{path}: no minimal.standard.squashfs entry; left unchanged')
src = orbit[0]
src.update(default=True, size=size,
           name={'en': f'Orbit OS {version}'},
           description={'en': 'Orbit OS with its apps, theme and tools.'})
yaml.safe_dump([src], open(path, 'w'), sort_keys=True, allow_unicode=True)
print(f'install-sources: Orbit OS only, {size} bytes')
