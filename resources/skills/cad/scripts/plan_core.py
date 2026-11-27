#!/usr/bin/env python3
"""平面图 → plan.json 的纯几何核心（不依赖 ezdxf，便于单独测试）。

输入是已经离散好的图元记录（与 cad_core.iter_geometry 的产出同形：layer / type / points / closed，
ARC 额外带 center / radius 更好但不是必须）和文字记录（text / anchor / height / layer），
输出 plan.json 结构：墙体中心线 + 厚度、挂在墙上的门窗洞口、房间轮廓与面积，以及一组自检结果。

只记录能从图上直接复现的几何证据；推断出来的部分（房间矩形、无门扇的过道洞口、默认的层高 / 窗台高）
都会写进 assumptions，交给用户确认，不静默当成事实。
"""
import math
import re

SCHEMA = "design-agent/plan@1"

DEFAULTS = {
    "storey_height": 2800.0,
    "door_height": 2100.0,
    "window_sill": 900.0,
    "window_head": 2400.0,
    "passage_height": 2100.0,
    "min_wall_thickness": 50.0,
    "max_wall_thickness": 600.0,
    "max_passage_width": 2400.0,
    "tolerance": 3.0,
}

AREA_RE = re.compile(r"([0-9]+(?:\.[0-9]+)?)\s*(?:㎡|m2|m²|平方米|平米|平)", re.I)
NUMERIC_RE = re.compile(r"^[\s0-9.,，xX×*+\-_/()（）㎡m²平方米]*$")


# ---------------------------------------------------------------------------
# 基础几何
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


def polygon_area(points):
    return abs(sum(points[i - 1][0] * points[i][1] - points[i][0] * points[i - 1][1] for i in range(len(points)))) / 2


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


# ---------------------------------------------------------------------------
# 墙体：成对平行线 → 墙段
# ---------------------------------------------------------------------------


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


def pair_wall_lines(lines, cfg):
    """为每条墙线在两侧各找最近的平行线；双方互为最近时成对，重叠区间即一段墙。"""
    tmin, tmax, tol = cfg["min_wall_thickness"], cfg["max_wall_thickness"], cfg["tolerance"]
    candidates = {}
    for i, li in enumerate(lines):
        for j in range(i + 1, len(lines)):
            lj = lines[j]
            if not same_direction(li.d, lj.d):
                continue
            gap = lj.offset - li.offset * dot(li.n, lj.n)
            dist = abs(gap)
            if dist < tmin - tol or dist > tmax + tol:
                continue
            lo, hi = max(li.t0, lj.t0), min(li.t1, lj.t1)
            overlap = hi - lo
            # 重叠段必须比厚度长：矩形墙块的两条短边（端头）不会被当成一段横墙
            if overlap < max(dist, 100.0) - tol:
                continue
            candidates.setdefault(i, []).append((j, dist, 1 if gap > 0 else -1))
            candidates.setdefault(j, []).append((i, dist, -1 if gap > 0 else 1))

    def nearest(i, side):
        options = [c for c in candidates.get(i, []) if c[2] == side]
        if not options:
            return set(), None
        best = min(c[1] for c in options)
        return {c[0] for c in options if c[1] <= best + tol}, best

    pieces = []
    seen = set()
    for i, li in enumerate(lines):
        for side in (1, -1):
            partners, _ = nearest(i, side)
            for j in partners:
                key = (min(i, j), max(i, j))
                if key in seen:
                    continue
                back, _ = nearest(j, -side)
                if i not in back:
                    continue
                seen.add(key)
                lj = lines[j]
                lo, hi = max(li.t0, lj.t0), min(li.t1, lj.t1)
                off_i = li.offset
                off_j = lj.offset * dot(li.n, lj.n)
                center_off = (off_i + off_j) / 2
                pieces.append(
                    {
                        "d": li.d,
                        "n": li.n,
                        "offset": center_off,
                        "t0": lo,
                        "t1": hi,
                        "thickness": abs(off_j - off_i),
                    }
                )
    return pieces


