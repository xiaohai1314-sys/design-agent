"""Create a same-canvas label guide or clear reviewed existing opening symbols."""

import argparse
import json
import math
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw
from plan_io import font, open_image, read_json, save_png, sha256


def annotation(source, geometry):
    def point(x, y):
        if not all(type(n) in (float, int) and math.isfinite(n) for n in (x, y)):
            raise ValueError("Each annotation point must have finite coordinates.")
        if not (0 <= x < source.width and 0 <= y < source.height):
            raise ValueError("An annotation is outside the source canvas.")
        return x, y

    if (
        not isinstance(geometry, dict)
        or geometry.keys() - {"labels", "outline"}
        or not (geometry.get("labels") or geometry.get("outline"))
    ):
        raise ValueError("A generation guide only takes labels or an exterior outline.")
    marks = Image.new("RGBA", source.size)
    draw = ImageDraw.Draw(marks)
    size = min(40, max(14, round(min(source.size) / 36)))
    red, blue = (199, 42, 36, 245), (18, 69, 144, 255)
    if geometry.get("outline"):
        outline = [point(*pair) for pair in geometry["outline"]]
        if len(outline) < 3:
            raise ValueError("Trace at least three outline points.")
        stroke = max(1, round(size / 8))
        for a, b in zip(outline, outline[1:] + outline[:1]):
            length = math.dist(a, b)
            if not length:
                continue
            for start in range(0, math.ceil(length), stroke * 5):
                end = min(length, start + stroke * 3)
                u, v = start / length, end / length
                first = tuple(p + (q - p) * u for p, q in zip(a, b))
                last = tuple(p + (q - p) * v for p, q in zip(a, b))
                draw.line((first, last), fill=red, width=stroke)
    face = font(size, chinese=True)
    for label in geometry.get("labels") or []:
        center = point(label["x"], label["y"])
        text = label["text"]
        if not isinstance(text, str) or not text.strip():
            raise ValueError("Each guide label needs text.")
        l, t, r, b = draw.textbbox(center, text, font=face, anchor="mm")
        if l < 2 or t < 2 or r + 2 >= source.width or b + 2 >= source.height:
            raise ValueError("A label falls outside the source image.")
        if label.get("anchor") is not None:
            x, y = point(*label["anchor"])
            radius = max(2, size / 6)
            stroke = max(1, round(size / 10))
            draw.line((center, (x, y)), fill=blue, width=stroke)
            draw.ellipse(
                (x - radius, y - radius, x + radius, y + radius),
                outline=blue,
                width=stroke,
            )
        draw.rectangle((l - 2, t - 1, r + 2, b + 1), fill=(255, 255, 255, 235))
        draw.text(center, text, fill=blue, font=face, anchor="mm")
    return Image.alpha_composite(source, marks)


def prepare(args):
    source = open_image(args.input_path)
    if args.geometry_path:
        if args.opening_scope_path:
            raise ValueError("Pass the opening scope only with an opening repair.")
        save_png(annotation(source, read_json(args.geometry_path)), args.output_path)
        mode = "labels"
    else:
        if not args.opening_scope_path:
            raise ValueError("An opening repair requires an original scope.")
        data = read_json(args.opening_repair_path)
        repairs = (
            data.get("repairs") if isinstance(data, dict) and len(data) == 1 else None
        )
        if not isinstance(repairs, list) or not repairs:
            raise ValueError(
                "Provide a nonempty repairs array for approved existing openings."
            )
        for item in repairs:
            if (
                not isinstance(item, dict)
                or item.keys() != {"type", "rect", "background"}
                or item["type"] != "clear"
                or not isinstance(item["rect"], list)
                or not isinstance(item["background"], list)
            ):
                raise ValueError(
                    "Each opening may only clear a confirmed symbol using rect and background."
                )
        scope = read_json(args.opening_scope_path)
        if (
            scope["originalSha256"].lower() != sha256(args.input_path)
            or not isinstance(scope.get("locks"), list)
            or not scope["locks"]
        ):
            raise ValueError(
                "The opening scope must identify the original and at least one protected area."
            )
        script = Path(__file__).with_name("repair-plan-openings.py")
        result = subprocess.run(
            [
                sys.executable,
                "-X",
                "utf8",
                "-B",
                str(script),
                "--base-path",
                str(args.input_path),
                "--original-path",
                str(args.input_path),
                "--repair-path",
                str(args.opening_repair_path),
                "--original-locks-path",
                str(args.opening_scope_path),
                "--output-path",
                str(args.output_path),
            ],
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
        )
        if result.returncode:
            raise ValueError(
                result.stderr.strip() or "The approved openings could not be cleared."
            )
        mode = "cleared-openings"
    return {
        "image_urls": [str(args.output_path.resolve())],
        "width": source.width,
        "height": source.height,
        "guideMode": mode,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-path", type=Path, required=True)
    parser.add_argument("--output-path", type=Path, required=True)
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument("--geometry-path", type=Path)
    modes.add_argument("--opening-repair-path", type=Path)
    parser.add_argument("--opening-scope-path", type=Path)
    try:
        print(json.dumps(prepare(parser.parse_args()), allow_nan=False))
    except (OSError, ValueError, TypeError, KeyError) as error:
        parser.exit(2, f"{error}\n")


if __name__ == "__main__":
    main()
