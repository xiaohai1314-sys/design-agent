"""Align candidates, protect original pixels, check the plan and stage verified delivery."""

import argparse
import json
from pathlib import Path
from tempfile import TemporaryDirectory

from plan_io import (
    copy_new,
    identity_geometry,
    new_png,
    open_image,
    read_json,
    rect_polygon,
    run_script,
    save_png,
    sha256,
    write_json,
)

REVIEWABLE_ISSUES = {
    "crossing_needs_review",
    "route_needs_review",
    "circuit_needs_review",
}


class RejectedComposition(ValueError):
    def __init__(self, message, report):
        super().__init__(message)
        self.report = report


def source_review(args):
    if args.plan_receipt_path and args.route_receipt_path:
        raise ValueError("Use one guide receipt.")
    receipt_path = args.plan_receipt_path or args.route_receipt_path
    review_path, protect = args.review_path, args.protect_filled_regions
    if receipt_path:
        receipt_path = receipt_path.resolve()
        receipt = read_json(receipt_path)
        if args.plan_receipt_path and receipt.get("check") != "plan_points_covered":
            raise ValueError("Use the receipt from the checked layout guide.")
        if not review_path and receipt.get("reviewSnapshot"):
            review_path = receipt_path.with_suffix(".source-review.json")
            if receipt["reviewSnapshot"] != review_path.name:
                raise ValueError(
                    "The review snapshot must be beside its guide receipt."
                )
        if not review_path:
            raise ValueError("This guide receipt needs its original review path.")
        setting = receipt.get("protectFilledRegions")
        if protect is None:
            protect = setting
        if (
            type(setting) is not bool
            or setting != protect
            or receipt["originalSha256"].lower() != sha256(args.original_path)
            or receipt["reviewSha256"].lower() != sha256(review_path)
        ):
            raise ValueError(
                "Use the original, source review and protection setting recorded by the guide receipt."
            )
    if not review_path:
        raise ValueError(
            "Provide --review-path or a guide receipt with a source review snapshot."
        )
    review = read_json(review_path)
    if args.route_receipt_path and not (
        review.get("existingRoutes") or review.get("plannedCircuits")
    ):
        raise ValueError(
            "The source review has no existing routes or planned circuits."
        )
    if args.plan_receipt_path and not review.get("planPoints"):
        raise ValueError("The source review has no checked plan points.")
    return review_path, review, receipt_path, bool(protect)


def output_paths(args, receipt_path):
    if args.initial_plan_receipt_path and not (
        args.plan_receipt_path and args.delivery_stage_path
    ):
        raise ValueError(
            "Comparing an initial layout receipt requires a current plan receipt and a delivery stage."
        )
    if args.delivery_stage_path and (not receipt_path or args.compose_part):
        raise ValueError(
            "A delivery stage needs a complete composition and a guide receipt."
        )
    if args.return_review and not args.review_preview_path:
        raise ValueError(
            "--return-review needs a preview path for the aligned review image."
        )
    if args.aligned_candidate_path and args.reapply_original_protection:
        raise ValueError(
            "An aligned preview requires a candidate that still needs to be aligned."
        )
    if args.alternate_output_path and not args.alternate_candidate_path:
        raise ValueError("Provide a second candidate with the alternate output.")
    if args.delivery_png_path and not args.delivery_stage_path:
        raise ValueError("A named delivery PNG needs a delivery stage.")
    paths = {}
    for key in (
        "output",
        "review_preview",
        "review_details",
        "aligned_candidate",
        "alternate_output",
        "delivery_png",
    ):
        value = getattr(args, key + "_path")
        paths[key] = new_png(value) if value else None
    preview = paths["review_preview"]
    paths["patch_preview"] = (
        new_png(preview.with_suffix(".local-patch.png"))
        if preview and receipt_path
        else None
    )
    paths["patch_recipe"] = (
        preview.with_suffix(".local-patch.json")
        if preview and receipt_path and args.return_review
        else None
    )
    paths["alternate_review"] = (
        new_png(preview.with_suffix(".alternate.png"))
        if preview and paths["alternate_output"]
        else None
    )
    paths["stage"] = (
        args.delivery_stage_path.resolve() if args.delivery_stage_path else None
    )
    assigned = [path for path in paths.values() if path is not None]
    if len(set(assigned)) != len(assigned) or any(
        path.exists() or not path.parent.is_dir() for path in assigned
    ):
        raise ValueError("Choose separate new outputs inside existing directories.")
    return paths


