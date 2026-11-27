"""Register two floor plans, prepare fixed stairs and verify paired delivery."""

import argparse
import json
import math
from pathlib import Path
from tempfile import TemporaryDirectory

from PIL import Image, ImageDraw
from plan_io import (
    copy_new,
    font,
    new_png,
    open_image,
    read_json,
    run_script,
    save_png,
    sha256,
    write_json,
)
from stair_geometry import (
    LEVELS,
    OutsideEditRegion,
    approach_probe,
    assert_within,
    checked_point,
    lerp,
    mask,
    pair_references,
    project,
    reference,
    rounded,
    select_anchors,
    stair_floors,
)


def coordinate_sheet(images, regions, path):
    path = new_png(path)
    with TemporaryDirectory() as temp:
        tiles, reports = [], []
        for level in reversed(LEVELS):
            image = Path(temp) / f"{level}.png"
            report = json.loads(
                run_script(
                    "plan-coordinate-view",
                    input_path=images[level],
                    output_path=image,
                    regions_path=regions.get(level),
                    whole_image=not regions.get(level),
                )
            )
            del report["coordinateView"]
            reports.append({**report, "layer": level})
            tiles.append(open_image(image))
        header, gutter = 32, 16
        sheet = Image.new(
            "RGB",
            (
                sum(tile.width for tile in tiles) + gutter,
                max(tile.height for tile in tiles) + header,
            ),
            "white",
        )
        draw = ImageDraw.Draw(sheet)
        face = font(18, chinese=True)
        x = 0
        for label, tile in zip(("上层", "下层"), tiles):
            draw.text((x + 40, 5), label, fill="black", font=face)
            sheet.paste(tile, (x, header), tile)
            x += tile.width + gutter
        save_png(sheet, path)
    return {"coordinateSheet": str(path), "levels": reports}


def draw_arrow(draw, start, end, width):
    dx, dy = end[0] - start[0], end[1] - start[1]
    norm = math.hypot(dx, dy)
    if not norm:
        return
    x, y = end
    ux, uy = dx / norm, dy / norm
    length, half = width * 3, width * 1.4
    color = (42, 42, 42, 255)
    draw.line((start, end), fill=color, width=width)
    draw.polygon(
        (
            end,
            (x - length * ux - half * uy, y - length * uy + half * ux),
            (x - length * ux + half * uy, y - length * uy - half * ux),
        ),
        fill=color,
    )


def draw_stair(source, floor, level):
    points = floor.outline
    layer = Image.new("RGBA", source.size, "white")
    draw = ImageDraw.Draw(layer)
    ink = (42, 42, 42, 255)
    if floor.turn:
        a, b, c, d, e, f = points
        outer_first, outer_second, _ = floor.turn
        draw.line((a, b, c), fill=ink, width=3)
        draw.line((d, e, f), fill=ink, width=3)
        for index in range(1, 8):
            t = index / 7
            draw.line((lerp(a, b, t), lerp(f, outer_first, t)), fill=ink, width=3)
            draw.line((lerp(c, b, t), lerp(d, outer_second, t)), fill=ink, width=3)
        start, turn, end = lerp(a, f), lerp(b, e), lerp(c, d)
        draw.line((lerp(start, turn, 0.16), turn), fill=ink, width=3)
        draw_arrow(draw, turn, lerp(turn, end, 0.84), 4)
    else:
        a, b, c, d = points
        near, far = lerp(a, b), lerp(d, c)
        width = max(2, min(5, round(floor.width / 35)))
        draw.line((a, d), fill=ink, width=width)
        draw.line((b, c), fill=ink, width=width)
        for index in range(1, 8):
            draw.line(
                (lerp(a, d, index / 8), lerp(b, c, index / 8)), fill=ink, width=width
            )
        start, end = (
            (near, far)
            if math.dist(near, floor.landing) < math.dist(far, floor.landing)
            else (far, near)
        )
        draw_arrow(
            draw, lerp(start, end, 0.18), lerp(start, end, 0.82), round(1.6 * width)
        )
        label = "上" if level == "lower" else "下"
        face = font(max(18, round(floor.width / 5)), chinese=True)
        center = lerp(start, end, 0.1)
        draw.rectangle(
            draw.textbbox(center, label, font=face, anchor="mm"), fill="white"
        )
        draw.text(center, label, font=face, anchor="mm", fill=ink)
    clip = Image.fromarray(mask(points, source.size)).convert("L")
    source.paste(layer, (0, 0), clip)
    return source


