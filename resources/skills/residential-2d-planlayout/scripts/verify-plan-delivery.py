"""Verify a composed plan against its original and stage the verified PNG bytes."""

import argparse
import hashlib
import io
import json
from importlib import import_module
from pathlib import Path
from tempfile import TemporaryDirectory

import cv2
import numpy as np
from PIL import Image

apertures = import_module("check-plan-apertures")
inspect_crossing = apertures.inspect
expected_crossing_status = apertures.expected_status
simple_polygon = import_module("layout_use_check").points


def digest(data):
    return hashlib.sha256(data).hexdigest()


def read_image(data, require_png=False):
    with Image.open(io.BytesIO(data)) as image:
        if require_png and image.format != "PNG":
            raise ValueError("The candidate must be a PNG.")
        return np.asarray(image.convert("RGBA"))


def region_mask(shape, regions, require_pixels=True):
    if not regions:
        raise ValueError("Provide explicit edit and protection polygons in original image pixels.")
    height, width = shape
    mask = np.zeros(shape, dtype=np.uint8)
    for region in regions:
        points = np.asarray(region["points"], dtype=float)
        if points.ndim != 2 or points.shape[0] < 3 or points.shape[1] != 2 or not np.isfinite(points).all():
            raise ValueError("Each region needs at least three finite [x,y] vertices.")
        if np.any(points < 0) or np.any(points >= [width, height]):
            raise ValueError("A region is outside the original canvas.")
        if cv2.contourArea(points.astype(np.float32)) < 1:
            raise ValueError("Each region must enclose at least one square pixel.")
        left, top = np.floor(points.min(axis=0)).astype(int)
        right, bottom = np.ceil(points.max(axis=0)).astype(int)
        # Test pixel centers. Integer right and bottom edges are exclusive.
        x = np.arange(left, right)[None, :] + 0.5
        y = np.arange(top, bottom)[:, None] + 0.5
        inside = np.zeros((bottom - top, right - left), dtype=bool)
        for (x0, y0), (x1, y1) in zip(points, np.roll(points, -1, axis=0)):
            if y0 != y1:
                inside ^= ((y0 > y) != (y1 > y)) & (x < x0 + (y - y0) * (x1 - x0) / (y1 - y0))
        mask[top:bottom, left:right] |= inside
    if require_pixels and not mask.any():
        raise ValueError("No pixel centers fall inside the supplied polygons.")
    return mask


def clearance_map(gray):
    # Lettering and door swing symbols can trigger visual review.
    free = cv2.copyMakeBorder((gray >= 205).astype(np.uint8), 1, 1, 1, 1, cv2.BORDER_CONSTANT, value=0)
    return cv2.distanceTransform(free, cv2.DIST_L2, cv2.DIST_MASK_PRECISE)[1:-1, 1:-1]


def inspect_routes(gray, routes):
    if not routes:
        return []
    ids = [item["id"] for item in routes]
    if len(ids) > 8 or any(not isinstance(name, str) or not name for name in ids) or len(set(ids)) != len(ids):
        raise ValueError("Provide at most eight uniquely named routes.")
    height, width = gray.shape
    clearance = clearance_map(gray)
    reports = []
    for route in routes:
        ends = [route["from"], *route.get("via", []), route["to"]]
        if any(not isinstance(point, list) or len(point) != 2 or any(type(value) is not int for value in point)
               or not (0 <= point[0] < width and 0 <= point[1] < height) for point in ends):
            raise ValueError("Each route needs original-pixel approach points.")
        if ends[0] == ends[-1]:
            raise ValueError("Route endpoints must differ.")
        distance = float(route["widthPx"])
        if not np.isfinite(distance) or distance < 1:
            raise ValueError("Provide a positive route width in original pixels.")
        area = region_mask(gray.shape, route["areas"]) != 0
        if any(not area[y, x] for x, y in ends):
            raise ValueError("Both approach points must be inside the route area.")
        passable = ((clearance > distance / 2) & area).astype(np.uint8)
        _, components = cv2.connectedComponents(passable, connectivity=4)
        waypoint_components = [components[y, x] for x, y in ends]
        connected = len(set(waypoint_components)) == 1 and waypoint_components[0] != 0
        report = {"id": route["id"], "widthPx": distance,
                  "status": "connected" if connected else "route_needs_review"}
        if not connected:
            report["blockedWaypoints"] = [
                {"point": point, "lineworkClearancePx": round(float(clearance[point[1], point[0]]), 2)}
                for point, component in zip(ends, waypoint_components) if component == 0
            ]
            report["segmentsNeedingReview"] = [
                {"from": ends[index], "to": ends[index + 1]}
                for index, (first, second) in enumerate(zip(waypoint_components, waypoint_components[1:]))
                if first == 0 or first != second
            ]
        reports.append(report)
    return reports


def route_opening_positions(points, probe):
    start, end = np.asarray([probe["from"], probe["to"]], dtype=float)
    axis = end - start
    length = np.linalg.norm(axis)
    if length == 0 or not np.isfinite(length):
        raise ValueError("An opening needs distinct approach points.")
    center = (start + end) / 2
    normal = np.array([-axis[1], axis[0]]) / length
    locations = np.asarray(points, dtype=float) - center
    offsets = locations @ axis
    positions = []
    # The centerline must cross the opening from one side to the other.
    previous = None
    for index, offset in enumerate(offsets):
        if offset == 0:
            continue
        if previous is not None and offsets[previous] * offset < 0:
            fraction = -offsets[previous] / (offset - offsets[previous])
            crossing = (locations[previous + 1] if index > previous + 1 else
                        locations[previous] + fraction * (locations[index] - locations[previous]))
            if abs(crossing @ normal) <= float(probe["width"]) / 2:
                positions.append(previous + fraction if index == previous + 1 else float(previous + 1))
        previous = index
    return positions


