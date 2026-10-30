import pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import harness  # noqa: E402
from orbit import winapps, winapps_app  # noqa: E402

# a laptop with 64-bit Wine (from the update) but no 32-bit support yet
winapps.ready = lambda: {"wine": True, "wine32": False}


def wait(w):
    pass


errs = harness.run(winapps_app.WindowsApp(), [(None, wait), (None, wait), ("windows", wait)],
                   sys.argv[1], settle_ms=1500)
print("\n".join(errs))
print("SCENARIO OK" if not errs else "SCENARIO FAILED")
