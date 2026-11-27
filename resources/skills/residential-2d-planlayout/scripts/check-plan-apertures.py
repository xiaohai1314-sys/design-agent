"""Check local wall crossings on a plan. Writes no image."""

import argparse
import hashlib
import json
from pathlib import Path

import cv2
import numpy as np


def point(value):
    coordinates = np.asarray(value, dtype=float)
    if coordinates.shape != (2,) or not np.isfinite(coordinates).all():
        raise ValueError("Expected a finite [x,y] coordinate in the image.")
    return coordinates


def sample_strip(image, start, end, across):
    start, end = point(start), point(end)
    distance = float(np.linalg.norm(end - start))
    across = float(across)
    if not 3 <= distance <= 600 or not 3 <= across <= 600:
        raise ValueError("Each local strip must be between 3 and 600 pixels on either axis.")
    along = (end - start) / distance
    normal = np.array([-along[1], along[0]])
    grid = (
        start + np.linspace(0, distance, round(distance) + 1)[:, None, None] * along
        + np.linspace(-across / 2, across / 2, round(across) + 1)[None, :, None] * normal
    )
    if np.any(grid.min(axis=(0, 1)) < 0) or np.any(grid.max(axis=(0, 1)) > np.array(image.shape[::-1]) - 1):
        raise ValueError("Strip extends beyond the plan image.")
    return cv2.remap(image, grid[:, :, 0].astype(np.float32), grid[:, :, 1].astype(np.float32), cv2.INTER_LINEAR)


def longest_run(values):
    edges = np.diff(np.r_[False, values, False].astype(np.int8))
    lengths = np.flatnonzero(edges == -1) - np.flatnonzero(edges == 1)
    return int(lengths.max(initial=0))


def crossing_width(probe):
    distance = float(np.linalg.norm(point(probe["to"]) - point(probe["from"])))
    width = float(probe["width"])
    if not 12 <= width <= 600 or not 3 <= distance <= width:
        raise ValueError(f"{probe['id']}: across-wall span {distance:.1f}px, along-wall sample width {width:g}px. "
                         "Put the endpoints just outside opposite wall faces. "
                         "Use a sample width of at least 12px and no smaller than the span.")
    return width


def expected_status(probe):
    return "line_across" if probe.get("state") == "closed" else "clear_sample"


def unchanged_beam_ink(original, probe):
    """Return source ink from explicitly located dashed overhead lines only."""
    rects = probe.get("sourceBeamLines", [])
    ink_mask = np.zeros(original.shape, dtype=bool)
    if not rects:
        return ink_mask
    name = probe["id"]
    if (not isinstance(rects, list) or len(rects) > 4 or probe.get("state") == "closed"
            or probe.get("surface", "linework") != "linework"):
        raise ValueError(f"{name}: use one to four original beam strokes for a linework passage.")
    height, width = original.shape
    travel = np.abs(point(probe["to"]) - point(probe["from"]))
    for rect in rects:
        if not isinstance(rect, list) or len(rect) != 4 or any(type(edge) is not int for edge in rect):
            raise ValueError(f"{name}: use four integer coordinates for each beam stroke.")
        left, top, right, bottom = rect
        strip_width, strip_height = right - left, bottom - top
        vertical = strip_height > strip_width
        thickness, length = sorted((strip_width, strip_height))
        if (not (0 <= left < right <= width and 0 <= top < bottom <= height)
                or not 1 <= thickness <= 6 or not 16 <= length <= 600
                or (vertical and travel[0] < 2 * travel[1])
                or (not vertical and travel[1] < 2 * travel[0])):
            raise ValueError(f"{name}: enclose a narrow original dashed line across the passage.")
        ink = original[top:bottom, left:right] < 205
        along = ink.any(axis=1 if vertical else 0)
        # Reject solid lines, short specks and a solid stroke with two tiny edge breaks.
        runs = np.flatnonzero(np.diff(np.r_[False, along, False].astype(np.int8))).reshape(-1, 2)
        lengths = runs[:, 1] - runs[:, 0]
        if (np.count_nonzero(lengths >= 3) < 2 or longest_run(~along) < 2
                or along.mean() > 0.90 or longest_run(along) > length / 2):
            raise ValueError(f"{name}: the selected marks are not a confirmed dashed source line.")
        ink_mask[top:bottom, left:right] |= ink
    return ink_mask


