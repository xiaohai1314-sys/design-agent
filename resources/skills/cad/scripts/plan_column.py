#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""柱：把成对的柱线拼成柱截面，并算出柱在墙段和房间里的占位。"""
import math

from plan_geom import (
    _on_boundary,
    add,
    clip_polygon_to_box,
    cross,
    dot,
    mul,
    polygon_area,
    same_direction,
    sub,
)


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


def room_column_cuts(polygon, columns, min_area=1e4):
    """房间轮廓里被柱子占掉的部分：[(交多边形, 露在房间里的柱边长 mm)]。

    泛洪时柱子只按墙厚封住了墙线所在的那一条，凸出墙面的部分还算在房间里；
    这里把它扣出来，地面 / 顶棚面积扣掉，露出来的柱边长加到墙面和踢脚线里。
    """
    cuts = []
    for box in columns:
        xs = [p[0] for p in polygon]
        ys = [p[1] for p in polygon]
        if box[2] <= min(xs) or box[0] >= max(xs) or box[3] <= min(ys) or box[1] >= max(ys):
            continue
        piece = clip_polygon_to_box(polygon, box)
        if len(piece) < 3 or polygon_area(piece) < min_area:
            continue
        exposed = 0.0
        for k, a in enumerate(piece):
            b = piece[(k + 1) % len(piece)]
            mid = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
            if not _on_boundary(mid, polygon):
                exposed += math.dist(a, b)
        cuts.append((piece, exposed))
    return cuts


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
