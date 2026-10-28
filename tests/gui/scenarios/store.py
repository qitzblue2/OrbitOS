import pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import harness  # noqa: E402
from orbit import catalog, store  # noqa: E402


def all_apps(w):
    i = 0
    while (r := w.side.get_row_at_index(i)) is not None:
        if r._cat == "All":
            w.side.select_row(r)
        i += 1


def details(w):
    vlc = [a for a in w.apps if a["name"] == "Bottles"][0]
    w.show_details(vlc)


def search(w):
    w.nav.pop_to_tag("browse")
    w.search.set_text("photo")


errs = harness.run(store.StoreApp(), [("store-featured", None), ("store-all", all_apps),
                                      ("store-details", details), ("store-search", search)], sys.argv[1])
print("\n".join(errs))
print("SCENARIO OK" if not errs else "SCENARIO FAILED")
