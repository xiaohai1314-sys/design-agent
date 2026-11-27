#!/usr/bin/env python3
"""plan.json 的共用几何工具：洞口落在哪个房间、房间分类、外墙判定、平面示意图绘制。

plan_quantity.py（工程量与报价）、plan_codecheck.py（规范审图）、report-pack 的汇报包都用它，
保证各处对“哪个门属于哪个房间”“哪些是湿区”的判断一致。
"""
import json
import math
import re
from pathlib import Path

WET_RE = re.compile(r"卫生间|卫浴|浴室|洗手间|厕所|淋浴|厨房|阳台|露台|设备|bath|wc|toilet|kitchen|balcony", re.I)
ROOM_TYPES = [
    ("bedroom", re.compile(r"卧|儿童房|老人房|客房|bedroom", re.I)),
    ("living", re.compile(r"客厅|起居|living", re.I)),
    ("dining", re.compile(r"餐厅|dining", re.I)),
    ("kitchen", re.compile(r"厨房|kitchen", re.I)),
    ("bathroom", re.compile(r"卫生间|卫浴|浴室|洗手间|厕所|bath|wc|toilet", re.I)),
    ("balcony", re.compile(r"阳台|露台|balcony|terrace", re.I)),
    ("study", re.compile(r"书房|study", re.I)),
    ("storage", re.compile(r"储藏|衣帽|storage", re.I)),
]
ROOM_TYPE_LABELS = {
    "bedroom": "卧室",
    "living": "起居室",
    "dining": "餐厅",
    "kitchen": "厨房",
    "bathroom": "卫生间",
    "balcony": "阳台",
    "study": "书房",
    "storage": "储藏",
    "other": "其他",
}

# 建筑类型：规范库只对某几类建筑适用（GB 50096 是住宅规范，拿去判教学楼就是误报）。
# 这里只做粗略识别，识别不出时返回 unknown，由调用方要求用户用 --building-type 指定。
BUILDING_TYPES = {
    "residential": ("住宅", re.compile(r"主卧|次卧|卧室|起居|客厅|餐厅|厨房|卫生间|浴室|阳台|书房|衣帽间|玄关|儿童房|老人房", re.I)),
    "education": ("教育（学校）", re.compile(r"教室|实验室|图书|阅览|音乐|美术|舞蹈|报告厅|多功能厅|教师办公", re.I)),
    "office": ("办公", re.compile(r"办公|会议|前台|接待|洽谈|档案", re.I)),
    "medical": ("医疗", re.compile(r"病房|诊室|手术|护士站|药房|候诊|处置|治疗", re.I)),
    "commercial": ("商业", re.compile(r"商业|商铺|营业|店铺|收银|超市|餐饮|包间|展示|店面", re.I)),
    "industrial": ("工业", re.compile(r"车间|厂房|仓库|生产线", re.I)),
}


def building_type_label(key):
    return BUILDING_TYPES.get(key, ("未识别", None))[0]


def infer_building_type(plan):
    """按房间名猜建筑类型；命中最多的类型要明显多于第二名，打平或一个都认不出时返回 unknown。"""
    counts = {}
    for room in plan.get("rooms", []):
        name = room.get("name") or ""
        for key, (_label, pattern) in BUILDING_TYPES.items():
            if pattern.search(name):
                counts[key] = counts.get(key, 0) + 1
                break
    if not counts:
        return "unknown"
    ranked = sorted(counts.items(), key=lambda kv: -kv[1])
    if len(ranked) > 1 and ranked[0][1] <= ranked[1][1]:
        return "unknown"
    return ranked[0][0]


def load_plan(path):
    plan = json.loads(Path(path).read_text(encoding="utf-8"))
    if not str(plan.get("schema", "")).startswith("design-agent/plan@"):
        raise ValueError(f"{path} 不是 plan.json（schema={plan.get('schema')}）")
    return plan


def room_type(name):
    for key, pattern in ROOM_TYPES:
        if pattern.search(name or ""):
            return key
    return "other"


def room_coverage(plan):
    """房间合计面积占外包面积的比例。

    正常平面里房间要占掉大半外包面积；明显偏低说明房间没识别全或墙体识别不完整，
    这时的面积类检查全是拿错数在判，不如不判。
    """
    rooms = plan.get("rooms", [])
    bounds = plan.get("bounds", {})
    footprint = float(bounds.get("width", 0) or 0) * float(bounds.get("depth", 0) or 0) / 1e6
    if footprint <= 0 or not rooms:
        return None
    return sum(float(room.get("area_m2", 0) or 0) for room in rooms) / footprint


def is_wet(name):
    return bool(WET_RE.search(name or ""))


def polygon_area(points):
    return abs(sum(points[i - 1][0] * points[i][1] - points[i][0] * points[i - 1][1] for i in range(len(points)))) / 2


def polygon_perimeter(points):
    return sum(math.dist(points[i - 1], points[i]) for i in range(len(points)))


def point_in_polygon(p, poly):
    x, y = p
    inside = False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / ((yj - yi) or 1e-12) + xi:
            inside = not inside
        j = i
    return inside


def min_side(points):
    """房间的“最小净宽”：取轮廓最短的那条边（矩形房间即短边）；多边形时只作参考。"""
    if len(points) == 4:
        sides = [math.dist(points[i - 1], points[i]) for i in range(4)]
        return min(sides)
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    return min(max(xs) - min(xs), max(ys) - min(ys))


def wall_frame(wall):
    sx, sy = wall["start"]
    ex, ey = wall["end"]
    length = math.hypot(ex - sx, ey - sy) or 1.0
    d = ((ex - sx) / length, (ey - sy) / length)
    n = (-d[1], d[0])
    return (sx, sy), d, n, length


