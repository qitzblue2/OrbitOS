import pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import harness  # noqa: E402
from orbit import updater, updater_app  # noqa: E402

# a machine with updates waiting and two past runs, without touching apt
updater.upgradable = lambda: updater.parse_upgradable(
    "aphelion/orbit 1.1.1 amd64 [upgradable from: 1.1.0]\n"
    "orbit-apps/orbit 2.0.0.5 all [upgradable from: 2.0.0.3]\n"
    "orbit-os-desktop/orbit 2.0.0.5 all [upgradable from: 2.0.0.3]\n"
    "libssl3t64/trixie-security 3.5.1-1+deb13u1 amd64 [upgradable from: 3.5.1-1]\n")
updater.history = lambda: updater.parse_history(
    "Start-Date: 2026-10-29  03:10:01\nUpgrade: orbit-apps:amd64 (2.0.0.2, 2.0.0.3), aphelion:amd64 (1.0.9, 1.1.0)\n"
    "End-Date: 2026-10-29  03:10:40\n")


def wait(w):
    pass


errs = harness.run(updater_app.UpdaterApp(), [(None, wait), (None, wait), ("updater", wait)],
                   sys.argv[1], settle_ms=1500)
print("\n".join(errs))
print("SCENARIO OK" if not errs else "SCENARIO FAILED")
