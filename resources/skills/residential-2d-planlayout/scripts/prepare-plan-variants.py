"""Create checked generation guides for independent layout variants."""

import argparse
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory

from plan_io import copy_new, read_json, run_script, sha256, write_json
from plan_variants import read_variants


def prepare_one(args, variant, folder, scope, initial):
    name = variant["id"]
    folder.mkdir()
    variant_path = None
    if args.variants_path:
        variant_path = folder / "variant.json"
        write_json(variant_path, variant)
    receipt = folder / "receipt.json"
    archived_receipt = scope / name / receipt.name if scope else None
    prior = initial / name / receipt.name if initial else None
    if prior and not prior.is_file():
        raise ValueError(f"No initial receipt for {name}. Run new variants separately.")
    if archived_receipt and archived_receipt.parent.exists():
        prior = archived_receipt
    result = json.loads(
        run_script(
            "annotate-plan",
            input_path=args.original_path,
            geometry_path=args.review_path,
            variant_path=variant_path,
            output_path=folder / "guide.png",
            plan_receipt_path=receipt,
            check_plan_points=True,
            initial_plan_receipt_path=prior,
            protect_filled_regions=args.protect_filled_regions,
            colored_plan=args.colored_plan,
            show_openings_cleared=args.show_openings_cleared,
            keep_uncleared_openings=args.show_openings_cleared and args.colored_plan,
        )
    )
    if archived_receipt:
        if not prior:
            with TemporaryDirectory(dir=scope) as temp:
                pending = Path(temp) / name
                pending.mkdir()
                for path in (receipt, receipt.with_suffix(".source-review.json")):
                    copy_new(path, pending / path.name)
                pending.rename(archived_receipt.parent)
        record = read_json(receipt)
        try:
            relative = Path(os.path.relpath(archived_receipt, folder)).as_posix()
        except ValueError:  # Windows drives can differ.
            relative = str(archived_receipt)
        record["initialScope"] = {"path": relative, "sha256": sha256(archived_receipt)}
        replacement = folder / ".receipt.json"
        write_json(replacement, record)
        replacement.replace(receipt)
    return {
        "id": name,
        **{
            key: result[key]
            for key in (
                "guidePath",
                "planReceiptPath",
                "unchangedSeparators",
                "unshownFurnitureLabels",
                "unconfirmedAreaIds",
            )
            if key in result
        },
    }


def prepare_variants(args):
    if args.variant_id and not args.variants_path:
        raise ValueError("--variant-id requires --variants-path.")
    if args.keep_uncleared_openings and not (
        args.show_openings_cleared and args.colored_plan
    ):
        raise ValueError(
            "--keep-uncleared-openings requires a colored guide with proposed openings cleared."
        )
    output = args.output_directory.resolve()
    initial = args.initial_guide_directory
    scope = args.scope_directory.resolve() if args.scope_directory else None
    if initial and not initial.is_dir():
        raise ValueError("Provide the directory of the first checked guides.")
    if scope and (initial or scope.is_relative_to(output)):
        raise ValueError(
            "Keep the persistent scope outside the output directory and use only one initial scope."
        )
    variants = (
        read_variants(args.variants_path) if args.variants_path else [{"id": "shared"}]
    )
    selected = {name.casefold() for name in args.variant_id or []}
    if selected - {item["id"].casefold() for item in variants}:
        raise ValueError("A selected variant is missing from the manifest.")
    output.mkdir(parents=True)
    if scope:
        scope.mkdir(parents=True, exist_ok=True)
    results = []
    for item in variants:
        if not selected or item["id"].casefold() in selected:
            try:
                results.append(
                    prepare_one(args, item, output / item["id"], scope, initial)
                )
            except (OSError, ValueError, TypeError, KeyError) as error:
                results.append(
                    {
                        "id": item["id"],
                        "status": "preflight_failed",
                        "error": str(error),
                    }
                )
    return {"variants": results}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for flag in ("original-path", "review-path", "output-directory"):
        parser.add_argument(f"--{flag}", type=Path, required=True)
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--scope-directory", type=Path)
    group.add_argument("--initial-guide-directory", type=Path)
    parser.add_argument("--variants-path", type=Path)
    parser.add_argument("--variant-id", nargs="+")
    for flag in (
        "protect-filled-regions",
        "colored-plan",
        "show-openings-cleared",
        "keep-uncleared-openings",
    ):
        parser.add_argument(f"--{flag}", action="store_true")
    try:
        print(json.dumps(prepare_variants(parser.parse_args()), allow_nan=False))
    except (OSError, ValueError, TypeError, KeyError) as error:
        parser.exit(2, f"{error}\n")


if __name__ == "__main__":
    main()