def piece_point(piece, t):
    return add(mul(piece["d"], t), mul(piece["n"], piece["offset"]))


def dedupe_pieces(pieces, cfg):
    """同一条中心线、同厚度且区间相交或相接的墙段合并成一段。"""
    tol = cfg["tolerance"]
    groups = []
    for p in sorted(pieces, key=lambda q: (round(q["d"][0], 4), round(q["d"][1], 4), round(q["offset"], 0), q["t0"])):
        for g in groups:
            if (
                same_direction(g["d"], p["d"])
                and abs(g["offset"] - p["offset"] * dot(g["n"], p["n"])) <= tol
                and abs(g["thickness"] - p["thickness"]) <= tol
                and p["t0"] <= g["t1"] + tol
                and p["t1"] >= g["t0"] - tol
            ):
                g["t0"], g["t1"] = min(g["t0"], p["t0"]), max(g["t1"], p["t1"])
                break
        else:
            groups.append(dict(p))
    return groups


# ---------------------------------------------------------------------------
# 门窗：按连通关系分组，投影到所在的墙上
# ---------------------------------------------------------------------------


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


def place_swing_door(arc, pieces, cfg):
    """平开门：铰点必须在某段墙的墙厚范围内；门弧两端中落在同一墙厚内的那一端是关门位置，
    沿墙方向从铰点到关门位置就是门洞。"""
    tol = cfg["tolerance"]
    best = None
    for idx, p in enumerate(pieces):
        h = arc["center"]
        if not in_strip(h, p, tol) or not within_extent(h, p, arc["radius"] + p["thickness"]):
            continue
        for end in arc["ends"]:
            if not in_strip(end, p, tol):
                continue
            # 关门位置应在铰点沿墙方向上，而不是垂直于墙
            along = abs(dot(sub(end, h), p["d"]))
            if along < arc["radius"] * 0.8:
                continue
            dist = abs(dot(end, p["n"]) - p["offset"]) + abs(dot(h, p["n"]) - p["offset"])
            if best is None or dist < best[0]:
                th, te = dot(h, p["d"]), dot(end, p["d"])
                best = (dist, idx, (min(th, te), max(th, te)))
    return best


def opening_candidates(groups, kind, pieces, cfg):
    """把一组门 / 窗图元落到最合适的墙段所在的中心线上，得到沿墙方向的区间。"""
    tol = cfg["tolerance"]
    out = []
    for g in groups:
        arcs = [a for a in (arc_info(rec) for rec in g["records"] if rec.get("type") == "ARC") if a]
        placed = False
        for arc in arcs:
            hit = place_swing_door(arc, pieces, cfg)
            if hit:
                _, idx, span = hit
                out.append({"kind": kind, "piece": idx, "t0": span[0], "t1": span[1], "has_arc": True, "bbox": g["bbox"]})
                placed = True
        if placed:
            continue
        points = [p for rec in g["records"] for p in rec["points"]]
        best = None
        for idx, p in enumerate(pieces):
            # 窗线、推拉门扇这类图元画在墙厚范围内，取落在墙厚内的那部分沿墙方向的投影
            inside = [q for q in points if in_strip(q, p, tol)]
            if not inside:
                continue
            ts_in = [dot(q, p["d"]) for q in inside]
            span = (min(ts_in), max(ts_in))
            if span[1] - span[0] < 200:
                continue
            # 洞口要与这段墙重叠或首尾相接（墙线在洞口处断开时，窗正好填在两段墙之间）
            if span[0] > p["t1"] + tol or span[1] < p["t0"] - tol:
                continue
            score = len(inside) / len(points)
            if best is None or score > best[0]:
                best = (score, idx, span)
        if best is None:
            out.append({"kind": kind, "unplaced": True, "bbox": g["bbox"], "has_arc": bool(arcs)})
            continue
        _, idx, span = best
        out.append({"kind": kind, "piece": idx, "t0": span[0], "t1": span[1], "has_arc": False, "bbox": g["bbox"]})
    return out