def verify_route_anchors(route, points, probes, gray=None):
    if "destinationRect" in route:
        if gray is None:
            raise ValueError("Destination checks require the source plan.")
        rect = route["destinationRect"]
        if not isinstance(rect, list) or len(rect) != 4 or any(type(edge) is not int for edge in rect):
            raise ValueError("A route destination needs four original-pixel edges.")
        left, top, right, bottom = rect
        height, width = gray.shape
        if not (0 <= left < right <= width and 0 <= top < bottom <= height):
            raise ValueError("The route destination must lie within the original plan.")
        x, y = points[-1]
        if not (left <= x < right and top <= y < bottom):
            raise ValueError(f"Route {route['id']} stops short of its destination area.")
    previous = -1
    for opening in route.get("crossingIds", []):
        if opening not in probes:
            raise ValueError(f"Route {route['id']} references an unknown opening: {opening}.")
        probe = probes[opening]
        if probe.get("state") == "closed":
            raise ValueError(f"Route {route['id']} cannot use an opening marked for closure: {opening}.")
        if gray is not None:
            check = inspect_crossing(gray, probe)
            if check["status"] != "clear_sample":
                raise ValueError(f"{opening}: {check['status']}, clear strip "
                                 f"{check['longestClearPx']}/{check['sampleWidthPx']}px. "
                                 "Check the original opening, wall faces and door symbols.")
        hits = route_opening_positions(points, probe)
        following = next((position for position in hits if position > previous), None)
        if following is None:
            raise ValueError(f"Route {route['id']} does not cross opening {opening} in order.")
        previous = following


def planned_circuit_geometry(shape, circuits, crossings):
    if not isinstance(circuits, list) or not 1 <= len(circuits) <= 4:
        raise ValueError("Provide one to four planned circuits.")
    ids = [circuit["id"] for circuit in circuits]
    if any(not isinstance(name, str) or not name for name in ids) or len(set(ids)) != len(ids):
        raise ValueError("Planned circuits need unique names.")
    probes = {probe["id"]: probe for probe in crossings}
    height, width = shape
    for circuit in circuits:
        points = circuit["points"]
        if (not isinstance(points, list) or not 4 <= len(points) <= 25 or points[0] != points[-1]
                or any(not isinstance(point, list) or len(point) != 2
                       or any(type(value) is not int for value in point)
                       or not (0 <= point[0] < width and 0 <= point[1] < height) for point in points)):
            raise ValueError("Use original-pixel circuit waypoints and return to the first point.")
        if len({tuple(point) for point in points[:-1]}) != len(points) - 1:
            raise ValueError("Use each circuit waypoint once, except for the closing point.")
        simple_polygon(points)
        clear_width = float(circuit["widthPx"])
        corridor_width = float(circuit.get("corridorWidthPx", clear_width + 8))
        if not np.isfinite([clear_width, corridor_width]).all() or not 1 <= clear_width <= corridor_width <= min(height, width):
            raise ValueError("Use positive pixel widths for the circuit and its search corridor.")
        openings = circuit.get("crossingIds", [])
        if (not isinstance(openings, list) or len(openings) > 8
                or any(not isinstance(name, str) or name not in probes for name in openings)
                or len(set(openings)) != len(openings)):
            raise ValueError("List the actual wall openings in travel order, with unique IDs.")
        centers = {tuple((np.asarray(probes[name]["from"]) + probes[name]["to"]) / 2) for name in openings}
        if len(centers) != len(openings):
            raise ValueError("Each circuit opening must have a different position.")
        # Opening samples are evaluated by the caller on the final image.
        verify_route_anchors({"id": circuit["id"], "crossingIds": openings}, points, probes)
        yield circuit["id"], points, clear_width, corridor_width


def inspect_planned_circuits(gray, circuits, crossings):
    height, width = gray.shape
    clearance = clearance_map(gray)
    reports = []
    for name, points, clear_width, corridor_width in planned_circuit_geometry(gray.shape, circuits, crossings):
        failed = []
        for first, second in zip(points, points[1:]):
            a, b = np.asarray([first, second], dtype=float)
            pad = corridor_width / 2
            left, top = np.maximum(np.floor(np.minimum(a, b) - pad).astype(int), 0)
            right, bottom = np.minimum(np.ceil(np.maximum(a, b) + pad).astype(int) + 1, [width, height])
            y, x = np.ogrid[top:bottom, left:right]
            vector = b - a
            progress = np.clip(((x - a[0]) * vector[0] + (y - a[1]) * vector[1]) / (vector @ vector), 0, 1)
            corridor = (x - a[0] - progress * vector[0]) ** 2 + (y - a[1] - progress * vector[1]) ** 2 <= pad ** 2
            passable = corridor & (clearance[top:bottom, left:right] > clear_width / 2)
            _, components = cv2.connectedComponents(passable.astype(np.uint8), connectivity=4)
            start = components[first[1] - top, first[0] - left]
            if not start or start != components[second[1] - top, second[0] - left]:
                failed.append({"from": first, "to": second})
        report = {"id": name, "widthPx": clear_width,
                  "status": "circuit_needs_review" if failed else "connected",
                  "segmentsNeedingReview": failed}
        if failed:
            blocked = [{"point": [x, y], "lineworkClearancePx": round(float(clearance[y, x]), 1)}
                       for x, y in points[:-1] if clearance[y, x] <= clear_width / 2]
            if blocked:
                report["blockedWaypoints"] = blocked
        reports.append(report)
    return reports


