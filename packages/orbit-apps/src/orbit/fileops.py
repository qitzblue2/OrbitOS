"""File-manager logic that does not need GTK: naming, sorting, kinds, copy plans."""
import mimetypes
import os
import pathlib
import shutil
import stat

KINDS = {  # category -> mime major or explicit types
    "Folders": None,
    "Documents": ("text/", "application/pdf", "application/vnd.oasis", "application/msword",
                  "application/vnd.openxmlformats", "application/rtf"),
    "Images": ("image/",),
    "Audio": ("audio/",),
    "Video": ("video/",),
    "Archives": ("application/zip", "application/x-tar", "application/gzip", "application/x-7z",
                 "application/x-xz", "application/x-bzip", "application/vnd.rar", "application/x-rar"),
    "Code": ("text/x-", "application/javascript", "application/json", "application/x-sh",
             "application/xml", "text/css", "text/html"),
}
CODE_EXT = {".py", ".js", ".ts", ".c", ".h", ".cpp", ".rs", ".go", ".java", ".sh", ".rb", ".php",
            ".css", ".html", ".json", ".toml", ".yaml", ".yml", ".md", ".lua", ".kt", ".swift"}


def kind_of(path, is_dir=False):
    """Human category for a file: Folders, Code, Images, ... or Other."""
    if is_dir:
        return "Folders"
    ext = pathlib.Path(path).suffix.lower()
    if ext in CODE_EXT:
        return "Code"
    mt = mimetypes.guess_type(str(path))[0] or ""
    for kind, prefixes in KINDS.items():
        if prefixes and kind != "Code" and any(mt.startswith(p) for p in prefixes):
            return kind
    if any(mt.startswith(p) for p in KINDS["Code"]):
        return "Code"
    return "Other"


def unique_name(directory, name):
    """'a.txt' -> 'a (2).txt' if taken. Directories keep dots in their name."""
    directory = pathlib.Path(directory)
    target = directory / name
    if not target.exists() and not target.is_symlink():
        return target
    p = pathlib.Path(name)
    stem, suffix = (p.stem, p.suffix) if p.suffix and not name.startswith(".") else (name, "")
    n = 2
    while True:
        cand = directory / f"{stem} ({n}){suffix}"
        if not cand.exists() and not cand.is_symlink():
            return cand
        n += 1


def valid_name(name):
    """Return an error string for an invalid new file name, else None."""
    if not name or not name.strip():
        return "The name cannot be empty."
    if "/" in name or "\0" in name:
        return "The name cannot contain “/”."
    if name in (".", ".."):
        return "“.” and “..” are reserved."
    if len(name.encode()) > 255:
        return "The name is too long."
    return None


def is_inside(child, parent):
    """True if child is parent or below it (resolving symlinks): blocks copying a folder into itself."""
    try:
        pathlib.Path(child).resolve().relative_to(pathlib.Path(parent).resolve())
        return True
    except ValueError:
        return False


def plan_transfer(sources, dest_dir, move=False):
    """List of (src, dst) pairs with collision-safe destinations.

    Raises ValueError for impossible requests (into itself, missing source).
    Moving a file onto the folder it already lives in is a no-op and is skipped.
    """
    dest_dir = pathlib.Path(dest_dir)
    plan, taken = [], set()
    for s in map(pathlib.Path, sources):
        if not s.exists() and not s.is_symlink():
            raise ValueError(f"“{s.name}” no longer exists.")
        if s.is_dir() and is_inside(dest_dir, s):
            raise ValueError(f"Cannot put “{s.name}” inside itself.")
        if move and s.parent.resolve() == dest_dir.resolve():
            continue
        dst = dest_dir / s.name
        if dst.exists() or dst.is_symlink() or dst in taken:
            dst = unique_name(dest_dir, s.name)
            while dst in taken:
                dst = unique_name(dest_dir, dst.name)
        taken.add(dst)
        plan.append((s, dst))
    return plan


def total_bytes(paths):
    total = 0
    for p in map(pathlib.Path, paths):
        if p.is_symlink() or p.is_file():
            total += p.lstat().st_size
        elif p.is_dir():
            for root, _dirs, files in os.walk(p):
                for f in files:
                    try:
                        total += os.lstat(os.path.join(root, f)).st_size
                    except OSError:
                        pass
    return total


def copy_with_progress(plan, progress=None, move=False, cancelled=lambda: False):
    """Execute a transfer plan. progress(done_bytes) is called as data moves."""
    done = 0

    def cb(n):
        nonlocal done
        done += n
        if progress:
            progress(done)

    for src, dst in plan:
        if cancelled():
            return False
        if move:
            try:
                os.rename(src, dst)  # same filesystem: instant
                cb(total_bytes([dst]))
                continue
            except OSError:
                pass  # cross-device: copy then delete
        _copy_tree(src, dst, cb, cancelled)
        if move and not cancelled():
            if src.is_dir() and not src.is_symlink():
                shutil.rmtree(src)
            else:
                src.unlink()
    return True


def _copy_tree(src, dst, cb, cancelled):
    if src.is_symlink():
        os.symlink(os.readlink(src), dst)
        return
    if src.is_dir():
        dst.mkdir()
        for child in sorted(src.iterdir()):
            if cancelled():
                return
            _copy_tree(child, dst / child.name, cb, cancelled)
        shutil.copystat(src, dst)
        return
    with open(src, "rb") as fi, open(dst, "wb") as fo:
        while True:
            if cancelled():
                break
            buf = fi.read(1 << 20)
            if not buf:
                break
            fo.write(buf)
            cb(len(buf))
    shutil.copystat(src, dst)


def search(root, query, limit=500, show_hidden=False, cancelled=lambda: False):
    """Case-insensitive filename search below root (bounded, skips hidden unless asked)."""
    q = query.lower()
    out = []
    for dirpath, dirs, files in os.walk(root):
        if cancelled():
            break
        if not show_hidden:
            dirs[:] = [d for d in dirs if not d.startswith(".")]
            files = [f for f in files if not f.startswith(".")]
        for name in dirs + files:
            if q in name.lower():
                out.append(pathlib.Path(dirpath) / name)
                if len(out) >= limit:
                    return out
    return out


def permissions_text(mode):
    return stat.filemode(mode)