def merge_overlapping_openings(openings):
    """同一墙上、同类型且区间大部分重叠的洞口合并（窗通常画成三四条平行线，会被分成几组）。"""
    merged = []
    for o in sorted(openings, key=lambda o: (o["kind"], o["t0"])):
        for m in merged:
            if m["kind"] != o["kind"]:
                continue
            ov = min(m["t1"], o["t1"]) - max(m["t0"], o["t0"])
            if ov >= 0.5 * min(m["t1"] - m["t0"], o["t1"] - o["t0"]):
                m["t0"], m["t1"] = min(m["t0"], o["t0"]), max(m["t1"], o["t1"])
                m["has_arc"] = m.get("has_arc") or o.get("has_arc")
                break
        else:
            merged.append(dict(o))
    return merged


def piece_footprint_hits(piece, t0, t1, others, cfg):
    """[t0, t1] 这段中心线是否被另一段不平行的墙穿过（T 形 / 十字交接）。"""
    tol = cfg["tolerance"]
    for o in others:
        if same_direction(o["d"], piece["d"]):
            continue
        # 另一段墙的中心线与本墙中心线的交点
        denom = cross(piece["d"], o["d"])
        if abs(denom) < 1e-9:
            continue
        p0 = piece_point(piece, 0)
        o0 = piece_point(o, 0)
        s = cross(sub(o0, p0), o["d"]) / denom
        u = dot(add(p0, mul(piece["d"], s)), o["d"])
        if t0 - tol <= s <= t1 + tol and o["t0"] - piece["thickness"] / 2 - tol <= u <= o["t1"] + piece["thickness"] / 2 + tol:
            return True
    return False


def merge_collinear(pieces, openings, cfg):
    """同线同厚的墙段之间的缺口：有门窗 → 合并并挂洞口；被交叉墙占住 → 直接合并；
    空缺口且不超过最大过道宽 → 合并并记为推断的过道洞口；否则保持为两段墙。"""
    tol = cfg["tolerance"]
    by_line = []
    for idx, p in enumerate(pieces):
        for line in by_line:
            q = pieces[line[0]]
            if same_direction(q["d"], p["d"]) and abs(q["offset"] - p["offset"] * dot(q["n"], p["n"])) <= tol and abs(q["thickness"] - p["thickness"]) <= tol:
                line.append(idx)
                break
        else:
            by_line.append([idx])

    walls = []
    dropped = []
    placed = [o for o in openings if not o.get("unplaced")]
    for line in by_line:
        segs = sorted(line, key=lambda i: pieces[i]["t0"])
        base = pieces[segs[0]]
        line_openings = [o for o in placed if o["piece"] in line]
        current = {"base": base, "t0": base["t0"], "t1": base["t1"], "openings": [], "thickness": base["thickness"]}
        for i in segs[1:]:
            p = pieces[i]
            gap0, gap1 = current["t1"], p["t0"]
            gap = gap1 - gap0
            if gap <= tol:
                current["t1"] = max(current["t1"], p["t1"])
                continue
            covering = [o for o in line_openings if o["t0"] <= gap1 + tol and o["t1"] >= gap0 - tol]
            crossing = piece_footprint_hits(base, gap0, gap1, [pieces[k] for k in range(len(pieces)) if k not in line], cfg)
            if covering or crossing or gap <= cfg["max_passage_width"] + tol:
                if not covering and not crossing:
                    current["openings"].append({"kind": "passage", "t0": gap0, "t1": gap1, "inferred": True})
                current["t1"] = max(current["t1"], p["t1"])
            else:
                walls.append(current)
                current = {"base": base, "t0": p["t0"], "t1": p["t1"], "openings": [], "thickness": base["thickness"]}
        walls.append(current)
        line_walls = [w for w in walls if w["base"] is base]
        for o in line_openings:
            # 洞口归到与它重叠最多的墙段；超出墙段的部分截掉（不再为洞口去延长墙）
            target = max(line_walls, key=lambda w: min(w["t1"], o["t1"]) - max(w["t0"], o["t0"]))
            if min(target["t1"], o["t1"]) - max(target["t0"], o["t0"]) <= 0:
                # 门洞开在墙尽端与另一面墙之间（墙线到洞口就停了）：把这段墙延长到盖住洞口，洞口上方补过梁
                adjacent = [w for w in line_walls if abs(w["t1"] - o["t0"]) <= tol or abs(w["t0"] - o["t1"]) <= tol]
                if not adjacent:
                    dropped.append(o)
                    continue
                target = adjacent[0]
                target["t0"], target["t1"] = min(target["t0"], o["t0"]), max(target["t1"], o["t1"])
            clipped = dict(o, t0=max(o["t0"], target["t0"]), t1=min(o["t1"], target["t1"]))
            target["openings"].append(clipped)
    for w in walls:
        real = merge_overlapping_openings([o for o in w["openings"] if o["kind"] != "passage"])
        # 推断的过道如果和真实门窗重叠，以门窗为准
        passages = [o for o in w["openings"] if o["kind"] == "passage" and not any(min(o["t1"], q["t1"]) - max(o["t0"], q["t0"]) > 0 for q in real)]
        w["openings"] = real + passages
    for o in dropped:
        o["unplaced"] = True
    return walls


