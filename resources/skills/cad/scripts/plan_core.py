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

# 门窗编号（M0921 = 门 900×2100）是图上写明的名义尺寸。门窗块通常比洞口画小一圈（实测普遍差 1%–3%），
# 实测宽度与编号相差在 CODE_SNAP_TOL 以内时以编号为准；超过 CODE_WIDTH_TOL 就当匹配错了，不用它的宽度。
CODE_WIDTH_TOL = 0.10
CODE_SNAP_TOL = 0.05

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


def column_pieces(pieces, columns, cfg):
    """柱子当作墙段补进它所在的每条墙中心线：墙线到柱边就断开（天正 T3 导出、多数结构图都这样），
    不补的话柱位会被当成过道洞口，挨着柱子的窗也找不到所在的墙。"""
    tol = cfg["tolerance"]
    lines = []
    for p in pieces:
        for line in lines:
            q = line["base"]
            if same_direction(q["d"], p["d"]) and abs(q["offset"] - p["offset"] * dot(q["n"], p["n"])) <= tol and abs(q["thickness"] - p["thickness"]) <= tol:
                line["t0"], line["t1"] = min(line["t0"], p["t0"]), max(line["t1"], p["t1"])
                break
        else:
            lines.append({"base": p, "t0": p["t0"], "t1": p["t1"]})
    extra = []
    for box in columns:
        corners = [(box[0], box[1]), (box[2], box[1]), (box[2], box[3]), (box[0], box[3])]
        size = max(box[2] - box[0], box[3] - box[1])
        for line in lines:
            b = line["base"]
            offs = [dot(c, b["n"]) for c in corners]
            if not (min(offs) - tol <= b["offset"] <= max(offs) + tol):
                continue
            ts = [dot(c, b["d"]) for c in corners]
            c0, c1 = min(ts), max(ts)
            # 柱子要落在这条墙线的范围内或紧挨端头，避免把远处同一条直线上的柱子也算进来
            if c1 < line["t0"] - size - tol or c0 > line["t1"] + size - tol:
                continue
            extra.append(dict(b, t0=c0, t1=c1, column=True))
    return extra


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


DOOR_BLOCK_RE = re.compile(r"door|dor|门|men", re.I)


