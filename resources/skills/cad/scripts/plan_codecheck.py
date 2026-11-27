#!/usr/bin/env python3
"""按 plan.json 做住宅户内规范初查：房间面积、门洞宽高、层高 / 净高、外窗防护、直接采光，输出问题清单与标注图。

用法：
  python plan_codecheck.py --plan xxx.plan.json [--rules 规则.json] [--building-type residential]
                           [--ceiling-height 2600] [--out 报告.md]

- 默认规则是同目录的 plan_rules.residential.json（参考 GB 50096-2011 整理）。限值只用于初查：
  报告里列出的每一条，出具正式结论前都要用 retrieve_regulation_chunks 检索现行条文核对，地方标准更严时以地方为准。
- 规则文件用 building_types 声明适用范围。图上判断出的建筑类型不在范围内时不做判定，只出一份说明为什么没判的报告：
  拿住宅限值去判教室、病房，报出来的「不满足」全是误报，比不判更糟。建筑类型按房间名猜，猜不出时用 --building-type 指定。
- 输出 <图名>.codecheck.md（问题清单）、同名 .json、同名 .png（问题位置用红圈编号标在平面上）。
- 退出码：0 = 全部满足或只有“需注意”；1 = 有“不满足”项；
  2 = 未做判定（规则库不覆盖这个建筑类型，或识别到的房间只占外包面积一半以下，先核对房间）。
"""
import argparse
import json
import re
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import plan_geom as pg  # noqa: E402

DOOR_PRIORITY = ["bathroom", "kitchen", "bedroom", "study", "storage", "balcony", "living", "dining", "other"]
CONFIDENCE_LABELS = {"high": "高", "medium": "中", "low": "低"}


def centroid(poly):
    return (sum(p[0] for p in poly) / len(poly), sum(p[1] for p in poly) / len(poly))


def door_requirement(item, rules):
    """门的规范类型：外墙上通往室内（非阳台）的门按户门；否则按它服务的房间中“更私密”的一侧。"""
    by_type = {r["type"]: r for r in rules["door_width"]}
    types = [pg.room_type(r["name"]) for r in item["rooms"]]
    if item["exterior"] and len(item["rooms"]) == 1 and types[0] != "balcony":
        return by_type.get("entry"), "户门"
    for key in DOOR_PRIORITY:
        if key in types:
            mapped = {"study": "bedroom", "storage": None, "dining": "living", "other": None}.get(key, key)
            if mapped and mapped in by_type:
                return by_type[mapped], f"{pg.ROOM_TYPE_LABELS[key]}门"
    return None, None


