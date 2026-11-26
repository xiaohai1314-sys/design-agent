#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""住宅平面布局的 DXF 生成与校验。

用法：
    python plan_dxf.py check layout.json
    python plan_dxf.py build layout.json 输出.dxf

layout.json 结构（单位默认 mm）：
{
  "unit": "mm",
  "rooms":     [{"name": "主卧", "x": 0, "y": 0, "w": 4000, "h": 3500}],
  "walls":     [{"x1": 0, "y1": 0, "x2": 8000, "y2": 0, "thickness": 200}],
  "openings":  [{"x": 3000, "y": 0, "width": 900, "orient": "h", "kind": "door"}],
  "furniture": [{"x": 1000, "y": 500, "w": 1800, "h": 2000, "label": "双人床"}]
}

坐标一律是图纸坐标；门洞的 (x, y) 是洞口起点，orient 为 h/v 表示所在墙的走向。
"""
import json
import math
import sys

MIN_DOOR = {"入户门": 900, "卧室门": 800, "卫生间门": 700, "厨房门": 800}
DOOR_HARD_MIN = 600


def load(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def wall_len(w):
    return math.hypot(w["x2"] - w["x1"], w["y2"] - w["y1"])


def point_seg_dist(px, py, w):
    x1, y1, x2, y2 = w["x1"], w["y1"], w["x2"], w["y2"]
    dx, dy = x2 - x1, y2 - y1
    L2 = dx * dx + dy * dy
    if L2 == 0:
        return math.hypot(px - x1, py - y1)
    t = max(0.0, min(1.0, ((px - x1) * dx + (py - y1) * dy) / L2))
    return math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))


def validate(spec):
    errors, warns, notes = [], [], []
    walls = spec.get("walls") or []
    rooms = spec.get("rooms") or []
    openings = spec.get("openings") or []
    furniture = spec.get("furniture") or []

    if not walls:
        errors.append("没有任何墙体，平面无法成立。")

    for i, w in enumerate(walls):
        if wall_len(w) < 1:
            errors.append(f"第 {i + 1} 段墙长度为 0。")
        if w.get("thickness", 0) <= 0:
            warns.append(f"第 {i + 1} 段墙未给厚度，按 0 处理。")

    for i, o in enumerate(openings):
        kind = o.get("kind", "door")
        width = o.get("width", 0)
        if width <= 0:
            errors.append(f"第 {i + 1} 个洞口宽度无效。")
            continue
        if kind == "door":
            if width < DOOR_HARD_MIN:
                errors.append(f"第 {i + 1} 个门洞 {width}mm，小于 {DOOR_HARD_MIN}mm，无法通行。")
            elif width < 700:
                warns.append(f"第 {i + 1} 个门洞 {width}mm，偏窄，请核对是否卫生间或设备间。")
        near = min((point_seg_dist(o["x"], o["y"], w) for w in walls), default=1e9)
        if near > 300:
            warns.append(f"第 {i + 1} 个洞口离最近的墙 {near:.0f}mm，可能没落在墙上。")

    total_area = 0.0
    for r in rooms:
        area = r["w"] * r["h"] / 1e6
        total_area += area
        if r["w"] <= 0 or r["h"] <= 0:
            errors.append(f"房间「{r.get('name', '?')}」尺寸无效。")
        elif area < 2:
            warns.append(f"房间「{r.get('name', '?')}」仅 {area:.1f}㎡，请确认。")

    for f in furniture:
        if f["w"] > 3200 or f["h"] > 3200:
            warns.append(f"家具「{f.get('label', '?')}」单边超过 3.2m，请确认不是笔误。")

    notes.append(f"墙段 {len(walls)} 段，总长 {sum(wall_len(w) for w in walls) / 1000:.1f}m")
    notes.append(f"房间 {len(rooms)} 间，套内面积合计 {total_area:.1f}㎡")
    notes.append(f"洞口 {len(openings)} 个，家具 {len(furniture)} 件")
    return errors, warns, notes


def emit_wall(msp, w):
    x1, y1, x2, y2 = w["x1"], w["y1"], w["x2"], w["y2"]
    t = w.get("thickness", 100) / 2.0
    L = wall_len(w)
    if L == 0:
        return
    nx, ny = -(y2 - y1) / L * t, (x2 - x1) / L * t
    a = (x1 + nx, y1 + ny)
    b = (x2 + nx, y2 + ny)
    c = (x2 - nx, y2 - ny)
    d = (x1 - nx, y1 - ny)
    msp.add_lwpolyline([a, b, c, d], close=True, dxfattribs={"layer": "墙体"})


def emit_opening(msp, o):
    x, y, width = o["x"], o["y"], o["width"]
    horizontal = o.get("orient", "h") == "h"
    if o.get("kind") == "window":
        for off in (-40, 40):
            if horizontal:
                msp.add_line((x, y + off), (x + width, y + off), dxfattribs={"layer": "门窗"})
            else:
                msp.add_line((x + off, y), (x + off, y + width), dxfattribs={"layer": "门窗"})
        return
    # 门：门扇 + 开启弧线
    if horizontal:
        leaf_end = (x, y + width)
        msp.add_line((x, y), leaf_end, dxfattribs={"layer": "门窗"})
        msp.add_arc((x, y), width, 0, 90, dxfattribs={"layer": "门窗"})
    else:
        leaf_end = (x + width, y)
        msp.add_line((x, y), leaf_end, dxfattribs={"layer": "门窗"})
        msp.add_arc((x, y), width, 0, 90, dxfattribs={"layer": "门窗"})


def build(spec, out_path):
    try:
        import ezdxf
    except ImportError:
        print("缺少 ezdxf，请用自带 Python 运行本脚本。", file=sys.stderr)
        return 2

    doc = ezdxf.new("R2010", setup=True)
    doc.units = ezdxf.units.MM
    doc.styles.add("CJK", font="simhei.ttf")
    for name, color in (("墙体", 7), ("门窗", 4), ("家具", 3), ("标注", 2)):
        if name not in doc.layers:
            doc.layers.add(name, color=color)
    msp = doc.modelspace()

    for w in spec.get("walls") or []:
        emit_wall(msp, w)
    for o in spec.get("openings") or []:
        emit_opening(msp, o)
    for f in spec.get("furniture") or []:
        x, y, w, h = f["x"], f["y"], f["w"], f["h"]
        msp.add_lwpolyline(
            [(x, y), (x + w, y), (x + w, y + h), (x, y + h)],
            close=True,
            dxfattribs={"layer": "家具"},
        )
        if f.get("label"):
            msp.add_text(
                f["label"], height=180, dxfattribs={"layer": "家具", "style": "CJK"}
            ).set_placement((x + w / 2 - len(f["label"]) * 90, y + h / 2))
    for r in spec.get("rooms") or []:
        if not r.get("name"):
            continue
        msp.add_text(
            r["name"], height=300, dxfattribs={"layer": "标注", "style": "CJK"}
        ).set_placement((r["x"] + r["w"] / 2 - len(r["name"]) * 150, r["y"] + r["h"] / 2))

    doc.saveas(out_path)
    return 0


def main(argv):
    if len(argv) < 3:
        print(__doc__.strip().splitlines()[1], file=sys.stderr)
        return 2
    action, spec_path = argv[1], argv[2]
    spec = load(spec_path)
    errors, warns, notes = validate(spec)

    for n in notes:
        print(f"  · {n}")
    for w in warns:
        print(f"  ⚠️ {w}")
    for e in errors:
        print(f"  ❌ {e}")

    if errors:
        print(f"\n校验未通过：{len(errors)} 项错误、{len(warns)} 项提醒。")
        return 1
    if action == "check":
        print(f"\n校验通过（{len(warns)} 项提醒）。")
        return 0
    if action != "build":
        print(f"未知动作：{action}", file=sys.stderr)
        return 2
    if len(argv) < 4:
        print("build 需要输出路径。", file=sys.stderr)
        return 2

    code = build(spec, argv[3])
    if code == 0:
        print(f"\n已生成：{argv[3]}（图层：墙体 / 门窗 / 家具 / 标注）")
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv))
