#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""轴网：轴号文字、轴线识别、交点与原点。

轴网决定多楼层对齐，也是定位房间和柱的参照。"""
import math
import re

from plan_geom import segments_of, text_point

AXIS_LABEL_RE = re.compile(r"^(?:\d{1,3}|[A-Z]{1,2}|\d{1,3}/\d{1,3}|[A-Z]/[A-Z])$")

AXIS_TEXT_LAYER_RE = re.compile(r"axis|轴", re.I)


def axis_label_key(label):
    """轴号排序：数字轴按数值，字母轴按字母；附加轴（1/2、A/B）排在主轴后面。"""
    if label.isdigit():
        return (0, int(label), label)
    if label.isalpha():
        return (1, sum((ord(ch) - 64) * 26 ** k for k, ch in enumerate(reversed(label))), label)
    return (2, 0, label)


def find_axes(axis_records, texts, cfg):
    """轴网：把轴号（1、2…、A、B…）对到它所在的那条轴线上。

    轴号写在轴线端头的圆圈里，轴线是长直线（点划线图层），引出线也与轴线共线。
    对每个轴号找延长线离它最近、端头又离它不远的那条线；同一个轴号上下 / 左右各标一次，取先找到的。
    返回 ([{label, point, dir}]（原图坐标，dir 为单位向量）, [有歧义的轴号])。
    """
    if not axis_records:
        return [], []
    segments = []
    for rec in axis_records:
        if rec.get("type") in ("CIRCLE", "ARC"):
            continue
        for a, b in segments_of(rec):
            if math.dist(a, b) >= 1000.0:
                segments.append((a, b))
    if not segments:
        return [], []
    candidates = [t for t in texts if AXIS_LABEL_RE.match((t.get("text") or "").strip())]
    on_axis_layer = [t for t in candidates if AXIS_TEXT_LAYER_RE.search(t.get("layer") or "")]
    if on_axis_layer:
        candidates = on_axis_layer
    found = {}
    for t in sorted(candidates, key=lambda t: axis_label_key(t["text"].strip())):
        label = t["text"].strip()
        p = text_point(t)
        size = max(float(t.get("height") or 0), 300.0)
        best = None
        for a, b in segments:
            length = math.dist(a, b)
            d = ((b[0] - a[0]) / length, (b[1] - a[1]) / length)
            rel = (p[0] - a[0], p[1] - a[1])
            across = abs(rel[0] * d[1] - rel[1] * d[0])
            along = rel[0] * d[0] + rel[1] * d[1]
            beyond = max(-along, along - length, 0.0)
            if across > size * 1.5 or beyond > max(size * 8, 3000.0):
                continue
            score = across + beyond * 0.01
            if best is None or score < best[0]:
                best = (score, a, d)
        if best:
            found.setdefault(label, []).append({"label": label, "point": best[1], "dir": best[2]})
    # 同一个轴号通常上下 / 左右各标一次，指向同一条轴线；如果指向不同的线（图幅里还有局部大样、
    # 分区轴网自己编了号），这个轴号就有歧义，宁可不用，免得拿错线算对齐
    lines, ambiguous = [], []
    for label, hits in found.items():
        first = hits[0]
        n = (-first["dir"][1], first["dir"][0])
        offset = first["point"][0] * n[0] + first["point"][1] * n[1]
        same = all(
            abs(abs(h["dir"][0] * first["dir"][0] + h["dir"][1] * first["dir"][1]) - 1) < 1e-3
            and abs(h["point"][0] * n[0] + h["point"][1] * n[1] - offset) <= 50.0
            for h in hits[1:]
        )
        (lines if same else ambiguous).append(first if same else label)
    lines.sort(key=lambda item: axis_label_key(item["label"]))
    return lines, sorted(ambiguous, key=axis_label_key)


def axis_intersection(first, second):
    """两条轴线的交点；平行时返回 None。"""
    (ax, ay), (dx, dy) = first["point"], first["dir"]
    (bx, by), (ex, ey) = second["point"], second["dir"]
    det = dx * (-ey) - dy * (-ex)
    if abs(det) < 0.5:
        return None
    s = ((bx - ax) * (-ey) - (by - ay) * (-ex)) / det
    return (ax + dx * s, ay + dy * s)


def axis_origin(axes):
    """第一根数字轴 × 第一根字母轴的交点（通常是 1 轴 × A 轴）。返回 (点, [数字轴号, 字母轴号]) 或 None。"""
    numbers = [a for a in axes if a["label"].isdigit()]
    letters = [a for a in axes if a["label"].isalpha()]
    for n in numbers:
        for l in letters:
            point = axis_intersection(n, l)
            if point is not None:
                return point, [n["label"], l["label"]]
    return None
