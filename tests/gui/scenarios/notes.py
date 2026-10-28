import pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import harness  # noqa: E402
from orbit import notes_app  # noqa: E402


def pick_welcome(w):
    i = 0
    while (row := w.list.get_row_at_index(i)) is not None:
        if row.path.name.startswith("Welcome"):
            w.list.select_row(row)
            w.store.set_pinned(row.path, True)
            break
        i += 1


def preview(w):
    w.prev_btn.set_active(True)


def typing(w):
    w.prev_btn.set_active(False)
    w.new_note()
    w.buffer.set_text("# Trip to Lisbon\n\n- [ ] book train\n- pack **camera**\n")
    w.flush()
    w.refresh_list()


errs = harness.run(notes_app.NotesApp(), [(None, pick_welcome), ("notes-editor", lambda w: w.refresh_list()),
                                          ("notes-preview", preview), ("notes-new", typing)], sys.argv[1])
# the new note must be on disk as plain markdown
saved = [p for p in (pathlib.Path.home() / "Home/Notes").glob("*.md") if "Lisbon" in p.read_text()]
if not saved:
    errs.append("new note was not saved to ~/Home/Notes")
print("\n".join(errs))
print("SCENARIO OK" if not errs else "SCENARIO FAILED")