def extend_wall_ends(walls, cfg):
    """墙端与另一段墙相交时补齐交接：L 形转角延伸到对方外皮，T 形交接延伸到对方中心线。"""
    tol = cfg["tolerance"]
    for w in walls:
        base = w["base"]
        for end in ("t0", "t1"):
            t_end = w[end]
            p_end = piece_point(base, t_end)
            best = None
            for o in walls:
                if o is w or same_direction(o["base"]["d"], base["d"]):
                    continue
                ob = o["base"]
                denom = cross(base["d"], ob["d"])
                p0 = piece_point(base, 0)
                o0 = piece_point(ob, 0)
                s = cross(sub(o0, p0), ob["d"]) / denom
                reach = abs(s - t_end)
                if reach > o["thickness"] / 2 + tol:
                    continue
                inter = add(p0, mul(base["d"], s))
                u = dot(inter, ob["d"])
                if not (o["t0"] - w["thickness"] / 2 - tol <= u <= o["t1"] + w["thickness"] / 2 + tol):
                    continue
                at_other_end = min(abs(u - o["t0"]), abs(u - o["t1"])) <= w["thickness"] / 2 + tol
                outward = 1 if end == "t1" else -1
                target = s + (outward * o["thickness"] / 2 if at_other_end else 0)
                if best is None or reach < best[0]:
                    best = (reach, target)
            if best is not None:
                new_t = best[1]
                if end == "t0":
                    w["t0"] = min(w["t0"], new_t)
                else:
                    w["t1"] = max(w["t1"], new_t)
    return walls


# ---------------------------------------------------------------------------
# 房间
# ---------------------------------------------------------------------------


def parse_area_text(text):
    m = AREA_RE.search(text or "")
    return float(m.group(1)) if m else None


def is_label(text):
    t = (text or "").strip()
    return bool(t) and not NUMERIC_RE.match(t) and len(t) <= 20


def rooms_from_polygons(polys, texts):
    rooms = []
    for poly in polys:
        pts = poly["points"]
        inside = [t for t in texts if point_in_polygon(t["anchor"], pts)]
        labels = sorted((t for t in inside if is_label(t["text"])), key=lambda t: -float(t.get("height") or 0))
        area_texts = [parse_area_text(t["text"]) for t in inside]
        area_texts = [a for a in area_texts if a is not None]
        rooms.append(
            {
                "name": labels[0]["text"].strip() if labels else None,
                "polygon": pts,
                "label_area_m2": area_texts[0] if area_texts else None,
                "source": "polyline",
            }
        )
    return rooms