def measure_approach(image, sample):
    return json.loads(
        run_script("check-plan-apertures", image, sample, allowed=(0, 1))
    )["crossings"][0]


def lock_flags(pair):
    return {level: bool(pair[level].get("locks")) for level in LEVELS}


def fixed_guides(path, pair_hash, floors):
    if not path:
        return {}
    receipt = read_json(path)
    if (
        receipt["pairSha256"].lower() != pair_hash
        or not receipt["landingGeometryChecked"]
        or any(
            receipt["sourceHashes"][level].lower() != floor.marks.digest
            for level, floor in floors.items()
        )
    ):
        raise ValueError("Use the fixed stair receipt from the same checked pair.")
    guides = {}
    for level in LEVELS:
        found = [guide for guide in receipt["guides"] if guide.get("layer") == level]
        if len(found) != 1:
            raise ValueError(f"The {level} fixed stair guide is missing or duplicated.")
        guide = found[0]
        if not guide.get("stairLock") or guide["layoutBaseSha256"].lower() != sha256(
            guide["layoutBase"]
        ):
            raise ValueError(
                f"The {level} fixed stair base differs from the checked guide."
            )
        for name in ("approachSample", "generationCrop"):
            if guide.get(name) and guide.get(name + "Sha256", "").lower() != sha256(
                guide[name]
            ):
                raise ValueError(f"The {level} {name} differs from the checked guide.")
        guides[level] = guide
    return guides


def write_level_guide(directory, level, floor, shape):
    png, geometry = (
        directory / f"{level}-stairs.{suffix}" for suffix in ("png", "json")
    )
    x, y = rounded(floor.landing)
    write_json(
        geometry,
        {
            "outline": [rounded(point) for point in floor.outline],
            "labels": [
                {"x": x, "y": y, "text": "下层起步" if level == "lower" else "上层落脚"}
            ],
        },
    )
    run_script(
        "annotate-plan",
        input_path=floor.marks.source,
        geometry_path=geometry,
        output_path=png,
    )
    guide = {"layer": level, "image": str(png), "geometry": str(geometry)}
    base = png
    if shape:
        base = directory / f"{level}-layout-base.png"
        save_png(draw_stair(open_image(floor.marks.source), floor, level), base)
        sample = directory / f"{level}-approach.json"
        write_json(sample, {"crossings": [approach_probe(floor.approach, level)]})
        guide.update(
            layoutBase=str(base),
            layoutBaseSha256=sha256(base),
            stairLock={"points": [rounded(point) for point in floor.outline]},
            approachSample=str(sample),
            approachSampleSha256=sha256(sample),
            approachOnSource=measure_approach(floor.marks.source, sample),
        )
        if shape == "turn":
            guide["approachLock"] = {
                "points": [rounded(point) for point in floor.approach]
            }
    if floor.crop:
        jpg, recipe = (
            directory / f"{level}-generation{suffix}"
            for suffix in (".jpg", "-crop.json")
        )
        x, y, w, h = floor.crop
        with jpg.open("xb") as stream:
            open_image(base).crop((x, y, x + w, y + h)).convert("RGB").save(
                stream, "JPEG", quality=94
            )
        write_json(recipe, {"crop": floor.crop})
        guide.update(generationImage=str(jpg), generationCrop=str(recipe))
        if shape:
            guide["generationCropSha256"] = sha256(recipe)
    if sha256(floor.marks.source) != floor.marks.digest:
        raise ValueError(f"The {level} original changed during generation.")
    return guide


