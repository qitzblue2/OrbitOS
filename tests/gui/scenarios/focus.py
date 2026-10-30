import pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import harness  # noqa: E402
from orbit import focus, focus_app  # noqa: E402


def wait(w):
    pass


def running(w):
    focus.start(50, focus.DEFAULT_SITES, gs=lambda *a: "true", schedule=lambda s: None)
    w.tick()


errs = harness.run(focus_app.FocusApp(), [(None, wait), (None, wait), ("focus", wait), ("focus-running", running)],
                   sys.argv[1], settle_ms=1200)
print("\n".join(errs))
print("SCENARIO OK" if not errs else "SCENARIO FAILED")
