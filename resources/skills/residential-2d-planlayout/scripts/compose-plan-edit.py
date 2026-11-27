"""Align a candidate and copy only the reviewed area, preserving original lock pixels."""

import argparse
import json
import subprocess
import sys
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np
from PIL import Image
from plan_draw import polygon_mask
from plan_io import new_png, open_image, read_json, save_png


def points(values, size):
    result = np.asarray(values, dtype=float)
    if (
        result.ndim != 2
        or result.shape[1] != 2
        or not np.isfinite(result).all()
        or (result < 0).any()
        or (result >= size).any()
    ):
        raise ValueError(
            "A point is outside its image or does not have two coordinates."
        )
    return result


def apply_regions(mask, regions, size, value, lower=None, upper=None):
    for region in regions:
        polygon = points(region["points"], size)
        if len(polygon) < 3:
            raise ValueError("Each edit or lock polygon needs at least three points.")
        if lower is not None and ((polygon < lower).any() or (polygon > upper).any()):
            raise ValueError("An edit vertex is outside the landmark bounds.")
        polygon_mask(mask, polygon, value)


def registered_geometry(args):
    if args.geometry_path:
        return read_json(args.geometry_path), {}
    with TemporaryDirectory(prefix="plan-landmarks-") as temp:
        geometry = Path(temp) / "geometry.json"
        command = [
            sys.executable,
            "-X",
            "utf8",
            "-B",
            str(Path(__file__).with_name("match-plan-landmarks.py")),
            str(args.base_path),
            str(args.candidate_path),
            str(args.regions_path),
            str(geometry),
        ]
        if args.reference_crop_path:
            command.extend(("--reference-crop", str(args.reference_crop_path)))
        result = subprocess.run(
            command, check=False, capture_output=True, text=True, encoding="utf-8"
        )
        if result.returncode:
            raise ValueError(
                result.stderr.strip() or "Automatic landmark matching failed."
            )
        return read_json(geometry), json.loads(result.stdout)


def compose(args):
    output = new_png(args.output_path)
    preview = new_png(args.aligned_preview_path) if args.aligned_preview_path else None
    if preview == output:
        raise ValueError("Choose separate output and aligned preview paths.")
    if bool(args.original_path) != bool(args.original_locks_path):
        raise ValueError("Provide both the original image and its lock polygons.")
    source, candidate = open_image(args.base_path), open_image(args.candidate_path)
    geometry, registration = registered_geometry(args)
    anchors, edits = geometry["anchors"], geometry["edits"]
    if len(anchors) < 4 or not edits:
        raise ValueError(
            "Provide at least four corresponding landmarks and an edit region."
        )
    target = points([a["base"] for a in anchors], source.size)
    moving = points([a["candidate"] for a in anchors], candidate.size)
    for group in (target, moving):
        if (
            len(np.unique(group, axis=0)) != len(group)
            or (np.ptp(group, axis=0) < 16).any()
        ):
            raise ValueError("Choose distinct landmarks spread across both directions.")
    centered = moving - moving.mean(axis=0)
    scale = (centered * (target - target.mean(axis=0))).sum(axis=0) / (centered**2).sum(
        axis=0
    )
    if (scale <= 0).any() or scale.max() / scale.min() > 1.08:
        raise ValueError(
            "The candidate must have the same orientation and proportions as the base."
        )
    offset = target.mean(axis=0) - moving.mean(axis=0) * scale
    max_error = float(np.linalg.norm(moving * scale + offset - target, axis=1).max())
    limit = min(8, max(2, min(source.size) * 0.004))
    if registration.get("method") == "sheet-outline-rounded-corner":
        limit *= 1.6
    if max_error > limit:
        raise ValueError(
            f"Landmarks disagree by {max_error:.1f} px (limit {limit:.1f} px)."
        )
    sx, sy = scale
    ox, oy = offset
    aligned = candidate.transform(
        source.size,
        Image.Transform.AFFINE,
        (1 / sx, 0, -ox / sx, 0, 1 / sy, -oy / sy),
        Image.Resampling.BICUBIC,
    )
    mask = np.zeros((source.height, source.width), dtype=bool)
    apply_regions(
        mask, edits, source.size, True, target.min(axis=0), target.max(axis=0)
    )
    apply_regions(mask, geometry.get("locks", []), source.size, False)
    original_mask = None
    if args.original_path:
        original = open_image(args.original_path)
        if original.size != source.size:
            raise ValueError(
                "An exact lock check needs the original canvas and resolution."
            )
        original_mask = np.zeros_like(mask)
        apply_regions(
            original_mask,
            read_json(args.original_locks_path)["locks"],
            source.size,
            True,
        )
        if not original_mask.any():
            raise ValueError("The original lock polygons cover no pixels.")
        mask &= ~original_mask
    result = np.array(source)
    replacements = np.asarray(aligned)[mask]
    if (replacements[:, 3] != 255).any():
        raise ValueError("The edit requires an opaque candidate.")
    changed = int(np.count_nonzero(np.any(result[mask] != replacements, axis=1)))
    if not changed:
        raise ValueError("The selected region contains no visible change.")
    result[mask] = replacements
    receipt = {
        "path": str(output),
        "changedPixels": changed,
        "maxLandmarkErrorPx": round(max_error, 2),
    }
    if original_mask is not None:
        differs = original_mask & np.any(np.asarray(original) != result, axis=2)
        if differs.any():
            y, x = np.argwhere(differs)[0]
            raise ValueError(f"Protected original pixel differs at ({x}, {y}).")
        receipt["originalLockedPixels"] = int(original_mask.sum())
    if registration:
        receipt.update(
            matchingLandmarks=registration["inliers"],
            supportAreas=registration["supportAreas"],
        )
        if registration.get("method"):
            receipt["registrationMethod"] = registration["method"]
    if preview:
        save_png(aligned, preview)
    save_png(Image.fromarray(result), output)
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("base", "candidate", "output"):
        parser.add_argument(f"--{name}-path", type=Path, required=True)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--geometry-path", type=Path)
    source.add_argument("--regions-path", type=Path)
    for name in ("reference-crop", "original", "original-locks", "aligned-preview"):
        parser.add_argument(f"--{name}-path", type=Path)
    try:
        print(json.dumps(compose(parser.parse_args()), allow_nan=False))
    except (OSError, ValueError, TypeError, KeyError) as error:
        parser.exit(2, f"{error}\n")


if __name__ == "__main__":
    main()
