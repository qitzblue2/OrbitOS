"""Screenshot annotations: a list of shapes drawn over an image with cairo.

Kept free of GTK so it can be unit-tested and reused (the editor draws the
same list live on screen and once more, at full resolution, when saving).
All coordinates are in image pixels.
"""
import math
from dataclasses import dataclass, field

import cairo

TOOLS = ["pen", "highlight", "arrow", "rect", "ellipse", "text", "pixelate", "crop"]
PALETTE = ["#ff4d5e", "#ffb02e", "#ffe14d", "#4cd97b", "#4fd1c0", "#5aa6ff", "#9b6cf0", "#ffffff", "#161619"]


def hex_rgb(h):
    """'#rrggbb' or '#rgb' -> floats; anything unreadable becomes red rather than crashing."""
    h = h.lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    try:
        return tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))
    except ValueError:
        return (1.0, 0.3, 0.37)


@dataclass
class Shape:
    tool: str
    color: str = "#ff4d5e"
    width: float = 4.0
    points: list = field(default_factory=list)  # [(x, y), ...]; two points for box tools
    text: str = ""

    def bbox(self):
        xs = [p[0] for p in self.points] or [0]
        ys = [p[1] for p in self.points] or [0]
        return min(xs), min(ys), max(xs), max(ys)


def normalized_rect(p0, p1):
    x0, y0 = p0
    x1, y1 = p1
    return min(x0, x1), min(y0, y1), abs(x1 - x0), abs(y1 - y0)


def arrow_head(p0, p1, width):
    """Two wing points of an arrow head at p1, sized to the line width."""
    ang = math.atan2(p1[1] - p0[1], p1[0] - p0[0])
    size = max(12.0, width * 4.5)
    spread = math.radians(28)
    return [(p1[0] - size * math.cos(ang - spread), p1[1] - size * math.sin(ang - spread)),
            (p1[0] - size * math.cos(ang + spread), p1[1] - size * math.sin(ang + spread))]