def composition_options(args, temp, review_path, review, receipt_path, protect):
    same_base = args.base_path.resolve(strict=True) == args.original_path.resolve(
        strict=True
    )
    if args.compose_part and not (
        args.regions_path and receipt_path and args.inspect_seams
    ):
        raise ValueError(
            "A partial composition needs patch regions, the original receipt and seam inspection."
        )
    if args.regions_path and args.geometry_path and not args.compose_part:
        raise ValueError(
            "Use patch regions with manual geometry only for a checked partial composition."
        )
    if (
        args.inspect_seams
        and not args.compose_part
        and (not same_base or args.regions_path)
    ):
        raise ValueError(
            "Seam hints use the original as the base and the reviewed composition region."
        )
    if args.reapply_original_protection and (
        not same_base
        or args.regions_path
        or args.reference_crop_path
        or args.alternate_candidate_path
        or args.geometry_path
    ):
        raise ValueError(
            "Reapply protection to one already-aligned candidate, using the original as base."
        )
    if args.repair_path and not args.reapply_original_protection:
        raise ValueError(
            "Apply a local repair to an aligned candidate with --reapply-original-protection."
        )
    if (
        receipt_path
        and args.regions_path
        and (args.compose_part or args.reference_crop_path)
    ):
        run_script(
            "compile-plan-requirements",
            args.original_path,
            args.regions_path,
            patch_base=args.base_path,
            patch_crop=args.reference_crop_path,
            initial_guide_receipt=receipt_path,
        )
    effective_review = review_path
    if (
        protect
        or {"existingRoutes", "darkDoorLocks", "unconfirmedAreas"} & review.keys()
    ):
        effective_review = temp / "locks.json"
        expanded = run_script(
            "compile-plan-requirements",
            args.original_path,
            review_path,
            expand_review=True,
            add_filled_locks=protect,
        )
        effective_review.write_text(expanded + "\n", encoding="utf-8")

    options = {
        "base_path": args.base_path,
        "original_path": args.original_path,
        "original_locks_path": effective_review,
    }
    repaired = None
    if args.reapply_original_protection:
        size = open_image(args.original_path).size
        if open_image(args.candidate_path).size != size:
            raise ValueError(
                "The already-aligned candidate must have the original canvas size."
            )
        options["geometry_path"] = temp / "identity.json"
        write_json(options["geometry_path"], identity_geometry(size, review["edits"]))
        if args.repair_path:
            repaired = temp / "repaired.png"
            run_script(
                "repair-plan-openings",
                base_path=args.candidate_path,
                repair_path=args.repair_path,
                original_path=args.original_path,
                original_locks_path=effective_review,
                output_path=repaired,
                before_protection=True,
            )
    elif args.geometry_path:
        geometry = read_json(args.geometry_path)
        if args.compose_part or args.inspect_seams or not geometry.get("edits"):
            geometry["edits"] = (
                read_json(args.regions_path).get("edits")
                if args.compose_part
                else review["edits"]
            )
            if not geometry["edits"]:
                raise ValueError("Provide patch edit polygons in original pixels.")
            options["geometry_path"] = temp / "geometry.json"
            write_json(options["geometry_path"], geometry)
        else:
            options["geometry_path"] = args.geometry_path
    else:
        options["regions_path"] = args.regions_path or effective_review
        if args.reference_crop_path:
            options["reference_crop_path"] = args.reference_crop_path
        elif (
            args.plan_receipt_path
            and not args.regions_path
            and review.get("crop") is not None
        ):
            options["reference_crop_path"] = review_path
    return options, effective_review, repaired


