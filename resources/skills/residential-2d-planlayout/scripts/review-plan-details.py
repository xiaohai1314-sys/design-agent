"""Create a contact sheet of local regions requiring plan review."""

import argparse
import math
from pathlib import Path

from PIL import Image, ImageDraw
from plan_io import font, open_image, read_json, save_png


def review_tiles(review, furniture):
    regions = []
    if review.get("openingCleanup"):
        rect = review["openingCleanup"]["repair"]["clear"][0]["rect"]
        regions.append({"kind": "Opening cleanup", "rect": rect, "outline": True})
    for crossing in review.get("crossings") or []:
        if crossing.get("sampleRect"):
            infill = crossing.get("expectedStatus") == "line_across"
            regions.append(
                {
                    "kind": "Wall infill" if infill else "Opening",
                    "rect": crossing["sampleRect"],
                    "adjacent": crossing.get("adjacentFloorGrayMedian") is not None
                    and not infill,
                }
            )
    for route in (review.get("routes") or []) + (review.get("plannedCircuits") or []):
        radius = math.ceil(route.get("widthPx", 0) / 2)
        for waypoint in route.get("blockedWaypoints") or []:
            x, y = waypoint["point"]
            regions.append(
                {
                    "kind": "Turn",
                    "point": (x, y),
                    "rect": (x - radius, y - radius, x + radius + 1, y + radius + 1),
                }
            )
        for segment in route.get("segmentsNeedingReview") or []:
            a, b = segment["from"], segment["to"]
            lo = [min(a[i], b[i]) - radius for i in range(2)]
            hi = [max(a[i], b[i]) + radius + 1 for i in range(2)]
            regions.append({"kind": "Route", "rect": lo + hi})
    ordered = sorted(furniture, key=lambda item: not item.get("guideLabel"))
    regions.extend(
        {
            "kind": "Furniture",
            "label": item.get("guideLabel"),
            "rect": item["rect"],
            "outline": True,
        }
        for item in ordered
    )
    regions.extend(
        {"kind": "Seam", "rect": seam["rect"]}
        for seam in review.get("seamsToReview") or []
    )
    return regions[:6]


def render_details(source, regions):
    cols = min(2, len(regions))
    sheet = Image.new(
        "RGB", (cols * 540, math.ceil(len(regions) / cols) * 350), "white"
    )
    draw = ImageDraw.Draw(sheet, "RGBA")
    labels, english = font(14, chinese=True), font(14)
    for i, tile in enumerate(regions):
        l, t, r, b = tile["rect"]
        px = py = 22
        if tile.get("adjacent"):
            if b - t >= r - l:
                px = min(110, max(22, math.ceil((b - t) / 2)))
            else:
                py = min(110, max(22, math.ceil((r - l) / 2)))
        crop = (
            max(0, round(l - px)),
            max(0, round(t - py)),
            min(source.width, round(r + px)),
            min(source.height, round(b + py)),
        )
        x1, y1, x2, y2 = crop
        cw, ch = x2 - x1, y2 - y1
        if cw <= 0 or ch <= 0:
            raise ValueError("Review crop has no area inside the image.")
        scale = min(4, 492 / cw, 281 / ch)
        w, h = max(1, round(cw * scale)), max(1, round(ch * scale))
        x, y = i % cols * 540 + 38, i // cols * 350 + 58
        title = f"{i + 1}. {tile.get('label') or tile['kind']}  crop ({x1}, {y1})  {cw}x{ch} px"
        draw.text(
            (x, y - 48),
            title,
            font=labels if tile.get("label") else english,
            fill="black",
        )
        piece = source.crop(crop).resize((w, h), Image.Resampling.NEAREST)
        sheet.paste(piece, (x, y), piece)
        step = 20 if scale >= 2.3 else 50
        grid = (43, 129, 170, 58)
        for a in range(math.ceil(x1 / step) * step, x2, step):
            p = x + (a - x1) * w / cw
            draw.line((p, y, p, y + h), fill=grid)
            draw.text((p, y - 21), str(a), font=english, anchor="mt", fill="steelblue")
        for a in range(math.ceil(y1 / step) * step, y2, step):
            p = y + (a - y1) * h / ch
            draw.line((x, p, x + w, p), fill=grid)
            draw.text((x - 4, p), str(a), font=english, anchor="rm", fill="steelblue")
        if tile.get("point"):
            a, b0 = tile["point"]
            cx, cy = x + (a - x1) * w / cw, y + (b0 - y1) * h / ch
            draw.ellipse((cx - 5, cy - 5, cx + 5, cy + 5), outline="darkorange")
        if tile.get("outline"):
            draw.rectangle(
                (
                    x + (l - x1) * w / cw,
                    y + (t - y1) * h / ch,
                    x + (r - x1) * w / cw,
                    y + (b - y1) * h / ch,
                ),
                outline="darkorange",
            )
        draw.rectangle((x, y, x + w, y + h), outline="lightgray")
    return sheet


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-path", type=Path, required=True)
    parser.add_argument("--output-path", type=Path, required=True)
    parser.add_argument("--review-path", type=Path, required=True)
    args = parser.parse_args()
    try:
        data = read_json(args.review_path)
        tiles = review_tiles(data["review"], data.get("furniture") or [])
        if tiles:
            save_png(
                render_details(open_image(args.input_path), tiles), args.output_path
            )
            print(args.output_path.resolve())
    except (OSError, ValueError, TypeError, KeyError) as error:
        parser.exit(2, f"{error}\n")


if __name__ == "__main__":
    main()