def rooms_from_labels(texts, walls, cfg):
    """图上没有房间轮廓时：从房间名文字向四个方向找最近的墙内皮，得到一个矩形（仅适用于正交户型）。"""
    rooms = []
    axis = [w for w in walls if abs(w["base"]["d"][0]) > 0.999 or abs(w["base"]["d"][1]) > 0.999]
    for t in texts:
        if not is_label(t["text"]):
            continue
        x, y = t["anchor"]
        bounds = {"left": None, "right": None, "down": None, "up": None}
        for w in axis:
            b = w["base"]
            half = w["thickness"] / 2
            p0, p1 = piece_point(b, w["t0"]), piece_point(b, w["t1"])
            if abs(b["d"][0]) > 0.999:  # 水平墙
                wy = p0[1]
                if min(p0[0], p1[0]) <= x <= max(p0[0], p1[0]):
                    if wy > y and (bounds["up"] is None or wy - half < bounds["up"]):
                        bounds["up"] = wy - half
                    if wy < y and (bounds["down"] is None or wy + half > bounds["down"]):
                        bounds["down"] = wy + half
            else:  # 竖直墙
                wx = p0[0]
                if min(p0[1], p1[1]) <= y <= max(p0[1], p1[1]):
                    if wx > x and (bounds["right"] is None or wx - half < bounds["right"]):
                        bounds["right"] = wx - half
                    if wx < x and (bounds["left"] is None or wx + half > bounds["left"]):
                        bounds["left"] = wx + half
        if None in bounds.values():
            continue
        poly = [(bounds["left"], bounds["down"]), (bounds["right"], bounds["down"]), (bounds["right"], bounds["up"]), (bounds["left"], bounds["up"])]
        near = [parse_area_text(o["text"]) for o in texts if point_in_polygon(o["anchor"], poly)]
        near = [a for a in near if a is not None]
        rooms.append({"name": t["text"].strip(), "polygon": poly, "label_area_m2": near[0] if near else None, "source": "inferred-rect"})
    return rooms


# ---------------------------------------------------------------------------
# 组装 plan.json
# ---------------------------------------------------------------------------


