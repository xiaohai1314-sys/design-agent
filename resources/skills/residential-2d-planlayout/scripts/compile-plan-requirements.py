"""Validate a source-layout recipe and derive original-pixel masks for composition."""

import argparse
import json
import re
from importlib import import_module
from pathlib import Path

import cv2
import numpy as np

structure_tools = import_module("inspect-plan-structure")
verification = import_module("verify-plan-delivery")
region_mask = verification.region_mask
add_existing_route_locks = verification.add_existing_route_locks
apertures = import_module("check-plan-apertures")
crossing_width = apertures.crossing_width


def named(items):
    identifiers = [item["id"] for item in items]
    if any(not isinstance(name, str) or not name.strip() for name in identifiers) or len(set(identifiers)) != len(identifiers):
        raise ValueError("Edit regions and openings need unique, nonempty IDs.")


def pixel(point, width, height):
    if (not isinstance(point, list) or len(point) != 2
            or any(type(value) is not int for value in point)
            or not (0 <= point[0] < width and 0 <= point[1] < height)):
        raise ValueError("Expected an integer pixel position within the original image.")
    return point


def derive_layout_variant(original, common, variant):
    if verification.digest(original) != common["originalSha256"]:
        raise ValueError("The shared layout does not identify the original image.")
    if common.get("existingRoutes") or common.get("plannedCircuits"):
        raise ValueError("Use separate checked route guides for variants with route receipts.")
    if set(variant) - {"id", "openSeparators", "planPoints"}:
        raise ValueError("A variant can only name its separators and place its furniture and rooms.")
    named([variant])
    separators = common.get("optionalSeparators", [])
    named(separators)
    opened = variant.get("openSeparators", [])
    by_name = {item["id"]: item for item in separators}
    if (not isinstance(opened, list) or any(not isinstance(name, str) for name in opened)
            or len(set(opened)) != len(opened) or any(name not in by_name for name in opened)):
        raise ValueError("Choose unique separators from the shared optionalSeparators list.")

    review = {key: value for key, value in common.items() if key != "optionalSeparators"}
    review["edits"] = list(review["edits"])
    review["locks"] = list(review.get("locks", []))
    review["crossings"] = list(review.get("crossings", []))
    doors = list(review.get("darkDoorLocks", []))
    points = list(review.get("planPoints", []))
    shape = verification.read_image(original).shape[:2]
    for option in separators:
        if set(option) - {"id", "crossing", "locks", "darkDoorLocks", "preservePoints"}:
            raise ValueError(f"{option['id']}: unsupported separator field.")
        crossing = option["crossing"]
        if crossing.get("state") != "proposed":
            raise ValueError(f"{option['id']}: an optional separator needs a proposed crossing.")
        left, top, right, bottom = separator_rectangle(crossing, shape)
        keep_points = option.get("preservePoints", [])
        if any(item.get("mode") != "preserve" for item in keep_points):
            raise ValueError(f"{option['id']}: separator preservePoints must use preserve mode.")
        if not (option.get("locks") or option.get("darkDoorLocks") or keep_points):
            raise ValueError(f"{option['id']}: identify the retained wall or door protection.")
        if option["id"] in opened:
            review["edits"].append({"points": [[left, top], [right, top], [right, bottom], [left, bottom]]})
            review["crossings"].append(crossing)
        else:
            review["locks"].extend(option.get("locks", []))
            doors.extend(option.get("darkDoorLocks", []))
            points.extend(keep_points)

    overrides = variant.get("planPoints", [])
    named(points)
    named(overrides)
    preserved = {item["id"] for item in points if item.get("mode") == "preserve"}
    if any(item.get("mode", "edit") != "edit" or item["id"] in preserved for item in overrides):
        raise ValueError("A variant may only add or update editable room and furniture points.")
    points_by_name = {item["id"]: item for item in [*points, *overrides]}
    review["planPoints"] = list(points_by_name.values())
    if doors:
        review["darkDoorLocks"] = doors
    named(review["crossings"])
    return review