def opening_candidates(groups, kind, pieces, cfg):
    """把一组门 / 窗图元落到最合适的墙段所在的中心线上，得到沿墙方向的区间。

    门窗画在同一图层时（天正 T3 导出常见），带门弧或块名像门的一组按门处理。
    """
    tol = cfg["tolerance"]
    out = []
    for g in groups:
        arcs = [a for a in (arc_info(rec) for rec in g["records"] if rec.get("type") == "ARC") if a]
        block_says_door = any(DOOR_BLOCK_RE.search(str(rec.get("block") or "")) for rec in g["records"])
        group_kind = "door" if (arcs or block_says_door) and kind == "window" else kind
        hits = [h for h in (place_swing_door(arc, pieces, cfg) for arc in arcs) if h]
        if hits:
            # 双开门的两扇门弧属于同一组：同一墙上相接的门扇合成一樘门
            # 两扇门的铰点可能分别落在墙段和柱段上：按所在墙中心线（而不是具体墙段）归并
            by_piece = {}
            for _, idx, span in hits:
                pc_ = pieces[idx]
                d_ = canonical_direction(pc_["d"])
                key = (round(d_[0], 3), round(d_[1], 3), round(pc_["offset"] * dot(pc_["n"], (-d_[1], d_[0]))), round(pc_["thickness"]))
                entry = by_piece.setdefault(key, {"idx": idx, "spans": []})
                entry["spans"].append(list(span))
            for entry in by_piece.values():
                idx, spans = entry["idx"], entry["spans"]
                spans.sort()
                merged = [spans[0]]
                for a, b in spans[1:]:
                    if a <= merged[-1][1] + max(tol, 60):
                        merged[-1][1] = max(merged[-1][1], b)
                    else:
                        merged.append([a, b])
                for a, b in merged:
                    out.append({"kind": "door", "piece": idx, "t0": a, "t1": b, "has_arc": True, "bbox": g["bbox"]})
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
            # 洞口要与这段墙重叠或首尾相接（墙线在洞口处断开时，窗正好填在两段墙之间）；
            # 窗框常比墙 / 柱边缩进几十到一两百毫米，相接的容差按墙厚放宽
            reach = max(tol, p["thickness"], 150.0)
            if span[0] > p["t1"] + reach or span[1] < p["t0"] - reach:
                continue
            score = len(inside) / len(points)
            if best is None or score > best[0]:
                best = (score, idx, span)
        if best is None:
            out.append({"kind": group_kind, "unplaced": True, "bbox": g["bbox"], "has_arc": bool(arcs)})
            continue
        _, idx, span = best
        out.append({"kind": group_kind, "piece": idx, "t0": span[0], "t1": span[1], "has_arc": False, "bbox": g["bbox"]})
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
        current = {"base": base, "t0": base["t0"], "t1": base["t1"], "openings": [], "thickness": base["thickness"], "end_column": bool(base.get("column"))}
        for i in segs[1:]:
            p = pieces[i]
            gap0, gap1 = current["t1"], p["t0"]
            gap = gap1 - gap0
            if gap <= tol:
                if p["t1"] >= current["t1"]:
                    current["end_column"] = bool(p.get("column"))
                current["t1"] = max(current["t1"], p["t1"])
                continue
            covering = [o for o in line_openings if o["t0"] <= gap1 + tol and o["t1"] >= gap0 - tol]
            crossing = piece_footprint_hits(base, gap0, gap1, [pieces[k] for k in range(len(pieces)) if k not in line], cfg)
            # 两头都是柱子的空缺口（走廊两侧柱子之间、柱距之间）不是过道，就是没有墙
            between_columns = current["end_column"] and bool(p.get("column"))
            if covering or crossing or (gap <= cfg["max_passage_width"] + tol and not between_columns):
                if not covering and not crossing:
                    current["openings"].append({"kind": "passage", "t0": gap0, "t1": gap1, "inferred": True})
                current["t1"] = max(current["t1"], p["t1"])
                current["end_column"] = bool(p.get("column"))
            else:
                walls.append(current)
                current = {"base": base, "t0": p["t0"], "t1": p["t1"], "openings": [], "thickness": base["thickness"], "end_column": bool(p.get("column"))}
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


OPENING_CODE_RE = re.compile(r"^(?P<prefix>[A-Z]{0,3}?(?P<kind>MC|M|C))[甲乙丙]?(?P<w>\d{2})(?P<h>\d{2})[a-z]?$", re.I)


def parse_opening_code(text):
    """门窗编号 → (类型, 宽, 高)：M1021 = 门 1000×2100，C1815 = 窗 1800×1500，FM甲1022 = 防火门。"""
    m = OPENING_CODE_RE.match((text or "").strip())
    if not m:
        return None
    kind = "door" if m.group("kind").upper() in ("M", "MC") else "window"
    return {"code": text.strip(), "kind": kind, "width": int(m.group("w")) * 100, "height": int(m.group("h")) * 100}


def parse_area_text(text):
    m = AREA_RE.search(text or "")
    return float(m.group(1)) if m else None


# 不是房间名的文字：门窗编号（M1021、C1815、FM甲1022、TLM…）、标高（±0.000 / %%P0.000 / -0.450）、
# 楼梯“上/下”、指北针“北”、比例、图名、面积统计等
NON_ROOM_RE = re.compile(
    r"^(?:[A-Z]{0,3}(?:M|C|MC|LC|GC|YC|BYC|HC|DK|TC|ZC)[甲乙丙]?\d{3,5}[a-z]?|"
    r"(?:%%[Pp]|±|[+-])?\d+(?:\.\d+)?m?|"
    r"[上下北东南西]|UP|DN|"
    r"\d+\s*[:：]\s*\d+|"
    r"[A-Z]?\d{0,3}[A-Z]?)$",
    re.I,
)
NON_ROOM_HINT_RE = re.compile(r"平面图|立面图|剖面图|详图|大样|面积|比例|说明|图例|标高|轴线|楼梯\d|^\d+-\d+$")
NON_ROOM_LAYER_RE = re.compile(r"window|door|门窗|axis|轴|dim|标注|尺寸|elev|标高|title|图签|图框", re.I)
HAS_WORD_RE = re.compile(r"[\u4e00-\u9fff]|[A-Za-z]{3,}")


