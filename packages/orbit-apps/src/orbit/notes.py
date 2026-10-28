"""Notes stored as plain Markdown files in ~/Home/Notes (sub-folders allowed).

Metadata that must not live inside the notes (pins) is kept in
~/Home/Notes/.orbit-notes.json so the folder stays portable.
"""
import html
import json
import pathlib
import re
import time

from . import paths

META = ".orbit-notes.json"


class NoteStore:
    def __init__(self, root=None):
        self.root = pathlib.Path(root) if root else paths.orbit_home() / "Notes"
        self.root.mkdir(parents=True, exist_ok=True)

    # ---- metadata
    def _meta(self):
        try:
            return json.loads((self.root / META).read_text())
        except (OSError, ValueError):
            return {"pinned": []}

    def _save_meta(self, m):
        (self.root / META).write_text(json.dumps(m, indent=2))

    def rel(self, p):
        return str(pathlib.Path(p).relative_to(self.root))

    def is_pinned(self, p):
        return self.rel(p) in self._meta().get("pinned", [])

    def set_pinned(self, p, on):
        m = self._meta()
        pins = [x for x in m.get("pinned", []) if x != self.rel(p)]
        if on:
            pins.insert(0, self.rel(p))
        m["pinned"] = pins
        self._save_meta(m)

    # ---- listing
    def folders(self):
        return sorted({self.rel(p.parent) for p in self.root.rglob("*.md")
                       if p.parent != self.root and not _hidden(p, self.root)} |
                      {self.rel(d) for d in self.root.rglob("*") if d.is_dir() and not _hidden(d, self.root)})

    def notes(self, folder=None, query=""):
        """Notes sorted: pinned first, then most recently edited."""
        base = self.root / folder if folder else self.root
        q = query.lower().strip()
        pins = self._meta().get("pinned", [])
        out = []
        for p in base.rglob("*.md"):
            if _hidden(p, self.root):
                continue
            if q:
                try:
                    body = p.read_text(errors="replace")
                except OSError:
                    continue
                if q not in p.stem.lower() and q not in body.lower():
                    continue
            out.append(p)
        return sorted(out, key=lambda p: (self.rel(p) not in pins, -p.stat().st_mtime))

    # ---- editing
    def create(self, title="Untitled", folder=None):
        d = self.root / folder if folder else self.root
        d.mkdir(parents=True, exist_ok=True)
        name = safe_filename(title) or "Untitled"
        p = d / f"{name}.md"
        n = 2
        while p.exists():
            p = d / f"{name} {n}.md"
            n += 1
        p.write_text(f"# {title}\n\n")
        return p

    def rename(self, p, new_title):
        p = pathlib.Path(p)
        name = safe_filename(new_title)
        if not name:
            raise ValueError("empty title")
        target = p.with_name(f"{name}.md")
        if target.exists() and target != p:
            raise FileExistsError(f"a note called “{new_title}” already exists")
        pinned = self.is_pinned(p)
        if pinned:
            self.set_pinned(p, False)
        p.rename(target)
        if pinned:
            self.set_pinned(target, True)
        return target

    def save(self, p, text):
        p = pathlib.Path(p)
        tmp = p.with_name(f".{p.name}.saving")
        tmp.write_text(text)
        tmp.replace(p)  # atomic: a crash never leaves a half-written note


def _hidden(p, root):
    return any(part.startswith(".") for part in pathlib.Path(p).relative_to(root).parts)


def safe_filename(title):
    t = re.sub(r"[/\\\0:*?\"<>|]", " ", title).strip().strip(".")
    return re.sub(r"\s+", " ", t)[:120]


def title_of(text, fallback):
    for line in text.splitlines():
        s = line.strip().lstrip("#").strip()
        if s:
            return s[:80]
    return fallback


def plain(line):
    """Markdown line -> readable text (for list snippets)."""
    s = re.sub(r"^\s*([-*+]\s+)?\[( |x|X)\]\s*", "", line)
    s = re.sub(r"^\s*(#{1,6}|[-*+>]|\d+\.)\s+", "", s)
    s = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", s)
    s = re.sub(r"(\*\*|__|~~|`)", "", s)
    s = re.sub(r"(?<!\w)[*_](\S[^*_]*)[*_](?!\w)", r"\1", s)
    return s.strip()


def snippet(text, n=90):
    lines = [l for l in text.splitlines() if l.strip() and not l.strip().startswith("```")]
    body = " · ".join(filter(None, (plain(l) for l in lines[1:])))
    return (body[:n] + "…") if len(body) > n else body


def word_count(text):
    return len(re.findall(r"\b\w+\b", text))


def relative_time(ts, now=None):
    d = (now or time.time()) - ts
    if d < 60:
        return "just now"
    if d < 3600:
        return f"{int(d // 60)} min ago"
    if d < 86400:
        return f"{int(d // 3600)} h ago"
    if d < 86400 * 7:
        return f"{int(d // 86400)} d ago"
    return time.strftime("%d %b %Y", time.localtime(ts))


# ---- Markdown -> Pango markup (preview). Small and safe: everything is escaped first.
def _inline(s):
    s = html.escape(s, quote=False)
    s = re.sub(r"`([^`]+)`", r'<span font_family="monospace" background="#ffffff1a">\1</span>', s)
    s = re.sub(r"\*\*([^*]+)\*\*", r"<b>\1</b>", s)
    s = re.sub(r"(?<![\w*])\*([^*]+)\*(?![\w*])", r"<i>\1</i>", s)
    s = re.sub(r"(?<!\w)_([^_]+)_(?!\w)", r"<i>\1</i>", s)
    s = re.sub(r"~~([^~]+)~~", r"<s>\1</s>", s)
    s = re.sub(r"\[([^\]]+)\]\((https?://[^)\s]+)\)", r'<a href="\2">\1</a>', s)
    return s


def markdown_to_pango(md):
    out, in_code = [], False
    sizes = {1: "xx-large", 2: "x-large", 3: "large"}
    for line in md.splitlines():
        if line.strip().startswith("```"):
            in_code = not in_code
            continue
        if in_code:
            out.append(f'<span font_family="monospace">{html.escape(line, quote=False)}</span>')
            continue
        m = re.match(r"^(#{1,6})\s+(.*)", line)
        if m:
            lvl = len(m.group(1))
            out.append(f'<span size="{sizes.get(lvl, "medium")}" weight="bold">{_inline(m.group(2))}</span>')
            continue
        m = re.match(r"^(\s*)[-*+]\s+\[( |x|X)\]\s+(.*)", line)
        if m:
            box = "☑" if m.group(2).lower() == "x" else "☐"
            out.append(f"{m.group(1)}{box} {_inline(m.group(3))}")
            continue
        m = re.match(r"^(\s*)[-*+]\s+(.*)", line)
        if m:
            out.append(f"{m.group(1)}  •  {_inline(m.group(2))}")
            continue
        m = re.match(r"^>\s?(.*)", line)
        if m:
            out.append(f'<span style="italic" alpha="70%">▍ {_inline(m.group(1))}</span>')
            continue
        if re.match(r"^\s*(-{3,}|\*{3,})\s*$", line):
            out.append("────────────────────")
            continue
        out.append(_inline(line))
    return "\n".join(out)
