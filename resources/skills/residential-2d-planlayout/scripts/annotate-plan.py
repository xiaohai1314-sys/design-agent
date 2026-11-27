"""Prepare an annotated source plan, optionally with a checked guide receipt."""

import argparse
import hashlib
import json
import math
from pathlib import Path
from tempfile import TemporaryDirectory

from PIL import Image, ImageDraw
from plan_draw import dashed_line, draw_bed, draw_corners
from plan_io import font, new_png, open_image, run_script, save_png, sha256, write_json


def preflight(args, geometry, review_bytes):
    checks = []
    if geometry.get("existingRoutes"):
        checks.append("--check-existing-routes")
    if geometry.get("plannedCircuits"):
        checks.append("--check-planned-review")
    if args.check_plan_points:
        checks = ["--check-plan-points"]
    selection = {}
    with TemporaryDirectory() as folder:
        snapshot = Path(folder) / "source-review.json"
        snapshot.write_bytes(review_bytes)
        for check in checks:
            select = (
                args.show_openings_cleared
                and check == "--check-planned-review"
                or args.keep_uncleared_openings
                and check == "--check-plan-points"
            )
            result = run_script(
                "compile-plan-requirements",
                args.input_path,
                snapshot,
                check,
                add_filled_locks=args.protect_filled_regions,
                select_clearable_openings=select,
                check_flat_source_locations=args.colored_plan
                and args.check_plan_points,
                check_cleared_openings=args.show_openings_cleared
                and args.check_plan_points
                and not select,
                initial_guide_receipt=args.initial_plan_receipt_path
                if args.check_plan_points
                else None,
            )
            if select:
                selection = json.loads(result)
    return selection


def guide_crop(value, size):
    if value is None:
        return 0, 0, *size
    if (
        not isinstance(value, list)
        or len(value) != 4
        or any(type(n) is not int for n in value)
    ):
        raise ValueError("Crop requires four integer pixels: x, y, width, height.")
    x, y, w, h = value
    if not (0 <= x < x + w <= size[0] and 0 <= y < y + h <= size[1]):
        raise ValueError("Crop must be within the source image.")
    return x, y, x + w, y + h