def suggest_turn_cleanup(gray, original_gray, allowed, circuits, crossings, reports):
    blocked = [(result, point["point"]) for result in reports for point in result.get("blockedWaypoints", [])]
    if len(blocked) != 1:
        return None
    result, (x, y) = blocked[0]
    radius = int(np.ceil(result["widthPx"] / 2))
    height, width = gray.shape
    left, top = max(0, x - radius), max(0, y - radius)
    right, bottom = min(width, x + radius + 1), min(height, y + radius + 1)
    _, labels, stats, _ = cv2.connectedComponentsWithStats((gray < 205).astype(np.uint8), connectivity=8)
    yy, xx = np.ogrid[top:bottom, left:right]
    disk = (xx - x) ** 2 + (yy - y) ** 2 <= radius ** 2
    nearby = np.unique(labels[top:bottom, left:right][disk])
    nearby = nearby[nearby != 0]
    if len(nearby) != 1:
        return None
    bx, by, bw, bh, _ = (int(value) for value in stats[nearby[0]])
    if max(bw, bh) > 5 * radius or bw * bh > 4 * radius ** 2:
        return None
    rect = [bx, by, bx + bw, by + bh]
    if rect[2] >= width or rect[3] >= height:
        return None
    x0, y0, x1, y1 = rect
    area = np.s_[y0:y1, x0:x1]
    if (not allowed[area].all() or (original_gray[area] < 205).any()
            or np.any((labels[area] != 0) & (labels[area] != nearby[0])) or gray[y, x] < 245):
        return None
    simulated = gray.copy()
    simulated[area] = gray[y, x]
    if any(item["status"] != "connected" for item in inspect_planned_circuits(simulated, circuits, crossings)):
        return None
    if any(inspect_crossing(simulated, probe)["status"] != expected_crossing_status(probe) for probe in crossings):
        return None
    return {"review": "Confirm this is a complete, optional object before using the repair.",
            "point": [x, y], "repair": {"clear": [{"rect": rect, "background": [x, y]}]}}


def suggest_opening_cleanup(gray, allowed, probe, report, probes):
    if probe.get("state") != "proposed" or report["status"] not in ("review_sample", "line_across"):
        return None
    left, top, right, bottom = report["sampleRect"]
    _, labels, stats, _ = cv2.connectedComponentsWithStats((gray < 205).astype(np.uint8), connectivity=8)
    present = np.unique(labels[top:bottom, left:right])
    components = stats[present[present != 0]]
    if not len(components):
        return None
    x0, y0 = components[:, :2].min(axis=0) - 1
    x1, y1 = (components[:, :2] + components[:, 2:4]).max(axis=0) + 1
    # A larger object that extends away from the probe needs manual review.
    height, width = gray.shape
    if not (0 <= x0 < x1 <= width and 0 <= y0 < y1 <= height and
            x0 >= left - 8 and y0 >= top - 8 and x1 <= right + 8 and y1 <= bottom + 8):
        return None
    area = np.s_[y0:y1, x0:x1]
    included = np.unique(labels[area])
    if not allowed[area].all() or not np.isin(included, present).all():
        return None
    backgrounds = np.argwhere((gray[top:bottom, left:right] == 255) & allowed[top:bottom, left:right])
    if not len(backgrounds):
        return None
    by, bx = (int(value) for value in backgrounds[0])
    bx, by = bx + left, by + top
    simulated = gray.copy()
    simulated[area] = gray[by, bx]
    if any(inspect_crossing(simulated, item)["status"] != expected_crossing_status(item) for item in probes):
        return None
    return {
        "id": probe["id"],
        "review": "Check the detail image. Use this only if the whole marked group is an approved separator, redundant annotation or leftover linework.",
        "repair": {"clear": [{"rect": [int(x0), int(y0), int(x1), int(y1)], "background": [bx, by]}]},
    }


def suggest_opening_patch(allowed, probe, report, footprints):
    if probe.get("state") != "proposed" or "clearRect" not in probe:
        return None
    x0, y0 = probe["from"]
    x1, y1 = probe["to"]
    if x0 != x1 and y0 != y1:
        return None
    left, top, right, bottom = report["sampleRect"]
    height, width = allowed.shape
    available = allowed.copy()
    for left_edge, top_edge, right_edge, bottom_edge in footprints:
        available[top_edge:bottom_edge, left_edge:right_edge] = False
    safe = cv2.erode(available.astype(np.uint8), np.ones((3, 3), np.uint8), borderType=cv2.BORDER_CONSTANT,
                     borderValue=0).astype(bool)
    rect = [left, top, right, bottom]
    if not safe[top:bottom, left:right].all():
        # The approaches can include fixed floor pixels. Only propose editing
        # from the confirmed separator, while the full sample still gets checked.
        rect = probe["clearRect"]
        if not isinstance(rect, list) or len(rect) != 4 or any(type(edge) is not int for edge in rect):
            return None
        l, t, r, b = rect
        if not (left <= l < r <= right and top <= t < b <= bottom and safe[t:b, l:r].all()):
            return None
    depth_margin = min(64, max(20, 2 * int(np.hypot(x1 - x0, y1 - y0))))
    along = (0, 2) if x0 == x1 else (1, 3)
    limits = [max(0, left - 110), max(0, top - 80), min(width - 1, right + 110), min(height - 1, bottom + 80)]
    for sides, margin in ((along, 12), ((i for i in range(4) if i not in along), depth_margin)):
        for side in sides:
            for _ in range(margin):
                extended = rect.copy()
                extended[side] += -1 if side < 2 else 1
                l, t, r, b = extended
                if (l < limits[0] or t < limits[1] or r > limits[2] or b > limits[3] or
                        not safe[t:b, l:r].all()):
                    break
                rect = extended
    return rect


