import pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import harness  # noqa: E402
from orbit import optimizer_app  # noqa: E402


def wait(w):
    pass


def startup(w):
    w.stack.set_visible_child_name("startup")


errs = harness.run(optimizer_app.OptimizerApp(), [(None, wait), (None, wait), ("optimizer-clean", wait),
                                                  ("optimizer-startup", startup)],
                   sys.argv[1], settle_ms=1500)
print("\n".join(errs))
print("SCENARIO OK" if not errs else "SCENARIO FAILED")
