import pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import harness  # noqa: E402
from orbit import games_app  # noqa: E402


def wait(w):
    pass


def setup(w):
    w.stack.set_visible_child_name("setup")


errs = harness.run(games_app.GamesApp(), [(None, wait), (None, wait), ("games-library", wait),
                                          ("games-setup", setup)],
                   sys.argv[1], settle_ms=1500)
print("\n".join(errs))
print("SCENARIO OK" if not errs else "SCENARIO FAILED")