def add_existing_route_locks(original_bytes, review):
    if digest(original_bytes) != review["originalSha256"]:
        raise ValueError("The route review does not identify the original plan.")
    gray = cv2.cvtColor(read_image(original_bytes), cv2.COLOR_RGBA2GRAY)
    background = review.get("background", "light")
    if background not in ("light", "dark"):
        raise ValueError("Choose a light or dark linework background.")
    if background == "dark":
        gray = 255 - gray
    locks = list(review.get("locks", []))
    routes = list(review.get("routes", []))
    probes = {probe["id"]: probe for probe in review.get("crossings", [])}
    first_openings = set()
    start = len(routes)
    for route in review["existingRoutes"]:
        points = route["points"]
        width = float(route["widthPx"])
        reserve = float(route.get("reservedWidthPx", width + 4))
        if (not isinstance(points, list) or not 2 <= len(points) <= 24
                or any(not isinstance(point, list) or len(point) != 2
                       or any(type(value) is not int for value in point) for point in points)
                or not np.isfinite([width, reserve]).all() or not 1 <= width <= reserve):
            raise ValueError("An existing route needs 2 to 24 integer points and valid pixel widths.")
        crossing_ids = route.get("crossingIds", [])
        if (not isinstance(crossing_ids, list) or len(crossing_ids) > 8
                or any(not isinstance(name, str) or not name for name in crossing_ids)
                or len(set(crossing_ids)) != len(crossing_ids)):
            raise ValueError("List up to eight different opening IDs in route order.")
        if review.get("distinctRouteExits"):
            if "destinationRect" not in route:
                raise ValueError(f"Route {route['id']} needs a destination inside the target room.")
            if not crossing_ids:
                raise ValueError("Each route needs a different first opening from the entry zone.")
            first_opening = probes.get(crossing_ids[0])
            if first_opening is not None:
                center = tuple((np.asarray(first_opening["from"]) + first_opening["to"]) / 2)
                if center in first_openings:
                    raise ValueError("Distinct entry openings must use different positions on the original plan.")
                first_openings.add(center)
        verify_route_anchors(route, points, probes, gray)
        areas = []
        for first, second in zip(points, points[1:]):
            a, b = np.asarray([first, second], dtype=float)
            length = np.linalg.norm(b - a)
            if not length:
                raise ValueError("Consecutive route points must differ.")
            along = (b - a) / length * reserve / 2
            across = np.array([-along[1], along[0]])
            corners = [a - along + across, b + along + across, b + along - across, a - along - across]
            areas.append({"points": [point.tolist() for point in corners]})
        locks.extend(areas)
        routes.append({"id": route["id"], "from": points[0], "via": points[1:-1], "to": points[-1],
                       "widthPx": width, "areas": areas})
    ids = [route["id"] for route in routes]
    if len(routes) == start or len(routes) > 8 or len(set(ids)) != len(ids):
        raise ValueError("Provide at least one existing route and at most eight uniquely named routes in total.")
    results = inspect_routes(gray, routes[start:])
    failed = [result["id"] for result in results if result["status"] != "connected"]
    if failed:
        raise ValueError("Check route points and clear width on the original plan: " + ", ".join(failed))
    expanded = {**review, "locks": locks, "routes": routes}
    del expanded["existingRoutes"]
    return expanded


def inspect_seams(original_gray, composed_gray, allowed, aligned_gray=None):
    boundary = allowed & ~cv2.erode(allowed.astype(np.uint8), np.ones((3, 3), np.uint8)).astype(bool)
    frame = np.concatenate((original_gray[0], original_gray[-1], original_gray[:, 0], original_gray[:, -1]))
    background = float(np.median(frame))
    original_ink = cv2.dilate((original_gray <= background - 20).astype(np.uint8), np.ones((7, 7), np.uint8))
    contacts = boundary & (composed_gray <= background - 32) & (original_ink == 0)
    lost_contacts = np.zeros(allowed.shape, dtype=bool)
    if aligned_gray is not None:
        # Thin generated linework can be fainter than the composed-image
        # heuristic. Look for strokes that straddle the actual clip boundary.
        contrast = original_gray.astype(np.int16) - aligned_gray
        new_ink = (contrast >= 16) & (aligned_gray <= background - 16) & (original_ink == 0)
        clipped = (new_ink & ~allowed).astype(np.uint8)
        next_to_clipped = cv2.dilate(clipped, np.ones((3, 3), np.uint8)).astype(bool)
        lost_contacts = boundary & new_ink & next_to_clipped
        contacts |= lost_contacts
    y, x = np.where(contacts)
    if not x.size:
        return []

    # Group nearby endpoints so the reader can inspect a few regions at plan scale.
    contacts = np.zeros(allowed.shape, dtype=np.uint8)
    contacts[y, x] = 1
    neighborhoods = cv2.dilate(contacts, np.ones((25, 25), np.uint8))
    count, labels = cv2.connectedComponents(neighborhoods)
    groups = labels[y, x]
    support = np.bincount(groups, minlength=count)
    lost_support = np.bincount(groups[lost_contacts[y, x]], minlength=count)
    selected = sorted(range(1, count), key=lambda index: (-lost_support[index], -support[index]))
    reports = []
    for index in selected:
        if support[index] < 8 and lost_support[index] < 3:
            continue
        members = groups == index
        left, right = int(x[members].min()), int(x[members].max()) + 1
        top, bottom = int(y[members].min()), int(y[members].max()) + 1
        report = {"rect": [left, top, right, bottom], "contactPixels": int(support[index])}
        if lost_support[index]:
            report["clippedStrokeContacts"] = int(lost_support[index])
        reports.append(report)
        if len(reports) == 6:
            break
    return reports


