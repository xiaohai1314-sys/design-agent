#!/usr/bin/env python3
"""把一张施工图里的各层平面提取出来，合并成一份带标高的 building.json，供建模时按层堆叠。

用法：
  python plan_building.py <图纸.dwg|dxf> --level 1=frame-5 --level 2=frame-9 [--storey 3000] [--out building.json]
  python plan_building.py <图纸.dwg|dxf> --auto [--storey 3000]

- `--level 层号=图幅`：层号 1 是一层（标高 0），2 是二层，-1 是地下一层。图幅编号来自 `plan_extract.py --list-plans`。
- `--auto`：按图名里的层数自动挑（一层 / 二层 / 负一层 / 十一层）；屋顶层、机房层、机房屋顶排到最高层之上；标准层认不出是哪几层，不选。
- `--level roof=frame-8`：手动指定屋顶层，不用自己数层号。
- 层高默认取平面里的 storey.height（plan_extract 默认 2800），可以用 `--storey` 指定。
- 各层按轴网对齐：同名轴线（1 轴 × A 轴等）的交点在各层重合；某层没有轴网或与基准层对不上时退回外包框左下角对齐，并给出警告。
"""
import argparse
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import cad_core  # noqa: E402

SCHEMA = "design-agent/building@1"
CN_DIGITS = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10}


def cn_number(text):
    """一 → 1、十一 → 11、二十三 → 23、3 → 3。"""
    if text.isdigit():
        return int(text)
    if "十" in text:
        head, _, tail = text.partition("十")
        return (CN_DIGITS.get(head, 1) if head else 1) * 10 + (CN_DIGITS.get(tail, 0) if tail else 0)
    return CN_DIGITS.get(text)


def parse_level(label):
    """图名 → 层号：负一层 -1、一层 1、十一层 11；标准层 / 屋顶层 / 机房层返回 None。"""
    text = (label or "").strip()
    if not text:
        return None
    match = re.search(r"(?:负|地下)([一二三四五六七八九十]+|\d+)层", text)
    if match:
        value = cn_number(match.group(1))
        return -value if value else None
    match = re.search(r"(?:第)?([一二三四五六七八九十]+|\d+)层", text)
    if match:
        return cn_number(match.group(1))
    if "首层" in text:
        return 1
    return None


# 没有层号的顶部楼层：屋顶 / 屋面 → 主体最高层之上一层；机房层、楼梯间层再往上；机房 / 楼梯间屋顶最上。
# 规则按顺序匹配，先匹配到的优先（「机房屋顶」不能被「屋顶」先吃掉）。
ROOF_RANKS = (
    (3, re.compile(r"(?:机房|楼梯间|电梯间|水箱间?)(?:层)?屋(?:顶|面)|小屋面|出屋面.*屋(?:顶|面)")),
    (2, re.compile(r"机房层|电梯机房|楼梯间层|出屋面层|水箱间")),
    (1, re.compile(r"屋顶|屋面|顶层平面")),
)
NOT_PLAN_TITLE = re.compile(r"立面|剖面|详图|大样|节点|轴测|效果")


def roof_rank(label):
    """图名 → 顶部楼层的次序（1 屋顶层、2 机房层、3 机房屋顶），不是这类图名返回 None。"""
    text = (label or "").strip()
    if not text or NOT_PLAN_TITLE.search(text) or parse_level(text) is not None:
        return None
    for rank, pattern in ROOF_RANKS:
        if pattern.search(text):
            return rank
    return None


def elevation_of(level, storey):
    """一层楼面标高为 0，二层 +层高，地下一层 -层高。"""
    return level * storey if level <= 0 else (level - 1) * storey


def _axis_key(label):
    if label.isdigit():
        return (0, int(label), label)
    if label.isalpha():
        return (1, sum((ord(ch) - 64) * 26 ** k for k, ch in enumerate(reversed(label))), label)
    return (2, 0, label)


def _intersect(first, second):
    (ax, ay), (dx, dy) = first["point"], first["dir"]
    (bx, by), (ex, ey) = second["point"], second["dir"]
    det = dx * (-ey) - dy * (-ex)
    if abs(det) < 0.5:
        return None
    s = ((bx - ax) * (-ey) - (by - ay) * (-ex)) / det
    return (ax + dx * s, ay + dy * s)


def _axis_lines(plan):
    return {line["label"]: line for line in (plan.get("axes") or {}).get("lines", [])}


def _pair_point(lines, number, letter):
    if number in lines and letter in lines:
        return _intersect(lines[number], lines[letter])
    return None


