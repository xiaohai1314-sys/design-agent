#!/usr/bin/env python3
"""从 DWG / DXF 平面图提取结构化平面数据 plan.json（墙体中心线与厚度、门窗洞口、房间轮廓与面积）。

用法：
  python plan_extract.py <图纸.dwg|dxf> [--bbox x0,y0,x1,y1] [--out plan.json]
                         [--wall-layer A-WALL] [--door-layer A-DOOR] [--window-layer A-WIND] [--room-layer A-ROOM]
                         [--height 2800] [--door-height 2100] [--window-sill 900] [--window-head 2400]

图层不指定时按名称自动识别（墙 / WALL、门 / DOOR、窗 / WIND、房间 / ROOM / SPACE），识别不到墙体图层时会列出图层清单。
一张图里有多个平面（多层、多方案）时用 --bbox 框出一个平面再提取。
结果默认写到 <当前目录>/.design-agent/plans/<图名>.plan.json，stdout 只打印摘要、自检结果和需要确认的假设。
plan.json 的格式见同目录 SKILL.md「平面转模型」一节；SketchUp 建模用 sketchup/scripts/plan_builder.rb 读它。
"""
import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import cad_core  # noqa: E402
import plan_core  # noqa: E402
import plan_frames  # noqa: E402
from cad_core import CadError  # noqa: E402

ROLE_PATTERNS = {
    "wall": re.compile(r"wall|墙|qiang", re.I),
    "column": re.compile(r"colu|^col$|[-_]col$|柱|^zhu", re.I),
    # 轴线：天正放在 DOTE（点划线），轴号圆圈和引出线在 AXIS；也有画在 A-GRID / 轴线 图层的。
    # 「中心线」只有图层名不夹带墙 / 窗 / 门 / 柱时才算轴线：「墙中心线」是墙层，
    # 认成轴线的话这一层整层丢失，图纸里只剩它时直接报「没有识别到墙体图层」
    "axis": re.compile(r"^axis$|^axis[-_]line|^dote$|grid|轴线|^轴网$|^(?!.*(?:墙|窗|门|柱)).*中心线", re.I),
    "door": re.compile(r"door|门|^men$|[-_]men", re.I),
    "window": re.compile(r"wind|窗|chuang|glaz", re.I),
    "room": re.compile(r"room|房间|空间|space", re.I),
}
NOT_PLAN_LAYER_RE = re.compile(r"立面|剖面|elev|sect|hatch|填充|text|文字|dim|标注|txt", re.I)
# 图纸单位 → 毫米（$INSUNITS：1 英寸，2 英尺，4 毫米，5 厘米，6 米）
UNIT_TO_MM = {0: 1.0, 1: 25.4, 2: 304.8, 4: 1.0, 5: 10.0, 6: 1000.0}


def parse_bbox(text):
    try:
        x0, y0, x1, y1 = [float(v) for v in str(text).replace("，", ",").split(",")]
    except ValueError as error:
        raise CadError(f"--bbox 须为 4 个逗号分隔的数字，收到「{text}」") from error
    return [min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1)]


def split_layers(value):
    return {part.strip().upper() for part in (value or "").split(",") if part.strip()}


def assign_roles(layers, args):
    explicit = {
        "wall": split_layers(args.wall_layer),
        "door": split_layers(args.door_layer),
        "window": split_layers(args.window_layer),
        "room": split_layers(args.room_layer),
        "column": split_layers(args.column_layer),
        "axis": split_layers(args.axis_layer),
    }
    roles = {}
    for layer in layers:
        key = layer.upper()
        chosen = None
        for role, names in explicit.items():
            if names and key in names:
                chosen = role
                break
        if chosen is None:
            # 立面 / 剖面 / 填充 / 文字类图层名里带“墙”也不是平面墙线（如“立面墙线”“WALL_HATCH”）
            if NOT_PLAN_LAYER_RE.search(layer):
                continue
            for role in ("axis", "window", "door", "room", "column", "wall"):
                if explicit[role]:
                    continue
                if ROLE_PATTERNS[role].search(layer):
                    chosen = role
                    break
        if chosen:
            roles[layer] = chosen
    return roles