def uncovered_plan_points(points, allowed, locked):
    height, width = allowed.shape
    seen = set()
    missing = []
    for item in points:
        name = item["id"]
        mode = item.get("mode", "edit")
        if not isinstance(name, str) or not name.strip() or name in seen or mode not in ("edit", "preserve"):
            raise ValueError("Plan checks need unique names and an edit or preserve mode.")
        if ("point" in item) == ("rect" in item):
            raise ValueError("Each plan check needs either a point or a rectangle.")
        seen.add(name)
        if "point" in item:
            point = item["point"]
            if (not isinstance(point, list) or len(point) != 2 or any(type(value) is not int for value in point)
                    or not (0 <= point[0] < width and 0 <= point[1] < height)):
                raise ValueError("Plan check points must use integer coordinates inside the original image.")
            x, y = point
            area = np.s_[y:y + 1, x:x + 1]
            location = {"point": point}
        else:
            rect = item["rect"]
            if not isinstance(rect, list) or len(rect) != 4 or any(type(value) is not int for value in rect):
                raise ValueError("Plan check rectangles need four integer original-pixel edges.")
            left, top, right, bottom = rect
            if not (0 <= left < right <= width and 0 <= top < bottom <= height):
                raise ValueError("Plan check rectangles must lie inside the original image.")
            area = np.s_[top:bottom, left:right]
            location = {"rect": rect}
        coverage = allowed[area]
        if mode == "preserve" and coverage.any():
            missing.append({"id": name, **location, "reason": "inside_edit_area"})
        if mode == "edit" and not coverage.all():
            reason = "locked" if locked[area].any() else "outside_edit_area"
            missing.append({"id": name, **location, "reason": reason})
    return missing


def verify(original_bytes, candidate_bytes, requirements_bytes, inspect_compose_seams=False,
           aligned_candidate_bytes=None, include_opening_patch=False, include_crossing_samples=False,
           *, require_candidate_png=True):
    requirements = json.loads(requirements_bytes.decode("utf-8-sig"))
    report = {
        "status": "rejected",
        "originalSha256": digest(original_bytes),
        "candidateSha256": digest(candidate_bytes),
        "requirementsSha256": digest(requirements_bytes),
        "issues": [],
    }
    issues = report["issues"]
    if report["originalSha256"] != requirements["originalSha256"]:
        issues.append("original_hash_mismatch")
        return report
    original = read_image(original_bytes)
    candidate = read_image(candidate_bytes, require_png=require_candidate_png)
    report["originalSize"] = [original.shape[1], original.shape[0]]
    report["candidateSize"] = [candidate.shape[1], candidate.shape[0]]
    if original.shape != candidate.shape:
        issues.append("canvas_size_changed")
        return report

    edit = region_mask(original.shape[:2], requirements["edits"])
    locked = region_mask(original.shape[:2], requirements["locks"]).astype(bool)
    allowed = (edit != 0) & ~locked
    changed = np.any(original != candidate, axis=2)
    # The compositor can cover an edge differently on sloped edit polygons.
    # Allow a one-pixel edge band for edits; locks have no allowance.
    outside = cv2.dilate(edit, np.ones((3, 3), dtype=np.uint8)) == 0
    report["changedPixels"] = int(changed.sum())
    report["changedOutsideExact"] = int(np.count_nonzero(changed & (edit == 0)))
    report["changedOutside"] = int(np.count_nonzero(changed & outside))
    report["protectedPixels"] = int(locked.sum())
    report["changedProtected"] = int(np.count_nonzero(changed & locked))
    if report["changedOutside"]:
        issues.append("pixels_changed_outside_edits")
    if report["changedProtected"]:
        issues.append("protected_pixels_changed")
        locations = []
        for index, region in enumerate(requirements["locks"], 1):
            polygon = np.asarray(region["points"], dtype=float)
            left, top = np.floor(polygon.min(axis=0)).astype(int)
            right, bottom = np.ceil(polygon.max(axis=0)).astype(int)
            local_changed = changed[top:bottom, left:right]
            if not local_changed.any():
                continue
            local_region = {"points": (polygon - [left, top]).tolist()}
            # Include the exclusive right and bottom coordinates as polygon vertices.
            local_mask = region_mask((bottom - top + 1, right - left + 1), [local_region],
                                     require_pixels=False)[:-1, :-1]
            y, x = np.where(local_changed & local_mask.astype(bool))
            if x.size:
                locations.append({
                    "id": region.get("id", f"lock-{index}"),
                    "rect": [int(x.min() + left), int(y.min() + top),
                             int(x.max() + left + 1), int(y.max() + top + 1)],
                    "changedPixels": int(x.size),
                })
        report["changedProtectedRegions"] = sorted(
            locations, key=lambda location: -location["changedPixels"]
        )[:8]
    if not report["changedPixels"]:
        issues.append("no_layout_changes")
    if "planPoints" in requirements:
        report["uncoveredPlanPoints"] = uncovered_plan_points(requirements["planPoints"], allowed, locked)
        if report["uncoveredPlanPoints"]:
            issues.append("plan_points_not_covered")

    probes = requirements.get("crossings", [])
    ids = [probe["id"] for probe in probes]
    if len(ids) > 8 or any(not isinstance(name, str) or not name for name in ids) or len(set(ids)) != len(ids):
        raise ValueError("Provide at most eight uniquely named crossing samples.")
    finish_gray = cv2.cvtColor(candidate, cv2.COLOR_RGBA2GRAY)
    background = requirements.get("background", "light")
    if background not in ("light", "dark"):
        raise ValueError("Choose a light or dark linework background.")
    gray = 255 - finish_gray if background == "dark" else finish_gray
    # A proposed colored opening is sampled against the actual floor finish.
    # The surrounding CAD sheet can still contain light-on-dark linework.
    report["crossings"] = []
    for probe in probes:
        if probe.get("sourceBeamLines"):
            source_gray = cv2.cvtColor(original, cv2.COLOR_RGBA2GRAY)
            if background == "dark":
                source_gray = 255 - source_gray
            unchanged = apertures.unchanged_beam_ink(source_gray, probe) & ~changed
            sampled = gray.copy()
            sampled[unchanged] = 255
            result = inspect_crossing(sampled, probe)
            result["ignoredUnchangedSourceBeamPixels"] = int(np.count_nonzero(unchanged))
        else:
            sampled = finish_gray if probe.get("surface") == "colored" and probe.get("state") == "proposed" else gray
            result = inspect_crossing(sampled, probe)
        report["crossings"].append(result)
    failed_crossings = []
    for probe, result in zip(probes, report["crossings"]):
        expected = expected_crossing_status(probe)
        if probe.get("state") == "closed":
            result["expectedStatus"] = expected
        failed = result["status"] != expected
        if failed:
            failed_crossings.append((probe, result))
        if not (failed or include_crossing_samples):
            continue
        start, end = np.asarray([probe["from"], probe["to"]], dtype=float)
        along = end - start
        across = np.abs(np.array([-along[1], along[0]]) / np.linalg.norm(along)) * float(probe["width"]) / 2
        low = np.maximum(np.floor(np.minimum(start, end) - across), 0).astype(int)
        high = np.minimum(np.ceil(np.maximum(start, end) + across) + 1, gray.shape[::-1]).astype(int)
        result["sampleRect"] = [*low.tolist(), *high.tolist()]
    if failed_crossings:
        issues.append("crossing_needs_review")
    if "routes" in requirements:
        report["routes"] = inspect_routes(gray, requirements["routes"])
        if any(item["status"] != "connected" for item in report["routes"]):
            issues.append("route_needs_review")
    if "plannedCircuits" in requirements:
        report["plannedCircuits"] = inspect_planned_circuits(gray, requirements["plannedCircuits"], probes)
        if any(item["status"] != "connected" for item in report["plannedCircuits"]):
            issues.append("circuit_needs_review")
    if include_opening_patch and issues == ["crossing_needs_review"] and len(failed_crossings) == 1:
        probe, failed_check = failed_crossings[0]
        footprints = [item["rect"] for item in requirements.get("planPoints", [])
                      if item.get("showOnGuide") and "rect" in item]
        patch = suggest_opening_patch(allowed, probe, failed_check, footprints)
        if patch:
            report["openingPatch"] = patch
    if inspect_compose_seams and background == "light" and issues == ["circuit_needs_review"]:
        original_gray = cv2.cvtColor(original, cv2.COLOR_RGBA2GRAY)
        cleanup = suggest_turn_cleanup(gray, original_gray, allowed, requirements["plannedCircuits"],
                                       probes, report["plannedCircuits"])
        if cleanup:
            report["turnCleanup"] = cleanup
    if inspect_compose_seams and background == "light" and issues == ["crossing_needs_review"]:
        if len(failed_crossings) == 1:
            probe, failed_check = failed_crossings[0]
            cleanup = suggest_opening_cleanup(gray, allowed, probe, failed_check, probes)
            if cleanup:
                report["openingCleanup"] = cleanup
    if inspect_compose_seams:
        original_gray = cv2.cvtColor(original, cv2.COLOR_RGBA2GRAY)
        aligned_gray = None
        if aligned_candidate_bytes is not None:
            aligned = read_image(aligned_candidate_bytes, require_png=True)
            if aligned.shape != original.shape:
                raise ValueError("The aligned candidate must match the original canvas.")
            # Transparent borders are outside the registered candidate.
            aligned_gray = cv2.cvtColor(aligned, cv2.COLOR_RGBA2GRAY)
            aligned_gray[aligned[:, :, 3] == 0] = original_gray[aligned[:, :, 3] == 0]
        if background == "dark":
            original_gray = 255 - original_gray
            if aligned_gray is not None:
                aligned_gray = 255 - aligned_gray
        report["seamsToReview"] = inspect_seams(original_gray, gray, allowed, aligned_gray)
    if not issues:
        report["status"] = "checks_passed"
    return report


