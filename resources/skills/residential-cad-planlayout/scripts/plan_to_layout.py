#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把 cad 技能的 plan.json 转成本技能用的 layout.json。

用法：
    python plan_to_layout.py --plan 户型.plan.json --out layout.json

plan.json 由 cad 技能的 plan_extract.py 产出（schema design-agent/plan@1），
墙是 start/end 线段，洞口用「沿墙偏移」定位，房间是多边形。
layout.json 是平面出图用的简化格式，房间写 points（原多边形）和 x/y/w/h（外包框），
plan_dxf.py 优先按 points 算面积、放房间名，没有 points 时才退回矩形。

plan.json 里没有家具几何（家具只做校验），furniture 一律输出空数组，由后续步骤补。
"""
import argparse
import json
import math
import sys


def load(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def bbox(points):
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    return min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys)


def room_points(room):
    poly = room.get("polygon") or []
    if len(poly) < 3:
        return None
    return [[round(float(p[0]), 1), round(float(p[1]), 1)] for p in poly]


def convert(plan):
    if plan.get("schema") not in (None, "design-agent/plan@1"):
        raise ValueError(f"不是 plan.json：schema={plan.get('schema')}")
    units = plan.get("units")
    if units not in (None, "mm"):
        raise ValueError(f"只支持毫米单位，当前 units={units}")

    walls = []
    wall_index = {}
    for w in plan.get("walls") or []:
        start, end = w.get("start"), w.get("end")
        if not start or not end:
            continue
        wall_index[w.get("id")] = w
        walls.append(
            {
                "x1": round(float(start[0]), 1),
                "y1": round(float(start[1]), 1),
                "x2": round(float(end[0]), 1),
                "y2": round(float(end[1]), 1),
                "thickness": round(float(w.get("thickness") or 0), 1),
            }
        )

    rooms = []
    for r in plan.get("rooms") or []:
        pts = room_points(r)
        if pts is None:
            continue
        x, y, w, h = bbox(pts)
        rooms.append(
            {
                "name": r.get("name") or r.get("id") or "未命名",
                "points": pts,
                "x": round(x, 1),
                "y": round(y, 1),
                "w": round(w, 1),
                "h": round(h, 1),
                "area_m2": r.get("area_m2"),
            }
        )

    openings = []
    skipped = []
    for o in plan.get("openings") or []:
        wall = wall_index.get(o.get("wall"))
        if wall is None:
            skipped.append(o.get("id") or "?")
            continue
        sx, sy = wall["start"]
        ex, ey = wall["end"]
        length = math.hypot(ex - sx, ey - sy) or 1.0
        dx, dy = (ex - sx) / length, (ey - sy) / length
        t0 = float(o.get("offset") or 0)
        width = float(o.get("width") or 0)
        if width <= 0:
            continue
        # 洞口的两个端点；墙可能朝负方向画，取靠左下的那个作起点
        ax, ay = sx + dx * t0, sy + dy * t0
        bx, by = sx + dx * (t0 + width), sy + dy * (t0 + width)
        horizontal = abs(dx) >= abs(dy)
        # 洞口沿墙只有一个方向在变，两个轴都取 min 就能得到 plan_dxf 要的左下角
        x, y = min(ax, bx), min(ay, by)
        openings.append(
            {
                "x": round(x, 1),
                "y": round(y, 1),
                "width": round(width, 1),
                "orient": "h" if horizontal else "v",
                "kind": o.get("type") or "door",
            }
        )

    if skipped:
        print(f"跳过 {len(skipped)} 个找不到所属墙的洞口：{'、'.join(skipped[:5])}", file=sys.stderr)

    storey = (plan.get("storey") or {}).get("height")
    return {
        "unit": "mm",
        "source": {
            "schema": plan.get("schema"),
            "storeyHeight": storey,
            "wallCount": len(walls),
            "roomCount": len(rooms),
        },
        "rooms": rooms,
        "walls": walls,
        "openings": openings,
        "furniture": [],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan", required=True, help="cad 技能产出的 plan.json")
    parser.add_argument("--out", required=True, help="输出的 layout.json")
    args = parser.parse_args()
    try:
        layout = convert(load(args.plan))
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f"转换失败：{error}", file=sys.stderr)
        return 2
    with open(args.out, "w", encoding="utf-8") as f:
        f.write(json.dumps(layout, ensure_ascii=False, indent=1) + "\n")
    print(
        f"已写出 {args.out}：房间 {len(layout['rooms'])} 间，墙 {len(layout['walls'])} 段，"
        f"洞口 {len(layout['openings'])} 个"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
