import pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import harness  # noqa: E402
from orbit import hardware_app  # noqa: E402


def wait(w):
    pass


def guided(w):
    w.stack.set_visible_child_name("guided")


errs = harness.run(hardware_app.HardwareApp(), [(None, wait), (None, wait), (None, wait),
                                                ("hardware-auto", wait), ("hardware-guided", guided)],
                   sys.argv[1], settle_ms=1500)
print("\n".join(errs))
print("SCENARIO OK" if not errs else "SCENARIO FAILED")