def stage(directory, candidate_bytes, report):
    receipt = json.dumps(report, indent=2, ensure_ascii=True) + "\n"
    if directory.exists():
        if ((directory / "plan.png").read_bytes() == candidate_bytes
                and (directory / "receipt.json").read_text(encoding="utf-8") == receipt):
            return
        raise FileExistsError("Choose a new review directory for a different candidate or requirement set.")
    with TemporaryDirectory(prefix=".plan-review-", dir=directory.parent) as temporary:
        prepared = Path(temporary) / "verified"
        prepared.mkdir()
        (prepared / "plan.png").write_bytes(candidate_bytes)
        (prepared / "receipt.json").write_text(receipt, encoding="utf-8", newline="\n")
        prepared.rename(directory)


def crop_for_delivery(candidate_bytes, requirements_bytes, report):
    review = json.loads(requirements_bytes.decode("utf-8-sig"))
    crop = review.get("crop")
    if not isinstance(crop, list) or len(crop) != 4 or any(type(edge) is not int for edge in crop):
        raise ValueError("The guide receipt needs a crop in original pixels.")
    left, top, width, height = crop
    right, bottom = left + width, top + height
    source_width, source_height = report["candidateSize"]
    if not (0 <= left < right <= source_width and 0 <= top < bottom <= source_height):
        raise ValueError("The guide crop must lie within the original canvas.")
    for region in review["edits"] + review["locks"]:
        vertices = np.asarray(region["points"])
        if np.any(vertices < [left, top]) or np.any(vertices > [right, bottom]):
            raise ValueError("The delivery crop must contain all edit and protected regions.")
    for item in review.get("planPoints", []):
        if "rect" in item:
            x0, y0, x1, y1 = item["rect"]
        else:
            x0, y0 = item["point"]
            x1, y1 = x0 + 1, y0 + 1
        if not (left <= x0 < x1 <= right and top <= y0 < y1 <= bottom):
            raise ValueError(f"The delivery crop omits plan check {item['id']}.")
    for probe in review.get("crossings", []):
        start, end = np.asarray([probe["from"], probe["to"]], dtype=float)
        axis = end - start
        normal = np.array([-axis[1], axis[0]]) / np.linalg.norm(axis)
        offset = normal * float(probe["width"]) / 2
        corners = np.array([start - offset, start + offset, end - offset, end + offset])
        if np.any(corners < [left, top]) or np.any(corners > [right - 1, bottom - 1]):
            raise ValueError(f"The delivery crop omits crossing check {probe['id']}.")
    buffer = io.BytesIO()
    with Image.open(io.BytesIO(candidate_bytes)) as image:
        image.crop((left, top, right, bottom)).save(buffer, format="PNG")
    cropped = buffer.getvalue()
    report["deliveryCrop"] = crop
    report["verifiedPngSha256"] = digest(cropped)
    return cropped