def compile_requirements(original_bytes, recipe):
    structure = structure_tools.inspect(original_bytes)
    if (recipe["originalSha256"] != structure["originalSha256"]
            or recipe["imageSize"] != structure["imageSize"]):
        raise ValueError("The recipe does not identify the original image and dimensions.")
    width, height = structure["imageSize"]
    candidates = {item["id"]: item for item in structure["filledCandidates"]}
    ids = recipe["protectedSolidIds"]
    if not ids or len(set(ids)) != len(ids) or any(name not in candidates for name in ids):
        raise ValueError("Select existing and unique filled-region IDs.")
    entry = recipe["entry"]
    left, top, right, bottom = entry["rect"]
    pixel([left, top], width, height)
    pixel([right, bottom], width, height)
    x, y = pixel(entry["point"], width, height)
    if not (left < x < right and top < y < bottom):
        raise ValueError("The entry point must lie within its protection rectangle.")
    locks = [{"id": name, "points": candidates[name]["points"]} for name in ids]
    locks.append({"id": "original-entry", "points": [[left, top], [right, top], [right, bottom], [left, bottom]]})
    locks.extend(recipe.get("locks", []))
    edits = recipe["edits"]
    openings = recipe["openings"]
    named(locks)
    named(edits)
    named(openings)
    allowed = region_mask((height, width), edits) != 0
    protected = region_mask((height, width), locks) != 0
    if not np.any(allowed & ~protected):
        raise ValueError("The recipe does not leave any editable pixels.")
    for opening in openings:
        x, y = pixel(opening["point"], width, height)
        state = opening["state"]
        from_room, to_room = opening["from"], opening["to"]
        if (state not in ("existing", "proposed") or not isinstance(from_room, str)
                or not isinstance(to_room, str) or not from_room.strip() or not to_room.strip()
                or from_room.strip() == to_room.strip()):
            raise ValueError("Each opening needs a state and two different named spaces.")
        if state == "proposed" and (not allowed[y, x] or protected[y, x]):
            raise ValueError(f"Proposed opening {opening['id']} falls outside the allowed edit area.")
    if not isinstance(recipe["layout"], str) or not recipe["layout"].strip():
        raise ValueError("Include a layout description and any conditions to confirm.")
    result = {
        "originalSha256": structure["originalSha256"],
        "imageSize": structure["imageSize"],
        "edits": edits,
        "locks": locks,
        "background": structure["background"],
        "crossings": recipe.get("crossings", []),
        "openings": openings,
        "layout": recipe["layout"],
        "editablePixels": int(np.count_nonzero(allowed & ~protected)),
        "protectedPixels": int(np.count_nonzero(protected)),
    }
    if "routes" in recipe:
        result["routes"] = recipe["routes"]
    if "plannedCircuits" in recipe:
        result["plannedCircuits"] = recipe["plannedCircuits"]
    return result


def check_review_points(original, review, check_source_locations=False):
    if not review.get("planPoints"):
        return
    for item in review["planPoints"]:
        if "showOnGuide" in item and (
            type(item["showOnGuide"]) is not bool
            or (item["showOnGuide"] and ("rect" not in item or item.get("mode", "edit") != "edit"))
        ):
            raise ValueError("A shown furniture footprint must be an editable plan-check rectangle.")
        if "guideLabel" in item:
            label = item["guideLabel"]
            if (item.get("showOnGuide") is not True or not isinstance(label, str)
                    or not 1 <= len(label.strip()) <= 18 or not label.isprintable()):
                raise ValueError("Place a short guideLabel on a shown furniture rectangle.")
        if "guideBedHead" in item:
            if (item.get("showOnGuide") is not True
                    or item["guideBedHead"] not in ("top", "bottom", "left", "right")):
                raise ValueError("A bed guide needs a checked rectangle and a top, bottom, left or right head edge.")
    shape = verification.read_image(original).shape[:2]
    editable = region_mask(shape, review["edits"]).astype(bool)
    locks = review.get("locks", [])
    locked = region_mask(shape, locks).astype(bool) if locks else np.zeros(shape, dtype=bool)
    uncovered = verification.uncovered_plan_points(review["planPoints"], editable & ~locked, locked)
    if uncovered:
        for issue in uncovered:
            if "rect" in issue:
                left, top, right, bottom = issue["rect"]
            else:
                left, top = issue["point"]
                right, bottom = left + 1, top + 1
            window = np.s_[top:bottom, left:right]
            pixels = locked[window] if issue["reason"] == "locked" else ~editable[window]
            if issue["reason"] == "inside_edit_area":
                pixels = (editable & ~locked)[window]
            rows, columns = np.nonzero(pixels)
            issue["conflictPixels"] = len(rows)
            issue["conflictBounds"] = [left + int(columns.min()), top + int(rows.min()),
                                       left + int(columns.max()) + 1, top + int(rows.max()) + 1]
    problems = []
    if uncovered:
        problems.append("原图范围与占位冲突：" + json.dumps(uncovered, ensure_ascii=False))
    if check_source_locations:
        try:
            check_flat_source_locations(original, review)
        except ValueError as error:
            problems.append(str(error))
    if problems:
        raise ValueError(" | ".join(problems))
    for item in review["planPoints"]:
        if "guideBedHead" in item:
            left, top, right, bottom = item["rect"]
            if min(right - left, bottom - top) < 12:
                raise ValueError(f"{item['id']}: keep the entire bed symbol readable.")


