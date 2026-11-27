#!/usr/bin/env python3
"""plan.json 的共用几何工具：洞口落在哪个房间、房间分类、外墙判定、平面示意图绘制。

plan_quantity.py（工程量与报价）、plan_codecheck.py（规范审图）、report-pack 的汇报包都用它，
保证各处对“哪个门属于哪个房间”“哪些是湿区”的判断一致。

本模块不 import 任何兄弟模块，是这一组脚本的最底层，同时也放最基础的几何原语：
向量运算、线段、包围盒、多边形裁剪、文字取点。plan_axis / plan_column / plan_wall /
plan_opening / plan_room / plan_core 都从这里取，不要在别处再写一份。
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


# ---------------------------------------------------------------------------
# 基础几何：向量、线段、包围盒、裁剪、文字取点
# ---------------------------------------------------------------------------

def sub(a, b):
    return (a[0] - b[0], a[1] - b[1])


def add(a, b):
    return (a[0] + b[0], a[1] + b[1])


def mul(a, k):
    return (a[0] * k, a[1] * k)


def dot(a, b):
    return a[0] * b[0] + a[1] * b[1]


def cross(a, b):
    return a[0] * b[1] - a[1] * b[0]


def norm(a):
    return math.hypot(a[0], a[1])


def unit(a):
    n = norm(a)
    return (a[0] / n, a[1] / n) if n > 1e-12 else (1.0, 0.0)


def canonical_direction(d):
    """把方向归一到半平面（角度 ∈ [0, 180)），平行但反向的线段得到同一方向。"""
    d = unit(d)
    if d[0] < -1e-9 or (abs(d[0]) <= 1e-9 and d[1] < 0):
        d = (-d[0], -d[1])
    return d


def r(value, digits=1):
    value = round(float(value), digits)
    return int(value) if float(value).is_integer() else value


def rp(p, digits=1):
    return [r(p[0], digits), r(p[1], digits)]


def segments_of(record):
    pts = record["points"]
    segs = [(pts[i], pts[i + 1]) for i in range(len(pts) - 1)]
    if record.get("closed") and len(pts) > 2:
        segs.append((pts[-1], pts[0]))
    return [s for s in segs if norm(sub(s[1], s[0])) > 1e-6]


class Line:
    __slots__ = ("a", "b", "d", "n", "offset", "t0", "t1")

    def __init__(self, a, b):
        self.a, self.b = a, b
        self.d = canonical_direction(sub(b, a))
        self.n = (-self.d[1], self.d[0])
        self.offset = dot(a, self.n)
        ta, tb = dot(a, self.d), dot(b, self.d)
        self.t0, self.t1 = min(ta, tb), max(ta, tb)


def same_direction(d1, d2, angle_tol_deg=0.5):
    return abs(cross(d1, d2)) <= math.sin(math.radians(angle_tol_deg))


def clip_polygon_to_box(polygon, box):
    """Sutherland-Hodgman：多边形与轴对齐矩形的交（房间被柱子占掉的那一块）。"""
    out = list(polygon)
    for axis, value, keep_greater in ((0, box[0], True), (0, box[2], False), (1, box[1], True), (1, box[3], False)):
        if not out:
            break
        inside = (lambda p: p[axis] >= value - 1e-9) if keep_greater else (lambda p: p[axis] <= value + 1e-9)
        clipped = []
        for k, cur in enumerate(out):
            prev = out[k - 1]
            if inside(cur):
                if not inside(prev):
                    clipped.append(_cross_at(prev, cur, axis, value))
                clipped.append(cur)
            elif inside(prev):
                clipped.append(_cross_at(prev, cur, axis, value))
        out = clipped
    return out


def _cross_at(a, b, axis, value):
    t = (value - a[axis]) / (b[axis] - a[axis])
    return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)


def _on_boundary(point, polygon, tol=1.0):
    for k, a in enumerate(polygon):
        b = polygon[(k + 1) % len(polygon)]
        length = math.dist(a, b)
        if length < 1e-9:
            continue
        rel = (point[0] - a[0], point[1] - a[1])
        d = ((b[0] - a[0]) / length, (b[1] - a[1]) / length)
        along = rel[0] * d[0] + rel[1] * d[1]
        if -tol <= along <= length + tol and abs(rel[0] * d[1] - rel[1] * d[0]) <= tol:
            return True
    return False


def bbox_of(points):
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    return (min(xs), min(ys), max(xs), max(ys))


def boxes_touch(a, b, pad):
    return not (a[2] + pad < b[0] or b[2] + pad < a[0] or a[3] + pad < b[1] or b[3] + pad < a[1])


def group_records(records, pad):
    groups = []
    for rec in records:
        box = bbox_of(rec["points"])
        hit = [g for g in groups if boxes_touch(g["bbox"], box, pad)]
        merged = {"records": [rec], "bbox": box}
        for g in hit:
            groups.remove(g)
            merged["records"].extend(g["records"])
            b = g["bbox"]
            merged["bbox"] = (min(merged["bbox"][0], b[0]), min(merged["bbox"][1], b[1]), max(merged["bbox"][2], b[2]), max(merged["bbox"][3], b[3]))
        groups.append(merged)
    return groups


def circle_from_points(a, b, c):
    """三点定圆；共线时返回 None。用于从离散后的门弧点列反求铰点与门宽。"""
    d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]))
    if abs(d) < 1e-9:
        return None
    ux = ((a[0] ** 2 + a[1] ** 2) * (b[1] - c[1]) + (b[0] ** 2 + b[1] ** 2) * (c[1] - a[1]) + (c[0] ** 2 + c[1] ** 2) * (a[1] - b[1])) / d
    uy = ((a[0] ** 2 + a[1] ** 2) * (c[0] - b[0]) + (b[0] ** 2 + b[1] ** 2) * (a[0] - c[0]) + (c[0] ** 2 + c[1] ** 2) * (b[0] - a[0])) / d
    center = (ux, uy)
    return center, norm(sub(a, center))


def arc_info(rec):
    """门弧的圆心（铰点）、半径（门宽）和两个端点。"""
    pts = rec["points"]
    if rec.get("center") is not None and rec.get("radius"):
        center, radius = tuple(rec["center"]), float(rec["radius"])
    else:
        if len(pts) < 3:
            return None
        fit = circle_from_points(pts[0], pts[len(pts) // 2], pts[-1])
        if fit is None:
            return None
        center, radius = fit
    return {"center": center, "radius": radius, "ends": (pts[0], pts[-1])}


def in_strip(q, piece, tol):
    return abs(dot(q, piece["n"]) - piece["offset"]) <= piece["thickness"] / 2 + tol


def within_extent(q, piece, margin):
    t = dot(q, piece["d"])
    return piece["t0"] - margin <= t <= piece["t1"] + margin


def text_point(text):
    """文字的包围盒中心；没有 bbox 时退回插入点。

    anchor 是文字的左下角，贴着墙写的房间名用 anchor 判断会落到墙的另一侧，房间就缩成一条窄缝。
    """
    return tuple(text.get("point") or text["anchor"])
