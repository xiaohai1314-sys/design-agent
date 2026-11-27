#!/usr/bin/env python3
"""把建模结果和 plan.json 逐项核对：墙长 / 厚 / 高、门窗洞口尺寸、房间地面面积、整体外包尺寸。

用法：
  python plan_verify.py --plan <xxx.plan.json> --model <measure.json> [--tol-mm 5] [--tol-area 0.02]

measure.json 是建模软件读回的实测结果，SketchUp 用 DesignAgentPlanBuilder.measure 的返回值原样保存即可；
其他软件只要输出同样的字段（walls / openings / rooms / bounds_mm）也能用。
全部通过时退出码为 0，有不一致时为 1，stdout 列出每一项差异，便于逐条修正后再核对。
"""
import argparse
import json
import math
import sys
from pathlib import Path


def load(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def compare(plan, model, tol_mm=5.0, tol_area=0.02):
    issues, passed = [], 0

    def check(ok, text):
        nonlocal passed
        if ok:
            passed += 1
        else:
            issues.append(text)

    walls = {w["id"]: w for w in model.get("walls", [])}
    for w in plan.get("walls", []):
        m = walls.get(w["id"])
        if not m:
            issues.append(f"墙 {w['id']}：模型里没有")
            continue
        length = math.dist(w["start"], w["end"])
        check(abs(m["length"] - length) <= tol_mm, f"墙 {w['id']} 长度：plan {length:.0f} / 模型 {m['length']:.0f}")
        check(abs(m["thickness"] - float(w["thickness"])) <= tol_mm, f"墙 {w['id']} 厚度：plan {w['thickness']} / 模型 {m['thickness']}")
        check(abs(m["height"] - float(w["height"])) <= tol_mm, f"墙 {w['id']} 高度：plan {w['height']} / 模型 {m['height']}")
        if "volume_m3" in m:
            expected = length * float(w["thickness"]) * float(w["height"]) / 1e9
            for o in plan.get("openings", []):
                if o["wall"] == w["id"]:
                    expected -= float(o["width"]) * float(w["thickness"]) * float(o["height"]) / 1e9
            check(abs(m["volume_m3"] - expected) <= max(0.01, expected * 0.03), f"墙 {w['id']} 体积：应为 {expected:.3f} m³ / 模型 {m['volume_m3']:.3f} m³（可能缺墙段或洞口位置不对）")
    extra = set(walls) - {w["id"] for w in plan.get("walls", [])}
    if extra:
        issues.append("模型里多出的墙：" + "、".join(sorted(extra)))

    openings = {o["id"]: o for o in model.get("openings", [])}
    for o in plan.get("openings", []):
        m = openings.get(o["id"])
        if not m:
            issues.append(f"洞口 {o['id']}：模型里没有")
            continue
        check(m.get("wall") == o["wall"], f"洞口 {o['id']} 所在墙：plan {o['wall']} / 模型 {m.get('wall')}")
        for key, label in (("width", "宽"), ("sill", "窗台"), ("height", "高")):
            check(abs(float(m.get(key, 0)) - float(o.get(key, 0))) <= tol_mm, f"洞口 {o['id']} {label}：plan {o.get(key)} / 模型 {m.get(key)}")

    rooms = {r["id"]: r for r in model.get("rooms", [])}
    for r in plan.get("rooms", []):
        m = rooms.get(r["id"])
        if not m:
            issues.append(f"房间 {r['id']}（{r['name']}）：模型里没有地面")
            continue
        target = float(r["area_m2"])
        check(abs(float(m["area_m2"]) - target) <= max(0.05, target * tol_area), f"房间 {r['name']} 面积：plan {target:.2f}㎡ / 模型 {m['area_m2']:.2f}㎡")

    bounds = model.get("bounds_mm")
    if bounds and plan.get("bounds"):
        for key, label in (("width", "总宽"), ("depth", "总深")):
            check(abs(float(bounds[key]) - float(plan["bounds"][key])) <= tol_mm * 2, f"{label}：plan {plan['bounds'][key]} / 模型 {bounds[key]}")
    return passed, issues


def main():
    parser = argparse.ArgumentParser(description="核对建模结果与 plan.json")
    parser.add_argument("--plan", required=True)
    parser.add_argument("--model", required=True, help="建模软件读回的实测 JSON")
    parser.add_argument("--tol-mm", type=float, default=5.0)
    parser.add_argument("--tol-area", type=float, default=0.02, help="面积相对误差，默认 2%%")
    args = parser.parse_args()
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except Exception:
            pass
    plan, model = load(args.plan), load(args.model)
    if model.get("status") == "error":
        sys.exit(f"ERROR: 模型实测失败：{model.get('error')}")
    passed, issues = compare(plan, model, args.tol_mm, args.tol_area)
    print(f"# 建模核对：通过 {passed} 项，不一致 {len(issues)} 项")
    for text in issues:
        print(f"- ❌ {text}")
    if not issues:
        print("- ✅ 墙体、洞口、房间面积与外包尺寸均与 plan.json 一致")
    sys.exit(1 if issues else 0)


if __name__ == "__main__":
    main()
