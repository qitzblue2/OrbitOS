import os, pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import harness  # noqa: E402
from orbit import annotate, screenshot  # noqa: E402

H = pathlib.Path(os.environ["HOME"]) / "Home"
SAMPLE = H.parent / "brand/wallpapers/orbit-glass.png"


def load(w):
    w.load_file(SAMPLE)


def annotate_it(w):
    hist = w.canvas.history
    hist.add(annotate.Shape("rect", "#ffe14d", 6, [(140, 120), (620, 360)]))
    hist.add(annotate.Shape("arrow", "#ff4d5e", 7, [(980, 560), (650, 360)]))
    hist.add(annotate.Shape("text", "#ffffff", 7, [(700, 580)], "Click here"))
    hist.add(annotate.Shape("highlight", "#4cd97b", 5, [(160 + i * 8, 420) for i in range(50)]))
    hist.add(annotate.Shape("pixelate", "#000", 5, [(900, 80), (1200, 220)]))
    w.canvas.queue_draw()
    w.changed()


def save(w):
    w.save()


errs = harness.run(screenshot.ScreenshotApp(), [("screenshot-empty", None), (None, load),
                                                ("screenshot-annotated", annotate_it), (None, save)], sys.argv[1])
shots = list((H / "Pictures/Screenshots").glob("Screenshot *.png"))
if not shots:
    errs.append("save did not write a PNG to ~/Home/Pictures/Screenshots")
print("\n".join(errs))
print("SCENARIO OK" if not errs else "SCENARIO FAILED")