def build_plan(records_by_role, texts, *, source=None, options=None):
    """records_by_role: {"wall": [...], "door": [...], "window": [...], "room": [...]}；texts: 房间名 / 面积文字。"""
    cfg = dict(DEFAULTS)
    cfg.update({k: v for k, v in (options or {}).items() if v is not None})
    tol = cfg["tolerance"]
    warnings = []
    assumptions = []

    lines = [Line(a, b) for rec in records_by_role.get("wall", []) for a, b in segments_of(rec)]
    if not lines:
        raise ValueError("墙体图层上没有可用的线段")
    pieces = dedupe_pieces(pair_wall_lines(lines, cfg), cfg)
    if not pieces:
        raise ValueError("没有找到成对的平行墙线（墙厚范围 %s–%s）" % (cfg["min_wall_thickness"], cfg["max_wall_thickness"]))

    pad = 10.0
    door_groups = group_records(records_by_role.get("door", []), pad)
    window_groups = group_records(records_by_role.get("window", []), pad)
    openings = opening_candidates(door_groups, "door", pieces, cfg) + opening_candidates(window_groups, "window", pieces, cfg)
    unplaced = [o for o in openings if o.get("unplaced")]
    for o in unplaced:
        warnings.append("有一组%s图元没有落在任何墙厚范围内，已忽略（包围盒 %s）" % ("门" if o["kind"] == "door" else "窗", [r(v) for v in o["bbox"]]))

    walls = extend_wall_ends(merge_collinear(pieces, openings, cfg), cfg)
    for o in openings:
        if o.get("unplaced") and o not in unplaced:
            warnings.append("有一个%s与所在墙段不相接，已忽略（包围盒 %s）" % ("门" if o["kind"] == "door" else "窗", [r(v) for v in o["bbox"]]))

    # 坐标平移：以墙体外包框左下角为原点，原图坐标偏移记在 source.origin_offset
    all_pts = []
    for w in walls:
        half = mul(w["base"]["n"], w["thickness"] / 2)
        for t in (w["t0"], w["t1"]):
            c = piece_point(w["base"], t)
            all_pts += [add(c, half), sub(c, half)]
    ox, oy = min(p[0] for p in all_pts), min(p[1] for p in all_pts)

    def tr(p):
        return (p[0] - ox, p[1] - oy)

    storey = cfg["storey_height"]
    out_walls, out_openings = [], []
    counters = {"door": 0, "window": 0, "passage": 0}
    for wi, w in enumerate(sorted(walls, key=lambda w: (-w["thickness"], w["t0"]))):
        wid = "W%d" % (wi + 1)
        start, end = tr(piece_point(w["base"], w["t0"])), tr(piece_point(w["base"], w["t1"]))
        length = w["t1"] - w["t0"]
        out_walls.append({"id": wid, "start": rp(start), "end": rp(end), "thickness": r(w["thickness"]), "height": r(storey), "length": r(length)})
        for o in sorted(w["openings"], key=lambda o: o["t0"]):
            kind = o["kind"]
            counters[kind] += 1
            prefix = {"door": "D", "window": "C", "passage": "P"}[kind]
            off0 = max(0.0, o["t0"] - w["t0"])
            off1 = min(length, o["t1"] - w["t0"])
            item = {"id": "%s%d" % (prefix, counters[kind]), "type": kind, "wall": wid, "offset": r(off0), "width": r(off1 - off0)}
            if kind == "window":
                item.update({"sill": r(cfg["window_sill"]), "height": r(cfg["window_head"] - cfg["window_sill"])})
            elif kind == "door":
                item.update({"sill": 0, "height": r(cfg["door_height"]), "style": "swing" if o.get("has_arc") else "sliding"})
            else:
                item.update({"sill": 0, "height": r(cfg["passage_height"]), "inferred": True})
            out_openings.append(item)

    # 房间
    polys = [rec for rec in records_by_role.get("room", []) if rec.get("closed") and len(rec["points"]) >= 3 and polygon_area(rec["points"]) > 1e5]
    rooms = rooms_from_polygons(polys, texts) if polys else rooms_from_labels(texts, walls, cfg)
    if not polys and rooms:
        assumptions.append("图上没有房间轮廓线，房间是从房间名文字向四周找最近墙内皮推断出的矩形（只适用于正交户型），请核对。")
    if not rooms:
        warnings.append("没有识别到房间：既没有闭合的房间轮廓线，也没能从房间名推断出矩形。可以在 plan.json 里手动补 rooms。")
    out_rooms = []
    for ri, room in enumerate(rooms):
        poly = [tr(p) for p in room["polygon"]]
        area = polygon_area(poly) / 1e6
        item = {"id": "R%d" % (ri + 1), "name": room["name"] or "房间%d" % (ri + 1), "polygon": [rp(p) for p in poly], "area_m2": round(area, 2), "source": room["source"]}
        if room["label_area_m2"] is not None:
            item["label_area_m2"] = room["label_area_m2"]
        if not room["name"]:
            warnings.append("房间 %s 内没有找到房间名文字" % item["id"])
        out_rooms.append(item)

    # 自检
    checks = []
    for room in out_rooms:
        if "label_area_m2" in room:
            diff = abs(room["area_m2"] - room["label_area_m2"])
            ok = diff <= max(0.05, room["label_area_m2"] * 0.02)
            checks.append({"check": "room_area_vs_label", "target": room["id"], "ok": ok, "detail": "%s：轮廓 %.2f㎡ / 图上标注 %.2f㎡" % (room["name"], room["area_m2"], room["label_area_m2"])})
    wall_ids = {w["id"]: w for w in out_walls}
    for o in out_openings:
        w = wall_ids[o["wall"]]
        ok = 0 <= o["offset"] and o["offset"] + o["width"] <= w["length"] + tol and o["sill"] + o["height"] <= w["height"] + tol
        checks.append({"check": "opening_within_wall", "target": o["id"], "ok": ok, "detail": "%s 在 %s 上：%s–%s / 墙长 %s" % (o["id"], o["wall"], o["offset"], r(o["offset"] + o["width"]), w["length"])})
    inferred = [o["id"] for o in out_openings if o.get("inferred")]
    if inferred:
        assumptions.append("以下洞口是墙线断开但没有门窗图元的缺口，按无门扇过道处理（高 %s）：%s" % (r(cfg["passage_height"]), "、".join(inferred)))
    assumptions.append("层高 %s、门高 %s、窗台 %s、窗顶 %s 为默认值（图上没有这些信息），请按实际修改 plan.json。" % (r(storey), r(cfg["door_height"]), r(cfg["window_sill"]), r(cfg["window_head"])))

    width = max(p[0] for p in all_pts) - ox
    depth = max(p[1] for p in all_pts) - oy
    return {
        "schema": SCHEMA,
        "units": "mm",
        "source": dict(source or {}, origin_offset=rp((ox, oy))),
        "storey": {"height": r(storey)},
        "bounds": {"width": r(width), "depth": r(depth)},
        "walls": out_walls,
        "openings": out_openings,
        "rooms": out_rooms,
        "summary": {
            "walls": len(out_walls),
            "doors": counters["door"],
            "windows": counters["window"],
            "passages": counters["passage"],
            "rooms": len(out_rooms),
            "room_area_m2": round(sum(x["area_m2"] for x in out_rooms), 2),
        },
        "checks": checks,
        "assumptions": assumptions,
        "warnings": warnings,
    }


