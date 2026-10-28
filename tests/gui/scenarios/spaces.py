import pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import harness  # noqa: E402
from orbit import spaces, spaces_app  # noqa: E402

calls = []
spaces.subprocess.run = lambda argv, check=False: calls.append(argv)  # no real gsettings in the test


def switch(w):
    w.switch("Work")


def edit(w):
    w.edit(w.spaces[1])


errs = harness.run(spaces_app.SpacesApp(), [("spaces", None), ("spaces-switched", switch),
                                            ("spaces-edit", edit)], sys.argv[1])
if spaces.load()[1] != "Work":
    errs.append("switch did not record the current space")
if not any(c[3] == "favorite-apps" for c in calls):
    errs.append("switch did not set the dock apps")
print("\n".join(errs))
print("SCENARIO OK" if not errs else "SCENARIO FAILED")
