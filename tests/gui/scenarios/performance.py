import pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import harness  # noqa: E402
from orbit import performance_app  # noqa: E402


def wait(w):
    pass


errs = harness.run(performance_app.PerformanceApp(), [(None, wait), (None, wait), ("performance", wait)],
                   sys.argv[1], settle_ms=2500)
print("\n".join(errs))
print("SCENARIO OK" if not errs else "SCENARIO FAILED")
