"""Source-pixel registration and footprint checks for a pair of floor plans."""

import math
from dataclasses import dataclass
from itertools import combinations
from pathlib import Path

import numpy as np
from PIL import Image
from plan_draw import polygon_mask
from plan_io import sha256

LEVELS = ("lower", "upper")
UNIT = ((0, 0), (1, 0), (0, 1), 1)


class OutsideEditRegion(ValueError):
    pass


@dataclass
class Landmarks:
    source: Path
    digest: str
    size: tuple
    points: list


@dataclass
class Floor:
    marks: Landmarks
    frame: tuple
    outline: list
    landing: tuple
    crop: tuple | None = None
    width: float | None = None
    turn: tuple | None = None
    approach: list | None = None


def checked_point(point, size):
    if (
        not isinstance(point, (list, tuple))
        or len(point) != 2
        or not all(type(n) in (int, float) and math.isfinite(n) for n in point)
    ):
        raise ValueError("Each point needs numeric x and y coordinates.")
    if not all(0 <= n < limit for n, limit in zip(point, size)):
        raise ValueError("Every point must lie inside its source image.")
    return tuple(point)


def landmarks(layer):
    source = Path(layer["image"]).resolve(strict=True)
    digest = sha256(source)
    with Image.open(source) as image:
        size = image.size
    return Landmarks(
        source, digest, size, [checked_point(point, size) for point in layer["anchors"]]
    )


def axes(a, b, c):
    u = (b[0] - a[0], b[1] - a[1])
    v = (c[0] - a[0], c[1] - a[1])
    return a, u, v, u[0] * v[1] - u[1] * v[0]


def project(point, source, target):
    a, u, v, det = source
    x, y = point[0] - a[0], point[1] - a[1]
    s, t = (x * v[1] - y * v[0]) / det, (u[0] * y - u[1] * x) / det
    a, u, v, _ = target
    return a[0] + s * u[0] + t * v[0], a[1] + s * u[1] + t * v[1]


def rounded(point):
    return [round(n, 1) for n in point]


def fit(marks, indices):
    frame = axes(*(marks.points[index] for index in indices))
    return frame if abs(frame[-1]) >= 0.015 * math.prod(marks.size) else None


def reference(layer):
    marks = landmarks(layer)
    if len(marks.points) != 4:
        raise ValueError(
            "Provide three corresponding anchors and a fourth check point per layer."
        )
    frame = fit(marks, (0, 1, 2))
    if frame is None:
        raise ValueError(
            "Choose three more widely separated, non-collinear common points."
        )
    if any(math.dist(point, marks.points[3]) < 1 for point in marks.points[:3]):
        raise ValueError(
            "Choose a separate fourth common point away from the three fitting points."
        )
    return marks, frame


def select_anchors(pair):
    lower, upper = (landmarks(pair[level]) for level in LEVELS)
    count = len(lower.points)
    if lower.digest == upper.digest:
        raise ValueError("Provide two distinct level plans.")
    if not 5 <= count <= 8 or len(upper.points) != count:
        raise ValueError(
            "Provide five to eight corresponding points in the same order on both floors."
        )
    if any(
        math.dist(a, b) < 1
        for marks in (lower, upper)
        for a, b in combinations(marks.points, 2)
    ):
        raise ValueError("Use distinct common features for the anchor candidates.")
    limit = 0.015 * min(upper.size)
    best_key, best = None, None
    for chosen in combinations(range(count), 3):
        first, second = fit(lower, chosen), fit(upper, chosen)
        if not first or not second or first[-1] * second[-1] < 0:
            continue
        checks = []
        for index in range(count):
            if index in chosen:
                continue
            projected = project(lower.points[index], first, second)
            error = math.dist(projected, upper.points[index])
            checks.append(
                {
                    "pair": index + 1,
                    "residualPx": round(error, 2),
                    "projectedUpper": rounded(projected),
                    "consistent": error <= limit,
                }
            )
        consistent = [row for row in checks if row["consistent"]]
        if len(consistent) < max(2, count - 4):
            continue
        witness = max(consistent, key=lambda row: row["residualPx"])
        key = len(consistent), -witness["residualPx"]
        if best_key is None or key > best_key:
            best_key, best = key, (chosen, witness, checks)
    if best is None:
        raise ValueError(
            "No anchor set fits both floors with two independent matching checks. Verify the original features."
        )
    chosen, witness, checks = best
    selected = (*chosen, witness["pair"] - 1)
    return {
        "status": "anchor_selection_ready",
        "selectedPairs": [index + 1 for index in selected],
        "checks": checks,
        "witnessDriftPx": witness["residualPx"],
        "checkTolerancePx": round(limit, 2),
        "lowerAnchors": [rounded(lower.points[i]) for i in selected],
        "upperAnchors": [rounded(upper.points[i]) for i in selected],
    }