def guide_review(receipt_path, original_bytes):
    receipt = json.loads(receipt_path.read_text(encoding="utf-8-sig"))
    snapshot = receipt_path.with_suffix(".source-review.json")
    if (receipt.get("reviewSnapshot") != snapshot.name
            or receipt.get("originalSha256", "").lower() != digest(original_bytes)
            or type(receipt.get("protectFilledRegions")) is not bool):
        raise ValueError("Use the original and original guide receipt for this plan.")
    requirements_bytes = snapshot.read_bytes()
    if receipt.get("reviewSha256", "").lower() != digest(requirements_bytes):
        raise ValueError("The source review snapshot does not match the guide receipt.")
    return requirements_bytes, receipt["protectFilledRegions"]


def initial_scope_receipt(receipt_path, explicit_path):
    receipt = json.loads(receipt_path.read_text(encoding="utf-8-sig"))
    reference = receipt.get("initialScope")
    if reference is None:
        return explicit_path
    archived = (receipt_path.parent / reference["path"]).resolve()
    expected_hash = reference["sha256"].lower()
    if archived == receipt_path.resolve() or digest(archived.read_bytes()) != expected_hash:
        raise ValueError("The archived initial scope receipt does not match the current guide.")
    if explicit_path and digest(explicit_path.read_bytes()) != expected_hash:
        raise ValueError("The supplied initial receipt differs from the archived first scope.")
    return archived


def add_dark_door_locks(original_bytes, review):
    if review.get("background") != "dark" or digest(original_bytes) != review["originalSha256"]:
        raise ValueError("Door linework locks require their original dark CAD plan.")
    picture = read_image(original_bytes)
    height, width = picture.shape[:2]
    locks = list(review.get("locks", []))
    doors = review["darkDoorLocks"]
    if not isinstance(doors, list) or not 1 <= len(doors) <= 24:
        raise ValueError("Provide one to twenty-four identified door crops.")
    names = set()
    for item in doors:
        name, rect = item["id"], item["rect"]
        if not isinstance(name, str) or not name.strip() or name in names:
            raise ValueError("Door crops need unique, nonempty IDs.")
        names.add(name)
        if not isinstance(rect, list) or len(rect) != 4 or any(type(edge) is not int for edge in rect):
            raise ValueError(f"{name}: provide four integer door crop edges.")
        left, top, right, bottom = rect
        if not (0 <= left < right < width and 0 <= top < bottom < height):
            raise ValueError(f"{name}: the door crop must be within the original plan.")
        if (right - left) * (bottom - top) > 0.05 * width * height:
            raise ValueError(f"{name}: crop just the confirmed door and its swing.")
        crop = picture[top:bottom, left:right]
        ink = np.any(crop[:, :, :3] != 0, axis=2)
        if not ink.any() or ink.mean() >= 0.5 or np.any(crop[:, :, 3] != 255):
            raise ValueError(f"{name}: select a door with visible linework on an opaque, flat black background.")
        for y, row in enumerate(ink, top):
            edges = np.flatnonzero(np.diff(np.r_[False, row, False]))
            for start, end in zip(edges[::2], edges[1::2]):
                x0, x1 = int(start) + left, int(end) + left
                locks.append({"points": [[x0, y], [x1, y], [x1, y + 1], [x0, y + 1]]})
    return {**review, "locks": locks}


def expand_review(original_bytes, requirements_bytes, protect_filled_regions, protect_routes=True):
    review = json.loads(requirements_bytes.decode("utf-8-sig"))
    has_door_locks = "darkDoorLocks" in review
    has_route_locks = protect_routes and "existingRoutes" in review
    if not (protect_filled_regions or has_door_locks or has_route_locks or "unconfirmedAreas" in review):
        return requirements_bytes
    if "unconfirmedAreas" in review:
        areas = review.pop("unconfirmedAreas")
        if not isinstance(areas, list):
            raise ValueError("unconfirmedAreas must be a list of named source polygons.")
        names = {item.get("id") for item in review.get("locks", [])}
        for area in areas:
            name = area.get("id") if isinstance(area, dict) else None
            if not isinstance(name, str) or not name.strip() or name in names:
                raise ValueError("Use unique, nonempty IDs for unconfirmed source areas and named locks.")
            names.add(name)
        if areas:
            with Image.open(io.BytesIO(original_bytes)) as image:
                shape = image.height, image.width
            unknown = region_mask(shape, areas).astype(np.float32)
            for probe in review.get("crossings", []):
                if probe.get("state") in ("proposed", "closed") and apertures.sample_strip(
                    unknown, probe["from"], probe["to"], apertures.crossing_width(probe)
                ).any():
                    raise ValueError(f"{probe['id']}: the proposed wall or opening change crosses an unconfirmed source area. "
                                     "Keep the original separation or confirm the space and its access first.")
            review["locks"] = [*review.get("locks", []), *areas]
    if protect_filled_regions:
        review = import_module("inspect-plan-structure").add_filled_locks(original_bytes, review)
    if has_door_locks:
        review = add_dark_door_locks(original_bytes, review)
        del review["darkDoorLocks"]
    if has_route_locks:
        review = add_existing_route_locks(original_bytes, review)
    return (json.dumps(review, ensure_ascii=True) + "\n").encode("utf-8")


