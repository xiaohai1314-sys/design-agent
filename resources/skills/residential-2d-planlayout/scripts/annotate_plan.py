#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""在户型底图上标注房间与尺寸，供用户核对。

用法：
    python annotate_plan.py spec.json

spec.json（坐标一律是图片像素）：
{
  "image":  "户型.png",
  "output": "户型-标注.png",
  "rooms":  [{"x1": 100, "y1": 100, "x2": 900, "y2": 800, "text": "主卧 3800×3300"}],
  "dims":   [{"x1": 100, "y1": 820, "x2": 900, "y2": 820, "text": "3800"}],
  "labels": [{"x": 500, "y": 60, "text": "方案 A", "size": 34}]
}

rooms 画半透明色块 + 居中文字；dims 画带端点刻度的尺寸线；labels 画自由文字。
"""
import json
import os
import sys

FONT_CANDIDATES = [
    "C:/Windows/Fonts/msyh.ttc",
    "C:/Windows/Fonts/simhei.ttf",
    "C:/Windows/Fonts/simsun.ttc",
]

ROOM_FILL = (59, 130, 246, 46)
ROOM_LINE = (37, 99, 235, 220)
DIM_LINE = (220, 38, 38, 230)
TEXT_FILL = (17, 24, 39, 255)


def load_font(size):
    from PIL import ImageFont

    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default()


def centered_text(draw, cx, cy, text, font, fill):
    box = draw.textbbox((0, 0), text, font=font)
    w, h = box[2] - box[0], box[3] - box[1]
    draw.text((cx - w / 2, cy - h / 2), text, font=font, fill=fill)


def main(argv):
    if len(argv) < 2:
        print("用法：python annotate_plan.py spec.json", file=sys.stderr)
        return 2
    with open(argv[1], "r", encoding="utf-8") as f:
        spec = json.load(f)

    try:
        from PIL import Image, ImageDraw
    except ImportError:
        print("缺少 Pillow，请用自带 Python 运行本脚本。", file=sys.stderr)
        return 2

    src = spec["image"]
    if not os.path.exists(src):
        print(f"底图不存在：{src}", file=sys.stderr)
        return 1

    base = Image.open(src).convert("RGBA")
    overlay = Image.new("RGBA", base.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)

    # 字号按图宽自适应，避免大图上字太小
    scale = max(base.size) / 1400.0
    room_font = load_font(max(14, int(26 * scale)))
    dim_font = load_font(max(12, int(20 * scale)))

    for r in spec.get("rooms") or []:
        draw.rectangle([r["x1"], r["y1"], r["x2"], r["y2"]], fill=ROOM_FILL, outline=ROOM_LINE, width=max(1, int(2 * scale)))
        if r.get("text"):
            centered_text(
                draw,
                (r["x1"] + r["x2"]) / 2,
                (r["y1"] + r["y2"]) / 2,
                r["text"],
                room_font,
                TEXT_FILL,
            )

    tick = max(4, int(7 * scale))
    for d in spec.get("dims") or []:
        x1, y1, x2, y2 = d["x1"], d["y1"], d["x2"], d["y2"]
        draw.line([x1, y1, x2, y2], fill=DIM_LINE, width=max(1, int(2 * scale)))
        draw.line([x1, y1 - tick, x1, y1 + tick], fill=DIM_LINE, width=max(1, int(2 * scale)))
        draw.line([x2, y2 - tick, x2, y2 + tick], fill=DIM_LINE, width=max(1, int(2 * scale)))
        if d.get("text"):
            centered_text(draw, (x1 + x2) / 2, (y1 + y2) / 2 - 16 * scale, d["text"], dim_font, DIM_LINE)

    for l in spec.get("labels") or []:
        font = load_font(int(l.get("size", 30) * scale))
        draw.text((l["x"], l["y"]), l["text"], font=font, fill=TEXT_FILL)

    out = spec.get("output") or "户型-标注.png"
    Image.alpha_composite(base, overlay).convert("RGB").save(out)
    print(f"已生成：{out}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
