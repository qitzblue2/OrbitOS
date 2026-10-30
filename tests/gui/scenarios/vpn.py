import pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import harness  # noqa: E402
from orbit import vpn, vpn_app  # noqa: E402

vpn.connections = lambda: [{"name": "laptop", "active": True}]
vpn.autoconnect = lambda n: True
vpn.public_ip = lambda: "203.0.113.7"


def wait(w):
    pass


errs = harness.run(vpn_app.VpnApp(), [(None, wait), (None, wait), ("vpn", wait)], sys.argv[1], settle_ms=1500)
print("\n".join(errs))
print("SCENARIO OK" if not errs else "SCENARIO FAILED")