def check(plan, rules, ceiling_height=None):
    findings = []

    def add(status, item, location, xy, detail, rule):
        findings.append({"status": status, "item": item, "location": location, "xy": [round(xy[0]), round(xy[1])] if xy else None, "detail": detail, "clause": rule.get("clause", ""), "requirement": rule.get("text", "")})

    area_rules = {r["type"]: r for r in rules.get("room_area", [])}

    def area_status(room, ok):
        # 房间轮廓本身不可信时（置信度低），不判「不满足」，只提醒核对：错的是轮廓，不是设计
        if ok:
            return "pass"
        return "warn" if room.get("confidence") == "low" else "fail"

    def area_note(room):
        return "（面积置信度低，请先核对房间轮廓）" if room.get("confidence") == "low" else ""

    for room in plan.get("rooms", []):
        rtype = pg.room_type(room["name"])
        area = float(room["area_m2"])
        xy = centroid(room["polygon"])
        note = area_note(room)
        if rtype == "bedroom":
            double = bool(re.search(r"主卧|双人", room["name"]))
            rule = area_rules.get("bedroom_double" if double else "bedroom_single")
            if rule:
                ok = area >= rule["min_m2"]
                add(area_status(room, ok), "卧室面积", room["name"], xy, f"{area:.2f}㎡ / 要求 ≥{rule['min_m2']}㎡{note}", rule)
                single_rule = area_rules.get("bedroom_double")
                if ok and not double and single_rule and area < single_rule["min_m2"]:
                    add("warn", "卧室面积", room["name"], xy, f"{area:.2f}㎡，按单人卧室满足；如作双人卧室需 ≥{single_rule['min_m2']}㎡{note}", single_rule)
        elif rtype in area_rules:
            rule = area_rules[rtype]
            ok = area >= rule["min_m2"]
            add(area_status(room, ok), f"{pg.ROOM_TYPE_LABELS[rtype]}面积", room["name"], xy, f"{area:.2f}㎡ / 要求 ≥{rule['min_m2']}㎡{note}", rule)

    for item in pg.opening_index(plan):
        o = item["opening"]
        if o["type"] not in ("door", "passage"):
            continue
        rule, label = door_requirement(item, rules)
        if not rule:
            continue
        xy = pg.opening_center(o, item["wall"])
        where = f"{o['id']}（{label}，{' / '.join(r['name'] for r in item['rooms']) or '室外'}）"
        width, height = float(o["width"]), float(o["height"])
        ok_w = width >= rule["min_mm"]
        add("pass" if ok_w else "fail", "门洞宽度", where, xy, f"{width:.0f}mm / 要求 ≥{rule['min_mm']}mm", rule)
        if rule.get("min_height_mm"):
            ok_h = height >= rule["min_height_mm"]
            add("pass" if ok_h else "fail", "门洞高度", where, xy, f"{height:.0f}mm / 要求 ≥{rule['min_height_mm']}mm", rule)

    storey = float(plan.get("storey", {}).get("height", 0))
    clear = float(ceiling_height) if ceiling_height else storey
    height_rules = {r["type"]: r for r in rules.get("height", [])}
    if "storey" in height_rules and storey:
        rule = height_rules["storey"]
        add("pass" if storey >= rule["min_mm"] else "warn", "层高", "全套", None, f"{storey:.0f}mm / 宜为 {rule['min_mm']}mm", rule)
    for key, types, label in (("clear_main", ("bedroom", "living"), "卧室 / 起居室净高"), ("clear_wet", ("kitchen", "bathroom"), "厨房 / 卫生间净高")):
        rule = height_rules.get(key)
        if not rule or not any(pg.room_type(r["name"]) in types for r in plan.get("rooms", [])):
            continue
        status = "pass" if clear >= rule["min_mm"] else "fail"
        note = "" if ceiling_height else "（未提供吊顶后净高，按层高计；做吊顶后需复核）"
        add(status, label, "全套", None, f"{clear:.0f}mm / 要求 ≥{rule['min_mm']}mm{note}", rule)

    guard = rules.get("window_guard")
    daylight = rules.get("daylight")
    lit_rooms = set()
    for item in pg.opening_index(plan):
        o = item["opening"]
        if o["type"] != "window":
            continue
        for r in item["rooms"]:
            if item["exterior"]:
                lit_rooms.add(r["id"])
        if guard and item["exterior"] and float(o.get("sill", 0)) < guard["min_sill_mm"]:
            inner = [r for r in item["rooms"] if pg.room_type(r["name"]) != "balcony"]
            if inner:
                xy = pg.opening_center(o, item["wall"])
                add("warn", "外窗防护", f"{o['id']}（{inner[0]['name']}）", xy, f"窗台 {float(o['sill']):.0f}mm < {guard['min_sill_mm']}mm，需设防护设施（窗外有阳台或平台时除外）", guard)
    if daylight:
        for room in plan.get("rooms", []):
            if pg.room_type(room["name"]) not in daylight["types"]:
                continue
            xy = centroid(room["polygon"])
            if room["id"] in lit_rooms:
                add("pass", "直接采光", room["name"], xy, "有外墙窗", daylight)
            else:
                add("warn", "直接采光", room["name"], xy, "平面上没有直接对外的窗（可能经阳台间接采光），需核对采光条件", daylight)
    return findings


