"""Draw a proportionate room outline and optional furniture guides."""

import argparse
import json
import math
from pathlib import Path

from PIL import Image, ImageDraw
from plan_io import font, save_png


def dashed_edge(draw, start, stop, fixed, horizontal):
    for pos in range(start, stop, 8):
        end = min(pos + 5, stop)
        line = (pos, fixed, end, fixed) if horizontal else (fixed, pos, fixed, end)
        draw.line(line, fill="slategray", width=2)


def render(width, depth, layout):
    if not all(1 <= n <= 1_000_000 for n in (width, depth)):
        raise ValueError("Width and depth must be between 1 and 1000000.")
    scale = 960 / max(width, depth)
    w, h = round(width * scale), round(depth * scale)
    if min(w, h) < 24:
        raise ValueError("The boundary is too narrow for this guide.")
    margin = 48
    image = Image.new("RGB", (w + 2 * margin, h + 2 * margin), "white")
    draw = ImageDraw.Draw(image)
    if layout is not None:
        if layout["width"] != width or layout["depth"] != depth:
            raise ValueError("Use the same width and depth as the layout file.")
        furniture = layout["furniture"]
        if not isinstance(furniture, list) or not 1 <= len(furniture) <= 6:
            raise ValueError("Provide one to six furniture footprints.")
        label_font = font(15, chinese=True)
        for item in furniture:
            rect, label = item["rect"], item["label"]
            if (
                not isinstance(rect, list)
                or len(rect) != 4
                or not all(type(n) in (float, int) and math.isfinite(n) for n in rect)
            ):
                raise ValueError("Each footprint needs four finite numeric edges.")
            left, top, right, bottom = rect
            if not (
                0 <= left < right <= width
                and 0 <= top < bottom <= depth
                and isinstance(label, str)
                and label.strip()
                and len(label) <= 16
            ):
                raise ValueError(
                    "Keep each labeled footprint within the room with positive area."
                )
            x, y, r, b = [margin + round(n * scale) for n in rect]
            for fixed in (y, b):
                dashed_edge(draw, x, r, fixed, True)
            for fixed in (x, r):
                dashed_edge(draw, y, b, fixed, False)
            l, t, label_r, label_b = draw.textbbox((0, 0), label, font=label_font)
            if label_r - l + 4 <= r - x and label_b - t + 4 <= b - y:
                draw.text(
                    ((x + r) / 2, (y + b) / 2),
                    label,
                    fill="slategray",
                    font=label_font,
                    anchor="mm",
                )
    draw.rectangle(
        (46, 46, margin + w + 2, margin + h + 2), outline=(199, 42, 36), width=4
    )
    dimension_font = font(22)

    def dimension(n):
        return f"{n:.3f}".rstrip("0").rstrip(".")

    draw.text(
        (image.width / 2, margin / 2),
        dimension(width),
        font=dimension_font,
        anchor="mm",
        fill="black",
    )
    strip = Image.new("RGB", (image.height, margin), "white")
    ImageDraw.Draw(strip).text(
        (strip.width / 2, margin / 2),
        dimension(depth),
        font=dimension_font,
        anchor="mm",
        fill="black",
    )
    # Paste only the text area so the margin does not erase the left edge of the outline.
    vertical = strip.transpose(Image.Transpose.ROTATE_90)
    image.paste(vertical.crop((0, 0, margin - 2, image.height)), (0, 0))
    return image


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--width", type=float, required=True)
    parser.add_argument("--depth", type=float, required=True)
    parser.add_argument("--layout", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.output.suffix.lower() != ".png":
            raise ValueError("Choose a new PNG output file.")
        layout = (
            json.loads(args.layout.read_text(encoding="utf-8-sig"))
            if args.layout
            else None
        )
        image = render(args.width, args.depth, layout)
        save_png(image, args.output)
        print(args.output.resolve())
    except (OSError, ValueError, TypeError, KeyError) as error:
        parser.exit(2, f"{error}\n")


if __name__ == "__main__":
    main()
