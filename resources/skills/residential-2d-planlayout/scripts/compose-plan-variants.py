"""Verify independent layout candidates and make a comparison sheet."""

import argparse
import json
import math
from pathlib import Path

from PIL import Image, ImageDraw
from plan_io import font, open_image, run_script, save_png, write_json
from plan_variants import read_variants


def preview(rows, path):
    images = [(row, row.get("verifiedPng") or row.get("reviewPng")) for row in rows]
    images = [(row, image) for row, image in images if image]
    if not images:
        return None
    columns = min(2, len(images))
    width, height = 820, 610
    sheet = Image.new(
        "RGB",
        (columns * width, math.ceil(len(images) / columns) * height),
        "whitesmoke",
    )
    draw = ImageDraw.Draw(sheet)
    face = font(20)
    for index, (row, image) in enumerate(images):
        x, y = index % columns * width, index // columns * height
        label = row["id"] if row.get("verifiedPng") else row["id"] + " (review only)"
        draw.text((x + 20, y + 12), label, font=face, fill="black")
        tile = open_image(image)
        tile.thumbnail((width - 40, height - 56), Image.Resampling.BICUBIC)
        sheet.paste(tile, (x + (width - tile.width) // 2, y + 42), tile)
    save_png(sheet, path)
    return str(path)


def compose_one(args, variant, folder):
    name = variant["id"]
    folder.mkdir()
    report_path = folder / "review.json"
    review_path = folder / "review.png"
    receipt = variant.get("receipt") or args.plan_receipt_path
    if not receipt:
        raise ValueError("Provide a shared or per-variant plan receipt.")
    if variant.get("repair") and (variant.get("geometry") or variant.get("alternate")):
        raise ValueError("Repair uses one already-aligned candidate.")
    if variant.get("geometry") and variant.get("alternate"):
        raise ValueError("Use a separate landmark geometry for each candidate.")
    result = json.loads(
        run_script(
            "compose-and-check-plan",
            original_path=args.original_path,
            base_path=args.original_path,
            candidate_path=variant["candidate"],
            plan_receipt_path=receipt,
            output_path=folder / "composition.png",
            review_preview_path=review_path,
            review_details_path=folder / "details.png",
            delivery_stage_path=folder / "delivery",
            initial_plan_receipt_path=args.initial_guide_directory
            / name
            / "receipt.json"
            if args.initial_guide_directory
            else None,
            reapply_original_protection=bool(variant.get("repair")),
            repair_path=variant.get("repair"),
            geometry_path=variant.get("geometry"),
            alternate_candidate_path=variant.get("alternate"),
            return_review=True,
        )
    )
    write_json(report_path, result)
    entry = {
        "id": name,
        "detailsPng": result.get("detailsPath"),
        "reportPath": str(report_path),
    }
    if result.get("verifiedPng") and Path(result["verifiedPng"]).is_file():
        return {
            **entry,
            "status": "verified",
            "verifiedPng": result["verifiedPng"],
            "candidatePath": result.get("candidatePath", variant["candidate"]),
        }
    entry.update(
        status="review_needed",
        reviewPng=str(review_path),
        error="Composition needs visual review and correction.",
    )
    if result.get("localPatch"):
        entry["localPatch"] = result["localPatch"]
    return entry


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for flag in ("original-path", "candidates-path", "output-directory"):
        parser.add_argument(f"--{flag}", type=Path, required=True)
    parser.add_argument("--plan-receipt-path", type=Path)
    parser.add_argument("--initial-guide-directory", type=Path)
    try:
        args = parser.parse_args()
        if args.initial_guide_directory and not args.initial_guide_directory.is_dir():
            raise ValueError("Provide the directory of the first checked guides.")
        variants = read_variants(args.candidates_path)
        output = args.output_directory.resolve()
        output.mkdir(parents=True)
        rows = []
        for item in variants:
            folder = output / item["id"]
            try:
                rows.append(compose_one(args, item, folder))
            except (OSError, ValueError, TypeError, KeyError) as error:
                row = {"id": item["id"], "status": "review_needed", "error": str(error)}
                if (folder / "review.png").is_file():
                    row["reviewPng"] = str(folder / "review.png")
                rows.append(row)
        summary = {
            "variants": rows,
            "nextAction": "Inspect each candidate and deliver only the exact verified PNG that meets the brief.",
        }
        try:
            summary["previewPng"] = preview(rows, output / "variants.png")
        except (OSError, ValueError) as error:
            summary["previewError"] = str(error)
        print(json.dumps(summary, allow_nan=False))
    except (OSError, ValueError, TypeError, KeyError) as error:
        parser.exit(2, f"{error}\n")


if __name__ == "__main__":
    main()