def opening_center(opening, wall):
    origin, d, _n, _length = wall_frame(wall)
    t = float(opening["offset"]) + float(opening["width"]) / 2
    return (origin[0] + d[0] * t, origin[1] + d[1] * t)


def opening_sides(opening, wall, rooms):
    """洞口两侧各是哪个房间（None 表示室外或未识别的区域）。"""
    origin, d, n, _length = wall_frame(wall)
    c = opening_center(opening, wall)
    reach = float(wall["thickness"]) / 2 + 60
    sides = []
    for sign in (1, -1):
        probe = (c[0] + n[0] * reach * sign, c[1] + n[1] * reach * sign)
        hit = next((r for r in rooms if point_in_polygon(probe, r["polygon"])), None)
        sides.append(hit)
    return sides


def is_exterior_wall(wall, plan, tol=5.0):
    """墙的外皮贴着整个平面的外包框，就当作外墙。"""
    width = float(plan["bounds"]["width"])
    depth = float(plan["bounds"]["depth"])
    half = float(wall["thickness"]) / 2
    (sx, sy), (ex, ey) = wall["start"], wall["end"]
    if abs(sx - ex) < tol:
        return abs(sx - half) < tol or abs(sx + half - width) < tol
    if abs(sy - ey) < tol:
        return abs(sy - half) < tol or abs(sy + half - depth) < tol
    return False


def opening_index(plan):
    walls = {w["id"]: w for w in plan.get("walls", [])}
    rooms = plan.get("rooms", [])
    out = []
    for o in plan.get("openings", []):
        w = walls.get(o["wall"])
        if not w:
            continue
        a, b = opening_sides(o, w, rooms)
        out.append({"opening": o, "wall": w, "rooms": [r for r in (a, b) if r], "exterior": is_exterior_wall(w, plan) or a is None or b is None})
    return out


def draw_plan(plan, out_path, marks=None, title=None):
    """画平面示意图：墙体实心、洞口留白、房间名与面积；marks 是要标红的问题点 [{xy, label}]。"""
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib import font_manager
    from matplotlib.patches import Polygon

    for name in ("Microsoft YaHei", "SimHei", "Noto Sans CJK SC", "Source Han Sans SC", "PingFang SC", "WenQuanYi Zen Hei"):
        if any(f.name == name for f in font_manager.fontManager.ttflist):
            plt.rcParams["font.sans-serif"] = [name]
            break
    plt.rcParams["axes.unicode_minus"] = False

    width = float(plan["bounds"]["width"])
    depth = float(plan["bounds"]["depth"])
    fig_w = 12
    fig, ax = plt.subplots(figsize=(fig_w, fig_w * depth / max(width, 1) + 0.8))
    for room in plan.get("rooms", []):
        ax.add_patch(Polygon(room["polygon"], closed=True, facecolor="#dbe8f4" if is_wet(room["name"]) else "#f4ede2", edgecolor="none"))
        if room.get("confidence") == "low":
            # 面积待核的房间用红色虚线框出来，看图和算量时一眼能认出来
            ax.add_patch(Polygon(room["polygon"], closed=True, facecolor="none", edgecolor="#e8341c", linestyle="--", linewidth=1.5))
        xs = [p[0] for p in room["polygon"]]
        ys = [p[1] for p in room["polygon"]]
        ax.text(sum(xs) / len(xs), sum(ys) / len(ys), f"{room['name']}\n{room['area_m2']}㎡", ha="center", va="center", fontsize=10, color="#333")

    openings = {}
    for o in plan.get("openings", []):
        openings.setdefault(o["wall"], []).append(o)
    for w in plan.get("walls", []):
        origin, d, n, length = wall_frame(w)
        half = float(w["thickness"]) / 2
        cursor = 0.0
        cuts = sorted(openings.get(w["id"], []), key=lambda o: o["offset"])
        spans = []
        for o in cuts:
            spans.append((cursor, float(o["offset"])))
            cursor = float(o["offset"]) + float(o["width"])
        spans.append((cursor, length))
        for u0, u1 in spans:
            if u1 - u0 < 1:
                continue
            quad = [
                (origin[0] + d[0] * u + n[0] * v, origin[1] + d[1] * u + n[1] * v)
                for u, v in ((u0, -half), (u1, -half), (u1, half), (u0, half))
            ]
            ax.add_patch(Polygon(quad, closed=True, facecolor="#2b2b2b", edgecolor="none"))
        for o in cuts:
            a = float(o["offset"])
            b = a + float(o["width"])
            p0 = (origin[0] + d[0] * a, origin[1] + d[1] * a)
            p1 = (origin[0] + d[0] * b, origin[1] + d[1] * b)
            if o["type"] == "window":
                for v in (-half / 2, 0, half / 2):
                    ax.plot([p0[0] + n[0] * v, p1[0] + n[0] * v], [p0[1] + n[1] * v, p1[1] + n[1] * v], color="#3a7bd5", lw=0.8)
            elif o["type"] == "door":
                ax.plot([p0[0], p1[0]], [p0[1], p1[1]], color="#c27c2c", lw=1.2)

    for i, mark in enumerate(marks or []):
        x, y = mark["xy"]
        ax.scatter([x], [y], s=260, facecolors="none", edgecolors="#e8341c", linewidths=2, zorder=5)
        ax.annotate(f"{i + 1}", (x, y), xytext=(8, 8), textcoords="offset points", color="#e8341c", fontsize=11, fontweight="bold", zorder=6)

    ax.set_xlim(-500, width + 500)
    ax.set_ylim(-500, depth + 500)
    ax.set_aspect("equal")
    ax.axis("off")
    if title:
        ax.set_title(title, fontsize=13)
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(out_path, dpi=150, bbox_inches="tight", facecolor="white")
    plt.close(fig)
    return str(out_path)