def review_revised_scope(original_bytes, initial_bytes, revised_bytes):
    initial = json.loads(initial_bytes.decode("utf-8-sig"))
    revised = json.loads(revised_bytes.decode("utf-8-sig"))
    shape = read_image(original_bytes).shape[:2]
    initial_edits = region_mask(shape, initial["edits"]).astype(bool)
    revised_edits = region_mask(shape, revised["edits"]).astype(bool)
    initial_locks = region_mask(shape, initial["locks"]).astype(bool)
    revised_locks = region_mask(shape, revised["locks"]).astype(bool)
    revised_probes = {probe["id"]: probe for probe in revised.get("crossings", [])}
    missing = []
    altered = []
    for probe in initial.get("crossings", []):
        name = probe["id"]
        current = revised_probes.get(name)
        if current is None:
            missing.append(name)
        elif (expected_crossing_status(probe) != expected_crossing_status(current)
              or probe.get("surface", "linework") != current.get("surface", "linework")
              or any(probe.get(key, []) != current.get(key, [])
                     for key in ("from", "to", "width", "wall_support", "sourceBeamLines"))):
            altered.append(name)
    return {
        "initialRequirementsSha256": digest(initial_bytes),
        "expandedEditPixels": int(np.count_nonzero(revised_edits & ~initial_edits)),
        "releasedProtectionPixels": int(np.count_nonzero(initial_locks & ~revised_locks)),
        "missingRequiredCrossings": missing,
        "alteredRequiredCrossings": altered,
    }


def revised_scope_exceeds_initial(scope):
    return any(scope[key] for key in ("expandedEditPixels", "releasedProtectionPixels",
                                      "missingRequiredCrossings", "alteredRequiredCrossings"))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("original", type=Path)
    parser.add_argument("candidate", type=Path)
    parser.add_argument("requirements", type=Path, nargs="?")
    parser.add_argument("--guide-receipt", type=Path, help="review snapshot and settings recorded before rendering")
    parser.add_argument("--initial-guide-receipt", type=Path,
                        help="original guide receipt when reviewing a revised layout with a new guide receipt")
    parser.add_argument("--stage", type=Path, help="new directory for plan.png and receipt.json on success")
    parser.add_argument("--crop-to-guide", action="store_true",
                        help="after verifying the full original canvas, stage the exact guide crop")
    parser.add_argument("--protect-filled-regions", action="store_true",
                        help="apply the same scanned source locks used in composition")
    parser.add_argument("--inspect-seams", action="store_true",
                        help="report new linework ending at the edit boundary for visual review")
    parser.add_argument("--aligned-candidate", type=Path,
                        help="original-size registered candidate before clipping, for seam inspection")
    parser.add_argument("--suggest-opening-patch", action="store_true",
                        help="return a safe edit rectangle for one blocked removable separator")
    parser.add_argument("--include-crossing-samples", action="store_true",
                        help="report the original-pixel visual review crop for each checked opening")
    args = parser.parse_args()
    if bool(args.requirements) == bool(args.guide_receipt):
        parser.error("Provide one source review JSON or --guide-receipt.")
    if args.guide_receipt and args.protect_filled_regions:
        parser.error("The guide receipt supplies the filled-region setting.")
    if args.initial_guide_receipt and not args.guide_receipt:
        parser.error("A revised layout needs both the initial and revised guide receipts.")
    if args.crop_to_guide and not (args.guide_receipt and args.stage):
        parser.error("Cropping the delivery requires --guide-receipt and --stage.")
    if args.aligned_candidate and not args.inspect_seams:
        parser.error("--aligned-candidate requires --inspect-seams")
    try:
        original_bytes = args.original.read_bytes()
        candidate_bytes = args.candidate.read_bytes()
        if args.guide_receipt:
            requirements_bytes, protect_filled_regions = guide_review(args.guide_receipt, original_bytes)
        else:
            requirements_bytes = args.requirements.read_bytes()
            protect_filled_regions = args.protect_filled_regions
        requirements_bytes = expand_review(original_bytes, requirements_bytes, protect_filled_regions)
        aligned_bytes = args.aligned_candidate.read_bytes() if args.aligned_candidate else None
        report = verify(original_bytes, candidate_bytes, requirements_bytes, args.inspect_seams, aligned_bytes,
                        args.suggest_opening_patch, args.include_crossing_samples)
        initial_receipt = None
        if args.guide_receipt:
            initial_receipt = initial_scope_receipt(args.guide_receipt, args.initial_guide_receipt)
        if initial_receipt:
            initial_bytes, initial_wall_setting = guide_review(initial_receipt, original_bytes)
            initial_bytes = expand_review(original_bytes, initial_bytes, initial_wall_setting)
            scope = review_revised_scope(original_bytes, initial_bytes, requirements_bytes)
            report["revisedScope"] = scope
            if revised_scope_exceeds_initial(scope):
                report["status"] = "rejected"
                report["issues"].append("revised_scope_exceeds_initial_receipt")
        if args.stage and report["status"] == "checks_passed":
            staged_bytes = candidate_bytes
            if args.crop_to_guide:
                staged_bytes = crop_for_delivery(candidate_bytes, requirements_bytes, report)
            stage(args.stage, staged_bytes, report)
            report["verifiedPng"] = str((args.stage / "plan.png").resolve())
        print(json.dumps(report, ensure_ascii=True))
        if report["status"] != "checks_passed":
            raise SystemExit(1)
    except (KeyError, OSError, TypeError, ValueError) as error:
        parser.exit(2, f"{error}\n")


if __name__ == "__main__":
    main()