def main():
    cad_core.configure_stdio()
    parser = argparse.ArgumentParser(description="平面图 → plan.json")
    parser.add_argument("input", help="DWG / DXF 图纸路径")
    parser.add_argument("--layout", default="model", help="Layout 名称，默认模型空间")
    parser.add_argument("--bbox", help="只提取这个范围内的平面：x0,y0,x1,y1（图纸坐标）")
    parser.add_argument("--frame", help="只提取某个图幅内的平面：cad.py info 列出的编号，如 2 或 frame-2")
    parser.add_argument("--list-plans", action="store_true", help="列出图框（候选平面）与图名后退出；再用 --frame N 选一个")
    parser.add_argument("--wall-layer", help="墙体图层，逗号分隔；不填按名称自动识别")
    parser.add_argument("--door-layer", help="门图层")
    parser.add_argument("--window-layer", help="窗图层")
    parser.add_argument("--room-layer", help="房间轮廓图层（闭合多段线）")
    parser.add_argument("--column-layer", help="柱图层（闭合轮廓）；不填按名称自动识别（COLUMN / 柱）")
    parser.add_argument("--axis-layer", help="轴线图层；不填按名称自动识别（AXIS / DOTE / GRID / 轴线），多层合并时按轴网对齐各层")
    parser.add_argument(
        "--building-type",
        help="建筑类型（residential / education / office / medical / commercial / industrial / unknown），写进 plan.json，规范初查按它选规则库，不再逐层按房间名猜",
    )
    parser.add_argument("--text-layer", help="只用这些图层上的文字识别房间名 / 面积；默认用全部文字")
    parser.add_argument("--height", type=float, help="层高（mm），默认 2800")
    parser.add_argument("--door-height", type=float, help="门高（mm），默认 2100")
    parser.add_argument("--window-sill", type=float, help="窗台高（mm），默认 900")
    parser.add_argument("--window-head", type=float, help="窗顶高（mm），默认 2400")
    parser.add_argument("--min-thickness", type=float, help="最小墙厚（mm），默认 50")
    parser.add_argument("--max-thickness", type=float, help="最大墙厚（mm），默认 600")
    parser.add_argument("--out", help="输出路径，默认 .design-agent/plans/<图名>.plan.json")
    args = parser.parse_args()

    try:
        source = Path(args.input)
        document, warnings = cad_core.open_document(source)
        tangent = cad_core.tangent_warning(document)
        if tangent:
            warnings.append(tangent)
        spec = cad_core.find_layout(document, args.layout)
        if args.bbox and args.frame:
            raise CadError("--bbox 与 --frame 只能给一个")
        if args.list_plans and (args.bbox or args.frame):
            raise CadError("--list-plans 只用来列图框，不要再给 --frame / --bbox")
        key = None
        try:
            key = cad_core.source_cache_key(source)
        except OSError:
            key = None
        collected = cad_core.collect_layout_cached(spec, key)
        if args.list_plans:
            records = list(cad_core.iter_geometry(spec, tolerance=1.0, top_level_only=True))
            print(plan_frames.format_plan_list(plan_frames.describe_plans(collected, records)))
            return
        region = parse_bbox(args.bbox) if args.bbox else None
        if args.frame:
            region = list(cad_core.find_frame(collected, args.frame)["bbox"])
        elif region is None:
            top = cad_core.top_level_frames(collected)
            if len(top) >= 2:
                listing = plan_frames.format_plan_list(
                    plan_frames.describe_plans(collected), with_layers=False
                )
                raise CadError(
                    "这张图里有 %d 个图框（各层平面 / 剖面 / 立面），整张一起提取会把它们混成一个平面。\n%s"
                    % (len(top), listing)
                )
        extents = cad_core.top_level_extents(spec, key) if region else None

        code, unit_name = cad_core.drawing_units(document)
        records = list(cad_core.iter_geometry(spec, region=region, tolerance=1.0, extents=extents))
        layers = Counter(rec["layer"] for rec in records)
        roles = assign_roles(layers, args)
        by_role = {"wall": [], "door": [], "window": [], "room": [], "column": [], "axis": []}
        for rec in records:
            role = roles.get(rec["layer"])
            if role:
                by_role[role].append(rec)
        if not by_role["wall"]:
            listing = "，".join(f"{name}({count})" for name, count in layers.most_common(30))
            if tangent:
                raise CadError(
                    "没有识别到墙体图层。这份图里有天正（Tangent）自定义对象，墙体和门窗在读取时已被丢弃，"
                    "指定图层也补不回来：\n%s\n图上的图层（图元数）：%s" % (tangent, listing)
                )
            raise CadError(f"没有识别到墙体图层，请用 --wall-layer 指定。图上的图层（图元数）：{listing}")

        # 单位换算到毫米；未声明单位时按尺度猜测（户型外包尺寸不足 200 时多半是以米为单位）
        scale = UNIT_TO_MM.get(code)
        notes = []
        if scale is None:
            scale = 1.0
            notes.append(f"图纸单位为 {unit_name}，无法换算，按毫米处理")
        wall_pts = [p for rec in by_role["wall"] for p in rec["points"]]
        span = max(max(p[0] for p in wall_pts) - min(p[0] for p in wall_pts), max(p[1] for p in wall_pts) - min(p[1] for p in wall_pts))
        if code == 0 and span * scale < 200:
            scale = 1000.0
            notes.append("图纸未声明单位且墙体外包尺寸很小，按米换算为毫米")
        if scale != 1.0:
            for rec in records:
                rec["points"] = [(x * scale, y * scale) for x, y in rec["points"]]

        text_layers = split_layers(args.text_layer)
        collected = cad_core.collect_layout_cached(spec, key)
        texts = []
        for item in collected["texts"]:
            if item.get("type") not in ("TEXT", "MTEXT", "ATTRIB"):
                continue
            if text_layers and item["layer"].upper() not in text_layers:
                continue
            if region and not cad_core.point_in_bbox(item["anchor"], region):
                continue
            # anchor 是文字的左下角插入点，贴着墙时可能落在墙的另一侧；房间归属一律用包围盒中心
            anchor = (item["anchor"][0] * scale, item["anchor"][1] * scale)
            box = item.get("bbox")
            point = (((box[0] + box[2]) / 2) * scale, ((box[1] + box[3]) / 2) * scale) if box else anchor
            texts.append({"text": item["text"], "anchor": anchor, "point": point, "height": item.get("height", 0), "layer": item["layer"]})

        options = {
            "storey_height": args.height,
            "door_height": args.door_height,
            "window_sill": args.window_sill,
            "window_head": args.window_head,
            "min_wall_thickness": args.min_thickness,
            "max_wall_thickness": args.max_thickness,
        }
        try:
            plan = plan_core.build_plan(
                by_role,
                texts,
                source={
                    "file": str(source.resolve()),
                    "layout": spec.id,
                    "bbox": region,
                    "units": unit_name,
                    "scale_to_mm": scale,
                    "layers": {role: sorted({name for name, rl in roles.items() if rl == role}) for role in by_role},
                },
                options=options,
            )
        except ValueError as error:
            raise CadError(str(error)) from error
        plan["warnings"] = list(warnings) + notes + plan["warnings"]
        if args.building_type:
            plan["building_type"] = args.building_type
        problems = plan_core.validate_plan(plan)
        if problems:
            plan["warnings"] += ["校验：" + p for p in problems]
    except CadError as error:
        sys.exit(f"ERROR: {error}")

    target = Path(args.out) if args.out else Path.cwd() / ".design-agent" / "plans" / f"{source.stem}.plan.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(plan, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")

    s = plan["summary"]
    lines = [
        f"# 平面提取：{source.name}",
        f"- 已写入 {target.resolve()}",
        f"- 外包尺寸 {plan['bounds']['width']} × {plan['bounds']['depth']} mm；层高 {plan['storey']['height']}",
        f"- 墙 {s['walls']} 段，门 {s['doors']}，窗 {s['windows']}，推断过道 {s['passages']}，柱 {s.get('columns', 0)}，轴线 {s.get('axes', 0)}；房间 {s['rooms']} 个，合计 {s['room_area_m2']} ㎡",
        "- 图层：" + "；".join(f"{role} = {', '.join(names) or '无'}" for role, names in plan["source"]["layers"].items()),
    ]
    if plan["rooms"]:
        lines.append("- 房间：" + "，".join(f"{room['name']} {room['area_m2']}㎡{'（面积待核）' if room.get('confidence') == 'low' else ''}" for room in plan["rooms"]))
    failed = [c for c in plan["checks"] if not c["ok"]]
    lines.append(f"- 自检 {len(plan['checks'])} 项，未通过 {len(failed)} 项" + ("：" + "；".join(c["detail"] for c in failed) if failed else ""))
    for text in plan["assumptions"]:
        lines.append(f"- 需确认：{text}")
    for text in plan["warnings"]:
        lines.append(f"- 警告：{text}")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
