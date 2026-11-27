"""Apply reviewed restoration, opening, wall and furniture patches."""

import argparse
import json
import math
import subprocess
import sys
from collections import defaultdict
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np
from PIL import Image
from plan_draw import draw_bed
from plan_io import new_png, open_image, read_json, sha256

KINDS = ("restore", "clear", "move", "infill", "bed")


def integers(values, count):
    if (
        not isinstance(values, list)
        or len(values) != count
        or any(type(n) is not int for n in values)
    ):
        raise ValueError(f"Expected {count} integer pixel coordinates.")
    return values


def rectangle(values, size):
    a, b, c, d = integers(values, 4)
    if not (0 <= a < c < size[0] and 0 <= b < d < size[1]):
        raise ValueError("Keep the correction strictly inside the base image.")
    return a, b, c, d


def intersection(a, b):
    return max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])


def area(rect):
    a, b, c, d = rect
    return max(0, c - a) * max(0, d - b)


def uncovered(rect, target):
    a, b, c, d = rect
    l, t, r, s = intersection(rect, target)
    if not area((l, t, r, s)):
        return rect
    if t == b and s == d:
        return (a, b, l, d) if l > a else (r, b, c, d)
    if l == a and r == c:
        return (a, b, c, t) if t > b else (a, s, c, d)
    return rect


def clear(source, candidate, rect, item, dark, obstruction=None):
    l, t, r, b = rect
    if "backgroundFrom" in item:
        if "background" in item:
            raise ValueError("Use one method to sample the background.")
        x, y = integers(item["backgroundFrom"], 2)
        patch = rectangle([x, y, x + r - l, y + b - t], source.size)
        if area(intersection(patch, obstruction or rect)):
            raise ValueError(
                "Choose a separate unobstructed patch of the same surface."
            )
        candidate.paste(source.crop(patch), (l, t))
    else:
        x, y = integers(item["background"], 2)
        if not (0 <= x < source.width and 0 <= y < source.height):
            raise ValueError("Background sample is outside the base image.")
        pixel = source.getpixel((x, y))
        rgb = pixel[:3]
        valid = max(rgb) <= 80 if dark else min(rgb) >= 245
        if pixel[3] != 255 or not valid:
            raise ValueError(
                "Choose an unobstructed background sample with the review image polarity."
            )
        candidate.paste(pixel, rect)


def infill(source, original, candidate, rect, item, review, dark):
    matches = [
        o
        for o in review.get("crossings", [])
        if o.get("state") == "closed" and o["id"] == item["openingId"]
    ]
    if len(matches) != 1:
        raise ValueError("Specify the openingId of one closure in the original review.")
    opening = matches[0]
    x1, y1 = opening["from"]
    x2, y2 = opening["to"]
    x, y = (x1 + x2) / 2, (y1 + y2) / 2
    half = opening["width"] / 2
    l, t, r, b = rect
    horizontal = x1 == x2 and y1 != y2
    if horizontal:
        bounds = (
            math.floor(x - half),
            min(y1, y2),
            math.ceil(x + half) + 1,
            max(y1, y2) + 1,
        )
        ends = ((l - 1, t, l, b), (r, t, r + 1, b))
        full = ((l - 1, bounds[1], l, bounds[3]), (r, bounds[1], r + 1, bounds[3]))
    elif y1 == y2 and x1 != x2:
        bounds = (
            min(x1, x2),
            math.floor(y - half),
            max(x1, x2) + 1,
            math.ceil(y + half) + 1,
        )
        ends = ((l, t - 1, r, t), (l, b, r, b + 1))
        full = ((bounds[0], t - 1, bounds[2], t), (bounds[0], b, bounds[2], b + 1))
    else:
        raise ValueError(
            "Wall infill needs a straight wall between two confirmed jambs."
        )
    if (
        not (l <= round(x) < r and t <= round(y) < b)
        or intersection(bounds, rect) != rect
    ):
        raise ValueError(
            "Keep the infill around the center and within the checked closure band."
        )

    def profile(image, strip):
        strip = rectangle(list(strip), image.size)
        luma = np.asarray(image.crop(strip))[..., :3] @ [0.299, 0.587, 0.114]
        return ((255 - luma if dark else luma) < 165).ravel()

    mark = profile(original, ends[0])
    if (
        mark[0]
        or mark[-1]
        or not mark.any()
        or any(mark.sum() != profile(original, strip).sum() for strip in full)
        or not np.array_equal(mark, profile(original, ends[1]))
        or any(not np.array_equal(mark, profile(source, strip)) for strip in ends)
    ):
        raise ValueError(
            "Choose clean jamb cuts with the same complete wall profile at both ends."
        )
    strip = original.crop(ends[0])
    candidate.paste(strip.resize((r - l, b - t), Image.Resampling.NEAREST), (l, t))


