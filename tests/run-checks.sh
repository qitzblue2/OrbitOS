#!/bin/bash
# Fast checks that need no root, ISO or VM. Run before every commit.
#   tests/run-checks.sh            # syntax, unit tests, packaging
#   ORBIT_GUI=1 tests/run-checks.sh   # + every app under Xvfb (needs xvfb, GTK 4, libadwaita)
#   ORBIT_SHELL=1 tests/run-checks.sh # + the desktop in headless GNOME Shell 46
set -uo pipefail
cd "$(dirname "$0")/.."
PY=${ORBIT_PYTHON:-python3}
fail=0; run() { echo "== $*"; "$@" || { echo "!! FAILED: $*"; fail=1; }; }

# shell syntax
run bash -n build.sh
for f in config/hooks/*.sh tests/*.sh tests/shell/*.sh tools/*.sh packages/orbit-os-desktop/files/usr/bin/* \
         packages/orbit-os-desktop/files/usr/lib/orbit-os/orbit-transparency \
         packages/orbit-os-desktop/files/usr/lib/orbit-os/orbit-first-login config/overlay/usr/local/bin/*; do
  if head -1 "$f" | grep -q bash; then run bash -n "$f"; else run sh -n "$f"; fi
done
command -v shellcheck >/dev/null && run shellcheck -S warning build.sh config/hooks/*.sh tools/*.sh tests/*.sh

# python syntax (every module, every launcher)
for f in packages/orbit-os-desktop/files/usr/lib/orbit-os/orbit-{settings,welcome,inbox-sorter} \
         packages/orbit-apps/src/orbit/*.py packages/orbit-apps/files/usr/bin/* \
         packages/orbit-apps/files/usr/lib/orbit-os/orbit-store-helper \
         packages/orbit-apps/files/usr/share/nautilus-python/extensions/*.py \
         branding/*.py icons/*.py tools/*.py tests/*.py tests/gui/*.py tests/gui/scenarios/*.py; do
  run $PY -m py_compile "$f"
done
find . -name __pycache__ -prune -exec rm -rf {} +

# JavaScript: every extension file parses; pure modules have unit tests
if command -v node >/dev/null; then
  for f in packages/orbit-launcher/*/*.js packages/orbit-shell-extensions/*/*.js tests/shell/*/*.js; do
    run node --check "$f"
  done
  for t in tests/*.test.mjs; do run node "$t"; done
fi
for m in packages/orbit-launcher/*/metadata.json packages/orbit-shell-extensions/*/metadata.json; do
  run $PY -c "import json,sys; d=json.load(open(sys.argv[1])); assert d['shell-version']==['46'], 'pin to GNOME 46'" "$m"
done
for s in packages/*/*/schemas packages/orbit-os-desktop/files/usr/share/glib-2.0/schemas; do
  command -v glib-compile-schemas >/dev/null && run glib-compile-schemas --strict --dry-run "$s"
done

# data files
run $PY -m json.tool packages/orbit-os-desktop/files/etc/firefox/policies/policies.json >/dev/null
run $PY -c "import sys; sys.path.insert(0,'packages/orbit-apps/src'); from orbit import catalog; a,_=catalog.load(); assert len(a)>30"
command -v desktop-file-validate >/dev/null && run desktop-file-validate packages/orbit-apps/files/usr/share/applications/*.desktop \
  packages/orbit-os-desktop/files/usr/share/applications/*.desktop
if command -v dconf >/dev/null; then
  T=$(mktemp -d); mkdir "$T/d"; cp config/dconf/db/local.d/00-orbit "$T/d/"; run dconf compile "$T/out" "$T/d"
fi

# unit tests
run $PY tests/test_orbit_apps.py
[ "$(id -u)" = 0 ] && run tests/test_merge_overlay.sh

# packages
run ./build.sh --debs-only >/dev/null
run $PY tests/check_debs.py out

if [ "${ORBIT_GUI:-0}" = 1 ]; then
  run env ORBIT_GUI_PYTHON="$PY" $PY tests/gui/screenshots.py "${TMPDIR:-/tmp}/orbit-gui-shots"
fi
if [ "${ORBIT_SHELL:-0}" = 1 ]; then
  out="${TMPDIR:-/tmp}/orbit-shell-shots"
  run tests/shell/run-desktop-shots.sh "$out"
  run $PY -c "import json,sys; r=json.load(open(sys.argv[1])); bad=[k for k,v in r.items() if k!='theme' and v.get('state')!=1]; sys.exit(f'not enabled: {bad}' if bad else 0)" "$out/report.json"
fi
find . -name __pycache__ -prune -exec rm -rf {} +
[ $fail = 0 ] && echo "ALL CHECKS PASSED" || { echo "SOME CHECKS FAILED"; exit 1; }