def draw_guide(source, geometry, args, selection):
    crop = guide_crop(geometry.get("crop"), source.size)
    left, top, right, bottom = crop
    proposed = [
        item
        for item in geometry.get("crossings", [])
        if item.get("state") == "proposed"
    ]
    closed = [
        item for item in geometry.get("crossings", []) if item.get("state") == "closed"
    ]
    footprints = [
        item
        for item in geometry.get("planPoints", [])
        if item.get("showOnGuide") is True
    ]
    unconfirmed = geometry.get("unconfirmedAreas", [])
    routes = geometry.get("routes") or []
    checked_routes = (geometry.get("existingRoutes") or []) + (
        geometry.get("plannedCircuits") or []
    )
    if routes and checked_routes:
        raise ValueError(
            "Use either display routes or the routes and circuits from the review."
        )
    routes = [] if args.clean_guide else (routes or checked_routes)
    labels = geometry.get("labels") or []
    outline = geometry.get("outline") or []
    if not (
        labels
        or outline
        or routes
        or geometry.get("crop")
        or args.clean_guide
        or args.check_plan_points
        and (footprints or proposed or closed or unconfirmed)
    ):
        raise ValueError(
            "Provide an outline, labels, routes, checked footprints, planned openings, or a crop."
        )

    cleared = [item for item in proposed if "clearRect" in item]
    if args.show_openings_cleared:
        if "shownCleared" in selection:
            cleared = [
                item for item in cleared if item["id"] in selection["shownCleared"]
            ]
        if args.keep_uncleared_openings:
            unchanged_ids = {
                item["id"] for item in selection.get("unchangedSeparators", [])
            }
            cleared = [item for item in cleared if item["id"] not in unchanged_ids]
    else:
        cleared = []
    erase = [item["clearRect"] for item in cleared]
    if args.plan_receipt_path:
        erase += [
            rect for item in cleared for rect in item.get("clearAdjacentRects", [])
        ]
        if geometry.get("crop") is not None:
            for region in (geometry.get("edits") or []) + unconfirmed:
                if any(
                    not (left <= x <= right and top <= y <= bottom)
                    for x, y in region["points"]
                ):
                    raise ValueError(
                        "The cropped layout guide must cover all edit and unconfirmed areas."
                    )
            if any(
                not (left <= l < r <= right and top <= t < b <= bottom)
                for l, t, r, b in erase
            ):
                raise ValueError(
                    "The cropped layout guide must include every checked opening."
                )
        labels = [
            label
            for label in labels
            if not (
                label.get("anchor")
                and any(
                    l <= label["anchor"][0] < r and t <= label["anchor"][1] < b
                    for l, t, r, b in erase
                )
            )
        ]
    canvas = source.crop(crop)
    marks = Image.new("RGBA", canvas.size)
    draw = ImageDraw.Draw(marks)
    font_size = max(12, min(44, round(min(canvas.size) * 0.017)))

    def offset(point):
        x, y = point
        return x - left, y - top

    def pixel(pair):
        x, y = pair
        if not all(type(n) in (int, float) and math.isfinite(n) for n in pair) or not (
            left <= x < right and top <= y < bottom
        ):
            raise ValueError("Pixel coordinate falls outside the selected image area.")
        return offset(pair)

    def box(rect):
        l, t, r, b = rect
        return l - left, t - top, r - left, b - top

    for route in routes:
        width = route.get("reservedWidthPx") or route.get("widthPx")
        if (
            not isinstance(width, (int, float))
            or not 1 <= width <= min(canvas.size)
            or len(route["points"]) < 2
        ):
            raise ValueError(
                "A route needs at least two points and a positive width in source pixels."
            )
        points = [pixel(point) for point in route["points"]]
        color = (255, 164, 28, 88)
        draw.line(points, fill=color, width=round(width), joint="curve")
        for x, y in (points[0], points[-1]):
            radius = width / 2
            draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=color)
        if args.route_receipt_path and route.get("furnitureRect"):
            l, t, r, b = box(route["furnitureRect"])
            dashed_line(
                draw,
                [(l, t), (r, t), (r, b), (l, b)],
                (64, 132, 85, 220),
                2,
                closed=True,
            )
    if args.clean_guide:
        for circuit in geometry.get("plannedCircuits", []):
            if circuit.get("furnitureRect"):
                l, t, r, b = box(circuit["furnitureRect"])
                draw_corners(
                    draw,
                    (l, t, r, b),
                    (106, 106, 106, 200),
                    min(12, (r - l) / 4, (b - t) / 4),
                )
    hidden = []
    if (args.route_receipt_path or args.check_plan_points) and not args.clean_guide:
        for item in footprints:
            rect = box(item["rect"])
            l, t, r, b = rect
            head = item.get("guideBedHead")
            if head:
                draw_bed(marks, rect, head, guide=True)
            else:
                draw_corners(
                    draw, rect, (64, 132, 85, 220), min(9, (r - l) / 5, (b - t) / 5)
                )
            if (
                args.check_plan_points
                and not args.omit_furniture_labels
                and item.get("guideLabel")
            ):
                label = item["guideLabel"].strip()
                margin = (b - t) * 0.40 if head else min(12, (b - t) / 5)
                center = ((l + r) / 2, t + margin)
                for size in range(max(13, round(font_size * 0.85)), 10, -1):
                    face = font(size, chinese=True)
                    x0, y0, x1, y1 = draw.textbbox(
                        center, label, font=face, anchor="mt"
                    )
                    if x1 - x0 <= r - l - 4 and y1 - y0 <= b - center[1] - 2:
                        draw.rectangle(
                            (x0 - 2, y0 - 1, x1 + 2, y1 + 1), fill=(232, 253, 237, 172)
                        )
                        draw.text(
                            center,
                            label,
                            font=face,
                            anchor="mt",
                            fill=(15, 80, 49, 255),
                        )
                        break
                else:
                    hidden.append(item["id"])
    if not args.clean_guide and (
        args.check_plan_points
        or args.route_receipt_path
        and geometry.get("plannedCircuits")
    ):
        for item in proposed:
            if args.plan_receipt_path and item in cleared:
                continue
            segment = [pixel(item[key]) for key in ("from", "to")]
            draw.line(
                segment, fill=(0, 148, 210, 68), width=max(1, round(item["width"]))
            )
            draw.line(
                segment, fill=(0, 123, 154, 232), width=max(2, round(font_size / 5))
            )
    if args.check_plan_points:
        for item in closed:
            a, b = (tuple(item[key]) for key in ("from", "to"))
            dx, dy = b[0] - a[0], b[1] - a[1]
            factor = item["width"] / (2 * math.hypot(dx, dy))
            x, y = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
            draw.line(
                [
                    pixel((x - dy * factor, y + dx * factor)),
                    pixel((x + dy * factor, y - dx * factor)),
                ],
                fill=(136, 90, 37, 222),
                width=max(2, round(font_size / 5)),
            )
    if outline:
        if len(outline) < 3:
            raise ValueError("Trace at least three outline points.")
        dashed_line(
            draw,
            [pixel(point) for point in outline],
            (199, 42, 36, 245),
            max(1, round(font_size / 8)),
            closed=True,
        )
    if args.plan_receipt_path:
        for region in unconfirmed:
            dashed_line(
                draw,
                [offset(point) for point in region["points"]],
                (119, 76, 142, 235),
                max(1, round(font_size / 9)),
                closed=True,
            )
    face = font(font_size, chinese=True)
    for label in labels:
        center = pixel((label["x"], label["y"]))
        text = label["text"]
        l, t, r, b = draw.textbbox(center, text, font=face, anchor="mm")
        if l < 2 or t < 2 or r + 2 >= canvas.width or b + 2 >= canvas.height:
            raise ValueError("A label falls outside the source image.")
        blue = (18, 69, 144, 255)
        if label.get("anchor") is not None:
            x, y = pixel(label["anchor"])
            radius = max(2, font_size / 6)
            draw.line((center, (x, y)), fill=blue, width=max(1, round(font_size / 10)))
            draw.ellipse((x - radius, y - radius, x + radius, y + radius), outline=blue)
        draw.rectangle((l - 2, t - 1, r + 2, b + 1), fill=(255, 255, 255, 235))
        draw.text(center, text, font=face, anchor="mm", fill=blue)

    background = "black" if geometry.get("background") == "dark" else "white"
    for rect in erase:
        canvas.paste(background, box(rect))
        if args.plan_receipt_path:
            marks.paste((0, 0, 0, 0), box(rect))
    canvas.alpha_composite(marks)
    return canvas, hidden


