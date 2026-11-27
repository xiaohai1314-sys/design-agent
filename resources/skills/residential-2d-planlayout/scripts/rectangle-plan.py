"""Validate and draw a dimensioned rectangular room from millimetre coordinates."""

import argparse
import json
import math
from pathlib import Path

from PIL import Image, ImageDraw
from plan_io import font, read_json, save_png

COLORS = {
    "cabinet": "#D6DFD1",
    "sink": "#D6DFD1",
    "cooktop": "#D6DFD1",
    "tall": "#BAC8B4",
    "island": "#EEE8D9",
    "chair": "#E5CDB1",
    "table": "#D3B390",
    "bed": "#DBE4E7",
    "desk": "#E5D8C4",
    "sofa": "#DEE1D9",
    "fixture": "#DFE8E9",
    "partition": "#8A8C86",
}
SIDES = ("north", "east", "south", "west")


def number(value):
    return type(value) in (int, float) and math.isfinite(value)


def overlap(a, b):
    return a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]


def validate(layout):
    width, depth = layout["width"], layout["depth"]
    if (
        not all(number(n) and n > 0 for n in (width, depth))
        or min(width, depth) / max(width, depth) < 0.08
    ):
        raise ValueError(
            "Provide positive room dimensions and a drawable rectangular boundary."
        )

    def check_rect(rect, label):
        if not isinstance(rect, list) or len(rect) != 4 or not all(map(number, rect)):
            raise ValueError(f"{label}: supply four finite rectangle edges.")
        a, b, c, d = rect
        if not (0 <= a < c <= width and 0 <= b < d <= depth):
            raise ValueError(
                f"{label}: rectangle must have positive area inside the room."
            )

    furniture, openings, spaces = (
        layout[key] for key in ("furniture", "openings", "clearances")
    )
    if (
        not all(isinstance(items, list) for items in (furniture, openings, spaces))
        or not 1 <= len(furniture) <= 60
        or not spaces
    ):
        raise ValueError(
            "Supply furniture, boundary openings and at least one clearance."
        )
    sweeps = {}
    for i, item in enumerate(furniture):
        kind, label, rect = item["kind"], item["label"], item["rect"]
        if (
            kind not in COLORS
            or not isinstance(label, str)
            or len(label) > 24
            or (kind == "chair" and item.get("front") not in SIDES)
        ):
            raise ValueError(
                "Each item needs a supported kind and label. Chairs need a facing side."
            )
        check_rect(rect, label)
        for other in furniture[:i]:
            if overlap(rect, other["rect"]):
                raise ValueError(f"Furniture overlaps: {label} / {other['label']}.")
        if "pullOut" in item:
            travel = item["pullOut"]
            if kind != "chair" or not number(travel) or travel <= 0:
                raise ValueError(
                    "pullOut must be a positive travel distance on a chair."
                )
            dx, dy = {
                "north": (0, travel),
                "east": (-travel, 0),
                "south": (0, -travel),
                "west": (travel, 0),
            }[item["front"]]
            a, b, c, d = rect
            sweep = [a + min(dx, 0), b + min(dy, 0), c + max(dx, 0), d + max(dy, 0)]
            check_rect(sweep, f"Chair {i + 1} pull-out")
            sweeps[i] = sweep
    for i, sweep in sweeps.items():
        for j, other in enumerate(furniture):
            if i != j and overlap(sweep, sweeps.get(j, other["rect"])):
                raise ValueError(
                    f"Chair {i + 1} pull-out intersects furniture {j + 1}."
                )
    for opening in openings:
        side, first, last = opening["side"], opening["from"], opening["to"]
        span = width if side in ("north", "south") else depth
        if (
            side not in SIDES
            or opening["kind"] not in ("window", "door")
            or not all(map(number, (first, last)))
            or not 0 <= first < last <= span
        ):
            raise ValueError(
                "Each opening needs a valid side and a positive span on that wall."
            )
    doors = [opening for opening in openings if opening["kind"] == "door"]
    if not doors:
        raise ValueError("Supply the planned entrance.")
    for side in SIDES:
        prev = -1
        for opening in sorted(
            (o for o in openings if o["side"] == side), key=lambda o: o["from"]
        ):
            if opening["from"] < prev:
                raise ValueError(f"Openings overlap on the {side} wall.")
            prev = opening["to"]
    checks = []
    for space in spaces:
        rect, axis, minimum, name = (
            space[k] for k in ("rect", "axis", "minimum", "label")
        )
        check_rect(rect, name)
        if (
            not isinstance(name, str)
            or not name.strip()
            or len(name) > 24
            or axis not in ("width", "depth")
            or not number(minimum)
            or minimum <= 0
        ):
            raise ValueError(
                "Each clearance needs a label, measurement axis and positive minimum."
            )
        for item in furniture:
            if overlap(rect, item["rect"]):
                raise ValueError(f"{name} intersects {item['label']}.")
        hold = space.get("keepClearWithChairsOut", False)
        if type(hold) is not bool:
            raise ValueError("keepClearWithChairsOut must be true or false.")
        if hold and (
            not sweeps or any(overlap(rect, sweep) for sweep in sweeps.values())
        ):
            raise ValueError(
                f"{name} must remain clear during the measured chair pull-outs."
            )
        i = int(axis == "depth")
        size = rect[i + 2] - rect[i]
        if size + 0.000001 < minimum:
            raise ValueError(f"{name} only has {size}.")
        check = {"label": name, "size": size, "axis": axis}
        if hold:
            check["keepClearWithChairsOut"] = True
        checks.append(check)
    for door in doors:
        side, first, last = door["side"], door["from"], door["to"]
        if not any(
            {
                "north": b == 0 and a <= first <= last <= c,
                "south": d == depth and a <= first <= last <= c,
                "west": a == 0 and b <= first <= last <= d,
                "east": c == width and b <= first <= last <= d,
            }[side]
            for a, b, c, d in (space["rect"] for space in spaces)
        ):
            raise ValueError(
                "Connect each entrance to a clear rectangle spanning its opening."
            )
    return checks, sweeps


