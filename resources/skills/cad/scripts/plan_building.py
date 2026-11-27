#!/usr/bin/env python3
"""把一张施工图里的各层平面提取出来，合并成一份带标高的 building.json，供建模时按层堆叠。

用法：
  python plan_building.py <图纸.dwg|dxf> --level 1=frame-5 --level 2=frame-9 [--storey 3000] [--out building.json]
  python plan_building.py <图纸.dwg|dxf> --auto [--storey 3000]

- `--level 层号=图幅`：层号 1 是一层（标高 0），2 是二层，-1 是地下一层。图幅编号来自 `plan_extract.py --list-plans`。
- `--auto`：按图名里的层数自动挑（一层 / 二层 / 负一层 / 十一层），标准层、屋顶层、机房层这类认不出层号的不选。
- 层高默认取平面里的 storey.height（plan_extract 默认 2800），可以用 `--storey` 指定。
- 各层按自己的外包框左下角对齐：同栋楼各层外轮廓基本一致时这是对的；外轮廓差得多时需要手动调整。
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


def elevation_of(level, storey):
    """一层楼面标高为 0，二层 +层高，地下一层 -层高。"""
    return level * storey if level <= 0 else (level - 1) * storey


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
    for frame in cad_core.top_level_frames(collected):
        level = parse_level(frame.get("label"))
        if level is None:
            continue
        if level in seen:
            skipped.append((level, frame["id"].split(":", 1)[-1], frame.get("label")))
            continue
        seen[level] = frame["id"]
        picks.append((level, frame["id"].split(":", 1)[-1], frame.get("label")))
    picks.sort(key=lambda item: item[0])
    return picks, skipped


def main():
    parser = argparse.ArgumentParser(description="各层平面 → building.json")
    parser.add_argument("input", help="DWG / DXF 图纸路径")
    parser.add_argument("--level", action="append", default=[], help="层号=图幅，可重复：--level 1=frame-5 --level 2=frame-9")
    parser.add_argument("--auto", action="store_true", help="按图名里的层数自动挑各层平面")
    parser.add_argument("--storey", type=float, help="层高（mm），默认取平面里的 storey.height")
    parser.add_argument("--wall-layer", help="墙体图层，透传给 plan_extract")
    parser.add_argument("--room-layer", help="房间轮廓图层，透传给 plan_extract")
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
        auto_skipped = []
        if args.auto:
            picks, auto_skipped = auto_levels(source)
            if len(picks) < 2:
                raise SystemExit("按图名只认出 %d 个楼层平面，请用 --level 层号=图幅 指定（图幅编号见 plan_extract.py --list-plans）" % len(picks))
        else:
            if not args.level:
                raise SystemExit("请用 --level 层号=图幅 指定各层，或加 --auto 按图名自动挑")
            picks = []
            for spec in args.level:
                level_text, _, frame = spec.partition("=")
                if not frame:
                    raise SystemExit("--level 的格式是 层号=图幅，收到「%s」" % spec)
                picks.append((int(level_text), frame, None))
            picks.sort(key=lambda item: item[0])

        extra = []
        if args.wall_layer:
            extra += ["--wall-layer", args.wall_layer]
        if args.room_layer:
            extra += ["--room-layer", args.room_layer]

        with tempfile.TemporaryDirectory() as tmp:
            plans = [(level, name, frame, extract(source, frame, tmp, extra)) for level, frame, name in picks]

        storey = args.storey or plans[0][3].get("storey", {}).get("height") or 2800.0
        floors = []
        for level, name, frame, plan in plans:
            floors.append(
                {
                    "level": level,
                    "name": name or plan.get("source", {}).get("frame") or "frame-%s" % frame,
                    "frame": frame,
                    "elevation": elevation_of(level, storey),
                    "plan": plan,
                }
            )
        width = max(float(floor["plan"]["bounds"]["width"]) for floor in floors)
        depth = max(float(floor["plan"]["bounds"]["depth"]) for floor in floors)
        building = {
            "schema": SCHEMA,
            "units": "mm",
            "source": {"file": str(source.resolve()), "levels": [{"level": floor["level"], "frame": floor["frame"]} for floor in floors]},
            "storey": {"height": storey},
            "bounds": {"width": width, "depth": depth},
            "floors": floors,
            "assumptions": [
                "各层按自己的外包框左下角对齐；各层外轮廓差得多时，模型里会有错位，需要手动调整。",
                "层高 %s 是统一值，不是从图上读的；不同层高时用 --storey 分别合并。" % storey,
            ],
            "warnings": sorted({text for floor in floors for text in floor["plan"].get("warnings", [])}),
        }
        for level, frame, label in auto_skipped:
            building["warnings"].append(
                "第 %s 层还认出一个图幅 %s（%s），没有选进来；如果这一层是它，用 --level %s=%s 指定。" % (level, frame, label or "无图名", level, frame)
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
        print(f"- 第 {floor['level']} 层（{floor['name']}）标高 {floor['elevation']}：墙 {s['walls']}、门 {s['doors']}、窗 {s['windows']}、柱 {s.get('columns', 0)}、房间 {s['rooms']} 个 {s['room_area_m2']}㎡")
    for text in building["assumptions"]:
        print(f"- 需确认：{text}")
    if building["warnings"]:
        print(f"- 警告 {len(building['warnings'])} 条（逐条见 building.json 的 warnings），例如：{building['warnings'][0][:80]}")


if __name__ == "__main__":
    main()
