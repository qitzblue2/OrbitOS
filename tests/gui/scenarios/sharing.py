import json, pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import harness  # noqa: E402
from orbit import paths, sharing, sharing_app  # noqa: E402

music = paths.orbit_home() / "Music"
music.mkdir(parents=True, exist_ok=True)
sharing.save([{"name": "Music", "path": str(music), "writable": False}])
sharing_app.sharing_active = lambda: True


def wait(w):
    pass


errs = harness.run(sharing_app.SharingApp(), [(None, wait), (None, wait), ("sharing", wait)],
                   sys.argv[1], settle_ms=1500)
print("\n".join(errs))
print("SCENARIO OK" if not errs else "SCENARIO FAILED")
