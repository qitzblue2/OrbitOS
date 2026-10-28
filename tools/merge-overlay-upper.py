#!/usr/bin/env python3
"""Fold an overlayfs upper dir into the squashfs layer directly below it.

Ubuntu 24.04 ships the root filesystem as stacked squashfs layers
(minimal -> minimal.standard -> minimal.standard.live). We modify a layer by
mounting overlayfs (upper=U over LAYER:LOWER...) and chrooting in. This
script then produces the new LAYER contents: LAYER + U, where

  * a whiteout (char dev 0:0) in U deletes the path from LAYER, and is kept
    as a whiteout only if the path still exists in a lower layer;
  * an opaque dir (xattr trusted.overlay.opaque=y) in U replaces the LAYER
    dir entirely and stays opaque if a lower layer has that dir;
  * everything else in U overwrites LAYER (metadata preserved).

Usage (as root): merge-overlay-upper.py UPPER LAYER [LOWER ...]
LAYER is modified in place.
"""
import os
import shutil
import stat
import sys

OPAQUE = "trusted.overlay.opaque"


def is_whiteout(st):
    return stat.S_ISCHR(st.st_mode) and st.st_rdev == 0


def in_lowers(rel, lowers):
    return any(os.path.lexists(os.path.join(l, rel)) for l in lowers)


def remove(p):
    if os.path.isdir(p) and not os.path.islink(p):
        shutil.rmtree(p)
    elif os.path.lexists(p):
        os.unlink(p)


def copy_entry(src, dst, st):
    keep_dir = stat.S_ISDIR(st.st_mode) and os.path.isdir(dst) and not os.path.islink(dst)
    if not keep_dir:
        remove(dst)
    if stat.S_ISDIR(st.st_mode):
        os.makedirs(dst, exist_ok=True)
    elif stat.S_ISLNK(st.st_mode):
        os.symlink(os.readlink(src), dst)
    elif stat.S_ISREG(st.st_mode):
        shutil.copyfile(src, dst, follow_symlinks=False)
    else:
        os.mknod(dst, st.st_mode, st.st_rdev)
    os.lchown(dst, st.st_uid, st.st_gid)
    if not stat.S_ISLNK(st.st_mode):
        os.chmod(dst, stat.S_IMODE(st.st_mode))
    for name in os.listxattr(src, follow_symlinks=False):
        if name.startswith("trusted.overlay."):
            continue
        os.setxattr(dst, name, os.getxattr(src, name, follow_symlinks=False), follow_symlinks=False)
    os.utime(dst, ns=(st.st_atime_ns, st.st_mtime_ns), follow_symlinks=False)


def main(upper, layer, lowers):
    for root, dirs, files in os.walk(upper):
        rel_root = os.path.relpath(root, upper)
        for name in sorted(dirs + files):
            src = os.path.join(root, name)
            rel = os.path.normpath(os.path.join(rel_root, name))
            dst = os.path.join(layer, rel)
            st = os.lstat(src)
            if is_whiteout(st):
                remove(dst)
                if in_lowers(rel, lowers):
                    os.mknod(dst, stat.S_IFCHR | 0o000, 0)
                continue
            opaque = False
            if stat.S_ISDIR(st.st_mode):
                try:
                    opaque = os.getxattr(src, OPAQUE, follow_symlinks=False) == b"y"
                except OSError:
                    pass
                if opaque:
                    remove(dst)
            copy_entry(src, dst, st)
            if opaque and in_lowers(rel, lowers):
                os.setxattr(dst, OPAQUE, b"y", follow_symlinks=False)


if __name__ == "__main__":
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2], sys.argv[3:])