def draw_plan(layout, sweeps):
    width, depth = layout["width"], layout["depth"]
    scale = 1080 / max(width, depth)
    left, top = 90, 108
    right, bottom = left + width * scale, top + depth * scale
    image = Image.new("RGB", (math.ceil(right + 64), math.ceil(bottom + 63)), "white")
    draw = ImageDraw.Draw(image)
    labels, small = font(17, chinese=True), font(15, chinese=True)

    def box(rect):
        a, b, c, d = rect
        return left + a * scale, top + b * scale, left + c * scale, top + d * scale

    draw.rectangle((left, top, right, bottom), fill="#F8F6F1")
    for sweep in sweeps.values():
        a, b, c, d = map(round, box(sweep))
        for x in range(a, c, 7):
            for y in (b, d):
                draw.line((x, y, min(c, x + 4), y), fill="#796B59")
        for y in range(b, d, 7):
            for x in (a, c):
                draw.line((x, y, x, min(d, y + 4)), fill="#796B59")
    for item in layout["furniture"]:
        a, b, c, d = box(item["rect"])
        kind = item["kind"]
        draw.rectangle((a, b, c, d), fill=COLORS[kind], outline="#4E514E", width=2)
        if kind == "chair":
            draw.line(
                {
                    "north": (a, d, c, d),
                    "south": (a, b, c, b),
                    "east": (a, b, a, d),
                    "west": (c, b, c, d),
                }[item["front"]],
                fill="#4E514E",
                width=5,
            )
        if kind in ("sink", "cooktop"):
            w, h = c - a, d - b
            symbol = (a + 0.20 * w, b + 0.19 * h, a + 0.80 * w, b + 0.81 * h)
            draw.rectangle(
                symbol,
                fill="whitesmoke" if kind == "sink" else "darkslategray",
                outline="#4E514E",
            )
            if kind == "cooktop":
                r = 0.08 * min(w, h)
                for x in (a + 0.36 * w, a + 0.64 * w):
                    for y in (b + 0.35 * h, b + 0.65 * h):
                        draw.ellipse((x - r, y - r, x + r, y + r), fill="lightgray")
        elif item["label"]:
            x, y, r, s = draw.textbbox((0, 0), item["label"], font=labels)
            if r - x + 4 <= c - a and s - y + 4 <= d - b:
                draw.text(
                    ((a + c) / 2, (b + d) / 2),
                    item["label"],
                    font=labels,
                    anchor="mm",
                    fill="black",
                )

    def dimension(x1, y1, x2, y2, label, offset, *, rotate_label=False):
        draw.line((x1, y1, x2, y2), fill="dimgray")
        for x, y in ((x1, y1), (x2, y2)):
            tick = (x, y - 5, x, y + 5) if y1 == y2 else (x - 5, y, x + 5, y)
            draw.line(tick, fill="dimgray")
        center = (x1 + x2) / 2 + offset[0], (y1 + y2) / 2 + offset[1]
        text = str(label)
        if rotate_label:
            l, t, r, b = draw.textbbox((0, 0), text, font=small)
            label_mask = Image.new("L", (r - l, b - t))
            ImageDraw.Draw(label_mask).text((-l, -t), text, font=small, fill=255)
            label_mask = label_mask.transpose(Image.Transpose.ROTATE_90)
            x, y = center
            image.paste(
                "dimgray",
                (round(x - label_mask.width / 2), round(y - label_mask.height / 2)),
                label_mask,
            )
        else:
            draw.text(center, text, font=small, fill="dimgray", anchor="mm")

    for space in layout["clearances"]:
        if space.get("dimension"):
            a, b, c, d = box(space["rect"])
            x, y = (a + c) / 2, (b + d) / 2
            r = space["rect"]
            if space["axis"] == "width":
                dimension(a, y, c, y, r[2] - r[0], (0, -11))
            else:
                dimension(x, b, x, d, r[3] - r[1], (29, 0))
    draw.rectangle(
        (left - 11, top - 11, right + 11, bottom + 11), outline="#292E30", width=11
    )
    for opening in layout["openings"]:
        start, end = opening["from"] * scale, opening["to"] * scale
        line, offset = {
            "north": ((left + start, top - 6, left + end, top - 6), (0, -22)),
            "south": ((left + start, bottom + 6, left + end, bottom + 6), (0, 22)),
            "west": ((left - 6, top + start, left - 6, top + end), (-24, 0)),
            "east": ((right + 6, top + start, right + 6, top + end), (23, 0)),
        }[opening["side"]]
        draw.line(line, fill="white", width=15)
        if opening["kind"] == "window":
            draw.line(line, fill="#578090", width=3)
        else:
            a, b, c, d = line
            draw.text(
                ((a + c) / 2 + offset[0], (b + d) / 2 + offset[1]),
                "入口",
                fill="black",
                font=small,
                anchor="mm",
            )
    dimension(left, 48, right, 48, width, (0, -14))
    dimension(30, top, 30, bottom, depth, (-14, 0), rotate_label=True)
    return image


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--layout-path", type=Path, required=True)
    parser.add_argument("--output-path", type=Path, required=True)
    args = parser.parse_args()
    try:
        layout = read_json(args.layout_path)
        checks, sweeps = validate(layout)
        save_png(draw_plan(layout, sweeps), args.output_path)
        receipt = {
            "filePath": str(args.output_path.resolve()),
            "room": [layout["width"], layout["depth"]],
            "clearances": checks,
        }
        if sweeps:
            receipt["chairPullOuts"] = [
                {
                    "furnitureIndex": i,
                    "travel": layout["furniture"][i]["pullOut"],
                    "sweep": sweep,
                }
                for i, sweep in sweeps.items()
            ]
        print(json.dumps(receipt, allow_nan=False))
    except (OSError, ValueError, TypeError, KeyError) as error:
        parser.exit(2, f"{error}\n")


if __name__ == "__main__":
    main()
