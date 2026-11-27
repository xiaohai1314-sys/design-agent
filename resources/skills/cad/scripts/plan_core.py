#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""平面图 → plan.json 的纯几何核心（不依赖 ezdxf，便于单独测试）。

输入是已经离散好的图元记录（与 cad_core.iter_geometry 的产出同形：layer / type / points / closed，
ARC 额外带 center / radius 更好但不是必须）和文字记录（text / anchor / height / layer），
输出 plan.json 结构：墙体中心线 + 厚度、挂在墙上的门窗洞口、房间轮廓与面积，以及一组自检结果。

只记录能从图上直接复现的几何证据；推断出来的部分（房间矩形、无门扇的过道洞口、默认的层高 / 窗台高）
都会写进 assumptions，交给用户确认，不静默当成事实。

本文件已按墙体 / 洞口 / 房间 / 轴网 / 柱拆到 plan_geom、plan_axis、plan_column、
plan_wall、plan_opening、plan_room，这里只保留把它们串成 build_plan 的组装逻辑
和写出前的校验。拆出去的名字在这里全部重新导入，plan_core.build_plan 之类的
旧调用一行都不用改。
"""
import math
import re

from plan_geom import (
    Line,
    add,
    bbox_of,
    clip_polygon_to_box,
    group_records,
    mul,
    polygon_area,
    r,
    rp,
    segments_of,
    sub,
    text_point,
)
from plan_axis import axis_origin, find_axes
from plan_column import (
    column_pieces,
    dedupe_pieces,
    piece_point,
    room_column_cuts,
)
from plan_wall import (
    extend_wall_ends,
    merge_collinear,
    pair_wall_lines,
    wall_column_spans,
    wall_net_volume_mm3,
)
from plan_opening import opening_candidates, parse_opening_code
from plan_room import (
    is_label,
    room_confidence,
    room_regions,
    rooms_from_labels,
    rooms_from_polygons,
)

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

# 楼梯间、电梯井在模型里是通高的洞口：本层不铺地面、不做顶棚，上层也不铺地面
# 注意不含「前室」：消防前室 / 合用前室是有楼板的房间，不是通高洞口
STAIR_ROOM_RE = re.compile(r"楼梯|电梯|梯井", re.I)


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
    dropped_column_walls = 0
    wall_index = 0
    for w in sorted(walls, key=lambda w: (-w["thickness"], w["t0"])):
        length = w["t1"] - w["t0"]
        spans = wall_column_spans(w, columns, cfg)
        if spans and sum(b - a for a, b in spans) >= length - tol and not w["openings"]:
            # 整段都在柱子里（柱补出来的短墙段）：不出墙，柱子自己会建
            dropped_column_walls += 1
            continue
        wall_index += 1
        wid = "W%d" % wall_index
        start, end = tr(piece_point(w["base"], w["t0"])), tr(piece_point(w["base"], w["t1"]))
        item_wall = {"id": wid, "start": rp(start), "end": rp(end), "thickness": r(w["thickness"]), "height": r(storey), "length": r(length)}
        if spans:
            # 墙中心线穿过柱子的区段（沿墙距离，mm）：建模时这几段不出墙体、算墙体体积时扣掉，
            # 由柱子自己占位 —— 否则墙和柱是两个重叠的实体，体积多算 柱宽 × 墙厚 × 层高
            item_wall["column_spans"] = [[r(a), r(b)] for a, b in spans]
        out_walls.append(item_wall)
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

    if dropped_column_walls:
        assumptions.append("%d 段墙整段落在柱子里，没有单独出墙（由柱子占位）。" % dropped_column_walls)

    # 轴网：多层合并时按同名轴线的交点对齐各层（外包框会因阳台、雨篷、退台而变）
    axes, ambiguous_axes = find_axes(records_by_role.get("axis", []), texts, cfg)
    if ambiguous_axes:
        warnings.append("轴号 %s 在图上指向不止一条线（图幅里可能有局部大样或分区轴网），这几个轴号不参与对齐。" % "、".join(ambiguous_axes))
    out_axes = [{"label": a["label"], "point": rp(tr(a["point"])), "dir": [round(a["dir"][0], 6), round(a["dir"][1], 6)]} for a in axes]
    origin = axis_origin(axes)

    # 柱：位置 + 截面 + 高度，建模时按它挤出（不输出的话模型里就没有柱）
    out_columns = []
    for ki, box in enumerate(sorted(columns, key=lambda b: (round(b[1]), round(b[0])))):
        out_columns.append(
            {
                "id": "K%d" % (ki + 1),
                "center": rp(tr(((box[0] + box[2]) / 2, (box[1] + box[3]) / 2))),
                "width": r(max(box[2] - box[0], 1.0)),
                "depth": r(max(box[3] - box[1], 1.0)),
                "height": r(storey),
            }
        )

    # 房间
    polys = [rec for rec in records_by_role.get("room", []) if rec.get("closed") and len(rec["points"]) >= 3 and polygon_area(rec["points"]) > 1e5]
    rooms = rooms_from_polygons(polys, texts) if polys else rooms_from_labels(texts, walls, cfg)
    if not polys and rooms:
        assumptions.append("图上没有房间轮廓线，房间是从房间名出发、取被墙围住的那一片泛洪出来的；泛洪没围住的（敞开的大厅、隔断没画）退回「向四周找最近墙内皮」的矩形，并标为低置信度，请核对。")
    if not rooms:
        warnings.append("没有识别到房间：既没有闭合的房间轮廓线，也没能从房间名推断出矩形。可以在 plan.json 里手动补 rooms。")
    out_rooms = []
    column_cut_total = 0.0
    for ri, room in enumerate(rooms):
        poly = [tr(p) for p in room["polygon"]]
        gross = polygon_area(poly) / 1e6
        # 柱子凸出墙面、落在房间里的部分：地面面积扣掉（polygon 仍是含柱的外轮廓，扣掉的块记在 column_cuts）
        cuts = room_column_cuts(room["polygon"], columns) if columns else []
        cut_area = sum(polygon_area(piece) for piece, _ in cuts) / 1e6
        area = gross - cut_area
        item = {
            "id": "R%d" % (ri + 1),
            "name": room["name"] or "房间%d" % (ri + 1),
            "type": "stair" if STAIR_ROOM_RE.search(room["name"] or "") else "room",
            "polygon": [rp(p) for p in poly],
            "area_m2": round(area, 2),
            "source": room["source"],
            "confidence": room_confidence(room, area, room.get("enclosed")),
        }
        if cuts:
            column_cut_total += cut_area
            item["gross_area_m2"] = round(gross, 2)
            item["column_cuts"] = [{"polygon": [rp(tr(p)) for p in piece], "exposed_mm": r(exposed)} for piece, exposed in cuts]
        if room["label_area_m2"] is not None:
            item["label_area_m2"] = room["label_area_m2"]
        if not room["name"]:
            warnings.append("房间 %s 内没有找到房间名文字" % item["id"])
        out_rooms.append(item)

    if column_cut_total > 0:
        assumptions.append("房间面积已扣除柱子凸出墙面的部分，共 %.2f㎡（polygon 是含柱的外轮廓，gross_area_m2 是扣柱前面积，扣掉的块在 column_cuts）。" % column_cut_total)

    # 自检
    merged = [(item, room) for item, room in zip(out_rooms, rooms) if room.get("labels", 1) > 1]
    for item, room in merged:
        warnings.append(
            "%s（%s㎡）这片被墙围住的空间里有 %d 个房间名，被算成了一间：多半是中间的隔墙没画或没识别出来，房间数会少、面积会偏大，请核对。"
            % (item["name"], item["area_m2"], room["labels"])
        )
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
        "columns": out_columns,
        "rooms": out_rooms,
        **(
            {"axes": dict({"lines": out_axes, "ambiguous": ambiguous_axes}, **({"origin": rp(tr(origin[0])), "origin_labels": origin[1]} if origin else {}))}
            if out_axes or ambiguous_axes
            else {}
        ),
        "summary": {
            "walls": len(out_walls),
            "doors": counters["door"],
            "windows": counters["window"],
            "passages": counters["passage"],
            "rooms": len(out_rooms),
            "columns": len(columns),
            "axes": len(axes),
            "room_area_m2": round(sum(x["area_m2"] for x in out_rooms), 2),
            "room_confidence": {key: sum(1 for x in out_rooms if x["confidence"] == key) for key in ("high", "medium", "low")},
        },
        "checks": checks,
        "assumptions": assumptions,
        "warnings": warnings,
    }


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
    for w in walls.values():
        length = math.dist(w["start"], w["end"])
        for span in w.get("column_spans", []):
            if not (-1 <= span[0] < span[1] <= length + 1):
                problems.append("墙 %s 的柱区段 %s 超出墙长" % (w.get("id"), span))
    for column in plan.get("columns", []):
        if float(column.get("width", 0)) <= 0 or float(column.get("depth", 0)) <= 0:
            problems.append("柱 %s 的截面不是正数" % column.get("id"))
        if float(column.get("height", 0)) <= 0:
            problems.append("柱 %s 的高度不是正数" % column.get("id"))
    for room in plan.get("rooms", []):
        for cut in room.get("column_cuts", []):
            if len(cut.get("polygon", [])) < 3:
                problems.append("房间 %s 的扣柱块轮廓无效" % room.get("id"))
        if len(room.get("polygon", [])) < 3 or polygon_area(room["polygon"]) <= 0:
            problems.append("房间 %s 的轮廓无效" % room.get("id"))
    return problems