def is_label(text, layer=None):
    t = (text or "").strip()
    if not t or len(t) > 20 or NUMERIC_RE.match(t):
        return False
    if layer and NON_ROOM_LAYER_RE.search(layer):
        return False
    if NON_ROOM_RE.match(t) or NON_ROOM_HINT_RE.search(t):
        return False
    return bool(HAS_WORD_RE.search(t))


def text_point(text):
    """文字的包围盒中心；没有 bbox 时退回插入点。

    anchor 是文字的左下角，贴着墙写的房间名用 anchor 判断会落到墙的另一侧，房间就缩成一条窄缝。
    """
    return tuple(text.get("point") or text["anchor"])


def rooms_from_polygons(polys, texts):
    rooms = []
    for poly in polys:
        pts = poly["points"]
        inside = [t for t in texts if point_in_polygon(text_point(t), pts)]
        labels = sorted((t for t in inside if is_label(t["text"], t.get("layer"))), key=lambda t: -float(t.get("height") or 0))
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


def edge_coverage(bounds, supports):
    """推断矩形的四条边被实际墙体盖住的比例（0–1）。

    从房间名推断的矩形只在四面都被墙围住时才可信；墙只盖住一半的（敞开的大厅、L 形走廊、
    中间隔断没画）说明这个房间不是矩形，面积会偏。
    """
    total = covered = 0.0
    for side, a, b in (("left", "down", "up"), ("right", "down", "up"), ("down", "left", "right"), ("up", "left", "right")):
        lo, hi = bounds[a], bounds[b]
        if hi <= lo:
            continue
        total += hi - lo
        span = supports.get(side)
        if span:
            covered += max(0.0, min(hi, span[1]) - max(lo, span[0]))
    return covered / total if total else 0.0


def rooms_from_rectangles(texts, walls, cfg, regions=None):
    """退路：从房间名文字向四个方向找最近的墙内皮，得到一个矩形（仅适用于正交户型）。

    只在泛洪找不到围合区域时用（敞开的大厅、隔断没画），结果一定标成低置信度。
    """
    rooms = []
    axis = [w for w in walls if abs(w["base"]["d"][0]) > 0.999 or abs(w["base"]["d"][1]) > 0.999]
    for t in texts:
        if not is_label(t["text"], t.get("layer")):
            continue
        x, y = text_point(t)
        bounds = {"left": None, "right": None, "down": None, "up": None}
        supports = {}
        for w in axis:
            b = w["base"]
            half = w["thickness"] / 2
            p0, p1 = piece_point(b, w["t0"]), piece_point(b, w["t1"])
            if abs(b["d"][0]) > 0.999:  # 水平墙
                wy = p0[1]
                span = (min(p0[0], p1[0]), max(p0[0], p1[0]))
                if min(p0[0], p1[0]) <= x <= max(p0[0], p1[0]):
                    if wy > y and (bounds["up"] is None or wy - half < bounds["up"]):
                        bounds["up"], supports["up"] = wy - half, span
                    if wy < y and (bounds["down"] is None or wy + half > bounds["down"]):
                        bounds["down"], supports["down"] = wy + half, span
            else:  # 竖直墙
                wx = p0[0]
                span = (min(p0[1], p1[1]), max(p0[1], p1[1]))
                if min(p0[1], p1[1]) <= y <= max(p0[1], p1[1]):
                    if wx > x and (bounds["right"] is None or wx - half < bounds["right"]):
                        bounds["right"], supports["right"] = wx - half, span
                    if wx < x and (bounds["left"] is None or wx + half > bounds["left"]):
                        bounds["left"], supports["left"] = wx + half, span
        if None in bounds.values():
            continue
        poly = [(bounds["left"], bounds["down"]), (bounds["right"], bounds["down"]), (bounds["right"], bounds["up"]), (bounds["left"], bounds["up"])]
        near = [parse_area_text(o["text"]) for o in texts if point_in_polygon(text_point(o), poly)]
        near = [a for a in near if a is not None]
        key = tuple(round(v) for v in (bounds["left"], bounds["down"], bounds["right"], bounds["up"]))
        same = next((r for r in rooms if r["_key"] == key), None)
        if same:
            # 同一个矩形里有多个名字（如“教室”+“储藏”）：合并名称，不重复计面积
            if t["text"].strip() not in same["name"].split("/"):
                same["name"] = f"{same['name']}/{t['text'].strip()}"
            continue
        rooms.append(
            {
                "name": t["text"].strip(),
                "polygon": poly,
                "label_area_m2": near[0] if near else None,
                "source": "inferred-rect",
                "support": edge_coverage(bounds, supports),
                "seed": (x, y),
                "enclosed": False,
                "_key": key,
            }
        )
    for room in rooms:
        room.pop("_key", None)
    return rooms