def prepare_guides(directory, pair, floors, drift, shape, pair_hash):
    directory = directory.resolve()
    directory.mkdir(parents=True, exist_ok=True)
    suffixes = ["stairs.png", "stairs.json"]
    if shape:
        suffixes += ["layout-base.png", "approach.json"]
    for level, floor in floors.items():
        outputs = suffixes + (
            ["generation.jpg", "generation-crop.json"] if floor.crop else []
        )
        if any((directory / f"{level}-{suffix}").exists() for suffix in outputs):
            raise ValueError("Use an unused directory for each stair pair.")
        if shape:
            # Validate both landing samples before writing any guides.
            approach_probe(floor.approach, level)
    fixed_receipt = directory / "fixed-stair.json"
    if shape and fixed_receipt.exists():
        raise ValueError("Use an unused directory for each stair pair.")
    guides = [
        write_level_guide(directory, level, floor, shape)
        for level, floor in floors.items()
    ]
    report = {
        "status": "stair_position_marked",
        "guides": guides,
        "witnessDriftPx": round(drift, 2),
        "sourceHashes": {level: floor.marks.digest for level, floor in floors.items()},
        "upperEditRegionChecked": pair.get("upperEditRegion") is not None,
        "lockedComponentsChecked": lock_flags(pair),
        "landingGeometryChecked": bool(shape),
    }
    if shape:
        blocked = any(
            guide["approachOnSource"]["status"] == "line_across" for guide in guides
        )
        template = {
            level: "retain" if pair[level].get("retainLayout") else []
            for level in LEVELS
        }
        report.update(
            status="fixed_stair_needs_review" if blocked else "fixed_stair_ready",
            fixedStairReceipt=str(fixed_receipt),
            pairSha256=pair_hash,
            candidateBatchTemplate=template,
            imageGeneration=[
                {
                    "layer": row["layer"],
                    "image": row.get("generationImage") or row["layoutBase"],
                }
                for row in guides
                if not blocked and template[row["layer"]] != "retain"
            ],
        )
        if blocked:
            report["nextAction"] = (
                "A continuous line spans a stair approach. Inspect it and choose a clear landing or report the proposed opening as conditional."
            )
        write_json(fixed_receipt, report)
    else:
        report["nextAction"] = (
            "The guides show position only. Set stairType and check both approaches before generating a fixed stair."
        )
    return report


def final_points(level, item, floor, pair):
    marks, frame = reference(item)
    target = floor.marks
    ref_error = math.dist(
        project(marks.points[3], frame, floor.frame), target.points[3]
    )
    spans = [max(axis) - min(axis) for axis in zip(*floor.outline)]
    limit = max(4, 0.2 * min(spans))
    status, corner_error, landing_error = "matches_marked_points", None, None
    if frame[-1] * floor.frame[-1] < 0 or ref_error > limit:
        status = "landmarks_need_review"
    elif not item.get("footprint"):
        status = "stair_missing"
    elif len(item["footprint"]) != len(floor.outline):
        status = "different_stair_shape"
    else:
        actual = [
            project(checked_point(point, marks.size), frame, floor.frame)
            for point in item["footprint"]
        ]
        corner_error = max(math.dist(a, b) for a, b in zip(actual, floor.outline))
        edit = pair.get(level + "EditRegion")
        if edit is not None:
            try:
                assert_within(edit, actual, target.size, level)
            except OutsideEditRegion:
                status = "stair_leaves_edit_region"
        if status == "matches_marked_points":
            if corner_error > limit:
                status = "stair_position_needs_review"
            elif not item.get("landing"):
                status = "landing_missing"
            else:
                aligned = project(
                    checked_point(item["landing"], marks.size), frame, floor.frame
                )
                landing_error = math.dist(aligned, floor.landing)
                if landing_error > limit:
                    status = "landing_position_needs_review"
    return {
        "layer": level,
        "status": status,
        "image": str(marks.source),
        "sha256": marks.digest,
        "referenceErrorPx": round(ref_error, 2),
        "reviewTolerancePx": round(limit, 2),
        "cornerErrorPx": corner_error,
        "landingErrorPx": landing_error,
    }


