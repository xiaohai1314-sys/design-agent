"""Read two plan images and propose same-position landmarks. Writes no images."""

import argparse
from importlib import import_module
import json
from pathlib import Path

import cv2
import numpy as np


def describe(path, detector, crop=None):
    pixels = cv2.imdecode(np.fromfile(path, dtype=np.uint8), cv2.IMREAD_GRAYSCALE)
    if pixels is None:
        raise ValueError(f"Cannot read plan: {path.name}")
    left = top = 0
    if crop is not None:
        if not isinstance(crop, list) or len(crop) != 4 or any(type(value) is not int for value in crop):
            raise ValueError("A reference crop needs integer left, top, width and height.")
        left, top, width, height = crop
        if (left < 0 or top < 0 or width < 1 or height < 1
                or left + width > pixels.shape[1] or top + height > pixels.shape[0]):
            raise ValueError("The reference crop must lie inside the base image.")
        pixels = pixels[top:top + height, left:left + width]
    factor = min(1.0, 1600 / max(pixels.shape))
    if factor < 1:
        pixels = cv2.resize(pixels, None, fx=factor, fy=factor, interpolation=cv2.INTER_AREA)
    points, descriptors = detector.detectAndCompute(pixels, None)
    coordinates = np.array([point.pt for point in points], dtype=np.float32).reshape(-1, 2)
    return coordinates / factor + np.array([left, top], dtype=np.float32), descriptors, factor


def unambiguous_matches(matcher, first, second):
    return {
        pair[0].queryIdx: pair[0].trainIdx
        for pair in matcher.knnMatch(first, second, k=2)
        if len(pair) == 2 and pair[0].distance < 0.75 * pair[1].distance
    }


def covers_bounds(target, bounds):
    return (len(target) >= 10 and np.min(np.ptp(target, axis=0)) >= 48
            and (target.min(axis=0) <= bounds[:2]).all() and (target.max(axis=0) >= bounds[2:]).all())


def axis_scaled_matches(source, target, bounds, tolerance=3.0):
    matrix, inliers = cv2.estimateAffine2D(source, target, method=cv2.RANSAC,
                                           ransacReprojThreshold=tolerance)
    if matrix is None or not np.isfinite(matrix).all():
        return None
    scale = np.diag(matrix[:, :2])
    cross_axis = [matrix[0, 1], matrix[1, 0]]
    if min(scale) <= 0 or max(scale) / min(scale) > 1.08 or np.max(np.abs(cross_axis)) > 0.006 * min(scale):
        return None
    error = np.linalg.norm(source * scale + matrix[:, 2] - target, axis=1)
    accepted = inliers.ravel().astype(bool) & (error <= tolerance)
    if np.mean(accepted) < 0.5 or not covers_bounds(target[accepted], bounds):
        return None
    return accepted