CONFIDENCE_LABELS = {"high": "高", "medium": "中", "low": "低"}


def simplify_line(points, tolerance):
    """Douglas-Peucker：把折线拉到容差以内，只保留拐点。"""
    if len(points) < 3:
        return list(points)
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        a, b = stack.pop()
        if b <= a + 1:
            continue
        ax, ay = points[a]
        bx, by = points[b]
        dx, dy = bx - ax, by - ay
        length = math.hypot(dx, dy)
        best, index = -1.0, -1
        for k in range(a + 1, b):
            px, py = points[k]
            if length < 1e-9:
                distance = math.hypot(px - ax, py - ay)
            else:
                distance = abs(dy * (px - ax) - dx * (py - ay)) / length
            if distance > best:
                best, index = distance, k
        if best > tolerance:
            keep[index] = True
            stack.append((a, index))
            stack.append((index, b))
    return [point for point, kept in zip(points, keep) if kept]


def simplify_closed(points, tolerance):
    """闭合折线：从离起点最远的点切开，两段分别简化后接回去。"""
    if len(points) < 5:
        return points
    far = max(range(1, len(points)), key=lambda k: math.dist(points[k], points[0]))
    head = simplify_line(points[: far + 1], tolerance)
    tail = simplify_line(points[far:] + [points[0]], tolerance)
    return head[:-1] + tail[:-1]


