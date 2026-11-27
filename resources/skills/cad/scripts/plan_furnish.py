#!/usr/bin/env python3
"""按 plan.json 校验家具布置，输出问题清单、DXF 和标注图。

  python plan_furnish.py --plan xxx.plan.json --furniture 家具.json [--out 布置.dxf]

家具清单（schema design-agent/furniture@1）：

  {
    "schema": "design-agent/furniture@1",
    "items": [
      {"id": "F1", "name": "双人床", "room": "R1", "category": "bed",
       "rect": {"cx": 2400, "cy": 1200, "width": 1500, "depth": 2000, "rotation": 0}},
      {"id": "F2", "name": "衣柜", "room": "R1", "category": "wardrobe",
       "polygon": [[0, 0], [600, 0], [600, 2000], [0, 2000]]}
    ]
  }

`rect` 以中心点定位，`rotation` 是逆时针角度（度）；异形家具直接用 `polygon`。
`room` 可以写房间 id 或房间名，不写就按家具中心落在哪个房间判断。

校验项（家具是已知几何，和墙、洞口、房间轮廓一起算，不靠看图比对）：
- 穿墙：家具压进墙体的面积超过 --tol-area；
- 出房间：家具顶点跑到房间轮廓外，或家具边穿出房间轮廓；
- 家具重叠：两件家具的轮廓相交（贴边相接不算）；
- 挡门：门洞 / 过道两侧、门宽 × 门宽 的范围内有家具 —— 门扇往哪边开都转不开；
- 无效缝隙：家具与墙之间留了 --min-passage 以内的缝，既贴不上又走不过去（警告）。

本工具只校验和出图，不生成布置方案。
"""
import argparse
import json
import math
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import plan_core  # noqa: E402
import plan_geom as pg  # noqa: E402

SCHEMA = "design-agent/furnish@1"
DEFAULTS = {"tol": 5.0, "tol_area": 2000.0, "min_passage": 500.0}


# ---------------------------------------------------------------------------
# 几何
# ---------------------------------------------------------------------------


def rect_polygon(cx, cy, width, depth, rotation=0.0):
    """中心 + 宽深 + 旋转角 → 四个角点。rotation 逆时针，单位度。"""
    hw, hd = width / 2.0, depth / 2.0
    rad = math.radians(rotation or 0.0)
    cos, sin = math.cos(rad), math.sin(rad)
    corners = []
    for dx, dy in ((-hw, -hd), (hw, -hd), (hw, hd), (-hw, hd)):
        corners.append((cx + dx * cos - dy * sin, cy + dx * sin + dy * cos))
    return corners


def point_segment_distance(p, a, b):
    ax, ay = a
    bx, by = b
    dx, dy = bx - ax, by - ay
    length2 = dx * dx + dy * dy
    if length2 < 1e-12:
        return math.dist(p, a)
    t = max(0.0, min(1.0, ((p[0] - ax) * dx + (p[1] - ay) * dy) / length2))
    return math.dist(p, (ax + dx * t, ay + dy * t))


def distance_to_boundary(p, poly):
    return min(point_segment_distance(p, poly[i - 1], poly[i]) for i in range(len(poly)))


def point_in_or_near(p, poly, tol):
    return pg.point_in_polygon(p, poly) or distance_to_boundary(p, poly) <= tol


def _orient(a, b, c):
    value = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
    return 0 if abs(value) < 1e-9 else (1 if value > 0 else -1)


def segments_cross(a, b, c, d):
    """两条线段真正相交（只碰到端点 / 共线重叠不算），用于判断家具边是否穿出房间。"""
    o1, o2 = _orient(a, b, c), _orient(a, b, d)
    o3, o4 = _orient(c, d, a), _orient(c, d, b)
    return o1 * o2 < 0 and o3 * o4 < 0


def edges_cross(poly_a, poly_b):
    for i in range(len(poly_a)):
        a, b = poly_a[i - 1], poly_a[i]
        for j in range(len(poly_b)):
            if segments_cross(a, b, poly_b[j - 1], poly_b[j]):
                return True
    return False


