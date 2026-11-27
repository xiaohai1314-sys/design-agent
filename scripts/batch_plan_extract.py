#!/usr/bin/env python3
r"""批量测试平面识别：对一个文件夹里的 DWG / DXF 逐张运行 plan_extract，并把诊断材料集中到一个输出目录。

用法（在项目根目录）：
  resources\runtime\python\python.exe scripts\batch_plan_extract.py 测试图纸 [--out 测试图纸\_out] [--all]

每张图在 <out>/<图名>/ 下生成：
  source.dxf        DWG 转换后的 DXF（便于离线分析几何）
  info.json         cad.py info 的结果（单位、图幅、图层、块、警告）
  stats.json        各图层 / 实体类型 / 块的数量，含天正等代理对象的统计
  overview*.png     cad.py render 出的总览图
  *.plan.json       plan_extract 的结果（有多个图幅时按图幅分别提取）
  extract.log       plan_extract 的完整输出
另在 <out>/summary.md 汇总每张图的识别数量与报错。
文件名含“剖面 / 立面 / 详图 / 大样 / 节点”的图默认跳过（不是平面），加 --all 全部处理。
"""
import argparse
import json
import re
import shutil
import subprocess
import sys
import time
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CAD_DIR = ROOT / "resources" / "skills" / "cad" / "scripts"
sys.path.insert(0, str(CAD_DIR))

import cad_core  # noqa: E402

SKIP_RE = re.compile(r"剖面|立面|详图|大样|节点|section|elevation|detail", re.I)


def run(args, log):
    started = time.time()
    proc = subprocess.run([sys.executable, *map(str, args)], capture_output=True, text=True, encoding="utf-8", errors="replace", cwd=ROOT)
    log.write(f"$ {' '.join(map(str, args))}\n{proc.stdout}{proc.stderr}\n[exit {proc.returncode}, {time.time() - started:.1f}s]\n\n")
    return proc


def stats_for(source):
    document, warnings = cad_core.open_document(source)
    model = document.modelspace()
    by_layer_type = Counter()
    proxies = Counter()
    for entity in model:
        kind = entity.dxftype()
        layer = str(entity.dxf.get("layer", "0") or "0")
        by_layer_type[f"{layer} | {kind}"] += 1
        if kind in ("ACAD_PROXY_ENTITY",) or kind.startswith("TCH_") or kind.startswith("TDB"):
            proxies[kind] += 1
    blocks = Counter(str(e.dxf.get("name", "")) for e in model.query("INSERT"))
    block_layers = Counter(str(e.dxf.get("layer", "")) for e in model.query("INSERT"))
    code, unit = cad_core.drawing_units(document)
    return {
        "units": {"code": code, "name": unit},
        "warnings": list(warnings) + ([cad_core.tangent_warning(document)] if cad_core.tangent_warning(document) else []),
        "entity_total": len(model),
        "by_layer_type": dict(by_layer_type.most_common(80)),
        "proxy_entities": dict(proxies),
        "insert_blocks": dict(blocks.most_common(60)),
        "insert_layers": dict(block_layers.most_common(30)),
    }


def main():
    parser = argparse.ArgumentParser(description="批量测试平面识别")
    parser.add_argument("folder")
    parser.add_argument("--out")
    parser.add_argument("--all", action="store_true", help="不跳过剖面 / 立面等非平面图")
    args = parser.parse_args()
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except Exception:
            pass
    folder = Path(args.folder).resolve()
    out_root = Path(args.out).resolve() if args.out else folder / "_out"
    out_root.mkdir(parents=True, exist_ok=True)
    files = sorted(p for p in folder.rglob("*") if p.suffix.lower() in (".dwg", ".dxf") and out_root not in p.parents)
    summary = ["# 平面识别批量测试", "", f"- 目录：{folder}", f"- 时间：{time.strftime('%Y-%m-%d %H:%M')}", "", "| 图纸 | 图幅 | 墙 | 门 | 窗 | 房间 | 面积㎡ | 结果 |", "|---|---|---|---|---|---|---|---|"]
    for source in files:
        if not args.all and SKIP_RE.search(source.stem):
            summary.append(f"| {source.name} | — | | | | | | 跳过（非平面） |")
            continue
        name = re.sub(r'[<>:"/\\|?*]', "_", f"{source.parent.name}__{source.stem}")[:80]
        out = out_root / name
        out.mkdir(parents=True, exist_ok=True)
        print(f"== {source.name}")
        with (out / "extract.log").open("w", encoding="utf-8") as log:
            try:
                dxf = cad_core.dxf_path_for(source)
                if dxf != source:
                    shutil.copy2(dxf, out / "source.dxf")
                else:
                    shutil.copy2(source, out / "source.dxf")
            except Exception as error:
                log.write(f"DWG 转换失败：{error}\n")
                summary.append(f"| {source.name} | — | | | | | | ❌ 转换失败：{str(error)[:60]} |")
                continue
            try:
                (out / "stats.json").write_text(json.dumps(stats_for(source), ensure_ascii=False, indent=1), encoding="utf-8")
            except Exception as error:
                log.write(f"统计失败：{error}\n")
            run([CAD_DIR / "cad.py", "info", source, "--format", "json", "--out", out / "info.json"], log)
            run([CAD_DIR / "cad.py", "render", source, "--out", out / "render"], log)
            frames = []
            try:
                info = json.loads((out / "info.json").read_text(encoding="utf-8"))
                model_layout = next((l for l in info.get("layouts", []) if l.get("id") == "model"), None)
                frames = [f["id"].split(":", 1)[-1] for f in (model_layout or {}).get("frames", []) if not f.get("within")]
            except Exception as error:
                log.write(f"读取 info.json 失败：{error}\n")
            targets = [(f, ["--frame", f]) for f in frames] if len(frames) >= 2 else [("全图", [])]
            for label, extra in targets:
                plan_path = out / (f"{label}.plan.json" if extra else "plan.json")
                proc = run([CAD_DIR / "plan_extract.py", source, *extra, "--out", plan_path], log)
                if proc.returncode != 0 or not plan_path.exists():
                    reason = (proc.stdout + proc.stderr).strip().splitlines()[-1:] or ["未知错误"]
                    summary.append(f"| {source.name} | {label} | | | | | | ❌ {reason[0][:70]} |")
                    continue
                plan = json.loads(plan_path.read_text(encoding="utf-8"))
                s = plan["summary"]
                flags = []
                if plan.get("warnings"):
                    flags.append(f"警告 {len(plan['warnings'])}")
                failed = [c for c in plan.get("checks", []) if not c.get("ok")]
                if failed:
                    flags.append(f"自检失败 {len(failed)}")
                summary.append(f"| {source.name} | {label} | {s['walls']} | {s['doors']} | {s['windows']} | {s['rooms']} | {s['room_area_m2']} | {'；'.join(flags) or '✅'} |")
    (out_root / "summary.md").write_text("\n".join(summary) + "\n", encoding="utf-8")
    print(f"\n完成，汇总见 {out_root / 'summary.md'}")


if __name__ == "__main__":
    main()