def final_review(measurements, floors, pair, guides, delivery):
    if delivery and delivery.exists():
        raise ValueError("Choose a new paired delivery directory.")
    checks = []
    for level, floor in floors.items():
        item = measurements[level]
        check = final_points(level, item, floor, pair)
        if delivery:
            original, final = floor.marks.source, check["image"]
            if not item.get("protectionReview"):
                raise ValueError(
                    f"Provide the original-pixel edits and locks for the {level} final PNG."
                )
            protection = json.loads(
                run_script(
                    "verify-plan-delivery",
                    original,
                    final,
                    item["protectionReview"],
                    allowed=(0, 1),
                    inspect_seams=item.get("inspectSeams") is True,
                )
            )
            if (
                protection["candidateSha256"] != check["sha256"]
                or protection["originalSha256"] != floor.marks.digest
            ):
                raise ValueError(
                    f"The {level} original or final PNG changed during review."
                )
            check["sourceProtection"] = protection
            sample = guides.get(level, {}).get("approachSample")
            if sample:
                check["approachOnSource"] = measure_approach(original, sample)
                check["approachOnFinal"] = measure_approach(final, sample)
                final_status = check["approachOnFinal"]["status"]
                check["approach"] = (
                    "line_across_final_approach"
                    if final_status == "line_across"
                    else "inspect_approach_on_plan"
                    if final_status == "review_sample"
                    or check["approachOnSource"]["status"] == "line_across"
                    else "clear_sample"
                )
        checks.append(check)
    report = {"layers": checks}
    if delivery:
        blocked = any(
            item.get("approach") == "line_across_final_approach" for item in checks
        )
        passed = not blocked and all(
            item["status"] == "matches_marked_points"
            and item["sourceProtection"]["status"] == "checks_passed"
            for item in checks
        )
        report["status"] = (
            "paired_delivery_checked" if passed else "paired_delivery_needs_review"
        )
        if blocked:
            report["nextAction"] = (
                "Inspect the reported approaches. Use a stage plan if the landing opening cannot be confirmed."
            )
        if passed:
            delivery.parent.mkdir(parents=True, exist_ok=True)
            with TemporaryDirectory(
                prefix=".stair-review-", dir=delivery.parent
            ) as folder:
                pending = Path(folder) / "delivery"
                pending.mkdir()
                for check in checks:
                    name = check["layer"] + ".png"
                    copy_new(check["image"], pending / name)
                    if sha256(pending / name) != check["sha256"]:
                        raise ValueError(
                            f"The {check['layer']} PNG changed after review."
                        )
                    check["verifiedPng"] = str(delivery / name)
                write_json(pending / "receipt.json", report)
                if delivery.exists():
                    raise ValueError("Choose a new paired delivery directory.")
                pending.rename(delivery)
    return report


def compose_level(level, floor, item, guide, pair, folder):
    source = floor.marks.source
    recipe = {
        "originalSha256": floor.marks.digest,
        "edits": [{"points": pair[level + "EditRegion"]}],
        "locks": pair[level]["locks"],
        "crossings": [],
    }
    recipe_path, output = (
        folder / f"{level}-source-review.json",
        folder / f"{level}.png",
    )
    write_json(recipe_path, recipe)
    entry = {"layer": level, "protectionReview": str(recipe_path)}
    if item == "retain":
        copy_new(guide["layoutBase"], output)
        if sha256(output) != guide["layoutBaseSha256"].lower():
            output.unlink()
            raise ValueError(f"The {level} fixed stair base changed while copying.")
        return {**entry, "status": "retained_layout_for_review", "image": str(output)}
    effective_review = recipe_path
    if guide:
        source = guide["layoutBase"]
        effective_review = folder / f"{level}-stair-base-review.json"
        locks = [*recipe["locks"], guide["stairLock"]]
        if guide.get("approachLock"):
            locks.append(guide["approachLock"])
        write_json(
            effective_review,
            {
                **recipe,
                "originalSha256": guide["layoutBaseSha256"].lower(),
                "locks": locks,
            },
        )
    options = {
        "original_path": source,
        "base_path": source,
        "review_path": effective_review,
        "output_path": output,
        "candidate_path": item[0],
        "alternate_candidate_path": item[1] if len(item) == 2 else None,
    }
    try:
        crop = guide.get("generationCrop")
        if crop:
            try:
                result = run_script(
                    "compose-and-check-plan", reference_crop_path=crop, **options
                )
            except ValueError:
                result = run_script("compose-and-check-plan", **options)
        else:
            result = run_script("compose-and-check-plan", **options)
        report = json.loads(result)
        return {
            **entry,
            "status": "composed_for_review",
            "image": report["filePath"],
            "candidate": report.get("candidatePath", item[0]),
            "maxLandmarkErrorPx": report["composition"]["maxLandmarkErrorPx"],
        }
    except ValueError as error:
        return {**entry, "status": "alignment_needs_review", "error": str(error)}