def inspect(image, probe):
    strip = sample_strip(image, probe["from"], probe["to"], crossing_width(probe))

    # A faint threshold and a stricter one separate unambiguous lines from marks
    # that could also be light flooring, a dimension line, or antialiasing.
    background = probe.get("surface", "linework")
    if background not in ("linework", "colored"):
        raise ValueError("Choose linework or colored for the opening surface.")
    colored = background == "colored" and probe.get("state") == "proposed"
    if colored:
        # Compare with the adjacent finish at each position along the opening.
        # Dark wood or a change of finish is not a line by itself.
        end_depth = max(1, len(strip) // 5)
        left_floor = np.percentile(strip[:end_depth], 75, axis=0)
        right_floor = np.percentile(strip[-end_depth:], 75, axis=0)
        floor = np.minimum(left_floor, right_floor)
        light = strip < np.clip(floor - 16, 65, 205)
        strong = strip < np.clip(floor - 32, 55, 165)
        # A few faint flecks in a floor texture can split an otherwise clear run.
        # Keep connected faint lines, dashed groups and every strong component.
        linked = cv2.morphologyEx(light.astype(np.uint8), cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
        _, labels, stats, _ = cv2.connectedComponentsWithStats(linked, connectivity=8)
        limit = min(6, max(2, len(strip) // 10))
        compact = (stats[:, cv2.CC_STAT_WIDTH] <= limit) & (stats[:, cv2.CC_STAT_HEIGHT] <= limit)
        compact[0] = False
        compact[np.unique(labels[strong])] = False
        light &= ~compact[labels]
    else:
        light = strip < 205
        strong = strip < 165
    closed = cv2.morphologyEx(strong.astype(np.uint8), cv2.MORPH_CLOSE, np.ones((1, 3), np.uint8))
    _, _, stats, _ = cv2.connectedComponentsWithStats(closed, connectivity=8)
    span = int(stats[1:, cv2.CC_STAT_WIDTH].max(initial=0))
    width = strip.shape[1]
    clear = longest_run(~light.any(axis=0))
    supports = [
        sample_strip(image, support["from"], support["to"], support["width"])
        for support in probe.get("wall_support", [])
    ]
    support_runs = [
        longest_run((support < 205).any(axis=1)) / support.shape[0]
        for support in supports
    ]
    if probe.get("state") == "closed":
        # A panel stopping just short of either jamb does not close the opening.
        components = stats[1:]
        starts = components[:, cv2.CC_STAT_LEFT]
        ends = starts + components[:, cv2.CC_STAT_WIDTH]
        line_across = np.any((starts <= 2) & (ends >= width - 2))
    else:
        line_across = span >= 0.9 * width
    if line_across:
        status = "line_across"
    elif supports and min(support_runs) < 0.55:
        status = "wall_end_unverified"
    elif clear >= 0.6 * width:
        status = "clear_sample"
    else:
        status = "review_sample"
    report = {
        "id": probe["id"],
        "status": status,
        "sampleWidthPx": width - 1,
        "longestClearPx": clear,
        "longestStrongLineSpanPx": span,
        "wallSupportFractions": [round(value, 3) for value in support_runs],
    }
    if colored:
        report["adjacentFloorGrayMedian"] = round(float(np.median(floor)), 1)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("plan", type=Path)
    parser.add_argument("probes", type=Path)
    parser.add_argument("--dark-background", action="store_true", help="treat light CAD linework as ink")
    args = parser.parse_args()
    try:
        image_bytes = args.plan.read_bytes()
        image = cv2.imdecode(np.frombuffer(image_bytes, dtype=np.uint8), cv2.IMREAD_GRAYSCALE)
        if image is None:
            raise ValueError("Cannot decode the plan image.")
        if args.dark_background:
            image = 255 - image
        probes = json.loads(args.probes.read_text(encoding="utf-8-sig"))["crossings"]
        ids = [probe["id"] for probe in probes]
        if not 1 <= len(ids) <= 8 or not all(isinstance(value, str) and value for value in ids) or len(set(ids)) != len(ids):
            raise ValueError("Provide one to eight uniquely named local crossings.")
        report = {"imageSha256": hashlib.sha256(image_bytes).hexdigest(), "crossings": [inspect(image, probe) for probe in probes]}
        print(json.dumps(report, ensure_ascii=True))
        if any(item["status"] != expected_status(probe) for probe, item in zip(probes, report["crossings"])):
            raise SystemExit(1)
    except (KeyError, OSError, TypeError, ValueError) as error:
        parser.exit(2, f"{error}\n")


if __name__ == "__main__":
    main()