def polygons_overlap(a, b, tol=1.0):
    """两个简单多边形是否有面积重叠。贴边相接、顶点落在对方边上都不算。

    只比顶点不够：两件家具完全重合时，顶点都落在对方边界上，会被判成"没重叠"；
    所以再加一条——一件的中心落在另一件里，就算重叠。
    """
    for poly, other in ((a, b), (b, a)):
        for p in poly:
            if pg.point_in_polygon(p, other) and distance_to_boundary(p, other) > tol:
                return True
        c = centroid(poly)
        if pg.point_in_polygon(c, other) and distance_to_boundary(c, other) > tol:
            return True
    return edges_cross(a, b)


def distance_to_polygon(poly, boundary):
    """多边形到另一条闭合轮廓的最近距离（取各顶点到轮廓的距离；家具在房间里面，用这个而不是相交判断）。"""
    return min(distance_to_boundary(p, boundary) for p in poly)


def local_overlap_area(poly, origin, d, n, box):
    """把多边形转到墙的局部坐标（u 沿墙、v 垂直墙），与轴对齐的 box 求交面积，mm²。"""
    local = [
        ((p[0] - origin[0]) * d[0] + (p[1] - origin[1]) * d[1], (p[0] - origin[0]) * n[0] + (p[1] - origin[1]) * n[1])
        for p in poly
    ]
    clipped = plan_core.clip_polygon_to_box(local, box)
    return pg.polygon_area(clipped) if len(clipped) >= 3 else 0.0


def wall_overlap_area(poly, wall):
    """家具压进墙体（墙中心线 ± 半墙厚、两端之间）的面积，mm²。"""
    origin, d, n, length = pg.wall_frame(wall)
    half = float(wall["thickness"]) / 2.0
    return local_overlap_area(poly, origin, d, n, (0.0, -half, length, half))


def item_polygon(item):
    """家具 → 多边形。rect 以中心定位，polygon 直接给点。"""
    rect = item.get("rect")
    if rect:
        return rect_polygon(
            float(rect.get("cx", 0.0)),
            float(rect.get("cy", 0.0)),
            float(rect.get("width", 0.0)),
            float(rect.get("depth", 0.0)),
            float(rect.get("rotation", 0.0)),
        )
    polygon = item.get("polygon")
    if polygon and len(polygon) >= 3:
        return [(float(p[0]), float(p[1])) for p in polygon]
    return None


def centroid(poly):
    xs, ys = [p[0] for p in poly], [p[1] for p in poly]
    return (sum(xs) / len(xs), sum(ys) / len(ys))


# ---------------------------------------------------------------------------
# 校验
# ---------------------------------------------------------------------------


def room_of(item, poly, rooms):
    key = str(item.get("room") or "").strip()
    if key:
        for room in rooms:
            if key in (room.get("id"), room.get("name")):
                return room
        raise ValueError("家具 %s 指定的房间「%s」不在 plan.json 里" % (item.get("id"), key))
    c = centroid(poly)
    return next((room for room in rooms if pg.point_in_polygon(c, room["polygon"])), None)


def door_zones(plan):
    """门洞 / 过道两侧的通行区：洞口宽 × 门宽，从墙面往里。门扇往哪边开都在这个范围里。"""
    walls = {w["id"]: w for w in plan.get("walls", [])}
    rooms = plan.get("rooms", [])
    zones = []
    for opening in plan.get("openings", []):
        if opening.get("type") not in ("door", "passage"):
            continue
        wall = walls.get(opening.get("wall"))
        if not wall:
            continue
        origin, d, n, _length = pg.wall_frame(wall)
        half = float(wall["thickness"]) / 2.0
        u0 = float(opening["offset"])
        u1 = u0 + float(opening["width"])
        depth = float(opening["width"])
        for sign in (1.0, -1.0):
            mid = ((u0 + u1) / 2.0, half + 60.0)
            probe = (origin[0] + d[0] * mid[0] + n[0] * mid[1] * sign, origin[1] + d[1] * mid[0] + n[1] * mid[1] * sign)
            room = next((r for r in rooms if pg.point_in_polygon(probe, r["polygon"])), None)
            if not room:
                continue
            zone = [
                (origin[0] + d[0] * u + n[0] * half * sign, origin[1] + d[1] * u + n[1] * half * sign) for u in (u0, u1)
            ]
            zone += [
                (origin[0] + d[0] * u + n[0] * (half + depth) * sign, origin[1] + d[1] * u + n[1] * (half + depth) * sign)
                for u in (u1, u0)
            ]
            v_lo, v_hi = (half, half + depth) if sign > 0 else (-(half + depth), -half)
            zones.append(
                {"opening": opening, "room": room, "polygon": zone, "origin": origin, "d": d, "n": n, "box": (u0, v_lo, u1, v_hi)}
            )
    return zones


