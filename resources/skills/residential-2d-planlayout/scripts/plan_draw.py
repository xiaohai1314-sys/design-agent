"""Drawing primitives shared by the residential plan guides."""

import itertools
import math

import numpy as np
from PIL import Image, ImageDraw


def dashed_line(draw, points, color, width, closed=False):
    if closed:
        points = [*points, points[0]]
    for start, stop in itertools.pairwise(points):
        distance = math.dist(start, stop)
        if not distance:
            continue
        for offset in range(0, math.ceil(distance), width * 5):
            first, last = (
                offset / distance,
                min(distance, offset + width * 3) / distance,
            )
            draw.line(
                [
                    tuple(a + (b - a) * t for a, b in zip(start, stop))
                    for t in (first, last)
                ],
                fill=color,
                width=width,
            )


def draw_corners(draw, rect, color, length, width=2):
    l, t, r, b = rect
    for x, dx in ((l, length), (r - 1, -length)):
        for y, dy in ((t, length), (b - 1, -length)):
            draw.line((x + dx, y, x, y, x, y + dy), fill=color, width=width)


def draw_bed(canvas, rect, head, guide=False):
    l, t, r, b = rect
    turns = {
        "top": None,
        "right": Image.Transpose.ROTATE_270,
        "bottom": Image.Transpose.ROTATE_180,
        "left": Image.Transpose.ROTATE_90,
    }
    w, h = r - l - 2, b - t - 2
    if min(w, h) < 1:
        raise ValueError("Bed footprint is too small.")
    if head in ("left", "right"):
        w, h = h, w
    fill = (233, 239, 234, 238) if guide else (253, 249, 241, 255)
    edge = (57, 81, 68, 163) if guide else (100, 88, 77, 255)
    symbol = Image.new("RGBA", (w, h), fill)
    draw = ImageDraw.Draw(symbol)
    draw.rectangle((0, 0, w - 1, h - 1), outline=edge, width=2)
    draw.rectangle((w * 0.2, h * 0.07, w * 0.8, h * 0.25), outline=edge, width=2)
    if guide:
        draw.line((0, h * 0.36, w - 1, h * 0.36), fill=edge, width=2)
    else:
        draw.rectangle(
            (w * 0.07, h * 0.36, w * 0.93, h * 0.94),
            fill=(201, 187, 169),
            outline=edge,
            width=2,
        )
    if turns[head] is not None:
        symbol = symbol.transpose(turns[head])
    canvas.alpha_composite(symbol, (l + 1, t + 1))


def polygon_mask(mask, polygon, value):
    """Match the original lock test at pixel centers, including sloping edges."""
    x0, y0 = np.floor(polygon.min(axis=0)).astype(int)
    x1, y1 = np.ceil(polygon.max(axis=0)).astype(int)
    xs = np.arange(x0, x1)[None, :] + 0.5
    ys = np.arange(y0, y1)[:, None] + 0.5
    inside = np.zeros((y1 - y0, x1 - x0), dtype=bool)
    for (ax, ay), (bx, by) in zip(polygon, np.roll(polygon, 1, axis=0)):
        if ay != by:
            inside ^= ((ay > ys) != (by > ys)) & (
                xs < ax + (ys - ay) * (bx - ax) / (by - ay)
            )
    mask[y0:y1, x0:x1][inside] = value
