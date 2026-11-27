"""Render source-pixel coordinates over a plan or focused crops."""

import argparse
import json
import math
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw
from plan_io import font, open_image, read_json, save_png, sha256


def regions_for(args, width, height):
    if args.regions_path:
        regions = read_json(args.regions_path)["regions"]
        if not isinstance(regions, list) or not 1 <= len(regions) <= 4:
            raise ValueError("Provide one to four regions as source pixel edges.")
        for rect in regions:
            if (
                not isinstance(rect, list)
                or len(rect) != 4
                or any(type(n) is not int for n in rect)
            ):
                raise ValueError(
                    "Each focus region requires four integer source-pixel edges."
                )
            left, top, right, bottom = rect
            if not (0 <= left < right <= width and 0 <= top < bottom <= height):
                raise ValueError(
                    "Focus regions must have positive area within the original image."
                )
        return regions
    if args.whole_image:
        return [(0, 0, width, height)]
    x_mid, y_mid = width // 2, height // 2
    x_pad, y_pad = width // 12, height // 12
    columns = [(0, min(width, x_mid + x_pad + 1)), (x_mid - x_pad, width)]
    rows = [(0, min(height, y_mid + y_pad + 1)), (y_mid - y_pad, height)]
    return [(l, t, r, b) for t, b in rows for l, r in columns if l < r and t < b]


def draw_coordinates(source, regions, focused):
    tile, margin, available = 660, 42, 606
    columns = min(2, len(regions))
    rows = [regions[i : i + columns] for i in range(0, len(regions), columns)]
    heights = [
        margin
        + 12
        + max(
            round(min(available, available * (b - t) / (r - l))) for l, t, r, b in row
        )
        if focused
        else tile
        for row in rows
    ]
    canvas = Image.new("RGB", (columns * tile, sum(heights)), "white")
    draw = ImageDraw.Draw(canvas, "RGBA")
    labels = font(14)
    axis, grid = (26, 93, 117, 255), (35, 152, 185, 105)
    ticks, y_offset = [], 0
    for row, height in zip(rows, heights):
        for column, (left, top, right, bottom) in enumerate(row):
            width_px, height_px = right - left, bottom - top
            scale = min(available / width_px, available / height_px)
            w, h = max(1, round(width_px * scale)), max(1, round(height_px * scale))
            x0, y0 = column * tile + margin, y_offset + margin
            step = 1 if focused else 10
            while (step * scale < 8) if focused else (max(source.size) / step > 100):
                step *= 2
            major = 5 * step
            crop = source.crop((left, top, right, bottom)).resize(
                (w, h), Image.Resampling.NEAREST
            )
            canvas.paste(crop, (x0, y0), crop)
            draw.rectangle((x0, y0, x0 + w, y0 + h), outline=axis)
            draw.text(
                (x0, y0 - 39),
                f"Source px ({left},{top}) to ({right - 1},{bottom - 1})",
                font=labels,
                fill=axis,
            )
            for x in range(math.ceil(left / step) * step, right, step):
                p = x0 + (x - left + 0.5) * w / width_px
                draw.line((p, y0 - 4, p, y0), fill=axis)
                if x % major == 0:
                    draw.line((p, y0, p, y0 + h), fill=grid)
                    draw.text((p, y0 - 23), str(x), anchor="mt", font=labels, fill=axis)
            for y in range(math.ceil(top / step) * step, bottom, step):
                p = y0 + (y - top + 0.5) * h / height_px
                draw.line((x0 - 4, p, x0, p), fill=axis)
                if y % major == 0:
                    draw.line((x0, p, x0 + w, p), fill=grid)
                    draw.text((x0 - 6, p), str(y), anchor="rm", font=labels, fill=axis)
            ticks.append(
                {
                    "bounds": [left, top, right, bottom],
                    "minorTickPx": step,
                    "gridPx": major,
                }
            )
        y_offset += height
    return canvas, ticks


def coordinate_view(args):
    original_hash = sha256(args.input_path)
    structure = None
    if args.scan_filled:
        script = Path(__file__).with_name("inspect-plan-structure.py")
        result = subprocess.run(
            [
                sys.executable,
                "-X",
                "utf8",
                "-B",
                str(script),
                str(args.input_path),
                "--summary",
            ],
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
        )
        if result.returncode:
            raise ValueError(
                result.stderr.strip() or "The optional solid-region scan failed."
            )
        structure = json.loads(result.stdout)
        if structure["originalSha256"] != original_hash:
            raise ValueError("The original changed during the scan.")
    source = open_image(args.input_path)
    canvas, ticks = draw_coordinates(
        source, regions_for(args, *source.size), bool(args.regions_path)
    )
    if sha256(args.input_path) != original_hash:
        raise ValueError("The original changed during rendering.")
    save_png(canvas, args.output_path)
    report = {
        "coordinateView": str(args.output_path.resolve()),
        "sourceWidth": source.width,
        "sourceHeight": source.height,
        "originalSha256": original_hash,
    }
    if args.regions_path:
        report["regions"] = ticks
    else:
        report.update(minorTickPx=ticks[0]["minorTickPx"], gridPx=ticks[0]["gridPx"])
    if structure:
        report.update(
            background=structure["background"],
            filledCandidates=structure["filledCandidates"],
        )
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-path", type=Path, required=True)
    parser.add_argument("--output-path", type=Path, required=True)
    views = parser.add_mutually_exclusive_group()
    views.add_argument("--regions-path", type=Path)
    views.add_argument("--whole-image", action="store_true")
    parser.add_argument("--scan-filled", action="store_true")
    try:
        print(json.dumps(coordinate_view(parser.parse_args()), allow_nan=False))
    except (OSError, ValueError, TypeError, KeyError) as error:
        parser.exit(2, f"{error}\n")


if __name__ == "__main__":
    main()