def render_markdown(plan_path, plan, rules, findings, image_name, building_type=None, type_source="按房间名识别"):
    fails = [f for f in findings if f["status"] == "fail"]
    warns = [f for f in findings if f["status"] == "warn"]
    passes = [f for f in findings if f["status"] == "pass"]
    lines = [
        f"# 规范初查：{Path(plan_path).name}",
        "",
        f"> 规则：{rules.get('name', '')}。{rules.get('note', '')}",
        "",
    ]
    if building_type:
        lines += [f"> 建筑类型：{pg.building_type_label(building_type)}（{type_source}，错了用 --building-type 指定）。", ""]
    lines += [
        f"共 {len(findings)} 项：❌ 不满足 {len(fails)}，⚠️ 需注意 {len(warns)}，✅ 满足 {len(passes)}。",
        "",
    ]
    if image_name:
        lines += [f"![问题位置]({image_name})", ""]
    marked = fails + warns
    if marked:
        lines += ["## 问题清单", "", "| 图上编号 | 状态 | 项目 | 位置 | 实际 / 要求 | 依据 |", "|---|---|---|---|---|---|"]
        number = 0
        for f in marked:
            tag = ""
            if f["xy"]:
                number += 1
                tag = str(number)
            lines.append(f"| {tag} | {'❌ 不满足' if f['status'] == 'fail' else '⚠️ 需注意'} | {f['item']} | {f['location']} | {f['detail']} | {f['clause']}：{f['requirement']} |")
        lines.append("")
    lines += ["## 满足的项目", "", "| 项目 | 位置 | 实际 / 要求 | 依据 |", "|---|---|---|---|"]
    for f in passes:
        lines.append(f"| {f['item']} | {f['location']} | {f['detail']} | {f['clause']} |")
    lines += ["", "## 未检查的内容", "", "- 疏散距离、楼梯、无障碍、防火分隔等需要建筑整体信息，本工具不判断。", "- 门洞宽度按 plan.json 中的洞口宽度判断；净宽另需扣除门框。", "- 房间类型按房间名识别，名称不规范时可能归类错误。"]
    return "\n".join(lines) + "\n"


def render_uncovered(plan_path, plan, rules, building_type, covered_types, type_source="按房间名识别"):
    covered = "、".join(pg.building_type_label(k) for k in covered_types) if covered_types else "未声明"
    example = covered_types[0] if covered_types else "residential"
    intro = "没能判断出这份图的建筑类型" if building_type == "unknown" else f"这份图是「{pg.building_type_label(building_type)}」（{type_source}）"
    lines = [
        f"# 规范初查：{Path(plan_path).name}",
        "",
        f"> {intro}，而规则库「{rules.get('name', '')}」只适用于{covered}，**没有做判定**。",
        "",
        f"拿{covered}的限值去判别的建筑类型，报出来的「不满足」基本都是误报，比不判更糟，所以这里直接停下。",
        "",
        "## 怎么继续",
        "",
        f"- 如果这确实是{covered}，用 `--building-type {example}` 指定后重跑；",
        f"- 要查这类建筑的同类问题（房间面积、门洞宽高、层高净高、外窗防护、直接采光），需要对应的规则库："
        f"复制 `plan_rules.residential.json`，把 `building_types` 改成 `[\"{building_type}\"]`，"
        "按对应规范（如中小学校设计规范 GB 50099、办公建筑设计标准 JGJ/T 67）填写限值，再用 `--rules` 指定；",
        "- 规则库里的每一条限值都要用 `retrieve_regulation_chunks` 检索现行条文核对后再用。",
        "",
        "## 图上识别到的房间（未做判定，仅供参考）",
        "",
        "| 房间 | 面积㎡ | 置信度 | 依据 |",
        "|---|---|---|---|",
    ]
    for room in plan.get("rooms", []):
        lines.append(
            "| %s | %s | %s | %s |"
            % (
                room.get("name", ""),
                room.get("area_m2", ""),
                CONFIDENCE_LABELS.get(room.get("confidence"), "—"),
                "轮廓线" if room.get("source") == "polyline" else "从房间名推断",
            )
        )
    lines += ["", "## 未检查的内容", "", "- 本工具的全部检查项（见上）。", "- 疏散距离、楼梯、无障碍、防火分隔等需要建筑整体信息，本工具不判断。"]
    return "\n".join(lines) + "\n"


