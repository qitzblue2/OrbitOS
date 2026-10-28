#!/bin/sh
# Unit test for tools/merge-overlay-upper.py (needs root for mknod/xattrs).
set -eu
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
M="$(dirname "$0")/../tools/merge-overlay-upper.py"
mkdir -p "$T/lower/etc" "$T/layer/etc/old" "$T/upper/etc/new" "$T/upper/etc/old"
echo base > "$T/lower/etc/inbase"; echo l > "$T/layer/etc/inlayer"; echo x > "$T/layer/etc/old/f"
echo n > "$T/upper/etc/new/f"
mknod "$T/upper/etc/inbase" c 0 0; mknod "$T/upper/etc/inlayer" c 0 0
setfattr -n trusted.overlay.opaque -v y "$T/upper/etc/old" 2>/dev/null || python3 -c "import os;os.setxattr('$T/upper/etc/old','trusted.overlay.opaque',b'y')"
python3 "$M" "$T/upper" "$T/layer" "$T/lower"
[ -f "$T/layer/etc/new/f" ] || { echo "FAIL new file"; exit 1; }
[ -c "$T/layer/etc/inbase" ] || { echo "FAIL whiteout kept for lower path"; exit 1; }
[ ! -e "$T/layer/etc/inlayer" ] || { echo "FAIL layer-only file deleted"; exit 1; }
[ ! -e "$T/layer/etc/old/f" ] || { echo "FAIL opaque dir replaced"; exit 1; }
echo "merge-overlay tests passed"