def compose_pair(batch, directory, delivery, floors, pair, guides):
    directory = directory.resolve()
    if delivery and (
        directory.is_relative_to(delivery)
        or delivery.is_relative_to(directory)
        or delivery.exists()
    ):
        raise ValueError(
            "Keep the composition and paired delivery in separate new directories."
        )
    for level in LEVELS:
        item = batch.get(level)
        if item == "retain":
            if level not in guides:
                raise ValueError(
                    f"Retaining the {level} layout needs the checked fixed stair receipt."
                )
        elif pair[level].get("retainLayout"):
            raise ValueError(
                f"The {level} was marked as retained. Use retain for that floor."
            )
        elif (
            not isinstance(item, list)
            or not 1 <= len(item) <= 2
            or any(
                not isinstance(path, str) or not Path(path).is_file() for path in item
            )
        ):
            raise ValueError(
                f"Provide one or two {level} candidate paths, or retain its layout."
            )
    directory.mkdir(parents=True)
    composed = [
        compose_level(
            level, floor, batch[level], guides.get(level, {}), pair, directory
        )
        for level, floor in floors.items()
    ]
    result = {
        "layers": composed,
        "nextAction": "Inspect the floors and coordinate sheet. Check the actual stair corners and landings before paired delivery.",
    }
    if all("image" in item for item in composed):
        regions = {}
        for level, floor in floors.items():
            xs, ys = zip(*floor.outline, floor.landing)
            margin = max(48, 0.20 * max(max(xs) - min(xs), max(ys) - min(ys)))
            rect = (
                max(0, math.floor(min(xs) - margin)),
                max(0, math.floor(min(ys) - margin)),
                min(floor.marks.size[0], math.ceil(max(xs) + margin)),
                min(floor.marks.size[1], math.ceil(max(ys) + margin)),
            )
            region_path = directory / f"{level}-coordinates.json"
            write_json(region_path, {"regions": [rect]})
            regions[level] = region_path
        result.update(
            coordinateSheet=coordinate_sheet(
                {row["layer"]: row["image"] for row in composed},
                regions,
                directory / "stair-coordinates.png",
            )["coordinateSheet"]
        )
        if delivery:
            measurements = {}
            for row in composed:
                level = row["layer"]
                measurements[level] = {
                    "image": row["image"],
                    "anchors": pair[level]["anchors"],
                    "footprint": guides[level]["stairLock"]["points"],
                    "landing": pair[level + "Landing"],
                    "protectionReview": row["protectionReview"],
                    "inspectSeams": batch[level] != "retain",
                }
            write_json(directory / "fixed-stair-final-review.json", measurements)
            result["delivery"] = final_review(
                measurements, floors, pair, guides, delivery
            )
            if result["delivery"]["status"] == "paired_delivery_checked":
                for row, verified in zip(composed, result["delivery"]["layers"]):
                    row["verifiedPng"] = verified["verifiedPng"]
                result["nextAction"] = (
                    "Inspect both verified PNGs for clipped walls, furniture, required rooms and actual routes before delivery."
                )
            else:
                result["nextAction"] = (
                    "Review the reported problem. Use the composed images as stage plans if the issue remains unresolved."
                )
    return result