def match_plans(base_path, candidate_path, bounds, crop=None, edits=None):
    detector = cv2.SIFT_create(nfeatures=6000)
    base_points, base_descriptors, base_factor = describe(base_path, detector, crop)
    candidate_points, candidate_descriptors, _ = describe(candidate_path, detector)
    if base_descriptors is None or candidate_descriptors is None:
        raise ValueError("No usable landmarks in at least one plan.")
    matcher = cv2.BFMatcher(cv2.NORM_L2)
    forward = unambiguous_matches(matcher, candidate_descriptors, base_descriptors)
    reverse = unambiguous_matches(matcher, base_descriptors, candidate_descriptors)
    pairs = [(a, b) for a, b in forward.items() if reverse.get(b) == a]
    if len(pairs) < 10:
        raise ValueError(f"Only {len(pairs)} mutually distinctive matches.")
    candidate_ids, base_ids = zip(*pairs)
    source, target = candidate_points[list(candidate_ids)], base_points[list(base_ids)]
    transform, inliers = cv2.estimateAffinePartial2D(source, target, method=cv2.RANSAC, ransacReprojThreshold=3.0)
    accepted = inliers.ravel().astype(bool) if inliers is not None else np.zeros(len(pairs), dtype=bool)
    rotation = abs(np.degrees(np.arctan2(transform[1, 0], transform[0, 0]))) if transform is not None else None
    left, top, right, bottom = bounds
    if left >= right or top >= bottom:
        raise ValueError("Edit bounds must have positive width and height.")
    method = None
    if (rotation is None or rotation > 0.35 or np.mean(accepted) < 0.5
            or not covers_bounds(target[accepted], bounds)):
        adjusted = axis_scaled_matches(source, target, bounds)
        if adjusted is None and base_factor < 0.75:
            # The detected points are quantized on the smaller analysis image.
            # Resizing back amplifies that uncertainty in original-image pixels.
            adjusted = axis_scaled_matches(source, target, bounds, min(6.0, 2.0 / base_factor))
        if adjusted is None and crop is None and edits:
            # Interior furniture and labels can add distinctive but misplaced
            # matches. Retry using only evidence from outside the edit polygons.
            polygons = [np.asarray(edit["points"], dtype=np.float32) for edit in edits]
            fixed = np.array([
                all(cv2.pointPolygonTest(polygon, tuple(map(float, position)), True) < -2 for polygon in polygons)
                for position in target
            ])
            if np.count_nonzero(fixed) >= 10:
                fixed_matches = axis_scaled_matches(source[fixed], target[fixed], bounds)
                if fixed_matches is not None:
                    adjusted = np.zeros(len(pairs), dtype=bool)
                    adjusted[fixed] = fixed_matches
                    method = "outside-edit-landmarks"
        if adjusted is None:
            if rotation is None:
                raise ValueError("No repeatable image alignment.")
            if np.mean(accepted) < 0.5:
                raise ValueError(f"Only {np.count_nonzero(accepted)} of {len(pairs)} matches agree.")
            if rotation > 0.35:
                raise ValueError(f"Images rotate by {rotation:.2f} degrees.")
            if crop is not None:
                agreed = target[accepted]
                supported = [round(float(edge), 1) for edge in (*agreed.min(axis=0), *agreed.max(axis=0))]
                requested = np.round(bounds, 1).tolist()
                raise ValueError(f"Crop landmarks span {supported}, but the patch needs {requested} "
                                 "[left, top, right, bottom] in original pixels. "
                                 "Keep the complete object within verified coverage or use a wider source crop with fixed corners.")
            raise ValueError("Matching landmarks do not span the edit in both directions.")
        accepted = adjusted
        method = method or "axis-scaled-features"
    source, target = source[accepted], target[accepted]

    # Several SIFT points at one wall corner count as one area of support.
    span = target.max(axis=0) - target.min(axis=0)
    support = np.unique(np.floor((target - target.min(axis=0)) / (span / 4)).astype(int), axis=0)
    if len(support) < 8:
        raise ValueError(f"Landmarks occupy only {len(support)} areas of the plan.")

    # Keep the extrema and at most one distinct point per cell. The compositor
    # independently fits separate x/y scales and checks their maximum residual.
    selected = set(target.argmin(axis=0)) | set(target.argmax(axis=0))
    cells = np.floor((target - target.min(axis=0)) / (span / 4)).astype(int)
    _, indices = np.unique(cells, axis=0, return_index=True)
    selected.update(indices)
    result = {
        "anchors": [
            {"base": target[index].round(3).tolist(), "candidate": source[index].round(3).tolist()}
            for index in sorted(selected)
        ],
        "matches": len(pairs),
        "inliers": len(source),
        "supportAreas": len(support),
        "rotationDegrees": 0 if method else round(float(rotation), 3),
    }
    if method:
        result["method"] = method
    return result


def match_filled_regions(base_path, candidate_path, bounds):
    scan = import_module("inspect-plan-structure").inspect
    base = scan(base_path.read_bytes())
    candidate = scan(candidate_path.read_bytes())
    if base["background"] != candidate["background"]:
        raise ValueError("Filled-region alignment requires the same linework polarity.")
    width, height = base["imageSize"]
    scale = np.array(base["imageSize"]) / candidate["imageSize"]
    if max(scale) / min(scale) > 1.08:
        raise ValueError("The candidate canvas has a different aspect ratio.")
    base_rects = np.array([item["rect"] for item in base["filledCandidates"]], dtype=float).reshape(-1, 4)
    candidate_rects = np.array([item["rect"] for item in candidate["filledCandidates"]], dtype=float).reshape(-1, 4)
    if min(len(base_rects), len(candidate_rects)) < 4:
        raise ValueError("Fewer than four filled regions are visible in both plans.")
    if max(len(base_rects), len(candidate_rects)) > 64:
        raise ValueError("Too many filled regions to distinguish structural landmarks.")

    # Find distinct counterparts near the same location after resizing the
    # whole canvas. Large offsets or widespread shape changes need review.
    expected = candidate_rects * np.tile(scale, 2)
    distance = np.abs(base_rects[:, None, :] - expected[None, :, :]).max(axis=2)
    tolerance = max(8, min(width, height) * 0.012)
    eligible = distance <= tolerance
    pairs = [(i, j) for i, j in zip(*np.nonzero(eligible))
             if np.count_nonzero(eligible[i]) == 1 and np.count_nonzero(eligible[:, j]) == 1]
    if len(pairs) < max(4, 0.7 * max(len(base_rects), len(candidate_rects))):
        raise ValueError("Too few unique filled regions retained their size and position.")
    base_ids, candidate_ids = zip(*pairs)
    target = base_rects[list(base_ids)].reshape(-1, 2)
    source = candidate_rects[list(candidate_ids)].reshape(-1, 2)
    if np.any(target.min(axis=0) > bounds[:2]) or np.any(target.max(axis=0) < bounds[2:]):
        raise ValueError("Matching filled regions do not span the edit.")
    if np.any(np.ptp(source, axis=0) < 48):
        raise ValueError("Matching filled regions are too close together.")

    fit = np.array([np.polyfit(source[:, axis], target[:, axis], 1) for axis in (0, 1)])
    residual = np.linalg.norm(source * fit[:, 0] + fit[:, 1] - target, axis=1)
    if residual.max() > min(3.5, max(2, min(width, height) * 0.004)):
        raise ValueError("Matched filled regions do not agree on a single alignment.")
    if (np.any(source < 0) or np.any(source >= candidate["imageSize"])
            or np.any(target < 0) or np.any(target >= base["imageSize"])):
        raise ValueError("Matched filled regions touch an image edge.")
    if len(np.unique(source, axis=0)) != len(source) or len(np.unique(target, axis=0)) != len(target):
        raise ValueError("Matched filled-region landmarks overlap.")
    return {
        "anchors": [{"base": first.tolist(), "candidate": second.tolist()}
                    for first, second in zip(target, source)],
        "matches": len(pairs),
        "inliers": len(pairs),
        "supportAreas": len(pairs),
        "method": "filled-regions",
    }