def run_checked(script, *arguments):
    command = [
        sys.executable,
        "-X",
        "utf8",
        "-B",
        str(Path(__file__).with_name(script)),
        *map(str, arguments),
    ]
    result = subprocess.run(
        command, check=False, capture_output=True, text=True, encoding="utf-8"
    )
    if result.returncode:
        raise ValueError(result.stderr.strip() or f"{script} failed.")
    return result.stdout


def repair(args):
    output = new_png(args.output_path)
    data = read_json(args.repair_path)
    review = read_json(args.original_locks_path)
    if not isinstance(data, dict):
        raise TypeError("Use a JSON object for the local corrections.")
    if "repairs" in data:
        if (
            len(data) != 1
            or not isinstance(data["repairs"], list)
            or not data["repairs"]
        ):
            raise ValueError("Provide a nonempty repairs array by itself.")
        grouped = defaultdict(list)
        for item in data["repairs"]:
            if not isinstance(item, dict) or item.get("type") not in KINDS:
                raise ValueError("Each repairs entry needs a supported type.")
            grouped[item["type"]].append(item)
        data = grouped
    if not any(data.get(kind) for kind in KINDS):
        raise ValueError("Provide at least one local correction.")
    if (data.get("infill") or data.get("bed")) and not args.before_protection:
        raise ValueError(
            "Wall infill and bed repairs must run before original protection."
        )
    if args.before_protection and review["originalSha256"].lower() != sha256(
        args.original_path
    ):
        raise ValueError(
            "The local edit needs the same original as the protection review."
        )
    source, original = open_image(args.base_path), open_image(args.original_path)
    if source.size != original.size:
        raise ValueError("Use the original canvas resolution for local corrections.")
    candidate = source.copy()
    dark = review.get("background") == "dark"
    edits = []
    with TemporaryDirectory(prefix="plan-repair-") as temp:
        folder = Path(temp)
        if data.get("bed"):
            spec = folder / "beds.json"
            spec.write_text(json.dumps(data["bed"]), encoding="utf-8")
            run_checked(
                "compile-plan-requirements.py",
                args.original_path,
                args.original_locks_path,
                "--check-bed-repair",
                spec,
            )
        for kind in KINDS:
            for item in data.get(kind) or []:
                rect = rectangle(item["rect"], source.size)
                l, t, r, b = rect
                if kind == "restore":
                    candidate.paste(original.crop(rect), (l, t))
                elif kind == "clear":
                    clear(source, candidate, rect, item, dark)
                elif kind == "move":
                    x, y = integers(item["to"], 2)
                    target = rectangle([x, y, x + r - l, y + b - t], source.size)
                    if "backgroundFrom" in item and rect == target:
                        raise ValueError(
                            "Choose a different position for the furniture."
                        )
                    empty = (
                        uncovered(rect, target) if "backgroundFrom" in item else rect
                    )
                    clear(source, candidate, empty, item, dark, rect)
                    candidate.paste(source.crop(rect), (x, y))
                    edits.append(target)
                elif kind == "infill":
                    infill(source, original, candidate, rect, item, review, dark)
                else:
                    draw_bed(candidate, rect, item["head"])
                edits.append(rect)
        preview = folder / "candidate.png"
        candidate.save(preview, "PNG")
        w, h = source.size
        corners = [(0, 0), (w - 1, 0), (w - 1, h - 1), (0, h - 1)]
        geometry = {
            "anchors": [{"base": p, "candidate": p} for p in corners],
            "edits": [
                {"points": [[a, b], [c, b], [c, d], [a, d]]} for a, b, c, d in edits
            ],
            "locks": [],
        }
        spec = folder / "geometry.json"
        spec.write_text(json.dumps(geometry), encoding="utf-8")
        options = [
            "--base-path",
            args.base_path,
            "--candidate-path",
            preview,
            "--geometry-path",
            spec,
            "--output-path",
            output,
        ]
        if not args.before_protection:
            options += [
                "--original-path",
                args.original_path,
                "--original-locks-path",
                args.original_locks_path,
            ]
        return run_checked("compose-plan-edit.py", *options)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("base", "repair", "original", "original-locks", "output"):
        parser.add_argument(f"--{name}-path", type=Path, required=True)
    parser.add_argument("--before-protection", action="store_true")
    try:
        print(repair(parser.parse_args()), end="")
    except (OSError, ValueError, TypeError, KeyError) as error:
        parser.exit(2, f"{error}\n")


if __name__ == "__main__":
    main()
