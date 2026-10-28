import datetime as dt, os, pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import harness  # noqa: E402
from orbit import backup, backup_app  # noqa: E402

drive = pathlib.Path(os.environ["HOME"]) / "USB-Drive"
drive.mkdir()
cfg = dict(backup.default_config(), destination=str(drive))
backup.save_config(cfg)
# two earlier snapshots so the list has content
backup.run_backup(cfg, now=dt.datetime.now() - dt.timedelta(days=2))
backup.run_backup(cfg, now=dt.datetime.now() - dt.timedelta(hours=5))


def run_now(w):
    w.run_now()


errs = harness.run(backup_app.BackupApp(), [("backup", None), (None, run_now), ("backup-after", None)],
                   sys.argv[1], settle_ms=1500)
if len(backup.snapshots(drive)) != 3:
    errs.append(f"expected 3 snapshots, found {len(backup.snapshots(drive))}")
print("\n".join(errs))
print("SCENARIO OK" if not errs else "SCENARIO FAILED")