def pixelate(cr, base, rect, block=12):
    """Replace rect of the base image with coarse blocks (irreversible in the saved file)."""
    x, y, w, h = (int(round(v)) for v in rect)
    if w < 2 or h < 2:
        return
    sw, sh = max(1, w // block), max(1, h // block)
    small = cairo.ImageSurface(cairo.FORMAT_ARGB32, sw, sh)
    sc = cairo.Context(small)
    sc.scale(sw / w, sh / h)
    sc.set_source_surface(base, -x, -y)
    sc.get_source().set_filter(cairo.FILTER_GOOD)
    sc.paint()
    cr.save()
    cr.rectangle(x, y, w, h)
    cr.clip()
    cr.translate(x, y)
    cr.scale(w / sw, h / sh)
    cr.set_source_surface(small, 0, 0)
    cr.get_source().set_filter(cairo.FILTER_NEAREST)
    cr.paint()
    cr.restore()


def draw_shape(cr, base, s):
    if not s.points:
        return
    r, g, b = hex_rgb(s.color)
    cr.save()
    cr.set_line_cap(cairo.LINE_CAP_ROUND)
    cr.set_line_join(cairo.LINE_JOIN_ROUND)
    cr.set_line_width(s.width)
    if s.tool in ("pen", "highlight"):
        if s.tool == "highlight":
            cr.set_source_rgba(r, g, b, 0.35)
            cr.set_line_width(s.width * 4)
            cr.set_operator(cairo.OPERATOR_MULTIPLY)
        else:
            cr.set_source_rgb(r, g, b)
        cr.move_to(*s.points[0])
        for p in s.points[1:]:
            cr.line_to(*p)
        if len(s.points) == 1:
            cr.line_to(s.points[0][0] + 0.1, s.points[0][1])
        cr.stroke()
    elif s.tool == "arrow" and len(s.points) >= 2:
        p0, p1 = s.points[0], s.points[-1]
        cr.set_source_rgb(r, g, b)
        w1, w2 = arrow_head(p0, p1, s.width)
        # stop the shaft inside the head so the tip stays sharp
        cr.move_to(*p0)
        cr.line_to((w1[0] + w2[0]) / 2, (w1[1] + w2[1]) / 2)
        cr.stroke()
        cr.move_to(*p1)
        cr.line_to(*w1)
        cr.line_to(*w2)
        cr.close_path()
        cr.fill()
    elif s.tool in ("rect", "ellipse") and len(s.points) >= 2:
        x, y, w, h = normalized_rect(s.points[0], s.points[-1])
        cr.set_source_rgb(r, g, b)
        if s.tool == "rect":
            rad = min(8, w / 2, h / 2)
            cr.new_sub_path()
            cr.arc(x + w - rad, y + rad, rad, -math.pi / 2, 0)
            cr.arc(x + w - rad, y + h - rad, rad, 0, math.pi / 2)
            cr.arc(x + rad, y + h - rad, rad, math.pi / 2, math.pi)
            cr.arc(x + rad, y + rad, rad, math.pi, 3 * math.pi / 2)
            cr.close_path()
        elif w > 0 and h > 0:
            cr.translate(x + w / 2, y + h / 2)
            cr.scale(w / 2, h / 2)
            cr.arc(0, 0, 1, 0, 2 * math.pi)
            cr.restore()
            cr.save()
            cr.set_source_rgb(r, g, b)
            cr.set_line_width(s.width)
        cr.stroke()
    elif s.tool == "text" and s.text:
        size = max(14, s.width * 5)
        cr.select_font_face("Inter", cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
        cr.set_font_size(size)
        x, y = s.points[0]
        # dark/light halo keeps the label readable on any background
        cr.move_to(x, y + size)
        cr.text_path(s.text)
        lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
        cr.set_source_rgba(*((0, 0, 0, 0.55) if lum > 0.5 else (1, 1, 1, 0.7)))
        cr.set_line_width(size / 6)
        cr.stroke_preserve()
        cr.set_source_rgb(r, g, b)
        cr.fill()
    elif s.tool == "pixelate" and len(s.points) >= 2:
        pixelate(cr, base, normalized_rect(s.points[0], s.points[-1]), block=max(8, int(s.width * 3)))
    cr.restore()


def render(base, shapes, crop=None):
    """Full-resolution result as a new cairo.ImageSurface (crop = (x, y, w, h) or None)."""
    W, H = base.get_width(), base.get_height()
    out = cairo.ImageSurface(cairo.FORMAT_ARGB32, W, H)
    cr = cairo.Context(out)
    cr.set_source_surface(base, 0, 0)
    cr.paint()
    for s in shapes:
        if s.tool != "crop":
            draw_shape(cr, base, s)
    if crop:
        x, y, w, h = (int(round(v)) for v in crop)
        x, y = max(0, x), max(0, y)
        w, h = min(W - x, w), min(H - y, h)
        if w > 1 and h > 1:
            c = cairo.ImageSurface(cairo.FORMAT_ARGB32, w, h)
            cc = cairo.Context(c)
            cc.set_source_surface(out, -x, -y)
            cc.paint()
            return c
    return out


class History:
    """Undo/redo over the shape list (and crop)."""

    def __init__(self):
        self.shapes, self.redo_stack, self.crop = [], [], None

    def add(self, shape):
        if shape.tool == "crop":
            self.crop = normalized_rect(shape.points[0], shape.points[-1])
        self.shapes.append(shape)
        self.redo_stack.clear()

    def undo(self):
        if self.shapes:
            s = self.shapes.pop()
            self.redo_stack.append(s)
            if s.tool == "crop":
                crops = [x for x in self.shapes if x.tool == "crop"]
                self.crop = normalized_rect(crops[-1].points[0], crops[-1].points[-1]) if crops else None

    def redo(self):
        if self.redo_stack:
            s = self.redo_stack.pop()
            self.shapes.append(s)
            if s.tool == "crop":
                self.crop = normalized_rect(s.points[0], s.points[-1])
