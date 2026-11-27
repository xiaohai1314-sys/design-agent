"""Find filled linework regions in a source floor plan. Writes no image."""

import argparse
import hashlib
import json
from pathlib import Path

import cv2
import numpy as np


def inspect_linework(gray, dark_background, bounds):
    height, width = gray.shape
    left, top, right, bottom = bounds or (0, 0, width, height)
    if not (0 <= left < right <= width and 0 <= top < bottom <= height):
        raise ValueError("Linework bounds must be within the original image.")
    crop = gray[top:bottom, left:right]
    ink = (crop >= 135 if dark_background else crop <= 165).astype(np.uint8)
    minimum = max(20, round(min(height, width) * 0.055))
    result = {"minimumLengthPx": minimum, "bounds": [left, top, right, bottom]}
    for axis, name in enumerate(("horizontal", "vertical")):
        shape = (1, minimum) if axis == 0 else (minimum, 1)
        lines = cv2.morphologyEx(ink, cv2.MORPH_OPEN, np.ones(shape, np.uint8))
        _, _, stats, _ = cv2.connectedComponentsWithStats(lines, connectivity=8)
        bands = [tuple(map(int, item[:4])) for item in stats[1:]
                 if item[2 + axis] >= minimum and item[3 - axis] <= min(height, width) * 0.03]
        bands.sort(key=lambda band: (-band[2 + axis], band[1], band[0]))
        result[name] = [[left + x, top + y, left + x + w, top + y + h] for x, y, w, h in bands[:18]]
    return result


def inspect(data, linework=False, bounds=None, filled_margin_px=1):
    image = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("Cannot decode the source plan.")
    height, width = image.shape[:2]
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    neutral = image.max(axis=2) - image.min(axis=2) <= 24
    frame = np.concatenate((gray[0], gray[-1], gray[:, 0], gray[:, -1]))
    background = float(np.median(frame))
    if 85 < background < 170:
        raise ValueError("The filled-linework scan requires a high-contrast plan.")
    dark_background = background <= 85
    filled = neutral & (gray >= 170 if dark_background else gray <= 75)
    kernel_size = max(3, min(19, round(min(height, width) / 165)))
    opened = cv2.morphologyEx(filled.astype(np.uint8), cv2.MORPH_OPEN, np.ones((kernel_size, kernel_size), np.uint8))
    # Extend just past antialiased edges. Returned regions are candidates for
    # review because symbols and filled annotations may survive the filter.
    margin_size = 2 * filled_margin_px + 1
    expanded = cv2.dilate(opened, np.ones((margin_size, margin_size), np.uint8))
    contours, _ = cv2.findContours(expanded, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    selected = []
    for contour in contours:
        x, y, w, h = cv2.boundingRect(contour)
        area = float(cv2.contourArea(contour))
        if area < kernel_size * kernel_size * 2 or max(w, h) < kernel_size * 2:
            continue
        points = cv2.approxPolyDP(contour, 0.8, True).reshape(-1, 2)
        if len(points) < 3:
            continue
        selected.append((y, x, {
            "rect": [x, y, x + w, y + h],
            "points": points.tolist(),
            "areaPx": round(area),
            "fillFraction": round(area / (w * h), 3),
        }))
    selected.sort(key=lambda item: item[:2])
    result = {
        "originalSha256": hashlib.sha256(data).hexdigest(),
        "imageSize": [width, height],
        "background": "dark" if dark_background else "light",
        "minimumFillThicknessPx": kernel_size,
        "filledCandidates": [{"id": f"S{number:02d}", **value} for number, (_, _, value) in enumerate(selected, 1)],
    }
    if linework:
        result["linework"] = inspect_linework(gray, dark_background, bounds)
    return result


def add_filled_locks(original_bytes, review):
    # Include the antialiased fringe before tracing the lock polygon.
    structure = inspect(original_bytes, filled_margin_px=3)
    if review["originalSha256"] != structure["originalSha256"]:
        raise ValueError("The review does not identify the original image.")
    filled = structure["filledCandidates"]
    if not filled:
        raise ValueError("No filled regions were detected on the original plan.")
    locks = [{"id": item["id"], "points": item["points"]} for item in filled]
    return {**review, "locks": [*review.get("locks", []), *locks]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("plan", type=Path)
    parser.add_argument("--summary", action="store_true", help="show IDs and rectangles without contour vertices")
    parser.add_argument("--linework", action="store_true", help="include long horizontal and vertical source line bands")
    parser.add_argument("--linework-bounds", type=int, nargs=4, metavar=("LEFT", "TOP", "RIGHT", "BOTTOM"),
                        help="limit the linework scan to a rectangle in original pixels")
    args = parser.parse_args()
    try:
        report = inspect(args.plan.read_bytes(), args.linework or args.linework_bounds is not None, args.linework_bounds)
        if args.summary:
            for candidate in report["filledCandidates"]:
                del candidate["points"]
        print(json.dumps(report, ensure_ascii=True))
    except (OSError, ValueError) as error:
        parser.exit(2, f"{error}\n")


if __name__ == "__main__":
    main()
