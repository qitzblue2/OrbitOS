import pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import harness  # noqa: E402
from orbit import sync, sync_app  # noqa: E402

ME = "FIDKJCU-RDTAAK4-ABCDEFG-HIJKLMN-OPQRSTU-VWXYZ23-4567ABC-DEFGHIJ"


class Fake:
    def my_id(self): return ME
    def devices(self, me=None): return [{"id": "B" * 7, "name": "Laptop", "connected": True}]
    def pending(self): return [{"id": "RXGUESW-ZF233Z2-AAAAAAA", "name": "Desktop", "address": ""}]
    def enabled_items(self): return {"orbit-notes", "orbit-documents"}
    def status(self): return "idle"


sync.Client = lambda *a, **k: Fake()
sync_app.running = lambda: True
sync_app.shutil.which = lambda _n: "/usr/bin/syncthing"


def wait(w):
    pass


errs = harness.run(sync_app.SyncApp(), [(None, wait), (None, wait), ("sync", wait)], sys.argv[1], settle_ms=1500)
print("\n".join(errs))
print("SCENARIO OK" if not errs else "SCENARIO FAILED")