def pair_references(pair):
    lower, first = reference(pair["lower"])
    upper, second = reference(pair["upper"])
    if lower.digest == upper.digest:
        raise ValueError("Provide two distinct level plans.")
    if first[-1] * second[-1] < 0:
        raise ValueError("The common-point order reverses between levels.")
    projected = project(lower.points[3], first, second)
    drift = math.dist(projected, upper.points[3])
    if drift > 0.015 * min(upper.size):
        raise ValueError(
            f"The fourth common point does not align. Lower source {rounded(lower.points[3])}, "
            f"upper source {rounded(upper.points[3])}, upper projection {rounded(projected)}, residual {drift:.1f} px."
        )
    return lower, first, upper, second, projected, drift


def mask(points, size):
    # Use the same pixel centers as the compositor for lock and edit boundaries.
    array = np.zeros((size[1], size[0]), dtype=bool)
    polygon = np.asarray(points, dtype=float)
    polygon[:, 0] = np.clip(polygon[:, 0], 0, size[0])
    polygon[:, 1] = np.clip(polygon[:, 1], 0, size[1])
    polygon_mask(array, polygon, True)
    return array


def assert_within(region, outline, size, level):
    if not isinstance(region, list) or not 3 <= len(region) <= 24:
        raise ValueError(f"Trace the {level} stair edit region as a polygon.")
    region = [checked_point(point, size) for point in region]
    if any(not (0 <= x < size[0] and 0 <= y < size[1]) for x, y in outline):
        raise OutsideEditRegion(f"The stairwell leaves the {level} canvas.")
    y, x = np.where(mask(outline, size) & ~mask(region, size))
    if len(x):
        raise OutsideEditRegion(
            f"The stairwell leaves the {level} edit region near pixel [{x[0]},{y[0]}]."
        )


def clear_locks(locks, outline, size, level, part="stairwell"):
    if locks is None:
        return
    if not isinstance(locks, list):
        raise TypeError(f"Provide {level} locked wall and column polygons as an array.")
    stair = mask(outline, size)
    for lock in locks:
        points = lock["points"]
        if not isinstance(points, list) or len(points) < 3:
            raise ValueError(
                f"A {level} lock needs at least three original-pixel points."
            )
        y, x = np.where(
            stair & mask([checked_point(point, size) for point in points], size)
        )
        if len(x):
            raise ValueError(
                f"The {level} {part} overlaps a locked component near [{x[0]},{y[0]}]."
            )


def lerp(a, b, t=0.5):
    return tuple(x + (y - x) * t for x, y in zip(a, b))


def straight_width(points):
    a, b, c, d = points
    width = min(math.dist(a, b), math.dist(c, d))
    length = math.dist(lerp(a, b), lerp(d, c))
    if width < 12 or length < 1.5 * width:
        raise ValueError(
            f"The straight flight is {length:.1f} px long and {width:.1f} px wide. Fit the full run and approaches."
        )
    return width


def landing_end(points, landing, level):
    a, b, c, d = points
    near, far = lerp(a, b), lerp(d, c)
    dx, dy = far[0] - near[0], far[1] - near[1]
    length = math.dist(near, far)
    if length < 1:
        raise ValueError(f"The {level} straight flight needs two distinct short ends.")
    along = ((landing[0] - near[0]) * dx + (landing[1] - near[1]) * dy) / length
    if 0 <= along <= length:
        raise ValueError(
            f"Place the {level} landing beyond a short end, outside the flight."
        )
    end = 0 if along < 0 else 1
    edge = (a, b) if end == 0 else (d, c)
    center = lerp(*edge)
    across = abs(
        ((landing[1] - center[1]) * dx - (landing[0] - center[0]) * dy) / length
    )
    if across >= math.dist(*edge) / 2:
        raise ValueError(
            f"Place the {level} landing within the approach to the selected short end."
        )
    return end, edge


def landing_approach(edge, landing, size):
    first, second = edge
    x, y = lerp(first, second)
    dx, dy = landing[0] - x, landing[1] - y
    return [
        first,
        second,
        *(checked_point((a + dx, b + dy), size) for a, b in (second, first)),
    ]