def blocked_crossings(review):
    return [
        crossing
        for crossing in review.get("crossings", [])
        if crossing.get("status") != crossing.get("expectedStatus", "clear_sample")
    ]


def rejection(review):
    if review.get("uncoveredPlanPoints"):
        return "Check the original-pixel edit and protection regions: " + json.dumps(
            review["uncoveredPlanPoints"]
        )
    reason = ", ".join(review.get("issues", []))
    crossings = blocked_crossings(review)
    if crossings:
        reason += " " + json.dumps(crossings)
    routes = [
        route
        for route in review.get("routes", [])
        if route.get("status") != "connected"
    ]
    routes += [
        circuit
        for circuit in review.get("plannedCircuits", [])
        if circuit.get("segmentsNeedingReview")
    ]
    return reason + (" " + json.dumps(routes) if routes else "")


def review_rank(item):
    review = item["review"]
    crossings = blocked_crossings(review)
    blocked = len(crossings) + sum(
        route.get("status") != "connected" for route in review.get("routes", [])
    )
    blocked += sum(
        len(circuit.get("segmentsNeedingReview", []))
        for circuit in review.get("plannedCircuits", [])
    )
    obstruction = sum(
        1 - crossing["longestClearPx"] / crossing["sampleWidthPx"]
        for crossing in crossings
        if crossing.get("sampleWidthPx", 0) > 0
    )
    return blocked, obstruction


def details_sheet(temp, path, image, report, source):
    if not path:
        return None
    furniture = [
        {"rect": item["furnitureRect"]}
        for item in source.get("plannedCircuits", [])
        if item.get("furnitureRect")
    ]
    furniture += [
        item for item in source.get("planPoints", []) if item.get("showOnGuide") is True
    ]
    inputs = temp / "details.json"
    write_json(inputs, {"review": report, "furniture": furniture})
    run_script(
        "review-plan-details", input_path=image, review_path=inputs, output_path=path
    )
    return str(path) if path.is_file() else None


def local_patch(report, paths, original, receipt):
    review = report["review"]
    failed = [item for item in blocked_crossings(review) if item.get("sampleRect")]
    if not receipt or len(failed) != 1 or review["issues"] != ["crossing_needs_review"]:
        return
    crossing = failed[0]
    l, t, r, b = crossing["sampleRect"]
    w, h = review["originalSize"]
    x, y, right, bottom = (
        max(0, l - 110),
        max(0, t - 80),
        min(w, r + 110),
        min(h, b + 80),
    )
    crop = [x, y, right - x, bottom - y]
    save_png(
        open_image(paths["review_preview"]).crop((x, y, right, bottom)),
        paths["patch_preview"],
    )
    patch = {
        "opening": crossing["id"],
        "referenceImage": str(paths["patch_preview"]),
        "crop": crop,
        "usePreview": str(paths["review_preview"]),
        "originalPath": str(original),
        "initialReceipt": str(receipt),
    }
    report["localPatch"] = patch
    report["nextAction"] = (
        "Inspect localPatch.referenceImage and choose a paste area in original pixels for a local redraw."
    )
    if review.get("openingPatch"):
        rect = review["openingPatch"]
        patch["patchJson"] = {"crop": crop, "edits": [rect_polygon(rect)]}
        l, t, r, b = rect
        patch["pasteRectInReference"] = [l - x, t - y, r - x, b - y]
        if paths["patch_recipe"]:
            write_json(paths["patch_recipe"], patch["patchJson"])
            patch["patchPath"] = str(paths["patch_recipe"])
        report["nextAction"] = (
            "Confirm the paste rectangle covers the defect, then generate from the crop alone and reuse its patch JSON."
        )