def annotate(args):
    destination = new_png(args.output_path)
    source_hash = sha256(args.input_path)
    input_review = args.geometry_path.read_bytes()
    review_bytes = input_review
    variant_hash = sha256(args.variant_path) if args.variant_path else None
    plan_check = args.plan_receipt_path and args.check_plan_points
    if args.variant_path:
        if not plan_check or args.patch_original_path:
            raise ValueError(
                "A variant requires its own checked guide and plan receipt."
            )
        review_bytes = (
            run_script(
                "compile-plan-requirements",
                args.input_path,
                args.geometry_path,
                layout_variant=args.variant_path,
            )
            + "\n"
        ).encode()
    geometry = json.loads(review_bytes.decode("utf-8-sig"))
    if "optionalSeparators" in geometry:
        raise ValueError(
            "Select a variant when the source review lists optionalSeparators."
        )
    has_routes = geometry.get("existingRoutes") or geometry.get("plannedCircuits")
    if args.colored_plan and not plan_check:
        raise ValueError("Use --colored-plan with a checked plan receipt.")
    if args.colored_plan:
        colored = False
        for item in geometry.get("crossings", []):
            if item.get("state") == "proposed" and "surface" not in item:
                item["surface"] = "colored"
                colored = True
        if colored:
            review_bytes = (json.dumps(geometry) + "\n").encode()
    if args.show_openings_cleared and (
        not (
            plan_check
            or args.route_receipt_path
            and geometry.get("plannedCircuits")
            and geometry.get("crop") is None
        )
        or not any(
            item.get("state") == "proposed" and "clearRect" in item
            for item in geometry.get("crossings", [])
        )
    ):
        raise ValueError(
            "Clearing openings requires a checked guide with proposed clearRect openings."
        )
    if args.clean_guide and (
        not args.show_openings_cleared
        or geometry.get("outline")
        or geometry.get("labels")
    ):
        raise ValueError(
            "A clean guide requires checked clearRect openings and no added labels or outline."
        )
    if args.keep_uncleared_openings and not (
        args.show_openings_cleared and plan_check and not args.clean_guide
    ):
        raise ValueError(
            "Use --keep-uncleared-openings with a checked furnished guide and --show-openings-cleared."
        )
    if args.route_receipt_path and (args.check_plan_points or not has_routes):
        raise ValueError(
            "A route receipt needs existingRoutes or plannedCircuits and runs its own checks."
        )
    if args.plan_receipt_path and (not args.check_plan_points or has_routes):
        raise ValueError(
            "A plan receipt needs --check-plan-points. Use a route receipt for routes or circuits."
        )
    if args.initial_plan_receipt_path and not (
        args.plan_receipt_path or args.patch_original_path
    ):
        raise ValueError(
            "Provide a new plan receipt together with the initial receipt."
        )
    if args.patch_original_path:
        if (
            not args.initial_plan_receipt_path
            or args.check_plan_points
            or args.plan_receipt_path
            or args.route_receipt_path
            or args.show_openings_cleared
            or args.protect_filled_regions
            or any(geometry.get(key) for key in ("labels", "outline", "routes"))
        ):
            raise ValueError(
                "A patch needs a plain crop, absolute edits, the original and its initial receipt."
            )
        run_script(
            "compile-plan-requirements",
            args.patch_original_path,
            args.geometry_path,
            patch_base=args.input_path,
            initial_guide_receipt=args.initial_plan_receipt_path,
        )
    receipt = args.plan_receipt_path or args.route_receipt_path
    if receipt:
        receipt = receipt.resolve()
        snapshot = receipt.with_suffix(".source-review.json")
        if (
            len({receipt, snapshot, destination}) != 3
            or receipt.exists()
            or snapshot.exists()
        ):
            raise ValueError("Choose a separate new file for the guide receipt.")
    selection = (
        preflight(args, geometry, review_bytes)
        if args.check_plan_points or args.route_receipt_path
        else {}
    )
    image, hidden = draw_guide(open_image(args.input_path), geometry, args, selection)
    if (
        sha256(args.input_path) != source_hash
        or args.geometry_path.read_bytes() != input_review
        or args.variant_path
        and sha256(args.variant_path) != variant_hash
    ):
        raise ValueError("The original or its review changed during preflight.")
    save_png(image, destination)
    if receipt:
        record = {
            "originalSha256": source_hash,
            "reviewSha256": hashlib.sha256(review_bytes).hexdigest(),
            "protectFilledRegions": args.protect_filled_regions,
            "reviewSnapshot": snapshot.name,
        }
        if plan_check:
            record["check"] = "plan_points_covered"
        try:
            with snapshot.open("xb") as stream:
                stream.write(review_bytes)
            try:
                write_json(receipt, record)
            except (OSError, ValueError):
                snapshot.unlink()
                raise
        except (OSError, ValueError):
            destination.unlink()
            raise
    result = {"guidePath": str(destination)}
    if receipt:
        result["planReceiptPath"] = str(receipt)
        result["nextAction"] = (
            "Use guidePath as the single floor-plan reference and keep planReceiptPath for composition and review."
        )
    if selection.get("unchangedSeparators"):
        result["unchangedSeparators"] = selection["unchangedSeparators"]
        result["nextAction"] += (
            " Describe the remaining separators as proposed openings, and check them before delivery."
        )
    if geometry.get("unconfirmedAreas"):
        result["unconfirmedAreaIds"] = [
            area["id"] for area in geometry["unconfirmedAreas"]
        ]
        result["nextAction"] = (
            result.get("nextAction", "")
            + " Preserve each purple dashed area and keep changes outside it."
        )
    if hidden:
        result["unshownFurnitureLabels"] = hidden
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("input", "output", "geometry"):
        parser.add_argument(f"--{name}-path", type=Path, required=True)
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--route-receipt-path", type=Path)
    group.add_argument("--plan-receipt-path", type=Path)
    for name in ("variant", "initial-plan-receipt", "patch-original"):
        parser.add_argument(f"--{name}-path", type=Path)
    for flag in (
        "protect-filled-regions",
        "check-plan-points",
        "show-openings-cleared",
        "clean-guide",
        "omit-furniture-labels",
        "keep-uncleared-openings",
        "colored-plan",
    ):
        parser.add_argument(f"--{flag}", action="store_true")
    try:
        print(json.dumps(annotate(parser.parse_args()), allow_nan=False))
    except (OSError, ValueError, TypeError, KeyError) as error:
        parser.exit(2, f"{error}\n")


if __name__ == "__main__":
    main()