def check(plan, items, cfg):
    """返回 (findings, 每件家具的房间与轮廓)。"""
    tol, tol_area, min_passage = cfg["tol"], cfg["tol_area"], cfg["min_passage"]
    rooms = plan.get("rooms", [])
    walls = plan.get("walls", [])
    findings = []
    placed = []

    for item in items:
        poly = item_polygon(item)
        name = item.get("name") or item.get("id") or "未命名"
        if poly is None:
            findings.append({"status": "fail", "check": "轮廓", "item": name, "detail": "没有 rect 或 polygon，无法定位", "xy": None})
            continue
        room = room_of(item, poly, rooms)
        placed.append({"item": item, "polygon": poly, "room": room, "name": name})
        if room is None:
            findings.append(
                {"status": "fail", "check": "归属", "item": name, "detail": "不在任何房间轮廓内，也没有指定 room", "xy": centroid(poly)}
            )
            continue

        worst = None
        for wall in walls:
            area = wall_overlap_area(poly, wall)
            if area > tol_area and (worst is None or area > worst[0]):
                worst = (area, wall["id"])
        if worst:
            findings.append(
                {
                    "status": "fail",
                    "check": "穿墙",
                    "item": name,
                    "detail": "压进墙 %s 共 %.0f mm²" % (worst[1], worst[0]),
                    "xy": centroid(poly),
                }
            )

        outside = [p for p in poly if not point_in_or_near(p, room["polygon"], tol)]
        if outside or edges_cross(poly, room["polygon"]):
            findings.append(
                {
                    "status": "fail",
                    "check": "出房间",
                    "item": name,
                    "detail": "超出「%s」的轮廓（%d 个角点在外或边穿出）" % (room.get("name"), len(outside)),
                    "xy": outside[0] if outside else centroid(poly),
                }
            )

        gap = distance_to_polygon(poly, room["polygon"])
        if tol < gap < min_passage:
            findings.append(
                {
                    "status": "warn",
                    "check": "无效缝隙",
                    "item": name,
                    "detail": "离「%s」的墙 %.0f mm：既贴不上墙，也过不去（净宽 < %.0f）" % (room.get("name"), gap, min_passage),
                    "xy": centroid(poly),
                }
            )

    for zone in door_zones(plan):
        for entry in placed:
            if entry["room"] is not zone["room"]:
                continue
            if local_overlap_area(entry["polygon"], zone["origin"], zone["d"], zone["n"], zone["box"]) > tol_area:
                opening = zone["opening"]
                findings.append(
                    {
                        "status": "fail",
                        "check": "挡门",
                        "item": entry["name"],
                        "detail": "挡住洞口 %s（宽 %s）前 %s mm 的通行区，门扇转不开"
                        % (opening.get("id"), opening.get("width"), opening.get("width")),
                        "xy": centroid(zone["polygon"]),
                    }
                )

    for i, first in enumerate(placed):
        for second in placed[i + 1 :]:
            if polygons_overlap(first["polygon"], second["polygon"], tol):
                findings.append(
                    {
                        "status": "fail",
                        "check": "家具重叠",
                        "item": first["name"],
                        "detail": "与「%s」重叠" % second["name"],
                        "xy": centroid(first["polygon"]),
                    }
                )

    return findings, placed


# ---------------------------------------------------------------------------
# 输出
# ---------------------------------------------------------------------------


def wall_spans(wall, openings):
    """墙中心线上要出实体的区段（扣掉门窗洞口），[(u0, u1)]。"""
    length = pg.wall_frame(wall)[3]
    cursor, spans = 0.0, []
    for opening in sorted(openings, key=lambda o: float(o["offset"])):
        a = min(max(float(opening["offset"]), 0.0), length)
        b = min(max(a + float(opening["width"]), 0.0), length)
        if a > cursor:
            spans.append((cursor, a))
        cursor = max(cursor, b)
    if cursor < length:
        spans.append((cursor, length))
    return spans