def rejected_preview(
    items, args, paths, source, receipt_path, review_path, protect, temp, failure
):
    ranked = sorted(items, key=review_rank)
    item = ranked[0]
    preview = paths["review_preview"]
    copy_new(item["staged"], preview)
    review = item["review"]
    repair_args = {
        "--base-path": str(args.original_path),
        "--original-path": str(args.original_path),
        "--candidate-path": str(preview),
        "--review-path": str(review_path),
        "--reapply-original-protection": True,
    }
    if protect:
        repair_args["--protect-filled-regions"] = True
    if receipt_path:
        flag = (
            "--route-receipt-path" if args.route_receipt_path else "--plan-receipt-path"
        )
        repair_args[flag] = str(receipt_path)
    report = {
        "status": "aligned_preview_needs_review",
        "path": str(preview),
        "candidatePath": str(item["candidate"]),
        "review": review,
        "repairArgs": repair_args,
        "detailsPath": details_sheet(
            temp, paths["review_details"], preview, review, source
        ),
        "nextAction": "Review the aligned preview and fix local obstructions or clipped objects before realigning.",
    }
    if paths["aligned_candidate"]:
        copy_new(item["aligned"], paths["aligned_candidate"])
        report["alignedCandidatePath"] = str(paths["aligned_candidate"])
    if review.get("turnCleanup"):
        report["turnCleanup"] = review.pop("turnCleanup")
    blocked_ids = {item["id"] for item in blocked_crossings(review)}
    removable = [
        {"id": item["id"], "clearRect": item["clearRect"]}
        for item in source.get("crossings", [])
        if item.get("state") == "proposed"
        and item.get("clearRect")
        and item["id"] in blocked_ids
    ]
    if removable:
        report["removableSeparatorRegions"] = removable
    local_patch(report, paths, args.original_path, receipt_path)
    if len(ranked) > 1 and paths["alternate_review"]:
        alternate = ranked[1]
        preview = paths["alternate_review"]
        copy_new(alternate["staged"], preview)
        report["alternate"] = {
            "path": str(preview),
            "candidatePath": str(alternate["candidate"]),
            "review": alternate["review"],
            "repairArgs": {**repair_args, "--candidate-path": str(preview)},
        }
        if "localPatch" not in report:
            report["nextAction"] = (
                "Compare both aligned previews and fix the specific obstruction on the more complete plan."
            )
    if args.return_review:
        return report
    raise RejectedComposition(failure, report)


def passing_report(item, first, args, paths, source, receipt, temp):
    output = paths["output" if first else "alternate_output"]
    report = {
        "status": "partial_composition"
        if args.compose_part
        else "ready_for_visual_review",
        "filePath": str(output),
        "composition": {**item["composition"], "path": str(output)},
        "review": item["review"],
        "nextAction": (
            "Inspect the changed area and seams, then use the PNG as the base for the remaining patches."
            if args.compose_part
            else "Inspect the PNG for required furniture, door connections and seams before delivery."
        ),
    }
    if args.alternate_candidate_path:
        report["candidatePath"] = str(item["candidate"])
    if first:
        details = details_sheet(
            temp, paths["review_details"], item["staged"], item["review"], source
        )
        if details:
            report["detailsPath"] = details
        if paths["stage"]:
            delivery = json.loads(
                run_script(
                    "verify-plan-delivery",
                    args.original_path,
                    item["staged"],
                    guide_receipt=receipt,
                    stage=paths["stage"],
                    initial_guide_receipt=args.initial_plan_receipt_path,
                    crop_to_guide=source.get("crop") is not None,
                )
            )
            verified = delivery["verifiedPng"]
            if paths["delivery_png"]:
                copy_new(verified, paths["delivery_png"])
                verified = str(paths["delivery_png"])
            report.update(
                verifiedPng=verified,
                verifiedPngSha256=delivery.get("verifiedPngSha256")
                or delivery["candidateSha256"],
                nextAction="Inspect verifiedPng once for required layout, access and objects. Deliver that exact PNG if it meets the brief.",
            )
        if paths["aligned_candidate"]:
            copy_new(item["aligned"], paths["aligned_candidate"])
            report["alignedCandidatePath"] = str(paths["aligned_candidate"])
    copy_new(item["staged"], output)
    return report


