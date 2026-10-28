"""Fill a throwaway HOME with a realistic ~/Home so screenshots show real content."""
import pathlib
import sys

from PIL import Image, ImageDraw


def make(home):
    H = pathlib.Path(home) / "Home"
    for d in ["Desktop", "Documents", "Downloads", "Pictures", "Music", "Videos", "Projects", "Notes",
              "Inbox", "Spaces/Personal", "Spaces/Work", "Spaces/Study"]:
        (H / d).mkdir(parents=True, exist_ok=True)
    for n, c in [("Beach.jpg", (90, 150, 220)), ("Sunset.jpg", (240, 140, 90)), ("Forest.jpg", (60, 140, 90)),
                 ("Mountains.jpg", (120, 110, 180))]:
        im = Image.new("RGB", (800, 500), c)
        d = ImageDraw.Draw(im)
        d.ellipse([250, 100, 550, 400], fill=tuple(min(255, x + 60) for x in c))
        im.save(H / "Pictures" / n)
    (H / "Documents/Budget 2026.ods").write_bytes(b"x" * 24000)
    (H / "Documents/CV.pdf").write_bytes(b"%PDF-1.4\n" + b"x" * 120000)
    (H / "Documents/Ideas.txt").write_text("Orbit OS ideas\n- glass widgets\n- spaces\n- a calm desktop\n")
    (H / "Projects/orbit-site").mkdir(exist_ok=True)
    (H / "Projects/orbit-site/index.html").write_text("<h1>hi</h1>")
    (H / "Projects/notes.py").write_text("print('hello')\n")
    (H / "Music/Song.mp3").write_bytes(b"x" * 3000000)
    (H / "Downloads/setup.zip").write_bytes(b"PK" + b"x" * 10000)
    (H / "Spaces/Work/Q3 plan.md").write_text("# Q3 plan\n")
    notes = {
        "Welcome to Orbit Notes.md": "# Welcome to Orbit Notes\n\nNotes are **plain Markdown files** in `~/Home/Notes`.\n\n"
                                     "- [x] Pin important notes\n- [ ] Try the preview (Ctrl+P)\n- Folders become groups\n\n"
                                     "> Everything syncs as normal files.\n",
        "Shopping.md": "# Shopping\n\n- oat milk\n- coffee\n- apples\n",
        "Work/Meeting notes.md": "# Meeting notes\n\n## Decisions\n- ship Orbit Store\n- **backup** weekly\n",
        "Study/Linux commands.md": "# Linux commands\n\n```\nls -la\nsudo apt update\n```\n",
    }
    for rel, body in notes.items():
        p = H / "Notes" / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(body)
    return H


if __name__ == "__main__":
    make(sys.argv[1])
