#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""门窗：按连通关系分组，投影到所在墙上，解析门窗编号得到名义宽度。"""
import re

from plan_geom import (
    arc_info,
    canonical_direction,
    dot,
    in_strip,
    sub,
    within_extent,
)

DOOR_BLOCK_RE = re.compile(r"door|dor|门|men", re.I)

OPENING_CODE_RE = re.compile(r"^(?P<prefix>[A-Z]{0,3}?(?P<kind>MC|M|C))[甲乙丙]?(?P<w>\d{2})(?P<h>\d{2})[a-z]?$", re.I)


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


def parse_opening_code(text):
    """门窗编号 → (类型, 宽, 高)：M1021 = 门 1000×2100，C1815 = 窗 1800×1500，FM甲1022 = 防火门。"""
    m = OPENING_CODE_RE.match((text or "").strip())
    if not m:
        return None
    kind = "door" if m.group("kind").upper() in ("M", "MC") else "window"
    return {"code": text.strip(), "kind": kind, "width": int(m.group("w")) * 100, "height": int(m.group("h")) * 100}