def compose_checked(args):
    if args.geometry_path and args.alternate_candidate_path:
        raise ValueError("Use a separate landmark geometry for each candidate.")
    review_path, source, receipt, protect = source_review(args)
    paths = output_paths(args, receipt)
    candidates = [args.candidate_path.resolve(strict=True)]
    if args.alternate_candidate_path:
        alternate = args.alternate_candidate_path.resolve(strict=True)
        if alternate != candidates[0]:
            candidates.append(alternate)
    passed, rejected, previews = [], [], []
    with TemporaryDirectory(
        prefix=".plan-check-", dir=paths["output"].parent
    ) as folder:
        temp = Path(folder)
        options, effective_review, repaired = composition_options(
            args, temp, review_path, source, receipt, protect
        )
        for index, candidate in enumerate(candidates):
            staged = temp / f"composition-{index}.png"
            aligned = (
                temp / f"aligned-{index}.png"
                if args.inspect_seams or paths["aligned_candidate"]
                else None
            )
            try:
                composition = json.loads(
                    run_script(
                        "compose-plan-edit",
                        candidate_path=repaired or candidate,
                        output_path=staged,
                        aligned_preview_path=aligned,
                        **options,
                    )
                )
            except ValueError as error:
                rejected.append({"path": str(candidate), "reason": str(error)})
                continue
            review = json.loads(
                run_script(
                    "verify-plan-delivery",
                    args.original_path,
                    staged,
                    effective_review,
                    allowed=(0, 1),
                    inspect_seams=args.inspect_seams,
                    aligned_candidate=aligned if args.inspect_seams else None,
                    include_crossing_samples=bool(paths["review_details"]),
                    suggest_opening_patch=bool(receipt and paths["review_preview"]),
                )
            )
            item = {
                "candidate": candidate,
                "staged": staged,
                "aligned": aligned,
                "review": review,
                "composition": composition,
            }
            issues = set(review.get("issues", []))
            if (
                review["status"] == "checks_passed"
                or args.compose_part
                and issues <= REVIEWABLE_ISSUES
            ):
                passed.append(
                    passing_report(item, not passed, args, paths, source, receipt, temp)
                )
                if not paths["alternate_output"]:
                    break
            else:
                rejected.append({"path": str(candidate), "reason": rejection(review)})
                if paths["review_preview"] and issues and issues <= REVIEWABLE_ISSUES:
                    previews.append(item)
        if passed:
            report = passed[0]
            if len(passed) > 1:
                report["alternate"] = passed[1]
                report["nextAction"] = (
                    "Compare the returned PNGs for required layout, complete objects and door connections."
                )
            if args.alternate_candidate_path:
                report["rejectedCandidates"] = rejected
            return report
        failure = "No composition passed review. " + " | ".join(
            f"{row['path']}: {row['reason']}" for row in rejected
        )
        if previews:
            return rejected_preview(
                previews,
                args,
                paths,
                source,
                receipt,
                review_path,
                protect,
                temp,
                failure,
            )
        raise ValueError(failure)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("base", "original", "candidate", "output"):
        parser.add_argument(f"--{name}-path", type=Path, required=True)
    for name in (
        "alternate-candidate",
        "alternate-output",
        "review",
        "route-receipt",
        "plan-receipt",
        "initial-plan-receipt",
        "repair",
        "regions",
        "reference-crop",
        "geometry",
        "review-preview",
        "review-details",
        "aligned-candidate",
        "delivery-stage",
        "delivery-png",
    ):
        parser.add_argument(f"--{name}-path", type=Path)
    for flag in (
        "reapply-original-protection",
        "inspect-seams",
        "compose-part",
        "return-review",
    ):
        parser.add_argument(f"--{flag}", action="store_true")
    parser.add_argument(
        "--protect-filled-regions", action=argparse.BooleanOptionalAction, default=None
    )
    try:
        print(json.dumps(compose_checked(parser.parse_args()), allow_nan=False))
    except RejectedComposition as error:
        print(
            "Rejected composition preview for local review only. "
            + json.dumps(error.report)
        )
        parser.exit(1, f"{error}\n")
    except (OSError, ValueError, TypeError, KeyError) as error:
        parser.exit(2, f"{error}\n")


if __name__ == "__main__":
    main()
