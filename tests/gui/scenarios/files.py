import os, pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import harness  # noqa: E402
from gi.repository import Gio, GLib  # noqa: E402
from orbit import files  # noqa: E402

H = pathlib.Path(os.environ["HOME"]) / "Home"


def pictures(w):
    w.current().open(Gio.File.new_for_path(str(H / "Pictures")))


def documents_list(w):
    w.current().open(Gio.File.new_for_path(str(H / "Documents")))
    w.set_view("list")


def preview(w):
    w.current().selection.select_item(2, True)  # Ideas.txt (folder has loaded by now)
    w.lookup_action("show-preview").change_state(GLib.Variant.new_boolean(True))


def search(w):
    w.lookup_action("show-preview").change_state(GLib.Variant.new_boolean(False))
    w.current().open(Gio.File.new_for_path(str(H)))
    w.search_btn.set_active(True)
    w.search_entry.set_text("o")
    w.current().show_search_results([Gio.File.new_for_path(str(p)) for p in sorted(H.rglob("*o*.*"))][:12])


def tabs(w):
    w.search_btn.set_active(False)
    w.set_view("grid")
    w.new_tab(Gio.File.new_for_path(str(H / "Spaces")))


errs = harness.run(files.FilesApp(), [("files-home", None), ("files-pictures", pictures),
                                      (None, documents_list), ("files-list-preview", preview), ("files-search", search),
                                      ("files-tabs-spaces", tabs)], sys.argv[1])
print("\n".join(errs))
print("SCENARIO OK" if not errs else "SCENARIO FAILED")
