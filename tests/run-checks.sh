#!/bin/bash
# Fast checks that need no root, ISO or VM. Run before every commit.
set -euo pipefail
cd "$(dirname "$0")/.."
fail=0; run() { echo "== $*"; "$@" || fail=1; }
run bash -n build.sh
for f in config/hooks/*.sh tests/*.sh tools/*.sh packages/orbit-os-desktop/files/usr/bin/* \
         packages/orbit-os-desktop/files/usr/lib/orbit-os/orbit-transparency \
         packages/orbit-os-desktop/files/usr/lib/orbit-os/orbit-first-login config/overlay/usr/local/bin/*; do
  if head -1 "$f" | grep -q bash; then run bash -n "$f"; else run sh -n "$f"; fi
done
command -v shellcheck >/dev/null && run shellcheck -S warning build.sh config/hooks/*.sh tools/*.sh tests/*.sh
for f in packages/orbit-os-desktop/files/usr/lib/orbit-os/orbit-{settings,welcome,inbox-sorter} branding/*.py icons/*.py tools/*.py tests/*.py; do
  run python3 -m py_compile "$f"
done
command -v node >/dev/null && run node tests/calc.test.mjs
command -v node >/dev/null && run node --check packages/orbit-launcher/orbit-launcher@orbit-os/extension.js
python3 -c "import json;json.load(open('packages/orbit-launcher/orbit-launcher@orbit-os/metadata.json'))" && echo "metadata.json ok"
run python3 -m json.tool packages/orbit-os-desktop/files/etc/firefox/policies/policies.json >/dev/null
[ "$(id -u)" = 0 ] && run tests/test_merge_overlay.sh
run ./build.sh --debs-only >/dev/null
run python3 tests/check_debs.py out
[ $fail = 0 ] && echo "ALL CHECKS PASSED" || { echo "SOME CHECKS FAILED"; exit 1; }