def stair_pair(args):
    drawing = args.draw_straight_stair or args.draw_turn_stair
    if args.coordinate_sheet_path:
        if (
            args.pair_path
            or args.output_directory
            or args.candidate_batch_path
            or args.candidate_check_path
            or args.delivery_directory
            or args.fixed_stair_receipt_path
            or args.check_only
            or args.check_anchors
            or drawing
            or not (args.lower_image_path and args.upper_image_path)
        ):
            raise ValueError(
                "For a coordinate sheet provide both source images and a new PNG path."
            )
        return coordinate_sheet(
            {"lower": args.lower_image_path, "upper": args.upper_image_path},
            {"lower": args.lower_regions_path, "upper": args.upper_regions_path},
            args.coordinate_sheet_path,
        )
    if not args.pair_path or any(
        (
            args.lower_image_path,
            args.upper_image_path,
            args.lower_regions_path,
            args.upper_regions_path,
        )
    ):
        raise ValueError(
            "Provide a pair file for stair geometry, or a coordinate sheet path for source images."
        )
    delivery = args.delivery_directory.resolve() if args.delivery_directory else None
    if delivery and not (
        args.candidate_check_path
        or args.candidate_batch_path
        and args.fixed_stair_receipt_path
    ):
        raise ValueError(
            "Paired delivery needs measured final images or a candidate batch with its fixed stair receipt."
        )
    if args.fixed_stair_receipt_path and not (args.candidate_batch_path or delivery):
        raise ValueError(
            "Use the fixed stair receipt with a candidate batch or paired delivery."
        )
    if args.candidate_batch_path and not args.output_directory:
        raise ValueError("Provide an output directory to compose both floors.")
    if (
        sum(
            map(
                bool,
                (
                    args.output_directory,
                    args.candidate_check_path,
                    args.check_anchors,
                    args.check_only,
                ),
            )
        )
        != 1
    ):
        raise ValueError(
            "Choose guide output, anchor check, geometry check or candidate review."
        )
    if drawing and (
        args.check_anchors or args.candidate_check_path or args.candidate_batch_path
    ):
        raise ValueError("Draw stairs during guide preparation or geometry check.")
    pair_hash = sha256(args.pair_path)
    pair = read_json(args.pair_path)
    for level in LEVELS:
        value = pair[level].get("retainLayout")
        if value is not None and type(value) is not bool:
            raise ValueError(f"Use true or false for {level}.retainLayout.")
    stair_type = pair.get("stairType")
    shape = (
        "straight"
        if args.draw_straight_stair
        else "turn"
        if args.draw_turn_stair
        else None
    )
    if stair_type is not None:
        if stair_type not in ("straight", "turn") or shape and shape != stair_type:
            raise ValueError("Use the straight or turn stairType recorded in the pair.")
        if args.check_only or args.output_directory and not args.candidate_batch_path:
            shape = stair_type
        if shape and any(
            type(pair[level].get("retainLayout")) is not bool for level in LEVELS
        ):
            raise ValueError(
                "Set retainLayout on both levels before preparing fixed stair guides."
            )
    if args.check_anchors and any(len(pair[level]["anchors"]) > 4 for level in LEVELS):
        return select_anchors(pair)
    references = pair_references(pair)
    lower, _, upper, _, projected, drift = references
    if args.check_anchors:
        return {
            "status": "anchors_checked",
            "lowerWitness": rounded(lower.points[3]),
            "upperWitness": rounded(upper.points[3]),
            "projectedUpperWitness": rounded(projected),
            "witnessDriftPx": round(drift, 2),
        }
    floors = stair_floors(
        pair,
        references,
        shape,
        bool(shape or args.candidate_batch_path),
        bool(
            shape
            or args.check_only
            or args.output_directory
            and not args.candidate_batch_path
        ),
    )
    if args.check_only:
        return {
            "status": "geometry_checked",
            **{
                level: [rounded(point) for point in floor.outline]
                for level, floor in floors.items()
            },
            "witnessDriftPx": round(drift, 2),
            "lockedComponentsChecked": lock_flags(pair),
            "landingGeometryChecked": bool(shape),
        }
    guides = fixed_guides(args.fixed_stair_receipt_path, pair_hash, floors)
    if args.candidate_batch_path:
        return compose_pair(
            read_json(args.candidate_batch_path),
            args.output_directory,
            delivery,
            floors,
            pair,
            guides,
        )
    if args.candidate_check_path:
        return final_review(
            read_json(args.candidate_check_path), floors, pair, guides, delivery
        )
    return prepare_guides(args.output_directory, pair, floors, drift, shape, pair_hash)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in (
        "pair-path",
        "output-directory",
        "candidate-batch-path",
        "fixed-stair-receipt-path",
        "candidate-check-path",
        "delivery-directory",
        "coordinate-sheet-path",
        "lower-image-path",
        "upper-image-path",
        "lower-regions-path",
        "upper-regions-path",
    ):
        parser.add_argument("--" + name, type=Path)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--draw-straight-stair", action="store_true")
    mode.add_argument("--draw-turn-stair", action="store_true")
    parser.add_argument("--check-only", action="store_true")
    parser.add_argument("--check-anchors", action="store_true")
    args = parser.parse_args()
    try:
        report = stair_pair(args)
        print(json.dumps(report, allow_nan=False))
        if (
            args.candidate_check_path
            and report.get("status") == "paired_delivery_needs_review"
        ):
            raise SystemExit(1)
    except (OSError, ValueError, TypeError, KeyError) as error:
        parser.exit(2, f"{error}\n")


if __name__ == "__main__":
    main()
