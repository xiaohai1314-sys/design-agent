"""Compare a generated room's measured inner frame and proposed dimension chains."""

import argparse
import json
import math
from pathlib import Path

import cv2
import numpy as np
from PIL import Image


def positive(value, name):
    if type(value) not in (int, float) or not math.isfinite(value) or value <= 0:
        raise ValueError(f"{name} must be a positive number.")
    return value


def check(spec, canvas):
    width = positive(spec["width"], "width")
    depth = positive(spec["depth"], "depth")
    limit = positive(spec.get("ratioReviewPercent", 5), "ratioReviewPercent")
    box = spec["innerRectPx"]
    if not isinstance(box, list) or len(box) != 4 or any(type(edge) is not int for edge in box):
        raise ValueError("innerRectPx requires four integer edges: left, top, right, bottom.")
    left, top, right, bottom = box
    if not (0 <= left < right <= canvas[0] and 0 <= top < bottom <= canvas[1]):
        raise ValueError("The measured inner frame must be inside the candidate image.")
    target = width / depth
    measured = (right - left) / (bottom - top)
    error = abs(measured / target - 1) * 100
    issues = ["inner_ratio_needs_review"] if error > limit else []
    chains = spec["chains"]
    if not isinstance(chains, dict) or set(chains) != {"width", "depth"}:
        raise ValueError("Provide a complete chain on each axis: width and depth.")
    checks = {}
    for axis, span in (("width", width), ("depth", depth)):
        segments = chains[axis]
        if not isinstance(segments, list) or not segments:
            raise ValueError(f"The {axis} chain needs named segments.")
        if any(not isinstance(segment["name"], str) or not segment["name"].strip() for segment in segments):
            raise ValueError("Each chain segment needs a name.")
        total = math.fsum(positive(segment["size"], segment["name"]) for segment in segments)
        remainder = round(span - total, 6)
        if remainder:
            issues.append(f"{axis}_chain_does_not_close")
        checks[axis] = {"total": total, "remainder": remainder}
    return {
        "status": "needs_review" if issues else "checks_passed",
        "innerSizePx": [right - left, bottom - top],
        "targetRatio": round(target, 4),
        "measuredRatio": round(measured, 4),
        "relativeErrorPercent": round(error, 2),
        "ratioReviewPercent": limit,
        "chains": checks,
        "issues": issues,
    }


def frame_from_wall_mask(mask):
    height, width = mask.shape
    kernel = np.ones((max(3, round(height * .004)), max(3, round(width * .004))), dtype=np.uint8)
    wall_ink = cv2.morphologyEx(mask.astype(np.uint8), cv2.MORPH_OPEN, kernel)
    edges = []
    for axis in (0, 1):
        span = mask.shape[1 - axis]
        supported = wall_ink.sum(axis=axis) >= .29 * mask.shape[axis]
        changes = np.flatnonzero(np.diff(np.r_[False, supported, False].astype(np.int8)))
        bands = [(int(start), int(end)) for start, end in zip(changes[::2], changes[1::2])
                 if .013 * span <= end - start <= .10 * span]
        near = [band for band in bands if band[0] <= .15 * span]
        far = [band for band in bands if band[1] >= .85 * span]
        pairs = [(first, last) for first in near for last in far]
        if len(pairs) > 1:
            # A cabinet can form a wide dark band near a wall. Opposing walls
            # of similar thickness can disambiguate without using the target ratio.
            pairs = [
                (first, last) for first, last in pairs
                if max(first[1] - first[0], last[1] - last[0])
                <= 2 * min(first[1] - first[0], last[1] - last[0])
                and last[0] - first[1] >= .55 * span
            ]
        if len(pairs) != 1:
            raise ValueError("Four unambiguous outer wall bands were not found. Measure their inner edges manually.")
        first, last = pairs[0]
        if last[0] - first[1] < .55 * span:
            raise ValueError("The wall bands are too close together. Measure their inner edges manually.")
        edges.append((first[1], last[0]))
    (left, right), (top, bottom) = edges
    return [left, top, right, bottom]


def detect_inner_frame(rgb):
    if min(rgb.shape[:2]) < 240:
        raise ValueError("The image is too small to find reliable wall bands.")
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    try:
        return frame_from_wall_mask(gray <= 100)
    except ValueError:
        # Neutral mid-gray wall fills are common in color plans. Keep the
        # extra range limited to nearly achromatic pixels so wood and floors
        # do not become solid walls at the higher threshold.
        neutral = np.ptp(rgb, axis=2) <= 15
        return frame_from_wall_mask((gray <= 100) | (neutral & (gray <= 168)))


def measure_candidate(candidate, spec, detect):
    measured = spec.copy()
    detected = detect and "innerRectPx" not in measured
    with Image.open(candidate) as image:
        canvas = image.size
        if detected:
            measured["innerRectPx"] = detect_inner_frame(np.asarray(image.convert("RGB")))
    report = check(measured, canvas)
    if detected:
        report["innerRectPx"] = measured["innerRectPx"]
    return report


def compare_candidates(candidates, spec):
    if "innerRectPx" in spec:
        raise ValueError("Batch comparison needs automatic measurements. Use separate calls for manual inner edges.")
    results = []
    for candidate in candidates:
        try:
            result = measure_candidate(candidate, spec, detect=True)
        except (OSError, ValueError) as error:
            result = {"status": "unmeasured", "reason": str(error)}
        results.append({"file": str(candidate), **result})
    fits = sorted(
        (result for result in results if result["status"] == "checks_passed"),
        key=lambda result: result["relativeErrorPercent"],
    )
    return {
        "status": "fit_available" if fits else "needs_review",
        "fitCandidates": [result["file"] for result in fits],
        "candidates": results,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("candidate", type=Path)
    parser.add_argument("geometry", type=Path)
    parser.add_argument("--detect-inner-frame", action="store_true", help="locate continuous dark outer walls when no innerRectPx is supplied")
    parser.add_argument("--also", type=Path, action="append", default=[],
                        help="compare another candidate with the same design dimensions and automatic inner-edge detection")
    args = parser.parse_args()
    try:
        spec = json.loads(args.geometry.read_text(encoding="utf-8-sig"))
        if args.also:
            report = compare_candidates([args.candidate, *args.also], spec)
        else:
            report = measure_candidate(args.candidate, spec, args.detect_inner_frame)
        print(json.dumps(report, ensure_ascii=True))
    except (KeyError, OSError, TypeError, ValueError) as error:
        parser.exit(2, f"{error}\n")
    if report["status"] == "needs_review":
        raise SystemExit(1)


if __name__ == "__main__":
    main()