def check_flat_source_locations(original, review):
    picture = verification.read_image(original)[:, :, :3]
    height, width = picture.shape[:2]
    x, y, w, h = review.get("crop", [0, 0, width, height])
    if (not all(type(value) is int for value in (x, y, w, h))
            or not (0 <= x < x + w <= width and 0 <= y < y + h <= height)):
        raise ValueError("Keep the source crop inside the image.")
    if min(w, h) < 128 or review.get("background") == "dark":
        return

    # A neutral, uniform page tone at two opposite corners suggests a floor-plan brochure.
    edge = min(24, min(w, h) // 16)
    corners = [picture[top:top + edge, left:left + edge]
               for top in (y, y + h - edge) for left in (x, x + w - edge)]
    tone = None
    for first, second in ((0, 3), (1, 2)):
        sample = int(np.median(corners[first]))
        if 175 <= sample <= 245 and all(
            (np.abs(corners[index].astype(np.int16) - sample) <= 2).all(axis=2).mean() >= 0.96
            for index in (first, second)
        ):
            tone = sample
            break
    if tone is None:
        return

    confirmations = review.get("confirmedSourceAreas", [])
    if not isinstance(confirmations, list):
        raise ValueError("confirmedSourceAreas must contain named original polygons and their source evidence.")
    uncertain = re.compile(
        r"未标注|未注明|不明确|待[核确查]|需.{0,14}(?:核[实对]|确认)|尚未|无法确认|不能确认|疑似|推测|假定|暂按"
        r"|\b(?:unlabelled|unlabeled|unmarked|unconfirmed|unverified|assumed|assumption|appears to be|"
        r"to be (?:checked|verified|confirmed)|needs? (?:verification|confirmation))\b",
        re.IGNORECASE,
    )
    confirmed_areas = []
    for area in confirmations:
        evidence = area.get("evidence", {}) if isinstance(area, dict) else {}
        if not isinstance(evidence, dict) or not all(
            isinstance(evidence.get(key), str) and evidence[key].strip() for key in ("use", "access")
        ):
            raise ValueError("For confirmedSourceAreas, identify source evidence for both use and access.")
        if not any(uncertain.search(evidence[key]) for key in ("use", "access")):
            confirmed_areas.append(area)
    named(confirmations)
    confirmed = region_mask((height, width), confirmed_areas).astype(bool) if confirmed_areas else None
    concerns = []
    for item in review["planPoints"]:
        if item.get("mode", "edit") != "edit":
            continue
        if "rect" in item:
            left, top, right, bottom = item["rect"]
        else:
            px, py = item["point"]
            left, top = max(0, px - 6), max(0, py - 6)
            right, bottom = min(width, px + 7), min(height, py + 7)
        area = np.s_[top:bottom, left:right]
        flat = (np.abs(picture[area].astype(np.int16) - tone) <= 2).all(axis=2)
        if confirmed is not None:
            flat &= ~confirmed[area]
        if flat.mean() >= 0.60:
            concerns.append({"id": item["id"], "rect": [left, top, right, bottom]})
    if concerns:
        ignored = [area["id"] for area in confirmations if area not in confirmed_areas]
        detail = {"locations": concerns}
        if ignored:
            detail["stillUnconfirmed"] = ignored
        raise ValueError("原图用途和入口待核：" + json.dumps(detail, ensure_ascii=False)
                         + "。把家具移到已确认的空间，并把待核区域及分隔写入 unconfirmedAreas。"
                           "原图或用户明确确认用途与入口时，才使用 confirmedSourceAreas。")


def separator_rectangle(probe, shape):
    rect = probe.get("clearRect")
    if not isinstance(rect, list) or len(rect) != 4 or any(type(edge) is not int for edge in rect):
        raise ValueError(f"{probe['id']}: mark the exact removable separator with four integer clearRect edges.")
    left, top, right, bottom = rect
    height, width = shape
    if not (0 <= left < right <= width and 0 <= top < bottom <= height):
        raise ValueError(f"{probe['id']}: the clearRect must lie inside the original image.")
    x, y = (np.asarray(probe["from"]) + probe["to"]) / 2
    if not (left <= x < right and top <= y < bottom):
        raise ValueError(f"{probe['id']}: the clearRect must cover the center of the opening sample.")
    return left, top, right, bottom


def separator_ink_areas(probe, shape, editable, footprints):
    core = separator_rectangle(probe, shape)
    extras = probe.get("clearAdjacentRects", [])
    if not isinstance(extras, list) or len(extras) > 4:
        raise ValueError(f"{probe['id']}: use up to four extra rectangles for the removed assembly and its labels.")
    areas = [core]
    for rect in extras:
        if (not isinstance(rect, list) or len(rect) != 4 or any(type(edge) is not int for edge in rect)):
            raise ValueError(f"{probe['id']}: each extra rectangle needs four integer edges.")
        left, top, right, bottom = rect
        if (not (0 <= left < right <= shape[1] and 0 <= top < bottom <= shape[0])
                or min(right, core[2]) <= max(left, core[0]) or min(bottom, core[3]) <= max(top, core[1])):
            raise ValueError(f"{probe['id']}: keep the extra rectangle on the canvas and overlapping clearRect.")
        areas.append((left, top, right, bottom))
    for left, top, right, bottom in areas:
        if not editable[top:bottom, left:right].all():
            raise ValueError(f"{probe['id']}: an erase rectangle touches protected or noneditable pixels.")
        if extras:
            for item in footprints:
                l, t, r, b = item["rect"]
                if min(right, r) > max(left, l) and min(bottom, b) > max(top, t):
                    raise ValueError(f"{probe['id']}: an erase rectangle overlaps furniture {item['id']}.")
    return areas


def check_opening_furniture(probe, footprints):
    keep_clear = probe.get("keepClear", False)
    if type(keep_clear) is not bool:
        raise ValueError(f"{probe['id']}: keepClear must be true or false.")
    if not keep_clear:
        return
    if probe["state"] != "proposed" or not footprints:
        raise ValueError(f"{probe['id']}: keepClear needs a proposed opening and checked furniture footprints.")
    start, end = np.asarray([probe["from"], probe["to"]])
    axis = end - start
    normal = np.array([-axis[1], axis[0]]) / np.linalg.norm(axis)
    offset = normal * (crossing_width(probe) / 2)
    strip = np.array([start - offset, start + offset, end - offset, end + offset])
    # A rectangle overlaps this oriented strip if their projections overlap on
    # the two image axes and the two strip axes. Touching edges leave no overlap.
    axes = np.array([[1, 0], [0, 1], axis, normal]).T
    band = strip @ axes
    blocked = []
    for item in footprints:
        left, top, right, bottom = item["rect"]
        box = np.array([[left, top], [left, bottom], [right, top], [right, bottom]]) @ axes
        depth = np.minimum(band.max(axis=0), box.max(axis=0)) - np.maximum(band.min(axis=0), box.min(axis=0))
        if np.all(depth > 1e-6):
            blocked.append({"id": item["id"], "rect": item["rect"]})
    if blocked:
        raise ValueError(f"{probe['id']}: keep these furniture footprints out of the opening and its approaches: "
                         + json.dumps(blocked, ensure_ascii=True))


def check_plan_openings(original, review, check_cleared_openings=False, select_clearable=False):
    crossings = review.get("crossings", [])
    changed = [probe for probe in crossings if probe.get("state") in ("proposed", "closed")]
    specified = [probe for probe in changed if probe["state"] == "proposed" and "clearRect" in probe]
    if (check_cleared_openings or select_clearable) and not specified:
        raise ValueError("Mark at least one removable proposed separator with clearRect.")
    if not changed:
        return [], []
    named(crossings)
    if len(crossings) > 8:
        raise ValueError("Provide at most eight opening samples.")
    gray = cv2.cvtColor(verification.read_image(original), cv2.COLOR_RGBA2GRAY)
    background = review.get("background", "light")
    if background not in ("light", "dark"):
        raise ValueError("Choose a light or dark linework background.")
    if background == "dark":
        gray = 255 - gray
    editable = region_mask(gray.shape, review["edits"]).astype(bool)
    locked = region_mask(gray.shape, review["locks"]).astype(bool) if review.get("locks") else None
    if locked is not None:
        editable &= ~locked
    footprints = [item for item in review.get("planPoints", []) if item.get("showOnGuide")]
    editable_points = [item for item in review.get("planPoints", [])
                       if item.get("mode", "edit") == "edit" and "rect" in item]
    cleared = gray.copy() if check_cleared_openings or select_clearable else gray
    cleared[editable] = 255
    for probe in changed:
        start = pixel(probe["from"], gray.shape[1], gray.shape[0])
        end = pixel(probe["to"], gray.shape[1], gray.shape[0])
        check_opening_furniture(probe, footprints)
        x, y = (np.asarray(start) + end) // 2
        if not editable[y, x]:
            reason = "locked" if locked is not None and locked[y, x] else "outside the editable area"
            raise ValueError(f"{probe['id']}: wall-change center [{x},{y}] is {reason}. "
                             "If this variant removes the separator, update only its verified edit area and associated locks.")
        if probe["state"] == "closed":
            band = apertures.sample_strip(editable.astype(np.uint8) * 255, start, end, crossing_width(probe))
            center = band[len(band) // 2]
            if apertures.longest_run(center == 255) < 0.9 * len(center):
                raise ValueError(f"{probe['id']}: fixed or noneditable pixels interrupt the wall infill band.")
            continue
        result = verification.inspect_crossing(cleared, probe)
        if result["status"] != "clear_sample":
            raise ValueError(f"{probe['id']}: fixed linework still crosses the planned opening. "
                             "Check the source wall, edit polygon, and the approach on both sides.")
    unchanged = []
    if check_cleared_openings or select_clearable:
        for probe in specified:
            left, top, right, bottom = separator_rectangle(probe, gray.shape)
            start, end = np.asarray([probe["from"], probe["to"]])
            axis = end - start
            distance = np.linalg.norm(axis)
            normal = np.abs(np.array([-axis[1], axis[0]]) / distance) * (crossing_width(probe) / 2)
            low, high = np.floor(np.minimum(start, end) - normal), np.ceil(np.maximum(start, end) + normal) + 1
            if np.any([left, top] < low) or np.any([right, bottom] > high):
                raise ValueError(f"{probe['id']}: keep clearRect within the opening sample.")
            if probe.get("surface") == "colored":
                corners = np.asarray([[left, top], [right - 1, top], [left, bottom - 1], [right - 1, bottom - 1]])
                positions = (corners - start) @ (axis / distance)
                if positions.min() < 2 or positions.max() > distance - 2:
                    raise ValueError(f"{probe['id']}: put the sample ends on the floor on both sides of clearRect.")
            if not np.any(gray[top:bottom, left:right] < 205):
                raise ValueError(f"{probe['id']}: there is no separator linework in clearRect.")
            areas = separator_ink_areas(probe, gray.shape, editable, editable_points)
            preview = gray.copy()
            for l, t, r, b in areas:
                preview[t:b, l:r] = 255
            result = verification.inspect_crossing(preview, probe)
            if result["status"] != "clear_sample":
                if select_clearable:
                    unchanged.append({"id": probe["id"], "longestClearPx": result["longestClearPx"],
                                      "sampleWidthPx": result["sampleWidthPx"]})
                    continue
                if probe.get("surface") == "colored" and result["status"] == "review_sample":
                    raise ValueError(f"{probe['id']}: after clearing clearRect, only "
                                     f"{result['longestClearPx']}/{result['sampleWidthPx']}px look clear. "
                                     "Inspect dimension text, trim or flooring in the two approaches. "
                                     "Place the ends on adjacent plain floor just beyond clearRect. "
                                     "Keep the intended width and the original protection regions.")
                raise ValueError(f"{probe['id']}: the separator remains in the opening after clearing clearRect.")
    return [probe["id"] for probe in changed], unchanged


def check_planned_circuits(original, review, crossings, check_cleared_openings=False,
                           select_clearable_openings=False):
    if verification.digest(original) != review["originalSha256"]:
        raise ValueError("The review does not identify the original plan.")
    gray = cv2.cvtColor(verification.read_image(original), cv2.COLOR_RGBA2GRAY)
    background = review.get("background", "light")
    if background not in ("light", "dark"):
        raise ValueError("Choose a light or dark linework background.")
    if background == "dark":
        gray = 255 - gray
    editable = region_mask(gray.shape, review["edits"]).astype(bool)
    locks = review.get("locks", [])
    if locks:
        editable &= ~region_mask(gray.shape, locks).astype(bool)
    proposed = [probe for probe in crossings if probe.get("state") == "proposed"]
    clearance = {"shownCleared": [], "unchangedSeparators": []}
    if check_cleared_openings or select_clearable_openings:
        separators = [probe for probe in proposed if "clearRect" in probe]
        if not separators:
            raise ValueError("Mark at least one removable proposed separator with clearRect.")
        cleared = gray.copy()
        for probe in separators:
            left, top, right, bottom = separator_rectangle(probe, gray.shape)
            blocked = (~editable[top:bottom, left:right]).astype(np.uint8)
            if blocked.any():
                _, _, conflicts, _ = cv2.connectedComponentsWithStats(blocked, connectivity=4)
                conflicts = sorted(conflicts[1:].tolist(), key=lambda item: -item[4])[:4]
                rectangles = [[left + x, top + y, left + x + w, top + y + h]
                              for x, y, w, h, _ in conflicts]
                if check_cleared_openings:
                    raise ValueError(f"{probe['id']}: clearRect touches protected or noneditable pixels. "
                                     f"Conflicting regions (left, top, right, bottom): {rectangles}. "
                                     "Check those source pixels before correcting the separator range.")
                clearance["unchangedSeparators"].append({"id": probe["id"], "reason": "protected_or_noneditable",
                                                         "conflicts": rectangles})
                continue
            if select_clearable_openings:
                # Test each confirmed separator on its own, without clearing its neighbors.
                cleared[top:bottom, left:right] = 255
                report = verification.inspect_crossing(cleared, probe)
                cleared[top:bottom, left:right] = gray[top:bottom, left:right]
                if report["status"] == "clear_sample":
                    clearance["shownCleared"].append(probe["id"])
                else:
                    clearance["unchangedSeparators"].append({**report, "reason": "remaining_linework"})
                continue
            cleared[top:bottom, left:right] = 255
        if check_cleared_openings:
            incomplete = [verification.inspect_crossing(cleared, probe) for probe in separators]
            incomplete = [report for report in incomplete if report["status"] != "clear_sample"]
            if incomplete:
                raise ValueError("The selected separators do not clear the openings: "
                                 + json.dumps(incomplete, ensure_ascii=True))
    # Test the most generous possible result without touching fixed pixels.
    gray[editable] = 255
    openings = [verification.inspect_crossing(gray, probe) for probe in proposed]
    circuits = review["plannedCircuits"]
    reports = verification.inspect_planned_circuits(gray, circuits, crossings)
    for index, circuit in enumerate(circuits):
        if "furnitureRect" not in circuit:
            continue
        rect = circuit["furnitureRect"]
        if not isinstance(rect, list) or len(rect) != 4 or any(type(edge) is not int for edge in rect):
            raise ValueError(f"{circuit['id']}: use four integer edges for the furniture footprint.")
        left, top, right, bottom = rect
        height, width = gray.shape
        if not (0 <= left < right <= width and 0 <= top < bottom <= height):
            raise ValueError(f"{circuit['id']}: the furniture footprint must lie inside the original image.")
        footprint = np.s_[top:bottom, left:right]
        inside = region_mask(gray.shape, [circuit]).astype(bool)
        if not (editable[footprint] & inside[footprint]).all():
            raise ValueError(f"{circuit['id']}: keep the furniture footprint inside the editable circuit interior.")
        layout = gray.copy()
        layout[footprint] = 0
        reports[index] = verification.inspect_planned_circuits(layout, [circuit], crossings)[0]
    blocked_openings = [report for report in openings if report["status"] != "clear_sample"]
    blocked_circuits = [report for report in reports if report["status"] != "connected"]
    if blocked_openings or blocked_circuits:
        raise ValueError("Planned opening or circuit remains blocked even with the editable area clear. "
                         "Check fixed walls, opening positions and edit boundaries: " + json.dumps(
                             {"openings": blocked_openings, "circuits": blocked_circuits}, ensure_ascii=True))
    return [report["id"] for report in reports], clearance


def check_local_patch(original, base, recipe, initial_receipt):
    initial, protect = verification.guide_review(initial_receipt, original)
    initial = verification.expand_review(original, initial, protect)
    starts_from_original = base == original
    current = verification.verify(original, base, initial, require_candidate_png=not starts_from_original)
    allowed_issues = {"crossing_needs_review", "route_needs_review", "circuit_needs_review"}
    # The first partial composition can start directly from the original.
    if starts_from_original:
        allowed_issues.add("no_layout_changes")
    if set(current["issues"]) - allowed_issues:
        raise ValueError("Use an aligned preview with the original locks and edit regions intact.")
    width, height = current["originalSize"]
    crop = recipe.get("crop")
    if not isinstance(crop, list) or len(crop) != 4 or any(type(edge) is not int for edge in crop):
        raise ValueError("A local patch needs crop [left, top, width, height].")
    left, top, size_x, size_y = crop
    if (left < 0 or top < 0 or size_x < 1 or size_y < 1
            or left + size_x > width or top + size_y > height):
        raise ValueError("The local crop must lie within the aligned preview.")
    shape = height, width
    patch = region_mask(shape, recipe["edits"]).astype(bool)
    if patch.sum() != np.count_nonzero(patch[top:top + size_y, left:left + size_x]):
        raise ValueError("Keep the paste area inside the crop and include nearby matching points.")
    review = json.loads(initial.decode("utf-8-sig"))
    allowed = region_mask(shape, review["edits"]).astype(bool)
    allowed &= ~region_mask(shape, review["locks"]).astype(bool)
    outside = int(np.count_nonzero(patch & ~allowed))
    if outside:
        raise ValueError(f"The paste area touches {outside} protected or noneditable pixels.")
    return {"status": "local_patch_covered", "crop": crop}


def check_bed_repair(original, recipe, review):
    shape = verification.read_image(original).shape[:2]
    editable = region_mask(shape, review["edits"]).astype(bool)
    locks = review.get("locks", [])
    locked = region_mask(shape, locks).astype(bool) if locks else np.zeros(shape, dtype=bool)
    footprints = []
    for item in recipe:
        rect = item["rect"]
        if item.get("head") not in ("top", "bottom", "left", "right") or (
            not isinstance(rect, list) or len(rect) != 4 or any(type(edge) is not int for edge in rect)
        ):
            raise ValueError("A bed repair needs a rectangle and a head edge.")
        left, top, right, bottom = rect
        if min(right - left, bottom - top) < 12:
            raise ValueError("A bed repair needs a readable original-scale footprint.")
        footprints.append({"id": str(len(footprints) + 1), "rect": rect})
    problems = verification.uncovered_plan_points(footprints, editable & ~locked, locked)
    if problems:
        raise ValueError("The complete bed must fit in the editable floor area: " +
                         json.dumps(problems, ensure_ascii=True))
    return {"status": "bed_footprints_covered"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("original", type=Path)
    parser.add_argument("recipe", type=Path)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--summary", action="store_true", help="print counts after validation without returning all polygons")
    modes.add_argument("--expand-review", action="store_true", help="derive protected areas for existing routes in a review")
    modes.add_argument("--check-existing-routes", action="store_true", help="check and summarize existing routes on the original")
    modes.add_argument("--check-planned-review", action="store_true", help="check whether planned circuits fit the allowed edits")
    modes.add_argument("--check-plan-points", action="store_true", help="check that room and object locations fit the edit and protection areas")
    modes.add_argument("--patch-base", type=Path, help="check a local patch against an already aligned preview")
    modes.add_argument("--layout-variant", type=Path, help="derive one variant from a shared source review")
    modes.add_argument("--check-bed-repair", type=Path, help="check complete replacement bed footprints against the expanded review")
    parser.add_argument("--patch-crop", type=Path, help="read the patch crop from a separate reference JSON")
    clearance = parser.add_mutually_exclusive_group()
    clearance.add_argument("--check-cleared-openings", action="store_true", help="validate exact removable separators for the guide")
    clearance.add_argument("--select-clearable-openings", action="store_true", help="report which optional separator erasures are safe")
    parser.add_argument("--add-filled-locks", action="store_true", help="add scanned filled regions to an existing review")
    parser.add_argument("--check-flat-source-locations", action="store_true",
                        help="review planned use of neutral page-tone areas on a colored source brochure")
    parser.add_argument("--initial-guide-receipt", type=Path,
                        help="check the revised layout stays within the initial source protection and edit areas")
    args = parser.parse_args()
    if args.select_clearable_openings and not (args.check_planned_review or args.check_plan_points):
        parser.error("Optional opening selection requires --check-plan-points or --check-planned-review.")
    if args.check_cleared_openings and not (args.check_planned_review or args.check_plan_points):
        parser.error("Opening clearance requires --check-plan-points or --check-planned-review")
    if args.check_flat_source_locations and not args.check_plan_points:
        parser.error("Source-location checks require --check-plan-points.")
    if args.initial_guide_receipt and not (args.check_plan_points or args.patch_base):
        parser.error("An initial guide receipt requires --check-plan-points or --patch-base.")
    if args.patch_base and not args.initial_guide_receipt:
        parser.error("A local patch requires the initial guide receipt.")
    if args.patch_crop and not args.patch_base:
        parser.error("A separate patch crop requires --patch-base.")
    try:
        recipe_bytes = args.recipe.read_bytes()
        recipe = json.loads(recipe_bytes.decode("utf-8-sig"))
        original = args.original.read_bytes()
        if args.check_bed_repair:
            if verification.digest(original) != recipe["originalSha256"]:
                raise ValueError("The repair review does not identify the original image.")
            beds = json.loads(args.check_bed_repair.read_text(encoding="utf-8-sig"))
            result = check_bed_repair(original, beds, recipe)
        elif args.layout_variant:
            variant = json.loads(args.layout_variant.read_text(encoding="utf-8-sig"))
            result = derive_layout_variant(original, recipe, variant)
        elif args.patch_base:
            if args.patch_crop:
                recipe["crop"] = json.loads(args.patch_crop.read_text(encoding="utf-8-sig"))["crop"]
            result = check_local_patch(original, args.patch_base.read_bytes(), recipe, args.initial_guide_receipt)
        elif args.check_plan_points:
            if verification.digest(original) != recipe["originalSha256"]:
                raise ValueError("The review does not identify the original plan.")
            points = recipe.get("planPoints")
            if not isinstance(points, list) or not points:
                raise ValueError("Include at least one area or object to check.")
            revised = verification.expand_review(original, recipe_bytes, args.add_filled_locks)
            checked = json.loads(revised.decode("utf-8-sig"))
            if not checked.get("locks"):
                raise ValueError("The layout review needs at least one source protection polygon. "
                                 "Mark the original entrance or another confirmed fixed feature.")
            if args.initial_guide_receipt:
                initial, initial_filled = verification.guide_review(args.initial_guide_receipt, original)
                initial = verification.expand_review(original, initial, initial_filled)
                scope = verification.review_revised_scope(original, initial, revised)
                if verification.revised_scope_exceeds_initial(scope):
                    raise ValueError("The revised layout exceeds the initial guide scope: "
                                     + json.dumps(scope, ensure_ascii=False))
            check_review_points(original, checked, check_source_locations=args.check_flat_source_locations)
            if any(probe.get("sourceBeamLines") for probe in checked.get("crossings", [])):
                source_gray = cv2.cvtColor(verification.read_image(original), cv2.COLOR_RGBA2GRAY)
                if checked.get("background") == "dark":
                    source_gray = 255 - source_gray
                for probe in checked.get("crossings", []):
                    if probe.get("sourceBeamLines"):
                        apertures.unchanged_beam_ink(source_gray, probe)
            result = {"status": "plan_points_covered", "checkedIds": [item["id"] for item in points]}
            opening_ids, unchanged = check_plan_openings(original, checked, args.check_cleared_openings,
                                                         args.select_clearable_openings)
            if opening_ids:
                result["openingIds"] = opening_ids
            if unchanged:
                result["unchangedSeparators"] = unchanged
        elif args.check_existing_routes or args.check_planned_review:
            recipe = json.loads(verification.expand_review(
                original, recipe_bytes, args.add_filled_locks, protect_routes=False).decode("utf-8-sig"))
            problems = []
            for probe in recipe.get("crossings", []):
                try:
                    crossing_width(probe)
                except (TypeError, ValueError) as error:
                    problems.append(str(error))
            if problems:
                raise ValueError("Check the opening samples together: " + " | ".join(problems))
            if args.check_existing_routes:
                checked = add_existing_route_locks(original, recipe)
                check_review_points(original, checked)
                result = {"status": "source_routes_connected",
                          "routeIds": [item["id"] for item in checked["routes"][len(recipe.get("routes", [])):]]}
            else:
                crossings = recipe.get("crossings", [])
                named(crossings)
                checked = add_existing_route_locks(original, recipe) if "existingRoutes" in recipe else recipe
                check_review_points(original, checked)
                names, clearance = check_planned_circuits(original, checked, crossings,
                                                          args.check_cleared_openings, args.select_clearable_openings)
                result = {"status": "planned_geometry_valid", "circuitIds": names,
                          "editableAreaFeasible": True}
                if args.select_clearable_openings:
                    result.update(clearance)
        elif args.expand_review or args.add_filled_locks:
            if args.summary:
                raise ValueError("The review expansion returns complete geometry.")
            result = json.loads(verification.expand_review(
                original, recipe_bytes, args.add_filled_locks).decode("utf-8-sig"))
        else:
            result = compile_requirements(original, recipe)
        if args.summary:
            result = {"status": "compiled", "editablePixels": result["editablePixels"],
                      "protectedPixels": result["protectedPixels"], "openings": len(result["openings"])}
        print(json.dumps(result, ensure_ascii=True))
    except (KeyError, OSError, TypeError, ValueError) as error:
        parser.exit(2, f"{error}\n")


if __name__ == "__main__":
    main()