def translate_plan(plan, dx, dy):
    """把一层平面整体平移（墙端点、柱中心、房间轮廓与扣柱块、轴线）；门窗是沿墙的相对距离，不用动。"""
    if abs(dx) < 1e-9 and abs(dy) < 1e-9:
        return
    move = lambda p: [round(p[0] + dx, 1), round(p[1] + dy, 1)]
    for wall in plan.get("walls", []):
        wall["start"], wall["end"] = move(wall["start"]), move(wall["end"])
    for column in plan.get("columns", []):
        column["center"] = move(column["center"])
    for room in plan.get("rooms", []):
        room["polygon"] = [move(p) for p in room["polygon"]]
        # 扣柱块也要跟着走：建模时按它在地面上挖洞，不跟着平移会把洞挖到别处
        for cut in room.get("column_cuts", []):
            cut["polygon"] = [move(p) for p in cut["polygon"]]
    axes = plan.get("axes")
    if axes:
        for line in axes.get("lines", []):
            line["point"] = move(line["point"])
        if axes.get("origin"):
            axes["origin"] = move(axes["origin"])
    source = plan.get("source")
    if source and source.get("origin_offset"):
        ox, oy = source["origin_offset"]
        source["origin_offset"] = [round(ox - dx, 1), round(oy - dy, 1)]


def align_floors(floors, tolerance=50.0):
    """按轴网对齐各层：同名轴线（如 1 轴 × A 轴）的交点在各层重合。

    外包框左下角会随阳台、雨篷、退台、屋顶只剩楼梯间而变，按它对齐时上下层会错位；轴网是各层共用的定位基准。
    以有轴网的最低一层为基准；每层取与基准共有的「最小数字轴 × 最小字母轴」算平移，再用共有的
    「最大数字轴 × 最大字母轴」复核（两处平移差超过 tolerance 说明轴距不同或认错了轴，退回外包框对齐）。
    直接改写 floors[i]["plan"] 的坐标，返回 (warnings, 每层的对齐方式)。
    """
    warnings = []
    reference = next((floor for floor in floors if len(_axis_lines(floor["plan"])) >= 2), None)
    if reference is None:
        for floor in floors:
            floor["alignment"] = {"method": "bounds"}
        return ["各层都没有识别到轴网，按外包框左下角对齐；各层外轮廓不一致时模型会错位。"], floors
    ref_lines = _axis_lines(reference["plan"])
    for floor in floors:
        if floor is reference:
            floor["alignment"] = {"method": "axis", "reference": True, "offset": [0.0, 0.0]}
            continue
        lines = _axis_lines(floor["plan"])
        common = sorted(set(lines) & set(ref_lines), key=_axis_key)
        numbers = [k for k in common if k.isdigit()]
        letters = [k for k in common if k.isalpha()]
        offsets = []
        for number, letter in ((numbers[0], letters[0]), (numbers[-1], letters[-1])) if numbers and letters else ():
            here, there = _pair_point(lines, number, letter), _pair_point(ref_lines, number, letter)
            if here is None or there is None:
                continue
            offsets.append(((there[0] - here[0], there[1] - here[1]), (number, letter)))
        parallel = all(
            abs(lines[k]["dir"][0] * ref_lines[k]["dir"][0] + lines[k]["dir"][1] * ref_lines[k]["dir"][1]) > 0.999 for k in common
        )
        label = "第 %s 层（%s）" % (floor["level"], floor["name"])
        if not offsets:
            floor["alignment"] = {"method": "bounds"}
            warnings.append("%s没有和基准层共有的数字轴 + 字母轴，按外包框左下角对齐，可能与其他层错位。" % label)
            continue
        if not parallel:
            floor["alignment"] = {"method": "bounds"}
            warnings.append("%s的轴线方向和基准层不一致（图幅可能旋转过），按外包框左下角对齐。" % label)
            continue
        (dx, dy), labels = offsets[0]
        if len(offsets) > 1:
            (dx2, dy2), labels2 = offsets[1]
            if abs(dx2 - dx) > tolerance or abs(dy2 - dy) > tolerance:
                floor["alignment"] = {"method": "bounds"}
                warnings.append(
                    "%s用 %s×%s 和 %s×%s 两处轴线交点算出的平移差了 (%.0f, %.0f) mm，轴距和基准层不一致或认错了轴，按外包框左下角对齐。"
                    % (label, labels[0], labels[1], labels2[0], labels2[1], dx2 - dx, dy2 - dy)
                )
                continue
        translate_plan(floor["plan"], dx, dy)
        floor["alignment"] = {"method": "axis", "labels": list(labels), "offset": [round(dx, 1), round(dy, 1)]}
    return warnings, floors


def extract(source, frame, out_dir, extra):
    target = Path(out_dir) / f"level-{frame}.plan.json"
    command = [sys.executable, str(SCRIPT_DIR / "plan_extract.py"), str(source), "--frame", str(frame), "--out", str(target), *extra]
    proc = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if proc.returncode != 0 or not target.exists():
        detail = (proc.stdout + proc.stderr).strip().splitlines()
        raise RuntimeError("图幅 %s 提取失败：%s" % (frame, detail[-1] if detail else "未知错误"))
    return json.loads(target.read_text(encoding="utf-8"))