def render_unreliable(plan_path, plan, coverage):
    rooms = plan.get("rooms", [])
    bounds = plan.get("bounds", {})
    footprint = float(bounds.get("width", 0) or 0) * float(bounds.get("depth", 0) or 0) / 1e6
    total = sum(float(room.get("area_m2", 0) or 0) for room in rooms)
    lines = [
        f"# 规范初查：{Path(plan_path).name}",
        "",
        f"> 识别到的房间合计 {total:.2f}㎡，只占外包面积 {footprint:.2f}㎡ 的 {coverage * 100:.0f}%，**没有做判定**。",
        "",
        "房间没识别全、或墙体识别不完整时，面积类检查是拿错数在判，门窗和采光也挂在错的房间上，"
        "报出来的「不满足」基本都是误报，比不判更糟。",
        "",
        "## 怎么继续",
        "",
        "- 先看 `plan_extract.py` 输出的「需确认 / 警告」：有没有房间名没识别到、房间轮廓是不是只圈住一条缝；",
        "- 图上如果有房间轮廓线，用 `--room-layer` 指定图层再提取一次，房间面积会比从房间名推断可靠得多；",
        "- 房间数据核对无误后重跑本命令。",
        "",
        "## 识别到的房间（未做判定）",
        "",
        "| 房间 | 面积㎡ | 置信度 | 依据 |",
        "|---|---|---|---|",
    ]
    for room in rooms:
        lines.append(
            "| %s | %s | %s | %s |"
            % (
                room.get("name", ""),
                room.get("area_m2", ""),
                CONFIDENCE_LABELS.get(room.get("confidence"), "—"),
                "轮廓线" if room.get("source") == "polyline" else "从房间名推断",
            )
        )
    lines += ["", "## 未检查的内容", "", "- 本工具的全部检查项（见上）。"]
    return "\n".join(lines) + "\n"