def approach_probe(approach, level):
    edge, arrival = lerp(*approach[:2]), lerp(*approach[2:])
    length = math.dist(edge, arrival)
    width = min(600, math.floor(0.75 * math.dist(*approach[:2])))
    if width < 12 or length < 12:
        raise ValueError(
            f"The {level} approach is too small to check. Mark a standing point farther into the floor."
        )
    return {
        "id": level + "-stair-approach",
        "state": "proposed",
        "surface": "colored",
        "width": width,
        "from": rounded(lerp(edge, arrival, min(0.20, 4 / length))),
        "to": rounded(lerp(edge, arrival, min(0.95, width / length))),
    }


def turn_flight(points, landing, level):
    a, b, c, d, e, f = points
    frame = axes(f, e, a)
    if abs(frame[-1]) < 100:
        raise ValueError(f"Check the six {level} L-stair corners in contour order.")
    (ix, iy), (cx, cy), (dx, dy) = (project(point, frame, UNIT) for point in (b, c, d))
    edge_tolerance = 0.12
    if (
        not 0 < ix < 1
        or abs(iy - 1) > edge_tolerance
        or abs(cx - ix) > edge_tolerance
        or abs(dx - 1) > edge_tolerance
        or cy <= 1.2
        or abs(dy - cy) > edge_tolerance
    ):
        raise ValueError(
            f"Trace the {level} L shape from the short end through the inside corner."
        )
    x, y = project(landing, frame, UNIT)
    if level == "lower" and not (x < 0 and 0 < y < 1):
        raise ValueError(
            "Place the lower start beyond the first short edge, in line with the flight."
        )
    if level == "upper" and not (y > cy and cx < x < dx):
        raise ValueError(
            "Place the upper landing beyond the far short edge, in line with the flight."
        )
    return lerp(f, e, ix), lerp(e, d, 1 / dy), (a, f) if level == "lower" else (c, d)


def generation_crop(value, size, required):
    if value is None:
        return None
    if (
        not isinstance(value, list)
        or len(value) != 4
        or any(type(n) is not int for n in value)
    ):
        raise ValueError(
            "A generation crop needs four integers: left, top, width, height."
        )
    x, y, w, h = value
    if not (0 <= x < x + w <= size[0] and 0 <= y < y + h <= size[1]):
        raise ValueError("The generation crop must fit its level plan.")
    if any(not (x <= a < x + w and y <= b < y + h) for a, b in required):
        raise ValueError(
            "Keep the entire stairwell and its approach in the generation crop."
        )
    return x, y, w, h


def stair_floors(pair, references, shape, require_locks, check_crop):
    lower, first, upper, second, _, _ = references
    footprint = pair["footprint"]
    if not 4 <= len(footprint) <= 12:
        raise ValueError(
            "Trace the planned stairwell with four to twelve lower-level points."
        )
    outline = [checked_point(point, lower.size) for point in footprint]
    area = sum(
        x * v - u * y for (x, y), (u, v) in zip(outline, outline[1:] + outline[:1])
    )
    if abs(area) < 10:
        raise ValueError("Trace the stairwell corners in contour order.")
    expected = 4 if shape == "straight" else 6
    if shape and len(outline) != expected:
        raise ValueError(
            f"Drawing a {shape} stair needs a {expected}-corner footprint and both edit regions."
        )
    upstairs = [
        checked_point(project(point, first, second), upper.size) for point in outline
    ]
    floors, ends = {}, []
    for level, marks, frame, points in (
        ("lower", lower, first, outline),
        ("upper", upper, second, upstairs),
    ):
        layer = pair[level]
        landing = checked_point(pair[level + "Landing"], marks.size)
        edit, locks = pair.get(level + "EditRegion"), layer.get("locks")
        if require_locks and (not edit or not isinstance(locks, list) or not locks):
            raise ValueError(
                f"Mark the {level} edit region and fixed source polygons before drawing or composing."
            )
        if edit is not None:
            assert_within(edit, points, marks.size, level)
        clear_locks(locks, points, marks.size, level)
        floor = Floor(marks, frame, points, landing)
        if shape:
            if shape == "straight":
                floor.width = straight_width(points)
                end, edge = landing_end(points, landing, level)
                ends.append(end)
            else:
                floor.turn = turn_flight(points, landing, level)
                edge = floor.turn[2]
            floor.approach = landing_approach(edge, landing, marks.size)
            clear_locks(locks, floor.approach, marks.size, level, "landing approach")
        if check_crop:
            floor.crop = generation_crop(
                layer.get("generationCrop"),
                marks.size,
                points + (floor.approach or [landing]),
            )
        floors[level] = floor
    if shape == "straight" and ends[0] == ends[1]:
        raise ValueError(
            "Put the lower start and upper landing at opposite flight ends."
        )
    return floors