class RoomRegions:
    """把墙当障碍做一次栅格连通标记，从房间名位置泛洪得到被墙围住的那一片。

    「四面都有墙」验证不了「这片空间真是一个房间」：窗户、阳台栏杆、飘窗台常画成几条平行长线，
    向四周找最近墙内皮围出来的可能只是条缝。泛洪得到的是真正连通的那一片，轮廓贴合墙体，
    走廊和 L 形空间也能算对 —— 墙线在门窗洞口处是连续的（洞口挂在墙上），不会从门口漏过去。
    """

    def __init__(self, walls, cfg, max_cells=600000):
        self.ok = False
        corners = []
        for wall in walls:
            for t in (wall["t0"], wall["t1"]):
                corners.append(piece_point(wall["base"], t))
        if not corners:
            return
        self.x0 = min(p[0] for p in corners)
        self.y0 = min(p[1] for p in corners)
        width = max(p[0] for p in corners) - self.x0
        height = max(p[1] for p in corners) - self.y0
        if width <= 0 or height <= 0:
            return
        self.cell = max(50.0, math.sqrt(width * height / max_cells))
        self.cols = int(width / self.cell) + 3
        self.rows = int(height / self.cell) + 3
        self.grid = [0] * (self.cols * self.rows)  # 0 未访问，-1 墙，>0 区域编号
        self.areas, self.touches, self.cells = {}, {}, {}
        self._outlines = {}
        self._block(walls)
        self._label()
        self.ok = True

    def _block(self, walls):
        cell, cols, rows, x0, y0 = self.cell, self.cols, self.rows, self.x0, self.y0
        for wall in walls:
            base = wall["base"]
            half = max(wall["thickness"] / 2, cell * 0.5)
            a, c = piece_point(base, wall["t0"]), piece_point(base, wall["t1"])
            i0 = max(0, int((min(a[0], c[0]) - half - x0) / cell))
            i1 = min(cols - 1, int((max(a[0], c[0]) + half - x0) / cell))
            j0 = max(0, int((min(a[1], c[1]) - half - y0) / cell))
            j1 = min(rows - 1, int((max(a[1], c[1]) + half - y0) / cell))
            for j in range(j0, j1 + 1):
                py = y0 + (j + 0.5) * cell
                for i in range(i0, i1 + 1):
                    index = j * cols + i
                    if self.grid[index]:
                        continue
                    px = x0 + (i + 0.5) * cell
                    along = px * base["d"][0] + py * base["d"][1]
                    across = abs(px * base["n"][0] + py * base["n"][1] - base["offset"])
                    if across <= half and wall["t0"] - half <= along <= wall["t1"] + half:
                        self.grid[index] = -1

    def _label(self):
        cols, rows, grid = self.cols, self.rows, self.grid
        label = 0
        for start in range(len(grid)):
            if grid[start]:
                continue
            label += 1
            grid[start] = label
            queue = [start]
            members, edge = [], False
            while queue:
                index = queue.pop()
                members.append(index)
                i, j = index % cols, index // cols
                if i == 0 or j == 0 or i == cols - 1 or j == rows - 1:
                    edge = True
                for step in (1, -1, cols, -cols):
                    if (step == 1 and i == cols - 1) or (step == -1 and i == 0):
                        continue
                    nxt = index + step
                    if 0 <= nxt < len(grid) and not grid[nxt]:
                        grid[nxt] = label
                        queue.append(nxt)
            self.areas[label] = len(members) * self.cell * self.cell
            self.touches[label] = edge
            self.cells[label] = members

    def label_at(self, point):
        if not self.ok:
            return 0
        i = int((point[0] - self.x0) / self.cell)
        j = int((point[1] - self.y0) / self.cell)
        if not (0 <= i < self.cols and 0 <= j < self.rows):
            return 0
        value = self.grid[j * self.cols + i]
        if value > 0:
            return value
        # 名字正好压在墙线上：取周围一圈里最大的那块
        best = 0
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                ni, nj = i + di, j + dj
                if 0 <= ni < self.cols and 0 <= nj < self.rows:
                    candidate = self.grid[nj * self.cols + ni]
                    if candidate > 0 and (best == 0 or self.areas[candidate] > self.areas[best]):
                        best = candidate
        return best

    def probe(self, point):
        """(面积 mm², 是否碰到边界)；点落在墙里时返回 None。"""
        label = self.label_at(point)
        return (self.areas[label], self.touches[label]) if label else None

    def outline(self, point):
        """房间轮廓：沿格子边界描一圈再拉直；同一区域只描一次。"""
        label = self.label_at(point)
        if not label:
            return None
        if label not in self._outlines:
            self._outlines[label] = {
                "polygon": self._trace(self.cells[label]),
                "area": self.areas[label],
                "enclosed": not self.touches[label],
                "key": label,
            }
        return self._outlines[label]

    def _trace(self, members):
        cols, rows, grid = self.cols, self.rows, self.grid
        edges = {}
        for index in members:
            i, j = index % cols, index // cols
            label = grid[index]
            if j == 0 or grid[index - cols] != label:
                edges[(i, j)] = (i + 1, j)
            if i == cols - 1 or grid[index + 1] != label:
                edges[(i + 1, j)] = (i + 1, j + 1)
            if j == rows - 1 or grid[index + cols] != label:
                edges[(i + 1, j + 1)] = (i, j + 1)
            if i == 0 or grid[index - 1] != label:
                edges[(i, j + 1)] = (i, j)
        if not edges:
            return []
        # 区域里可能有独立墙垛（内岛），边界会分成外轮廓和若干个洞；房间只取最大的那个外轮廓
        loops, remaining = [], dict(edges)
        while remaining:
            start = next(iter(remaining))
            loop, cursor = [start], start
            while True:
                cursor = remaining.pop(cursor, None)
                if cursor is None or cursor == start:
                    break
                loop.append(cursor)
            loops.append(loop)
        if not loops:
            return []
        loop = max(loops, key=lambda points: abs(polygon_area(points)))
        points = [(self.x0 + i * self.cell, self.y0 + j * self.cell) for i, j in loop]
        return simplify_closed(points, self.cell * 1.5)