# ---------------------------------------------------------------------------
# plan.json 校验（plan_extract 写出前、建模后核对都用这一份）
# ---------------------------------------------------------------------------


def validate_plan(plan):
    """返回问题列表；为空表示结构完整、洞口都落在墙内、房间面积为正。"""
    problems = []
    if plan.get("schema") != SCHEMA:
        problems.append("schema 不是 %s" % SCHEMA)
    walls = {w.get("id"): w for w in plan.get("walls", [])}
    if not walls:
        problems.append("没有墙体")
    for w in walls.values():
        if float(w.get("thickness", 0)) <= 0 or float(w.get("height", 0)) <= 0:
            problems.append("墙 %s 的厚度或高度不是正数" % w.get("id"))
        length = math.dist(w["start"], w["end"])
        if length <= 0:
            problems.append("墙 %s 长度为 0" % w.get("id"))
    for o in plan.get("openings", []):
        w = walls.get(o.get("wall"))
        if not w:
            problems.append("洞口 %s 挂在不存在的墙 %s 上" % (o.get("id"), o.get("wall")))
            continue
        length = math.dist(w["start"], w["end"])
        if o["offset"] < -1 or o["offset"] + o["width"] > length + 1:
            problems.append("洞口 %s 超出墙 %s 的长度" % (o.get("id"), w.get("id")))
        if o.get("sill", 0) + o.get("height", 0) > float(w.get("height", 0)) + 1:
            problems.append("洞口 %s 高于墙 %s" % (o.get("id"), w.get("id")))
    for room in plan.get("rooms", []):
        if len(room.get("polygon", [])) < 3 or polygon_area(room["polygon"]) <= 0:
            problems.append("房间 %s 的轮廓无效" % room.get("id"))
    return problems