def auto_levels(source):
    """按图名挑出各层平面。返回 ([(层号, 图幅编号, 图名)], [同一层号但没用上的图幅])。"""
    document, _warnings = cad_core.open_document(source)
    spec = cad_core.find_layout(document, "model")
    collected = cad_core.collect_layout_cached(spec, cad_core.source_cache_key(source))
    picks, seen, skipped = [], {}, []
    frames = list(cad_core.top_level_frames(collected))
    for frame in frames:
        level = parse_level(frame.get("label"))
        if level is None:
            continue
        if level in seen:
            skipped.append((level, frame["id"].split(":", 1)[-1], frame.get("label")))
            continue
        seen[level] = frame["id"]
        picks.append((level, frame["id"].split(":", 1)[-1], frame.get("label")))
    picks.sort(key=lambda item: item[0])
    roofs = pick_roofs(frames, picks, skipped)
    picks += [(level, frame_id, label) for level, frame_id, label in roofs]
    return picks, skipped, {level for level, _frame, _label in roofs}


def pick_roofs(frames, picks, skipped):
    """屋顶层 / 机房层图名里没有层号：排到主体最高层之上，按 屋顶 → 机房层 → 机房屋顶 的次序编号。"""
    above = [level for level, _frame, _label in picks if level >= 1]
    if not above:
        return []
    top = max(above)
    by_rank = {}
    for frame in frames:
        rank = roof_rank(frame.get("label"))
        if rank is None:
            continue
        frame_id = frame["id"].split(":", 1)[-1]
        if rank in by_rank:
            skipped.append(("屋顶类 %d" % rank, frame_id, frame.get("label")))
            continue
        by_rank[rank] = (frame_id, frame.get("label"))
    return [(top + index + 1, by_rank[rank][0], by_rank[rank][1]) for index, rank in enumerate(sorted(by_rank))]