def room_regions(walls, cfg, max_cells=600000):
    regions = RoomRegions(walls, cfg, max_cells)
    return regions if regions.ok else None


def rooms_from_labels(texts, walls, cfg):
    """图上没有房间轮廓时：从房间名泛洪，取被墙围住的那一片作为房间轮廓。

    泛洪找不到围合区域（敞开的大厅、隔断没画）的，退回「向四周找最近墙内皮」的矩形，并标成低置信度。
    """
    regions = room_regions(walls, cfg)
    rooms, by_region = [], {}
    for text in texts:
        if not is_label(text["text"], text.get("layer")):
            continue
        seed = text_point(text)
        region = regions.outline(seed) if regions else None
        if not region or not region["enclosed"] or len(region["polygon"]) < 3:
            continue
        same = by_region.get(region["key"])
        if same:
            # 同一片空间里有多个名字（如“教室”+“储藏”）：合并名称，不重复计面积
            if text["text"].strip() not in same["name"].split("/"):
                same["name"] = f"{same['name']}/{text['text'].strip()}"
            continue
        poly = region["polygon"]
        near = [parse_area_text(other["text"]) for other in texts if point_in_polygon(text_point(other), poly)]
        near = [value for value in near if value is not None]
        room = {
            "name": text["text"].strip(),
            "polygon": poly,
            "label_area_m2": near[0] if near else None,
            "source": "inferred-region",
            "support": 1.0,
            "seed": seed,
            "enclosed": True,
        }
        by_region[region["key"]] = room
        rooms.append(room)

    existing = [room["polygon"] for room in rooms]
    for room in rooms_from_rectangles(texts, walls, cfg, regions):
        if any(point_in_polygon(room["seed"], poly) for poly in existing):
            continue
        rooms.append(room)
    return rooms