def wall_quad(origin, d, n, u0, u1, half):
    return [
        (origin[0] + d[0] * u0 - n[0] * half, origin[1] + d[1] * u0 - n[1] * half),
        (origin[0] + d[0] * u1 - n[0] * half, origin[1] + d[1] * u1 - n[1] * half),
        (origin[0] + d[0] * u1 + n[0] * half, origin[1] + d[1] * u1 + n[1] * half),
        (origin[0] + d[0] * u0 + n[0] * half, origin[1] + d[1] * u0 + n[1] * half),
    ]


def write_dxf(plan, placed, findings, path):
    import ezdxf

    doc = ezdxf.new("R2010", setup=True)
    doc.units = ezdxf.units.MM
    msp = doc.modelspace()
    for name, color in (("A-WALL", 7), ("A-ROOM", 8), ("A-FURN", 2), ("A-CHECK", 1)):
        doc.layers.add(name, color=color)

    openings_by_wall = {}
    for opening in plan.get("openings", []):
        openings_by_wall.setdefault(opening.get("wall"), []).append(opening)
    for wall in plan.get("walls", []):
        origin, d, n, _length = pg.wall_frame(wall)
        half = float(wall["thickness"]) / 2.0
        for u0, u1 in wall_spans(wall, openings_by_wall.get(wall["id"], [])):
            msp.add_lwpolyline(wall_quad(origin, d, n, u0, u1, half), close=True, dxfattribs={"layer": "A-WALL"})

    for room in plan.get("rooms", []):
        msp.add_lwpolyline(room["polygon"], close=True, dxfattribs={"layer": "A-ROOM"})
        c = centroid(room["polygon"])
        msp.add_text("%s %s㎡" % (room.get("name"), room.get("area_m2")), height=120, dxfattribs={"layer": "A-ROOM"}).set_placement(c)

    for entry in placed:
        msp.add_lwpolyline(entry["polygon"], close=True, dxfattribs={"layer": "A-FURN"})
        msp.add_text(entry["name"], height=120, dxfattribs={"layer": "A-FURN"}).set_placement(centroid(entry["polygon"]))

    for index, finding in enumerate([f for f in findings if f["status"] == "fail"]):
        if not finding["xy"]:
            continue
        x, y = finding["xy"]
        msp.add_circle((x, y), 260, dxfattribs={"layer": "A-CHECK"})
        msp.add_text("%d %s" % (index + 1, finding["check"]), height=140, dxfattribs={"layer": "A-CHECK"}).set_placement((x + 300, y + 300))

    Path(path).parent.mkdir(parents=True, exist_ok=True)
    doc.saveas(path)
    return path


def write_png(plan, placed, findings, path):
    """标注图：墙实心、房间填色、家具描边、问题画红圈。"""
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib import font_manager
    from matplotlib.patches import Polygon

    for name in ("Microsoft YaHei", "SimHei", "Noto Sans CJK SC", "Source Han Sans SC", "PingFang SC"):
        if any(f.name == name for f in font_manager.fontManager.ttflist):
            plt.rcParams["font.sans-serif"] = [name]
            break
    plt.rcParams["axes.unicode_minus"] = False

    width = float(plan["bounds"]["width"])
    depth = float(plan["bounds"]["depth"])
    fig, ax = plt.subplots(figsize=(12, 12 * depth / max(width, 1) + 0.8))
    for room in plan.get("rooms", []):
        ax.add_patch(Polygon(room["polygon"], closed=True, facecolor="#f4ede2", edgecolor="none"))

    openings_by_wall = {}
    for opening in plan.get("openings", []):
        openings_by_wall.setdefault(opening.get("wall"), []).append(opening)
    for wall in plan.get("walls", []):
        origin, d, n, _length = pg.wall_frame(wall)
        half = float(wall["thickness"]) / 2.0
        for u0, u1 in wall_spans(wall, openings_by_wall.get(wall["id"], [])):
            ax.add_patch(Polygon(wall_quad(origin, d, n, u0, u1, half), closed=True, facecolor="#2b2b2b", edgecolor="none"))

    for entry in placed:
        ax.add_patch(Polygon(entry["polygon"], closed=True, facecolor="#dbe8f4", edgecolor="#3a7bd5", linewidth=1.2))
        c = centroid(entry["polygon"])
        ax.text(c[0], c[1], entry["name"], ha="center", va="center", fontsize=8, color="#1f4e79")

    fails = [f for f in findings if f["status"] == "fail"]
    for index, finding in enumerate(fails):
        if not finding["xy"]:
            continue
        ax.scatter([finding["xy"][0]], [finding["xy"][1]], s=260, facecolors="none", edgecolors="#e8341c", linewidths=2, zorder=5)
        ax.annotate(str(index + 1), finding["xy"], xytext=(8, 8), textcoords="offset points", color="#e8341c", fontsize=11, fontweight="bold", zorder=6)

    ax.set_xlim(-500, width + 500)
    ax.set_ylim(-500, depth + 500)
    ax.set_aspect("equal")
    ax.axis("off")
    ax.set_title("家具布置校验：不满足 %d 项" % len(fails), fontsize=13)
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(path, dpi=150, bbox_inches="tight", facecolor="white")
    plt.close(fig)
    return path


# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------


def main():
    parser = argparse.ArgumentParser(description="按 plan.json 校验家具布置")
    parser.add_argument("--plan", required=True, help="plan.json 路径")
    parser.add_argument("--furniture", required=True, help="家具清单 JSON")
    parser.add_argument("--out", help="输出 DXF，默认 <plan 同目录>/<图名>.furnish.dxf")
    parser.add_argument("--png", help="输出标注图；不给则默认写同名 .png，写 --no-png 关掉")
    parser.add_argument("--no-png", action="store_true", help="不生成标注图")
    parser.add_argument("--min-passage", type=float, default=DEFAULTS["min_passage"], help="通行净宽（mm），默认 500")
    parser.add_argument("--tol", type=float, default=DEFAULTS["tol"], help="贴边容差（mm），默认 5")
    parser.add_argument("--tol-area", type=float, default=DEFAULTS["tol_area"], help="判穿墙的最小重叠面积（mm²），默认 2000")
    args = parser.parse_args()

    plan_path = Path(args.plan)
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    if not str(plan.get("schema", "")).startswith("design-agent/plan@"):
        sys.exit("ERROR: 需要单层 plan.json，收到 schema=%s" % plan.get("schema"))

    payload = json.loads(Path(args.furniture).read_text(encoding="utf-8"))
    items = payload.get("items") if isinstance(payload, dict) else payload
    if not items:
        sys.exit("ERROR: 家具清单里没有 items")

    cfg = {"tol": args.tol, "tol_area": args.tol_area, "min_passage": args.min_passage}
    try:
        findings, placed = check(plan, items, cfg)
    except ValueError as error:
        sys.exit("ERROR: %s" % error)

    stem = plan_path.name.replace(".plan.json", "").replace(".json", "")
    out = Path(args.out) if args.out else plan_path.with_name(stem + ".furnish.dxf")
    report_path = out.with_suffix(".json")
    png_path = Path(args.png) if args.png else out.with_suffix(".png")

    write_dxf(plan, placed, findings, out)
    if not args.no_png:
        try:
            write_png(plan, placed, findings, png_path)
        except Exception as error:  # 缺 matplotlib 或字体时不影响 DXF 和清单
            print("- 警告：标注图生成失败：%s" % error)
            png_path = None
    else:
        png_path = None

    fails = [f for f in findings if f["status"] == "fail"]
    warns = [f for f in findings if f["status"] == "warn"]
    report = {
        "schema": SCHEMA,
        "plan": str(plan_path.resolve()),
        "items": len(placed),
        "findings": findings,
        "summary": {"fail": len(fails), "warn": len(warns)},
        "assumptions": [
            "只校验几何关系，不判断家具尺寸是否符合人体工程学或功能是否合理。",
            "挡门检查的是洞口前 门宽×门宽 的通行区（门扇往哪边开都覆盖），不是按实际铰接侧画的开启弧。",
        ],
    }
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")

    print("# 家具布置校验：%s" % plan_path.name)
    print("- 已写入 %s" % out.resolve())
    print("- 清单 %s%s" % (report_path.resolve(), "，标注图 %s" % png_path.resolve() if png_path else ""))
    print("- 家具 %d 件；不满足 %d 项，需注意 %d 项" % (len(placed), len(fails), len(warns)))
    for finding in fails + warns:
        print("- %s %s｜%s｜%s" % ("❌" if finding["status"] == "fail" else "⚠️", finding["check"], finding["item"], finding["detail"]))
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