def sheet_outline(path):
    image = cv2.imdecode(np.fromfile(path, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("Cannot read the plan outline.")
    height, width = image.shape[:2]
    frame = np.concatenate((image[0], image[-1], image[:, 0], image[:, -1]))
    background = np.median(frame, axis=0).astype(np.int16)
    if np.mean(np.max(np.abs(frame - background), axis=1) <= 10) < 0.95:
        raise ValueError("Outline matching needs a plain sheet margin.")
    foreground = (np.max(np.abs(image.astype(np.int16) - background), axis=2) > 25).astype(np.uint8)
    gap = max(3, round(min(height, width) * 0.014) | 1)
    gap = min(gap, 63)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (gap, gap))
    joined = cv2.morphologyEx(foreground, cv2.MORPH_CLOSE, kernel)
    contours, _ = cv2.findContours(joined, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        raise ValueError("No plan perimeter is visible.")
    outline = max(contours, key=cv2.contourArea)
    x, y, span_x, span_y = cv2.boundingRect(outline)
    if (x <= 0 or y <= 0 or x + span_x >= width or y + span_y >= height
            or cv2.contourArea(outline) < 0.55 * span_x * span_y):
        raise ValueError("The outline is incomplete or touches the sheet edge.")
    corners = cv2.approxPolyDP(outline, max(2, 0.01 * min(span_x, span_y)), True).reshape(-1, 2)
    if len(corners) < 8 or len(corners) > 48:
        raise ValueError("The outline needs distinctive corners and recesses.")
    return outline, corners, (height, width)


def match_sheet_outline(base_path, candidate_path, bounds, regions):
    base_outline, base, shape = sheet_outline(base_path)
    candidate_outline, candidate, _ = sheet_outline(candidate_path)
    span = np.ptp(base, axis=0)
    normalized = (candidate - candidate.min(axis=0)) * span / np.ptp(candidate, axis=0) + base.min(axis=0)
    distances = np.linalg.norm(base[:, None] - normalized[None, :], axis=2)
    forward, reverse = distances.argmin(axis=1), distances.argmin(axis=0)
    pairs = [(i, j) for i, j in enumerate(forward) if reverse[j] == i and distances[i, j] <= 0.022 * min(span)]
    if len(pairs) < max(8, 0.8 * len(base)):
        raise ValueError("Too few outer corners and recesses agree.")
    base_ids, candidate_ids = np.array(pairs).T
    target, source = base[base_ids], candidate[candidate_ids]
    if not ((target.min(axis=0) <= bounds[:2]).all() and (target.max(axis=0) >= bounds[2:]).all()):
        raise ValueError("Matching perimeter corners do not cover the edit.")
    scale, offset = np.array([np.polyfit(source[:, axis], target[:, axis], 1) for axis in (0, 1)]).T
    tolerance = min(8, max(2, min(shape) * 0.004))
    residual = np.linalg.norm(source * scale + offset - target, axis=1)
    if min(scale) <= 0 or max(scale) / min(scale) > 1.08:
        raise ValueError("Perimeter corners disagree on one alignment.")
    # A single rasterized outer corner can be rounded differently. Retain the
    # same fit and independently check the complete enclosed shape below.
    rounded_corner = (len(pairs) >= 12 and np.count_nonzero(residual > tolerance) == 1
                      and residual.max() <= 1.6 * tolerance and np.median(residual) <= tolerance / 2)
    ignored_corner = False
    if residual.max() > tolerance and not rounded_corner:
        if (len(pairs) < 12 or np.count_nonzero(residual > tolerance) != 1
                or not regions.get("locks")):
            raise ValueError("Perimeter corners disagree on one alignment.")
        worst = int(residual.argmax())
        corner = target[worst]
        keep = np.arange(len(pairs)) != worst
        target, source = target[keep], source[keep]
        scale, offset = np.array([np.polyfit(source[:, axis], target[:, axis], 1) for axis in (0, 1)]).T
        new_errors = np.linalg.norm(source * scale + offset - target, axis=1)
        corner_error = np.linalg.norm(candidate[candidate_ids[worst]] * scale + offset - corner)
        if (min(scale) <= 0 or max(scale) / min(scale) > 1.08
                or new_errors.max() > tolerance or np.median(new_errors) > tolerance / 2
                or corner_error > 3.25 * tolerance
                or not ((target.min(axis=0) <= bounds[:2]).all() and (target.max(axis=0) >= bounds[2:]).all())):
            raise ValueError("Other perimeter corners cannot safely establish the same alignment.")
        verifier = import_module("verify-plan-delivery")
        edit = verifier.region_mask(shape, regions["edits"]).astype(bool)
        edit &= ~verifier.region_mask(shape, regions["locks"]).astype(bool)
        x, y = corner
        margin = int(np.ceil(corner_error + 2 * tolerance))
        if edit[max(0, y - margin):y + margin + 1, max(0, x - margin):x + margin + 1].any():
            raise ValueError("An uncertain perimeter corner touches the edit area.")
        ignored_corner = True

    # Distinct corners alone can miss a wall edge lost between two corners.
    # Compare the enclosed areas after fitting the same scale and translation.
    original = cv2.drawContours(np.zeros(shape, np.uint8), [base_outline], -1, 1, cv2.FILLED)
    transformed = np.rint(candidate_outline * scale + offset).astype(np.int32)
    aligned = cv2.drawContours(np.zeros(shape, np.uint8), [transformed], -1, 1, cv2.FILLED)
    mismatch_limit = 0.008 if rounded_corner else 0.012
    if np.count_nonzero(original ^ aligned) > mismatch_limit * np.count_nonzero(original | aligned):
        raise ValueError("The outside shape changes between the matched corners.")
    if ignored_corner and np.any(edit & (aligned == 0)):
        raise ValueError("The candidate perimeter omits an editable area.")
    return {
        "anchors": [{"base": first.tolist(), "candidate": second.tolist()}
                    for first, second in zip(target, source)],
        "matches": len(pairs),
        "inliers": len(target),
        "supportAreas": len(target),
        "method": ("sheet-outline-unchanged-corner" if ignored_corner else
                   "sheet-outline-rounded-corner" if rounded_corner else "sheet-outline"),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("base", type=Path)
    parser.add_argument("candidate", type=Path)
    parser.add_argument("regions", type=Path, help="JSON with edit and lock polygons in original image pixels")
    parser.add_argument("output", type=Path, help="new geometry JSON for the compositor")
    parser.add_argument("--reference-crop", type=Path, help="annotation JSON with crop coordinates on the base image")
    args = parser.parse_args()
    try:
        if args.output.suffix.lower() != ".json":
            raise ValueError("Choose a new JSON output file.")
        regions = json.loads(args.regions.read_text(encoding="utf-8-sig"))
        vertices = np.array([point for region in regions["edits"] for point in region["points"]], dtype=float)
        if vertices.ndim != 2 or vertices.shape[1] != 2 or not np.isfinite(vertices).all():
            raise ValueError("Edit polygons must contain valid points.")
        bounds = [*vertices.min(axis=0), *vertices.max(axis=0)]
        crop = None
        if args.reference_crop:
            crop = json.loads(args.reference_crop.read_text(encoding="utf-8-sig"))["crop"]
            if crop is None:
                raise ValueError("The reference crop cannot be null.")
        try:
            matched = match_plans(args.base, args.candidate, bounds, crop, regions["edits"])
        except ValueError as feature_error:
            if crop is not None:
                raise
            try:
                matched = match_filled_regions(args.base, args.candidate, bounds)
            except ValueError as region_error:
                try:
                    matched = match_sheet_outline(args.base, args.candidate, bounds, regions)
                except ValueError as outline_error:
                    raise ValueError(f"{feature_error} {region_error} {outline_error}") from outline_error
        anchors = matched.pop("anchors")
        geometry = {"anchors": anchors, "edits": regions["edits"], "locks": regions.get("locks", [])}
        with args.output.open("x", encoding="utf-8") as destination:
            json.dump(geometry, destination, indent=2, allow_nan=False)
        print(json.dumps({"path": str(args.output.resolve()), **matched}, allow_nan=False))
    except (KeyError, OSError, ValueError) as error:
        parser.exit(2, f"{error}\n")


if __name__ == "__main__":
    main()