def room_confidence(room, area, enclosed=None):
    """房间面积的可信度。

    高：轮廓是图上画出来的闭合多段线，或推断矩形四面都被墙围住、泛洪出的区域与它面积相当，
        或算出的面积与图上标注差 2% 以内。
    中：从房间名推断的矩形，墙体基本围合（70%–95%），或没有图上标注可以对照。
    低：推断矩形没被墙围住（敞开的大厅、L 形走廊、隔断没画）、泛洪区域与矩形差 25% 以上
        （只圈住一条缝，或把邻居吞了），或与图上标注差 10% 以上。
    """
    if room["source"] == "polyline":
        base = "high"
    elif room["source"] == "inferred-region":
        base = "high"
    else:
        support = room.get("support")
        if support is None:
            base = "medium"
        elif support >= 0.95:
            base = "high"
        elif support >= 0.7:
            base = "medium"
        else:
            base = "low"
        if enclosed is False:
            base = "low"
    label = room.get("label_area_m2")
    if label:
        diff = abs(area - label) / label
        if diff <= 0.02:
            return "high"
        if diff > 0.10:
            return "low"
        if base == "high":
            base = "medium"
    return base


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
        raise ValueError(
            "没有找到成对的平行墙线（墙厚范围 %s–%s mm）。这张图可能不是平面图（总平面、详图、立面），"
            "也可能墙体画在别的图层或用了别的画法，可以用 --wall-layer 指定图层再试。" % (r(cfg["min_wall_thickness"]), r(cfg["max_wall_thickness"]))
        )
    columns = [bbox_of(rec["points"]) for rec in records_by_role.get("column", []) if rec.get("closed") and len(rec["points"]) >= 3]
    # 同一根柱子常由外框、填充多条记录组成：按包围盒去重
    columns = list({tuple(round(v) for v in b): b for b in columns}.values())
    if columns:
        pieces = dedupe_pieces(pieces + column_pieces(pieces, columns, cfg), cfg)

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

    # 门窗编号文字：用来校核宽度、补上图上才有的门窗高度
    code_texts = [dict(t, **parse_opening_code(t["text"])) for t in texts if parse_opening_code(t["text"])]

    def match_code(kind, center, width):
        best = None
        for c in code_texts:
            if c["kind"] != kind and not (kind == "door" and c["code"].upper().startswith("MC")):
                continue
            if abs(c["width"] - width) > max(80.0, width * CODE_WIDTH_TOL):
                continue
            dist = math.dist(text_point(c), center)
            if dist > max(2500.0, width):
                continue
            if best is None or dist < best[0]:
                best = (dist, c)
        return best[1] if best else None

    storey = cfg["storey_height"]
    out_walls, out_openings = [], []
    counters = {"door": 0, "window": 0, "passage": 0}
    snapped, mismatched = 0, []
    for wi, w in enumerate(sorted(walls, key=lambda w: (-w["thickness"], w["t0"]))):
        wid = "W%d" % (wi + 1)
        start, end = tr(piece_point(w["base"], w["t0"])), tr(piece_point(w["base"], w["t1"]))
        length = w["t1"] - w["t0"]
        out_walls.append({"id": wid, "start": rp(start), "end": rp(end), "thickness": r(w["thickness"]), "height": r(storey), "length": r(length)})
        for o in sorted(w["openings"], key=lambda o: o["t0"]):
            kind = o["kind"]
            counters[kind] += 1
            prefix = {"door": "D", "window": "C", "passage": "P"}[kind]
            oid = "%s%d" % (prefix, counters[kind])
            off0 = max(0.0, o["t0"] - w["t0"])
            off1 = min(length, o["t1"] - w["t0"])
            width = off1 - off0
            center = piece_point(w["base"], (max(o["t0"], w["t0"]) + min(o["t1"], w["t1"])) / 2)
            code = match_code(kind, center, width) if kind in ("door", "window") else None
            if code:
                nominal = float(code["width"])
                if abs(nominal - width) <= max(50.0, nominal * CODE_SNAP_TOL) and nominal <= length + 1:
                    # 洞口中心不动，宽度改成编号的名义值
                    off0 = min(max(0.0, off0 - (nominal - width) / 2), max(0.0, length - nominal))
                    width = nominal
                    snapped += 1
                elif abs(nominal - width) > max(50.0, nominal * CODE_SNAP_TOL):
                    mismatched.append((oid, width, code["code"], nominal))
            item = {"id": oid, "type": kind, "wall": wid, "offset": r(off0), "width": r(width)}
            if kind == "window":
                height = float(code["height"]) if code else cfg["window_head"] - cfg["window_sill"]
                sill = cfg["window_sill"]
                if sill + height > storey:
                    sill = max(0.0, storey - height - 300)
                item.update({"sill": r(sill), "height": r(height)})
            elif kind == "door":
                height = float(code["height"]) if code else cfg["door_height"]
                item.update({"sill": 0, "height": r(min(height, storey)), "style": "swing" if o.get("has_arc") else "sliding"})
            else:
                item.update({"sill": 0, "height": r(cfg["passage_height"]), "inferred": True})
            if code:
                item["code"] = code["code"]
            out_openings.append(item)

    # 房间
    polys = [rec for rec in records_by_role.get("room", []) if rec.get("closed") and len(rec["points"]) >= 3 and polygon_area(rec["points"]) > 1e5]
    rooms = rooms_from_polygons(polys, texts) if polys else rooms_from_labels(texts, walls, cfg)
    if not polys and rooms:
        assumptions.append("图上没有房间轮廓线，房间是从房间名出发、取被墙围住的那一片泛洪出来的；泛洪没围住的（敞开的大厅、隔断没画）退回「向四周找最近墙内皮」的矩形，并标为低置信度，请核对。")
    if not rooms:
        warnings.append("没有识别到房间：既没有闭合的房间轮廓线，也没能从房间名推断出矩形。可以在 plan.json 里手动补 rooms。")
    out_rooms = []
    for ri, room in enumerate(rooms):
        poly = [tr(p) for p in room["polygon"]]
        area = polygon_area(poly) / 1e6
        item = {
            "id": "R%d" % (ri + 1),
            "name": room["name"] or "房间%d" % (ri + 1),
            "polygon": [rp(p) for p in poly],
            "area_m2": round(area, 2),
            "source": room["source"],
            "confidence": room_confidence(room, area, room.get("enclosed")),
        }
        if room["label_area_m2"] is not None:
            item["label_area_m2"] = room["label_area_m2"]
        if not room["name"]:
            warnings.append("房间 %s 内没有找到房间名文字" % item["id"])
        out_rooms.append(item)

    # 自检
    low_rooms = [x for x in out_rooms if x["confidence"] == "low"]
    if any(x["source"] == "inferred-rect" for x in out_rooms):
        assumptions.append("房间面积置信度：高 = 闭合轮廓、泛洪出的房间四面被墙围住、或与图上标注一致；中 = 从房间名推断且基本围合；低 = 泛洪没围住（退回了矩形）、或与图上标注差 10% 以上。")
    if low_rooms:
        warnings.append("以下房间的面积置信度低，算量和报价前请人工核对轮廓：" + "、".join("%s %s㎡" % (x["name"], x["area_m2"]) for x in low_rooms))
    footprint = ((max(p[0] for p in all_pts) - ox) * (max(p[1] for p in all_pts) - oy)) / 1e6
    room_area = sum(x["area_m2"] for x in out_rooms)
    if footprint > 0 and room_area < footprint * 0.5:
        warnings.append(
            "识别到的房间合计 %s㎡，只占外包面积 %s㎡ 的 %d%%：可能有房间没识别出来，或者墙体识别不完整。"
            "这个比例明显偏低时，房间数据不要直接用于算量和报价，先对照图面核对。"
            % (round(room_area, 2), round(footprint, 2), round(room_area / footprint * 100))
        )
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
    coded = sum(1 for o in out_openings if o.get("code"))
    real = sum(1 for o in out_openings if o["type"] in ("door", "window"))
    if coded:
        assumptions.append("%d / %d 个门窗按图上的门窗编号取了高度（如 M1021 = 1000×2100）；其余用默认值。" % (coded, real))
    if snapped:
        assumptions.append(
            "%d 个门窗的宽度按图上编号取了名义值（门窗块通常比洞口画小一圈，实测与编号相差 %d%% 以内时以编号为准）。"
            % (snapped, int(CODE_SNAP_TOL * 100))
        )
    for oid, width, code, nominal in mismatched:
        warnings.append("%s 的实测宽 %s 与编号 %s 的 %s 相差超过 %d%%，宽度按实测值算，请核对这个编号是不是标错了位置。" % (oid, r(width), code, r(nominal), int(CODE_SNAP_TOL * 100)))
    assumptions.append("层高 %s、窗台 %s 为默认值，未匹配到编号的门高 %s、窗顶 %s 也是默认值（图上没有这些信息），请按实际修改 plan.json。" % (r(storey), r(cfg["window_sill"]), r(cfg["door_height"]), r(cfg["window_head"])))

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
            "columns": len(columns),
            "room_area_m2": round(sum(x["area_m2"] for x in out_rooms), 2),
            "room_confidence": {key: sum(1 for x in out_rooms if x["confidence"] == key) for key in ("high", "medium", "low")},
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