def main():
    parser = argparse.ArgumentParser(description="各层平面 → building.json")
    parser.add_argument("input", help="DWG / DXF 图纸路径")
    parser.add_argument("--level", action="append", default=[], help="层号=图幅，可重复：--level 1=frame-5 --level 2=frame-9；屋顶层写 roof=frame-8")
    parser.add_argument("--auto", action="store_true", help="按图名里的层数自动挑各层平面")
    parser.add_argument("--storey", type=float, help="层高（mm），默认取平面里的 storey.height")
    parser.add_argument("--building-type", help="建筑类型，写进 building.json 和每一层，规范初查按它选规则库")
    parser.add_argument("--wall-layer", help="墙体图层，透传给 plan_extract")
    parser.add_argument("--room-layer", help="房间轮廓图层，透传给 plan_extract")
    parser.add_argument("--axis-layer", help="轴线图层，透传给 plan_extract（按轴网对齐各层用）")
    parser.add_argument("--out", help="输出路径，默认 <当前目录>/.design-agent/plans/<图名>.building.json")
    args = parser.parse_args()
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except Exception:
            pass

    source = Path(args.input)
    try:
        if args.auto and args.level:
            raise SystemExit("--auto 与 --level 只能给一个")
        auto_skipped, roof_levels = [], set()
        if args.auto:
            picks, auto_skipped, roof_levels = auto_levels(source)
            if len(picks) < 2:
                raise SystemExit("按图名只认出 %d 个楼层平面，请用 --level 层号=图幅 指定（图幅编号见 plan_extract.py --list-plans）" % len(picks))
        else:
            if not args.level:
                raise SystemExit("请用 --level 层号=图幅 指定各层，或加 --auto 按图名自动挑")
            picks, roof_frames = [], []
            for spec in args.level:
                level_text, _, frame = spec.partition("=")
                if not frame:
                    raise SystemExit("--level 的格式是 层号=图幅，收到「%s」" % spec)
                if level_text.strip().lower() in ("roof", "r", "屋顶"):
                    # 屋顶层不用自己数层号：--level roof=frame-8，排到最高层之上
                    roof_frames.append(frame)
                    continue
                picks.append((int(level_text), frame, None))
            picks.sort(key=lambda item: item[0])
            top = max((level for level, _f, _n in picks), default=0)
            for index, frame in enumerate(roof_frames):
                picks.append((top + index + 1, frame, None))
                roof_levels.add(top + index + 1)

        extra = []
        if args.wall_layer:
            extra += ["--wall-layer", args.wall_layer]
        if args.room_layer:
            extra += ["--room-layer", args.room_layer]
        if args.axis_layer:
            extra += ["--axis-layer", args.axis_layer]
        if args.storey:
            # 层高必须同时传给提取：墙高、柱高、窗台校正都按 plan 里的 storey 算，
            # 只改标高不改墙高的话，层高 4200 时每层墙只有 2800，楼层之间空出 1400 的缝
            extra += ["--height", str(args.storey)]

        with tempfile.TemporaryDirectory() as tmp:
            plans = [(level, name, frame, extract(source, frame, tmp, extra)) for level, frame, name in picks]

        storey = args.storey or plans[0][3].get("storey", {}).get("height") or 2800.0
        heights = {float(plan.get("storey", {}).get("height") or storey) for _level, _name, _frame, plan in plans}
        if len(heights) > 1:
            raise RuntimeError("各层平面的层高不一致（%s），请用 --storey 统一指定" % "、".join(str(h) for h in sorted(heights)))
        floors = []
        for level, name, frame, plan in plans:
            if args.building_type:
                plan["building_type"] = args.building_type
            floors.append(
                {
                    "level": level,
                    "name": name or plan.get("source", {}).get("frame") or "frame-%s" % frame,
                    "frame": frame,
                    # roof：屋顶层 / 机房层，只有楼梯间、机房和女儿墙；建模时它下面那一层也要做顶棚
                    "kind": "roof" if level in roof_levels else "floor",
                    "elevation": elevation_of(level, storey),
                    "plan": plan,
                }
            )
        align_warnings, _ = align_floors(floors)
        aligned = [floor for floor in floors if floor["alignment"]["method"] == "axis"]
        width = max(float(floor["plan"]["bounds"]["width"]) for floor in floors)
        depth = max(float(floor["plan"]["bounds"]["depth"]) for floor in floors)
        building = {
            "schema": SCHEMA,
            "units": "mm",
            "source": {"file": str(source.resolve()), "levels": [{"level": floor["level"], "frame": floor["frame"]} for floor in floors]},
            **({"building_type": args.building_type} if args.building_type else {}),
            "storey": {"height": storey},
            "bounds": {"width": width, "depth": depth},
            "floors": floors,
            "assumptions": [
                (
                    "各层按轴网对齐（以第 %s 层为基准，同名轴线交点重合）。" % next(f["level"] for f in floors if f["alignment"].get("reference"))
                    if len(aligned) == len(floors)
                    else "%d / %d 层按轴网对齐，其余按外包框左下角对齐（见 warnings）。" % (len(aligned), len(floors))
                    if aligned
                    else "各层按自己的外包框左下角对齐；各层外轮廓差得多时，模型里会有错位，需要手动调整。"
                ),
                "层高 %s 是统一值，不是从图上读的；不同层高时用 --storey 分别合并。" % storey,
            ],
            "warnings": align_warnings + sorted({text for floor in floors for text in floor["plan"].get("warnings", [])}),
        }
        for level, frame, label in auto_skipped:
            if isinstance(level, str):
                building["warnings"].append("%s还认出一个图幅 %s（%s），没有选进来；需要它时用 --level roof=%s 手动指定。" % (level, frame, label or "无图名", frame))
                continue
            building["warnings"].append(
                "第 %s 层还认出一个图幅 %s（%s），没有选进来；如果这一层是它，用 --level %s=%s 指定。" % (level, frame, label or "无图名", level, frame)
            )
        if roof_levels:
            building["assumptions"].append(
                "第 %s 层是屋顶层 / 机房层（图名里没有层号，排在主体最高层之上），层高按统一层高算；女儿墙、屋面板不建模。"
                % "、".join(str(level) for level in sorted(roof_levels))
            )
    except (RuntimeError, SystemExit) as error:
        sys.exit(f"ERROR: {error}")

    target = Path(args.out) if args.out else Path.cwd() / ".design-agent" / "plans" / f"{source.stem}.building.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(building, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")

    print(f"# 楼层合并：{source.name}")
    print(f"- 已写入 {target.resolve()}")
    print(f"- {len(floors)} 层，层高 {storey} mm，外包 {width} × {depth} mm")
    for floor in floors:
        plan = floor["plan"]
        s = plan["summary"]
        how = floor.get("alignment", {})
        how_text = ("轴网 %s×%s 对齐，平移 %s" % (how["labels"][0], how["labels"][1], how["offset"])) if how.get("labels") else ("轴网基准层" if how.get("reference") else "外包框对齐")
        print(f"- 第 {floor['level']} 层（{floor['name']}）标高 {floor['elevation']}，{how_text}：墙 {s['walls']}、门 {s['doors']}、窗 {s['windows']}、柱 {s.get('columns', 0)}、房间 {s['rooms']} 个 {s['room_area_m2']}㎡")
    for text in building["assumptions"]:
        print(f"- 需确认：{text}")
    if building["warnings"]:
        print(f"- 警告 {len(building['warnings'])} 条（逐条见 building.json 的 warnings），例如：{building['warnings'][0][:80]}")


if __name__ == "__main__":
    main()