def main():
    parser = argparse.ArgumentParser(description="plan.json 规范初查")
    parser.add_argument("--plan", required=True)
    parser.add_argument("--rules", help="规则 JSON，默认 plan_rules.residential.json")
    parser.add_argument(
        "--building-type",
        choices=["auto", "unknown", *pg.BUILDING_TYPES],
        default="auto",
        help="建筑类型，默认按房间名识别；规则库不覆盖这个类型时不做判定",
    )
    parser.add_argument("--ceiling-height", type=float, help="吊顶后净高（mm），默认按层高计")
    parser.add_argument("--out", help="报告 .md 路径，默认与 plan.json 同目录")
    parser.add_argument("--no-image", action="store_true", help="不生成标注图")
    args = parser.parse_args()
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except Exception:
            pass
    try:
        plan = pg.load_plan(args.plan)
        rules_path = Path(args.rules) if args.rules else SCRIPT_DIR / "plan_rules.residential.json"
        rules = json.loads(rules_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        sys.exit(f"ERROR: {error}")

    plan_path = Path(args.plan)
    stem = plan_path.name.replace(".plan.json", "").replace(".json", "")
    md_path = Path(args.out) if args.out else plan_path.with_name(f"{stem}.codecheck.md")

    # 建筑类型是项目级设置：优先用命令指定的，其次用 plan.json 里记的（项目档案定的），最后才按房间名猜。
    # 按房间名逐层猜会出现「三层有会议室就判成办公」这种事，同一栋楼各层结论不一致。
    if args.building_type != "auto":
        building_type, type_source = args.building_type, "--building-type 指定"
    elif plan.get("building_type"):
        building_type, type_source = str(plan["building_type"]), "plan.json 里记的"
    else:
        building_type, type_source = pg.infer_building_type(plan), "按房间名识别"
    covered_types = rules.get("building_types")
    if covered_types is not None and building_type not in covered_types:
        covered = "、".join(pg.building_type_label(k) for k in covered_types) or "未声明"
        md_path.parent.mkdir(parents=True, exist_ok=True)
        md_path.write_text(render_uncovered(plan_path, plan, rules, building_type, covered_types, type_source), encoding="utf-8")
        md_path.with_suffix(".json").write_text(
            json.dumps({"rules": rules.get("name"), "building_type": building_type, "building_type_source": type_source, "covered": False, "findings": []}, ensure_ascii=False, indent=1),
            encoding="utf-8",
        )
        print(f"# 规范初查：{plan_path.name}")
        print(f"- 已写入 {md_path.resolve()}")
        kind = "没能判断出建筑类型" if building_type == "unknown" else f"这份图是「{pg.building_type_label(building_type)}」（{type_source}）"
        print(f"- {kind}，规则库「{rules.get('name', '')}」只适用于{covered}，没有做判定。")
        print("- 判断错了就用 --building-type 指定，或在项目档案 project.json 里把 building_type 定下来后重新提取。")
        sys.exit(2)

    coverage = pg.room_coverage(plan)
    if coverage is not None and coverage < 0.5:
        md_path.parent.mkdir(parents=True, exist_ok=True)
        md_path.write_text(render_unreliable(plan_path, plan, coverage), encoding="utf-8")
        md_path.with_suffix(".json").write_text(
            json.dumps({"rules": rules.get("name"), "building_type": building_type, "covered": True, "room_coverage": round(coverage, 3), "findings": []}, ensure_ascii=False, indent=1),
            encoding="utf-8",
        )
        print(f"# 规范初查：{plan_path.name}")
        print(f"- 已写入 {md_path.resolve()}")
        print(f"- 识别到的房间只占外包面积的 {coverage * 100:.0f}%，房间没识别全或墙体识别不完整，没有做判定。")
        print("- 先核对房间（plan_extract 的「需确认 / 警告」），有房间轮廓线时用 --room-layer 指定后重提。")
        sys.exit(2)

    findings = check(plan, rules, args.ceiling_height)

    image_path = md_path.with_suffix(".png")
    image_name = None
    if not args.no_image:
        # 编号顺序与报告“问题清单”一致：先不满足、后需注意
        ordered = [f for f in findings if f["status"] == "fail"] + [f for f in findings if f["status"] == "warn"]
        marks = [{"xy": f["xy"], "label": f["item"]} for f in ordered if f["xy"]]
        try:
            pg.draw_plan(plan, image_path, marks, title=f"规范初查：{stem}")
            image_name = image_path.name
        except Exception as error:  # 缺少 matplotlib 或字体时不影响清单
            print(f"- 警告：标注图生成失败：{error}")
    md_path.parent.mkdir(parents=True, exist_ok=True)
    md_path.write_text(render_markdown(plan_path, plan, rules, findings, image_name, building_type, type_source), encoding="utf-8")
    md_path.with_suffix(".json").write_text(
        json.dumps({"rules": rules.get("name"), "building_type": building_type, "covered": True, "findings": findings}, ensure_ascii=False, indent=1),
        encoding="utf-8",
    )

    fails = [f for f in findings if f["status"] == "fail"]
    warns = [f for f in findings if f["status"] == "warn"]
    print(f"# 规范初查：{plan_path.name}")
    print(f"- 已写入 {md_path.resolve()}" + (f"，标注图 {image_path.resolve()}" if image_name else ""))
    print(f"- 建筑类型：{pg.building_type_label(building_type)}（{type_source}，错了用 --building-type 指定）")
    print(f"- 共 {len(findings)} 项：不满足 {len(fails)}，需注意 {len(warns)}，满足 {len(findings) - len(fails) - len(warns)}")
    for f in fails + warns:
        print(f"- {'❌' if f['status'] == 'fail' else '⚠️'} {f['item']}｜{f['location']}｜{f['detail']}｜{f['clause']}")
    print("- 说明：限值为初查参考值，正式结论前请用 retrieve_regulation_chunks 检索现行条文核对。")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
