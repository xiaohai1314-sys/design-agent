#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""墙体：成对平行线拼成墙段、合并共线、端头延伸、扣柱与净体积。"""
import math

from plan_geom import (
    add,
    cross,
    dot,
    mul,
    same_direction,
    sub,
)
from plan_column import piece_footprint_hits, piece_point


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


def wall_column_spans(wall, columns, cfg):
    """墙中心线穿过的柱子在墙上占的区段：[(距墙起点, 距墙起点)]，已合并、裁到墙长以内。"""
    if not columns:
        return []
    tol = cfg["tolerance"]
    base = wall["base"]
    half = wall["thickness"] / 2
    spans = []
    for box in columns:
        corners = [(box[0], box[1]), (box[2], box[1]), (box[2], box[3]), (box[0], box[3])]
        offs = [dot(p, base["n"]) for p in corners]
        # 柱截面要把墙厚整个盖住，才算墙穿过柱子（只擦到墙边的不算）
        if not (min(offs) <= base["offset"] - half + tol and max(offs) >= base["offset"] + half - tol):
            continue
        ts = [dot(p, base["d"]) for p in corners]
        a, b = max(min(ts), wall["t0"]) - wall["t0"], min(max(ts), wall["t1"]) - wall["t0"]
        if b - a > tol:
            spans.append([a, b])
    spans.sort()
    merged = []
    for a, b in spans:
        if merged and a <= merged[-1][1] + tol:
            merged[-1][1] = max(merged[-1][1], b)
        else:
            merged.append([a, b])
    return [tuple(s) for s in merged]


def wall_net_volume_mm3(wall, openings):
    """墙体净体积（mm³）：长 × 厚 × 高，扣门窗洞口和柱子占的区段。plan_quantity / plan_verify 共用。"""
    length = math.dist(wall["start"], wall["end"])
    thickness, height = float(wall["thickness"]), float(wall["height"])
    solid = length - sum(float(b) - float(a) for a, b in wall.get("column_spans", []))
    volume = solid * thickness * height
    for o in openings:
        if o.get("wall") == wall.get("id"):
            volume -= float(o["width"]) * thickness * float(o["height"])
    return max(volume, 0.0)


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
