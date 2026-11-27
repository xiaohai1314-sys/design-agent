#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""plan_extract / plan_quantity / plan_codecheck 的基准测试。

用可手算的户型当基准：断言具体数值而不是"跑通即可"。
算量和规范结论会进报价单和正式说明，错了用户很难发现，所以必须有第二套可核对的数。

用法：npm run test:plan   （或 python scripts/test_plan_scripts.py）
"""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = ROOT / "resources" / "skills" / "cad" / "scripts"
sys.path.insert(0, str(SCRIPTS))

import plan_quantity as pq  # noqa: E402
import plan_codecheck as pc  # noqa: E402

PASS, FAIL = [], []


def check(name, got, want, tol=0.01):
    if isinstance(want, (int, float)) and isinstance(got, (int, float)):
        ok = abs(got - want) <= tol
    else:
        ok = got == want
    (PASS if ok else FAIL).append((name, got, want))
    mark = "✅" if ok else "❌"
    print(f"  {mark} {name}" + ("" if ok else f"：得到 {got!r}，期望 {want!r}"))


def section(title):
    print(f"\n{title}")


# ---------------------------------------------------------------- 基准户型
# 主卧净空 4000×3000，墙厚 200，层高 2800；南墙一樘 900×2100 平开门，北墙一扇 1500×1200 窗（窗台 900）。
# 手算：面积 12.00㎡、周长 14.00m、洞口 1.89+1.80=3.69㎡、墙面 14×2.8-3.69=35.51㎡、
#       踢脚 14.0-0.9=13.10m、墙体积 (4.0+3.0)×2×0.2×2.8-0.378-0.36=7.10m³
def bedroom_plan():
    return {
        "schema": "design-agent/plan@1",
        "bounds": {"width": 4000, "depth": 3000},
        "storey": {"height": 2800},
        "walls": [
            {"id": "W1", "start": [0, 0], "end": [4000, 0], "thickness": 200, "height": 2800},
            {"id": "W2", "start": [4000, 0], "end": [4000, 3000], "thickness": 200, "height": 2800},
            {"id": "W3", "start": [4000, 3000], "end": [0, 3000], "thickness": 200, "height": 2800},
            {"id": "W4", "start": [0, 3000], "end": [0, 0], "thickness": 200, "height": 2800},
        ],
        "openings": [
            {"id": "D1", "wall": "W1", "offset": 1500, "width": 900, "height": 2100, "sill": 0, "type": "door", "style": "swing"},
            {"id": "N1", "wall": "W3", "offset": 1000, "width": 1500, "height": 1200, "sill": 900, "type": "window"},
        ],
        "rooms": [
            {"id": "R1", "name": "主卧", "area_m2": 12.0, "polygon": [[0, 0], [4000, 0], [4000, 3000], [0, 3000]]}
        ],
    }


# 卫生间净空 2000×1800，无洞口。手算：面积 3.60㎡、周长 7.60m、
# 墙面 7.6×2.8=21.28㎡、踢脚 0（湿区）、防水 3.6+7.6×1.8=17.28㎡
def bathroom_plan():
    return {
        "schema": "design-agent/plan@1",
        "bounds": {"width": 2000, "depth": 1800},
        "storey": {"height": 2800},
        "walls": [
            {"id": "B1", "start": [0, 0], "end": [2000, 0], "thickness": 200, "height": 2800},
            {"id": "B2", "start": [2000, 0], "end": [2000, 1800], "thickness": 200, "height": 2800},
            {"id": "B3", "start": [2000, 1800], "end": [0, 1800], "thickness": 200, "height": 2800},
            {"id": "B4", "start": [0, 1800], "end": [0, 0], "thickness": 200, "height": 2800},
        ],
        "openings": [],
        "rooms": [
            {"id": "R9", "name": "卫生间", "area_m2": 3.6, "polygon": [[0, 0], [2000, 0], [2000, 1800], [0, 1800]]}
        ],
    }


def rules():
    with open(SCRIPTS / "plan_rules.residential.json", encoding="utf-8") as f:
        return json.load(f)


def test_quantity_bedroom():
    section("工程量：主卧（净空 4000×3000，墙厚 200，层高 2800）")
    r = pq.compute(bedroom_plan())
    room = r["rooms"][0]
    q = r["quantities"]
    check("地面面积", room["floor_area"], 12.00)
    check("周长", room["perimeter"], 14.00)
    check("墙面面积（扣门窗洞口）", room["wall_area"], 35.51)
    check("顶棚面积", room["ceiling_area"], 12.00)
    check("踢脚线（扣门洞）", room["skirting_length"], 13.10)
    check("干区防水为 0", room["waterproof_area"], 0.0)
    check("平开门樘数", q["door_swing_count"], 1)
    check("窗面积", q["window_area"], 1.80)
    check("窗樘数", q["window_count"], 1)
    check("墙体体积", q["wall_volume"], 7.10)
    check("房间数", q["room_count"], 1)


def test_quantity_bathroom():
    section("工程量：卫生间（湿区，净空 2000×1800）")
    r = pq.compute(bathroom_plan())
    room = r["rooms"][0]
    check("地面面积", room["floor_area"], 3.60)
    check("墙面面积", room["wall_area"], 21.28)
    check("湿区踢脚线为 0", room["skirting_length"], 0.0)
    check("防水面积（面积+周长×1.8）", room["waterproof_area"], 17.28)
    check("湿区地面合计", r["quantities"]["floor_area_wet"], 3.60)
    check("干区地面合计", r["quantities"]["floor_area_dry"], 0.0)


def test_quantity_ceiling_height():
    section("工程量：指定吊顶后净高 2400")
    r = pq.compute(bedroom_plan(), ceiling_height=2400)
    # 墙面 14×2.4-3.69=29.91；洞口高度按 min(高+窗台, 净高)-窗台 计算
    check("墙面面积按净高 2400 计", r["rooms"][0]["wall_area"], 29.91)
    check("说明里标注了净高", "2400" in r["assumptions"][0], True)


def test_codecheck():
    section("规范初查：主卧 + 900 宽户门")
    findings = pc.check(bedroom_plan(), rules())
    fails = [f for f in findings if f["status"] == "fail"]
    check("检查项总数", len(findings), 6)
    check("不满足项数", len(fails), 1)
    check("不满足的是门洞宽度", fails[0]["item"] if fails else None, "门洞宽度")
    check("引用条文", fails[0]["clause"] if fails else None, "GB 50096-2011 第 5.8.7 条")
    check("判定依据含 900mm", "900mm" in (fails[0]["detail"] if fails else ""), True)
    items = {f["item"]: f["status"] for f in findings}
    check("卧室面积判定", items.get("卧室面积"), "pass")
    check("门洞高度判定", items.get("门洞高度"), "pass")
    check("直接采光判定", items.get("直接采光"), "pass")


def test_codecheck_wide_door():
    section("规范初查：门加宽到 1000 后应全部通过")
    plan = bedroom_plan()
    plan["openings"][0]["width"] = 1000
    findings = pc.check(plan, rules())
    check("不满足项数", sum(1 for f in findings if f["status"] == "fail"), 0)


def test_extract_roundtrip():
    section("提取：合成 DXF → plan.json → 算量")
    try:
        import ezdxf  # noqa: F401
    except ImportError:
        print("  ⚠️ 没有 ezdxf，跳过提取测试")
        return
    import ezdxf

    with tempfile.TemporaryDirectory() as tmp:
        dxf_path = os.path.join(tmp, "plan.dxf")
        out_path = os.path.join(tmp, "plan.json")
        doc = ezdxf.new("R2010")
        doc.units = ezdxf.units.MM
        for name in ("A-WALL", "A-DOOR", "A-WIND", "A-ROOM"):
            doc.layers.add(name)
        msp = doc.modelspace()
        # 外墙双线：外框 0..4000 × 0..3000，内框内缩 200
        msp.add_lwpolyline([(0, 0), (4000, 0), (4000, 3000), (0, 3000)], close=True, dxfattribs={"layer": "A-WALL"})
        msp.add_lwpolyline([(200, 200), (3800, 200), (3800, 2800), (200, 2800)], close=True, dxfattribs={"layer": "A-WALL"})
        msp.add_arc((1500, 200), 900, 0, 90, dxfattribs={"layer": "A-DOOR"})
        msp.add_line((1500, 200), (1500, 1100), dxfattribs={"layer": "A-DOOR"})
        msp.add_line((1000, 2800), (2500, 2800), dxfattribs={"layer": "A-WIND"})
        msp.add_line((1000, 3000), (2500, 3000), dxfattribs={"layer": "A-WIND"})
        msp.add_lwpolyline([(200, 200), (3800, 200), (3800, 2800), (200, 2800)], close=True, dxfattribs={"layer": "A-ROOM"})
        doc.styles.add("CJK", font="simhei.ttf")
        msp.add_text("主卧", height=250, dxfattribs={"layer": "A-ROOM", "style": "CJK"}).set_placement((1800, 1500))
        doc.saveas(dxf_path)

        proc = subprocess.run(
            [sys.executable, str(SCRIPTS / "plan_extract.py"), dxf_path, "--out", out_path],
            capture_output=True,
            text=True,
            encoding="utf-8",
        )
        if proc.returncode != 0:
            check("plan_extract 退出码", proc.returncode, 0)
            print(proc.stderr[-800:])
            return
        with open(out_path, encoding="utf-8") as f:
            plan = json.load(f)
        check("墙体段数", len(plan["walls"]), 4)
        check("门数", sum(1 for o in plan["openings"] if o["type"] == "door"), 1)
        check("窗数", sum(1 for o in plan["openings"] if o["type"] == "window"), 1)
        check("房间数", len(plan["rooms"]), 1)
        # 内净空 3600×2600 = 9.36㎡
        check("房间面积", plan["rooms"][0]["area_m2"], 9.36)
        q = pq.compute(plan)["quantities"]
        check("提取后地面合计", q["floor_area_all"], 9.36)


def main():
    test_quantity_bedroom()
    test_quantity_bathroom()
    test_quantity_ceiling_height()
    test_codecheck()
    test_codecheck_wide_door()
    test_extract_roundtrip()

    print(f"\n通过 {len(PASS)}，失败 {len(FAIL)}")
    if FAIL:
        for name, got, want in FAIL:
            print(f"  ❌ {name}：得到 {got!r}，期望 {want!r}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
