"""Prepare a fixed-plan guide or compose against its recorded first scope."""

import argparse
import json
from pathlib import Path
from tempfile import mkdtemp

from plan_io import read_json, run_script, sha256, write_json


def fixed_plan(args):
    original = args.original_path.resolve(strict=True)
    root = Path.cwd() / ".design-agent"
    root.mkdir(exist_ok=True)
    scope_path = root / "fixed-plan-scope.json"
    if args.review_path:
        if args.candidate_path or args.alternate_candidate_path:
            raise ValueError("Choose guide preparation or composition.")
        if scope_path.is_file():
            scope = read_json(scope_path)
            if scope["originalSha256"].lower() != sha256(original):
                raise ValueError(
                    "The fixed-plan scope was prepared for a different original."
                )
            return {key: scope[key] for key in ("guidePath", "planReceiptPath")}
        geometry = read_json(args.review_path)
        has_routes = bool(
            geometry.get("existingRoutes") or geometry.get("plannedCircuits")
        )
        if has_routes and args.initial_plan_receipt_path:
            raise ValueError(
                "Use the existing route receipt for the final composition."
            )
        folder = Path(mkdtemp(dir=root))
        receipt = folder / "首轮回执.json"
        result = json.loads(
            run_script(
                "annotate-plan",
                input_path=original,
                geometry_path=args.review_path,
                output_path=folder / "引导.png",
                route_receipt_path=receipt if has_routes else None,
                plan_receipt_path=receipt if not has_routes else None,
                check_plan_points=not has_routes,
                initial_plan_receipt_path=args.initial_plan_receipt_path,
                protect_filled_regions=args.protect_filled_regions,
                colored_plan=args.colored_plan and not has_routes,
                show_openings_cleared=args.clear_proposed_openings,
                keep_uncleared_openings=args.clear_proposed_openings and not has_routes,
            )
        )
        write_json(
            scope_path,
            {
                "guidePath": result["guidePath"],
                "planReceiptPath": str(receipt),
                "originalSha256": sha256(original),
                "planReceiptSha256": sha256(receipt),
            },
        )
        return result
    if (
        not args.candidate_path
        or args.initial_plan_receipt_path
        or args.protect_filled_regions
        or args.colored_plan
        or args.clear_proposed_openings
    ):
        raise ValueError(
            "Composition requires a candidate and the recorded plan receipt."
        )
    receipt = args.plan_receipt_path.resolve(strict=True)
    scope = read_json(scope_path)
    if Path(scope["planReceiptPath"]).resolve() != receipt or scope[
        "planReceiptSha256"
    ].lower() != sha256(receipt):
        raise ValueError("Reuse the fixed-plan scope recorded during preflight.")
    checked = read_json(receipt).get("check") == "plan_points_covered"
    folder = Path(mkdtemp(dir=root))
    result = json.loads(
        run_script(
            "compose-and-check-plan",
            base_path=original,
            original_path=original,
            candidate_path=args.candidate_path,
            alternate_candidate_path=args.alternate_candidate_path,
            plan_receipt_path=receipt if checked else None,
            route_receipt_path=receipt if not checked else None,
            output_path=folder / "贴回.png",
            review_preview_path=folder / "待核.png",
            delivery_stage_path=folder / "复核",
            delivery_png_path=folder / "家装平面方案.png",
            return_review=True,
        )
    )
    if result.get("verifiedPng"):
        write_json(
            result["verifiedPng"] + ".delivery.json",
            {
                "planReceiptSha256": scope["planReceiptSha256"],
                "verifiedPngSha256": result["verifiedPngSha256"],
            },
        )
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--original-path", type=Path, required=True)
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument("--plan-receipt-path", type=Path)
    modes.add_argument("--review-path", type=Path)
    for name in ("initial-plan-receipt", "candidate", "alternate-candidate"):
        parser.add_argument(f"--{name}-path", type=Path)
    for flag in ("protect-filled-regions", "colored-plan", "clear-proposed-openings"):
        parser.add_argument(f"--{flag}", action="store_true")
    try:
        print(json.dumps(fixed_plan(parser.parse_args()), allow_nan=False))
    except (OSError, ValueError, TypeError, KeyError) as error:
        parser.exit(2, f"{error}\n")


if __name__ == "__main__":
    main()
