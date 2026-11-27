#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""plan_extract / plan_quantity / plan_codecheck 的基准测试。

用可手算的户型当基准：断言具体数值而不是"跑通即可"。
算量和规范结论会进报价单和正式说明，错了用户很难发现，所以必须有第二套可核对的数。

用法：npm run test:plan   （或 python scripts/test_plan_scripts.py）
"""
import json
import math
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
import plan_geom as pg  # noqa: E402

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


def test_price():
    section("报价：示例单价表套在主卧工程量上")
    with open(ROOT / "resources" / "presets" / "price-table.sample.json", encoding="utf-8") as f:
        prices = json.load(f)
    quote = pq.price(pq.compute(bedroom_plan()), prices)
    lines = {ln["code"]: ln for ln in quote["lines"]}
    # 手算：地面 12.00×(1+5%)×260 = 3276.00；墙面 35.51×48 = 1704.48；
    #       踢脚 13.10×(1+5%)×55 = 756.53；平开门 1×2200；清运 1×3000
    check("木地板金额", lines["F01"]["amount"], 3276.00, tol=0.01)
    check("墙面乳胶漆金额", lines["W01"]["amount"], 1704.48, tol=0.01)
    check("踢脚线金额", lines["K01"]["amount"], 756.53, tol=0.02)
    check("平开门金额", lines["D01"]["amount"], 2200.00, tol=0.01)
    check("湿区地砖工程量为 0", lines["F02"]["qty"], 0.0)
    check("直接费小计", quote["subtotal"], 13397.01, tol=0.05)
    fees = {f["name"]: f["amount"] for f in quote["fees"]}
    check("管理费 8%", fees.get("管理费"), 1071.76, tol=0.02)
    check("税金 3%", fees.get("税金"), 401.91, tol=0.02)
    check("合计", quote["total"], 14870.68, tol=0.1)
    check("没有缺失的工程量依据", quote["missing"], [])


def test_xlsx():
    section("Excel 输出：三张表、公式与数值")
    try:
        from openpyxl import load_workbook
    except ImportError:
        print("  ⚠️ 没有 openpyxl，跳过 Excel 测试")
        return
    with open(ROOT / "resources" / "presets" / "price-table.sample.json", encoding="utf-8") as f:
        prices = json.load(f)
    result = pq.compute(bedroom_plan())
    quote = pq.price(result, prices)
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "报价.xlsx")
        pq.write_xlsx(path, "plan.json", result, quote)
        wb = load_workbook(path)
        check("表数量", len(wb.sheetnames), 3)
        check("表名", wb.sheetnames, ["报价单", "房间明细", "工程量汇总"])

        detail = wb["房间明细"]
        check("房间明细首行地面面积", detail["E2"].value, 12.0, tol=0.01)
        check("房间明细首行墙面面积", detail["G2"].value, 35.51, tol=0.01)
        check("房间明细含置信度列", detail["K1"].value, "面积置信度")
        check("房间明细合计行是公式", str(detail["E3"].value).startswith("=SUM("), True)

        quote_ws = wb["报价单"]
        check("报价单金额列是公式", str(quote_ws["I2"].value).startswith("=ROUND("), True)
        check("报价单含合计行", any("合计" in str(c.value) for row in quote_ws.iter_rows() for c in row), True)

        summary = wb["工程量汇总"]
        values = [str(c.value) for row in summary.iter_rows() for c in row if c.value is not None]
        check("汇总含地面合计", any("地面" in v for v in values), True)
        check("汇总含说明", any(v.startswith("说明：") for v in values), True)


def test_extract_two_rooms():
    section("提取：两室带内墙（外墙 200、内墙 200、内门 900）")
    try:
        import ezdxf
    except ImportError:
        print("  ⚠️ 没有 ezdxf，跳过")
        return

    with tempfile.TemporaryDirectory() as tmp:
        dxf_path = os.path.join(tmp, "two.dxf")
        out_path = os.path.join(tmp, "two.json")
        doc = ezdxf.new("R2010")
        doc.units = ezdxf.units.MM
        for name in ("A-WALL", "A-DOOR", "A-ROOM"):
            doc.layers.add(name)
        msp = doc.modelspace()
        # 外墙双线 8000×3000，墙厚 200
        msp.add_lwpolyline([(0, 0), (8000, 0), (8000, 3000), (0, 3000)], close=True, dxfattribs={"layer": "A-WALL"})
        msp.add_lwpolyline([(200, 200), (7800, 200), (7800, 2800), (200, 2800)], close=True, dxfattribs={"layer": "A-WALL"})
        # 内墙在 x=4000，厚 200（两条平行线，应合并成一段墙）
        msp.add_line((4000, 200), (4000, 2800), dxfattribs={"layer": "A-WALL"})
        msp.add_line((4200, 200), (4200, 2800), dxfattribs={"layer": "A-WALL"})
        msp.add_arc((4000, 1500), 900, 0, 90, dxfattribs={"layer": "A-DOOR"})
        msp.add_lwpolyline([(200, 200), (4000, 200), (4000, 2800), (200, 2800)], close=True, dxfattribs={"layer": "A-ROOM"})
        msp.add_lwpolyline([(4200, 200), (7800, 200), (7800, 2800), (4200, 2800)], close=True, dxfattribs={"layer": "A-ROOM"})
        doc.styles.add("CJK", font="simhei.ttf")
        msp.add_text("主卧", height=250, dxfattribs={"layer": "A-ROOM", "style": "CJK"}).set_placement((1800, 1500))
        msp.add_text("客厅", height=250, dxfattribs={"layer": "A-ROOM", "style": "CJK"}).set_placement((5800, 1500))
        doc.saveas(dxf_path)

        proc = subprocess.run(
            [sys.executable, str(SCRIPTS / "plan_extract.py"), dxf_path, "--out", out_path],
            capture_output=True,
            text=True,
            encoding="utf-8",
        )
        check("plan_extract 退出码", proc.returncode, 0)
        if proc.returncode != 0:
            print(proc.stderr[-800:])
            return
        with open(out_path, encoding="utf-8") as f:
            plan = json.load(f)
        # 两条内墙线应合并为一段墙：4 段外墙 + 1 段内墙
        check("墙体段数（内墙合并）", len(plan["walls"]), 5)
        check("房间数", len(plan["rooms"]), 2)
        areas = {r["name"]: r["area_m2"] for r in plan["rooms"]}
        check("主卧面积 3800×2600", areas.get("主卧"), 9.88)
        check("客厅面积 3600×2600", areas.get("客厅"), 9.36)
        q = pq.compute(plan)["quantities"]
        check("地面合计", q["floor_area_all"], 19.24)


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
        check("闭合轮廓线的房间置信度高", plan["rooms"][0].get("confidence"), "high")
        q = pq.compute(plan)["quantities"]
        check("提取后地面合计", q["floor_area_all"], 9.36)


def test_extract_multi_frame():
    section("分幅：一张图两个图框，必须用 --frame 选一个")
    try:
        import ezdxf
    except ImportError:
        print("  ⚠️ 没有 ezdxf，跳过")
        return

    with tempfile.TemporaryDirectory() as tmp:
        dxf_path = os.path.join(tmp, "two_frames.dxf")
        doc = ezdxf.new("R2010")
        doc.units = ezdxf.units.MM
        for name in ("A-WALL", "PUB_TEXT"):
            doc.layers.add(name)
        doc.styles.add("CJK", font="simhei.ttf")
        msp = doc.modelspace()
        # 两个同尺寸图框，各放一间 4000×3000 的房
        for offset, title in ((0, "一层平面图"), (20000, "二层平面图")):
            msp.add_lwpolyline(
                [(offset, 0), (offset + 10000, 0), (offset + 10000, 8000), (offset, 8000)],
                close=True,
                dxfattribs={"layer": "0"},
            )
            msp.add_lwpolyline(
                [
                    (offset + 1000, 1000),
                    (offset + 5000, 1000),
                    (offset + 5000, 4000),
                    (offset + 1000, 4000),
                ],
                close=True,
                dxfattribs={"layer": "A-WALL"},
            )
            # 墙厚 200：内外两条闭合多段线配对成墙段
            msp.add_lwpolyline(
                [
                    (offset + 1200, 1200),
                    (offset + 4800, 1200),
                    (offset + 4800, 3800),
                    (offset + 1200, 3800),
                ],
                close=True,
                dxfattribs={"layer": "A-WALL"},
            )
            msp.add_text(
                title, height=400, dxfattribs={"layer": "PUB_TEXT", "style": "CJK"}
            ).set_placement((offset + 4000, 7000))
        doc.saveas(dxf_path)

        def run(*extra):
            return subprocess.run(
                [sys.executable, str(SCRIPTS / "plan_extract.py"), dxf_path, *extra],
                capture_output=True,
                text=True,
                encoding="utf-8",
            )

        listed = run("--list-plans")
        check("列图框退出码", listed.returncode, 0)
        check("列出两个图框", "共 2 个图框" in listed.stdout, True)
        check("图名含一层平面图", "一层平面图" in listed.stdout, True)

        blocked = run("--out", os.path.join(tmp, "all.json"))
        check("不选图框时拒绝提取", blocked.returncode != 0, True)
        check("拒绝时提示用 --frame", "--frame" in (blocked.stdout + blocked.stderr), True)

        out_path = os.path.join(tmp, "frame1.json")
        picked = run("--frame", "1", "--out", out_path)
        check("按图框提取退出码", picked.returncode, 0)
        if picked.returncode == 0:
            with open(out_path, encoding="utf-8") as f:
                plan = json.load(f)
            check("只提取第一个图框：宽 4000", plan["bounds"]["width"], 4000, tol=1)
            check("只提取第一个图框：深 3000", plan["bounds"]["depth"], 3000, tol=1)


def test_opening_width_from_code():
    section("门窗宽度：实测比编号小 2.5% 时以编号为准")
    import plan_core

    def line(a, b, layer):
        return {"layer": layer, "type": "LINE", "points": [a, b], "closed": False}

    # 240 厚墙，x=1000–1877.5 是门洞（比 M0921 的 900 小 2.5%，门窗块常这么画）
    walls = [line((x0, y), (x1, y), "WALL") for y in (-120, 120) for x0, x1 in ((0, 1000), (1877.5, 5000))]
    arc = [(1000 + 877.5 * math.cos(math.radians(90 * i / 12)), 120 + 877.5 * math.sin(math.radians(90 * i / 12))) for i in range(13)]
    door = [line((1000, 120), (1000, 997.5), "DOOR"), {"layer": "DOOR", "type": "ARC", "points": arc, "closed": False}]
    texts = [{"text": "M0921", "anchor": (1438, -600), "height": 300, "layer": "TEXT"}]
    roles = {"wall": walls, "door": door, "window": [], "room": [], "column": []}
    plan = plan_core.build_plan(roles, texts)
    d = next(o for o in plan["openings"] if o["type"] == "door")
    check("实测 877.5 按编号取 900", d["width"], 900, tol=1)
    check("高度取编号的 2100", d["height"], 2100, tol=1)
    check("编号", d.get("code"), "M0921")
    check("洞口中心不动（原来 1438.75）", d["offset"] + d["width"] / 2, 1438.75, tol=2)
    check("注明按编号取宽", any("宽度按图上编号" in a for a in plan["assumptions"]), True)
    check("结构校验", plan_core.validate_plan(plan), [])

    # 差 9%（820 vs 900）超出「以编号为准」的 5%：宽度按实测，并给出核对提示
    walls2 = [line((x0, y), (x1, y), "WALL") for y in (-120, 120) for x0, x1 in ((0, 1000), (1820, 5000))]
    arc2 = [(1000 + 820 * math.cos(math.radians(90 * i / 12)), 120 + 820 * math.sin(math.radians(90 * i / 12))) for i in range(13)]
    door2 = [line((1000, 120), (1000, 940), "DOOR"), {"layer": "DOOR", "type": "ARC", "points": arc2, "closed": False}]
    plan2 = plan_core.build_plan(dict(roles, wall=walls2, door=door2), texts)
    d2 = next(o for o in plan2["openings"] if o["type"] == "door")
    check("差 9% 时宽度按实测", d2["width"], 820, tol=1)
    check("并提示核对编号", any("相差超过" in w for w in plan2["warnings"]), True)


def test_room_confidence():
    section("房间面积置信度：四面被墙围住才是高，推断矩形没围住要标低")
    import plan_core

    def hwall(y, x0, x1):
        return {"base": {"d": (1.0, 0.0), "n": (0.0, 1.0), "offset": y}, "t0": x0, "t1": x1, "thickness": 200}

    def vwall(x, y0, y1):
        return {"base": {"d": (0.0, 1.0), "n": (-1.0, 0.0), "offset": -x}, "t0": y0, "t1": y1, "thickness": 200}

    closed = [hwall(0, 0, 4000), hwall(3000, 0, 4000), vwall(0, 0, 3000), vwall(4000, 0, 3000)]
    rooms = plan_core.rooms_from_labels([{"text": "主卧", "anchor": (900, 1500), "height": 300, "layer": "ROOM"}], closed, plan_core.DEFAULTS)
    check("四面围合：面积", round(plan_core.polygon_area(rooms[0]["polygon"]) / 1e6, 2), 10.64)
    check("四面围合：置信度高", plan_core.room_confidence(rooms[0], 10.64), "high")

    # 上下两道墙只盖住房间宽度的 1/4 和 3/8：这个「房间」其实不是矩形
    open_sides = [hwall(0, 0, 1000), hwall(3000, 0, 1500), vwall(0, 0, 3000), vwall(4000, 0, 3000)]
    rooms2 = plan_core.rooms_from_labels([{"text": "门厅", "anchor": (900, 1500), "height": 300, "layer": "ROOM"}], open_sides, plan_core.DEFAULTS)
    check("墙只盖住部分：支撑率 < 0.7", rooms2[0]["support"] < 0.7, True)
    check("墙只盖住部分：置信度低", plan_core.room_confidence(rooms2[0], 10.64), "low")

    # 图上标了面积且算出来的对得上：即使轮廓是推断的也算高
    rooms2[0]["label_area_m2"] = round(plan_core.polygon_area(rooms2[0]["polygon"]) / 1e6, 2)
    check("与图上标注一致时置信度高", plan_core.room_confidence(rooms2[0], plan_core.polygon_area(rooms2[0]["polygon"]) / 1e6), "high")

    poly_room = {"source": "polyline", "label_area_m2": None}
    check("闭合轮廓线：置信度高", plan_core.room_confidence(poly_room, 12.0), "high")


def test_building_type():
    section("建筑类型识别")
    check("主卧 → 住宅", pg.infer_building_type(bedroom_plan()), "residential")
    check("两间教室 → 教育", pg.infer_building_type({"rooms": [{"name": "教室"}, {"name": "教室"}, {"name": "开水间"}]}), "education")
    check("教室和办公室打平 → 未识别", pg.infer_building_type({"rooms": [{"name": "教室"}, {"name": "办公室"}]}), "unknown")
    check("认不出 → 未识别", pg.infer_building_type({"rooms": [{"name": "房间1"}]}), "unknown")
    check("没有房间 → 未识别", pg.infer_building_type({"rooms": []}), "unknown")


def test_codecheck_uncovered():
    section("规范初查：规则库不覆盖的建筑类型不做判定")
    plan = bedroom_plan()
    plan["rooms"] = [
        {"id": "R1", "name": "教室", "area_m2": 12.0, "polygon": [[0, 0], [4000, 0], [4000, 3000], [0, 3000]]},
        {"id": "R2", "name": "教室", "area_m2": 12.0, "polygon": [[0, 0], [4000, 0], [4000, 3000], [0, 3000]]},
    ]
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "school.plan.json")
        Path(path).write_text(json.dumps(plan, ensure_ascii=False), encoding="utf-8")

        def run(*extra):
            return subprocess.run(
                [sys.executable, str(SCRIPTS / "plan_codecheck.py"), "--plan", path, "--no-image", *extra],
                capture_output=True,
                text=True,
                encoding="utf-8",
            )

        refused = run()
        check("不覆盖时退出码为 2", refused.returncode, 2)
        check("说明没有做判定", "没有做判定" in refused.stdout, True)
        check("报告里写了怎么继续", "plan_rules.residential.json" in refused.stdout or "规则库" in refused.stdout, True)
        report = Path(tmp) / "school.codecheck.md"
        check("写出了说明报告", report.exists(), True)

        forced = run("--building-type", "residential")
        check("指定住宅后照常判定（900 户门 < 1000）", forced.returncode, 1)
        check("判定里出现门洞宽度", "门洞宽度" in forced.stdout, True)


def test_frames_tiled_sheet():
    section("图幅：一张图纸里平铺多个带图名的图幅")
    import cad_core

    outer = [0, 0, 100000, 60000]
    f1, f2, f3 = [1000, 1000, 30000, 20000], [35000, 1000, 65000, 20000], [1000, 25000, 30000, 50000]
    boxes = [outer, f1, f2, f3]
    texts = [
        {"text": "一层平面图", "anchor": [2000, 1500], "height": 300},
        {"text": "二层平面图", "anchor": [36000, 1500], "height": 300},
        {"text": "南立面图", "anchor": [2000, 25500], "height": 300},
    ]
    frames = cad_core.organize_frames(boxes, outer, "model", texts)
    check("平铺图幅：按图名分出 3 个", len(frames), 3)
    check("不含整张图纸边框", any(frame["bbox"] == outer for frame in frames), False)
    check("编号按阅读顺序（先上后下、先左后右）", [frame["bbox"] for frame in frames], [f3, f1, f2])

    plain = cad_core.organize_frames(boxes, outer, "model", [])
    check("没有图名时退回包含关系（只剩图纸边框）", len(plain), 1)


def test_text_point():
    section("房间名定位：用文字包围盒中心，不用左下角插入点")
    import plan_core

    check("有中心点时用中心", plan_core.text_point({"text": "卧室", "anchor": [1000, 2000], "point": [1300, 2150]}), (1300, 2150))
    check("没有时退回 anchor", plan_core.text_point({"text": "卧室", "anchor": [1, 2]}), (1, 2))


def test_room_regions():
    section("房间轮廓：从房间名泛洪取被墙围住的那一片")
    import plan_core

    def hwall(y, x0, x1):
        return {"base": {"d": (1.0, 0.0), "n": (0.0, 1.0), "offset": y}, "t0": x0, "t1": x1, "thickness": 200}

    def vwall(x, y0, y1):
        return {"base": {"d": (0.0, 1.0), "n": (-1.0, 0.0), "offset": -x}, "t0": y0, "t1": y1, "thickness": 200}

    label = [{"text": "卧室", "anchor": (2000, 1500), "height": 300, "layer": "ROOM"}]

    # 8000×3000 的一整间，中间只有半截隔墙（y 1000–2000）：两半连通，应该算作一间
    open_mid = [hwall(0, 0, 8000), hwall(3000, 0, 8000), vwall(0, 0, 3000), vwall(8000, 0, 3000), vwall(4000, 1000, 2000)]
    rooms = plan_core.rooms_from_labels(label, open_mid, plan_core.DEFAULTS)
    check("连通的两半算一间", len(rooms), 1)
    check("来源是泛洪", rooms[0]["source"], "inferred-region")
    check("面积是整间 7800×2800", round(plan_core.polygon_area(rooms[0]["polygon"]) / 1e6, 2), 21.84)
    check("置信度高", plan_core.room_confidence(rooms[0], 21.84), "high")

    # 隔墙画通到底：两半各自成间，只取房间名所在的那半
    closed_mid = open_mid[:4] + [vwall(4000, 0, 3000)]
    rooms2 = plan_core.rooms_from_labels(label, closed_mid, plan_core.DEFAULTS)
    check("整道隔墙分开：取左半间 3800×2800", round(plan_core.polygon_area(rooms2[0]["polygon"]) / 1e6, 2), 10.64)

    # 顶墙只画了一半（隔断没画）：泛洪漏到图框外面，退回矩形并标低置信度
    leaking = [hwall(0, 0, 8000), hwall(3000, 0, 4000), vwall(0, 0, 3000), vwall(8000, 0, 3000)]
    rooms3 = plan_core.rooms_from_labels(label, leaking, plan_core.DEFAULTS)
    check("漏出去时退回矩形", rooms3[0]["source"], "inferred-rect")
    check("矩形按最近的墙取 7800×2800", round(plan_core.polygon_area(rooms3[0]["polygon"]) / 1e6, 2), 21.84)
    check("置信度判低", plan_core.room_confidence(rooms3[0], 21.84, rooms3[0].get("enclosed")), "low")

    regions = plan_core.room_regions(open_mid, plan_core.DEFAULTS)
    area, touches_edge = regions.probe((2000, 1500))
    check("泛洪区域不碰边界", touches_edge, False)
    check("泛洪面积扣掉了中间那截隔墙", round(area / 1e6, 1), 21.6)

    # L 形房间：6000×6000 缺掉右上角 3000×3000，轮廓要跟着拐，不能退回包围盒
    l_shape = [hwall(0, 0, 6000), vwall(6000, 0, 3000), hwall(3000, 3000, 6000), vwall(3000, 3000, 6000), hwall(6000, 0, 3000), vwall(0, 0, 6000)]
    rooms4 = plan_core.rooms_from_labels([{"text": "客厅", "anchor": (1500, 1500), "height": 300, "layer": "ROOM"}], l_shape, plan_core.DEFAULTS)
    poly = rooms4[0]["polygon"]
    check("L 形房间面积", round(plan_core.polygon_area(poly) / 1e6, 2), 24.64)
    check("L 形轮廓是 6 个顶点", len(poly), 6)
    check("L 形包围盒会比实际大（对照）", round((max(p[0] for p in poly) - min(p[0] for p in poly)) * (max(p[1] for p in poly) - min(p[1] for p in poly)) / 1e6, 2), 33.64)

    # 内墙在 1525（不是格子大小的整数倍）：轮廓要贴到墙面 1425，不能停在栅格边 1450
    offset = [hwall(0, 0, 4000), hwall(3000, 0, 4000), vwall(0, 0, 3000), vwall(4000, 0, 3000), hwall(1525, 0, 4000)]
    rooms5 = plan_core.rooms_from_labels([{"text": "卧室", "anchor": (2000, 700), "height": 300, "layer": "ROOM"}], offset, plan_core.DEFAULTS)
    snapped = rooms5[0]["polygon"]
    check("轮廓贴到墙面：上边正好在 1425", max(p[1] for p in snapped), 1425, tol=0.5)
    check("贴墙后的面积 3800×1325", round(plan_core.polygon_area(snapped) / 1e6, 3), 5.035, tol=0.01)


def test_codecheck_low_coverage():
    section("规范初查：房间只占外包面积一半以下时不判定")
    plan = bedroom_plan()
    plan["bounds"] = {"width": 20000, "depth": 20000}  # 400㎡ 的图里只有一间 12㎡ 的房间
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "sparse.plan.json")
        Path(path).write_text(json.dumps(plan, ensure_ascii=False), encoding="utf-8")
        proc = subprocess.run(
            [sys.executable, str(SCRIPTS / "plan_codecheck.py"), "--plan", path, "--no-image"],
            capture_output=True,
            text=True,
            encoding="utf-8",
        )
        check("退出码为 2", proc.returncode, 2)
        check("说明房间占比过低", "只占外包面积" in proc.stdout, True)
        check("没有给出判定", "不满足" not in proc.stdout, True)


def test_extract_columns_and_codes():
    section("实测图纸回归：柱断墙线 / 门窗同图层 / 门窗编号 / 非房间名文字")
    import plan_core

    def line(a, b, layer):
        return {"layer": layer, "type": "LINE", "points": [a, b], "closed": False}

    # 一道 240 厚的墙，x=4700–5300 被 600×600 的柱子断开，x=7000–7900 是门洞
    walls = [line((x0, y), (x1, y), "WALL") for y in (-120, 120) for x0, x1 in ((0, 4700), (5300, 7000), (7900, 10000))]
    # 窗和门都画在 WINDOW 图层（天正 T3 导出就是这样）：窗是四条平行线，门是门扇线 + 门弧
    window = [line((1000, y), (2500, y), "WINDOW") for y in (-120, -40, 40, 120)]
    window += [line((1000, -120), (1000, 120), "WINDOW"), line((2500, -120), (2500, 120), "WINDOW")]
    arc_pts = [(7000 + 900 * math.cos(math.radians(90 * i / 12)), 120 + 900 * math.sin(math.radians(90 * i / 12))) for i in range(13)]
    door = [line((7000, 120), (7000, 1020), "WINDOW"), {"layer": "WINDOW", "type": "ARC", "points": arc_pts, "closed": False}]
    column = [{"layer": "COLUMN", "type": "LWPOLYLINE", "points": [(4700, -300), (5300, -300), (5300, 300), (4700, 300)], "closed": True}]
    texts = [
        {"text": "C1515", "anchor": (1750, -600), "height": 300, "layer": "WINDOW_TEXT"},
        {"text": "M0921", "anchor": (7450, -600), "height": 300, "layer": "WINDOW_TEXT"},
    ]
    roles = {"wall": walls, "door": [], "window": window + door, "room": [], "column": column}
    plan = plan_core.build_plan(roles, texts)
    s = plan["summary"]
    check("柱子补成墙段：不出推断过道", s["passages"], 0)
    check("柱子补成墙段：一整段墙", s["walls"], 1)
    check("识别到柱", s["columns"], 1)
    check("窗图层上带门弧的一组按门处理", s["doors"], 1)
    check("窗", s["windows"], 1)
    by_type = {o["type"]: o for o in plan["openings"]}
    check("窗按编号 C1515 取高 1500", by_type["window"]["height"], 1500, tol=1)
    check("窗编号", by_type["window"].get("code"), "C1515")
    check("门编号", by_type["door"].get("code"), "M0921")
    check("结构校验", plan_core.validate_plan(plan), [])

    no_col = plan_core.build_plan(dict(roles, column=[]), texts)
    check("不给柱图层时柱位当过道（对照）", no_col["summary"]["passages"], 1)

    for text in ("M1021", "C1815", "FM甲1022", "%%P0.000", "±0.000", "-0.450", "上", "北", "1:100", "首层平面图", "963.80m", "A", "11"):
        check(f"不是房间名：{text}", plan_core.is_label(text), False)
    for text in ("教室", "卫生间", "Lobby"):
        check(f"是房间名：{text}", plan_core.is_label(text), True)
    check("门窗图层上的文字不当房间名", plan_core.is_label("教室", "WINDOW_TEXT"), False)
    check("M1021 = 门 1000×2100", plan_core.parse_opening_code("M1021"), {"code": "M1021", "kind": "door", "width": 1000, "height": 2100})
    check("C1815 = 窗 1800×1500", plan_core.parse_opening_code("C1815")["height"], 1500)


def test_room_region_merged_labels():
    section("泛洪区域里有两个房间名：少了隔墙，两间算成一间，必须标低并报警")
    import plan_core

    def line(a, b):
        return {"layer": "WALL", "type": "LINE", "points": [a, b], "closed": False}

    # 外框 8000×3000（墙厚 200），中间本该有一道隔墙但图上没画；两个“教室”各写在一半里
    walls = []
    for (x0, y0, x1, y1) in ((0, 0, 8000, 0), (0, 3000, 8000, 3000)):
        walls += [line((x0, y0 - 100), (x1, y1 - 100)), line((x0, y0 + 100), (x1, y1 + 100))]
    for x in (0, 8000):
        walls += [line((x - 100, 0), (x - 100, 3000)), line((x + 100, 0), (x + 100, 3000))]
    texts = [
        {"text": "教室", "anchor": (1800, 1500), "point": (2000, 1500), "height": 300, "layer": "PUB_TEXT"},
        {"text": "教室", "anchor": (5800, 1500), "point": (6000, 1500), "height": 300, "layer": "PUB_TEXT"},
    ]
    plan = plan_core.build_plan({"wall": walls, "door": [], "window": [], "room": []}, texts)
    check("只得到一间", len(plan["rooms"]), 1)
    check("同名重复 → 置信度低", plan["rooms"][0]["confidence"], "low")
    check("报警提示少了隔墙", any("隔墙" in w for w in plan["warnings"]), True)

    texts[1] = dict(texts[1], text="储藏")
    plan = plan_core.build_plan({"wall": walls, "door": [], "window": [], "room": []}, texts)
    check("不同名合并成一个名字", plan["rooms"][0]["name"], "教室/储藏")
    check("不同名 → 置信度中（可能是套间）", plan["rooms"][0]["confidence"], "medium")


def fake_measure(plan):
    """按 plan.json 造一份「建得完全正确」的模型实测结果，用来验证核对逻辑本身。"""
    return {
        "status": "ok",
        "bounds_mm": {"width": plan["bounds"]["width"], "depth": plan["bounds"]["depth"], "height": plan["storey"]["height"]},
        "walls": [
            {"id": w["id"], "length": round(math.dist(w["start"], w["end"]), 1), "thickness": w["thickness"], "height": w["height"]}
            for w in plan["walls"]
        ],
        "openings": [
            {"id": o["id"], "type": o["type"], "wall": o["wall"], "width": o["width"], "sill": o.get("sill", 0), "height": o["height"]}
            for o in plan["openings"]
        ],
        "columns": [{"id": c["id"], "width": c["width"], "depth": c["depth"], "height": c["height"]} for c in plan.get("columns", [])],
        "rooms": [{"id": r["id"], "name": r["name"], "area_m2": r["area_m2"]} for r in plan["rooms"]],
    }


def test_verify_closed_loop():
    section("建模核对闭环：完全一致时报通过，差一处就报出来")
    import plan_verify as pv

    plan = bedroom_plan()
    plan["columns"] = [{"id": "K1", "center": [1000, 1000], "width": 600, "depth": 600, "height": 2800}]
    model = fake_measure(plan)
    passed, issues = pv.compare(plan, model)
    check("完全一致：没有不一致项", issues, [])
    check("通过项数大于 0", passed > 0, True)

    model["walls"][0]["thickness"] = 250
    _, issues = pv.compare(plan, model)
    check("墙厚差 50 能报出来", any("厚度" in text for text in issues), True)

    model = fake_measure(plan)
    model["columns"][0]["width"] = 500
    _, issues = pv.compare(plan, model)
    check("柱截面不对能报出来", any("柱 K1" in text for text in issues), True)

    model = fake_measure(plan)
    model["rooms"][0]["area_m2"] = 13.0
    _, issues = pv.compare(plan, model)
    check("房间面积不对能报出来", any("面积" in text for text in issues), True)


def test_building_levels():
    section("多层：层号解析与标高")
    import plan_building as pb

    check("一层", pb.parse_level("一层平面图"), 1)
    check("负一层", pb.parse_level("负一层平面图"), -1)
    check("十一层", pb.parse_level("十一层平面图"), 11)
    check("首层", pb.parse_level("首层平面图"), 1)
    check("标准层认不出层号", pb.parse_level("标准层平面图"), None)
    check("屋顶层认不出层号", pb.parse_level("屋顶层平面图"), None)
    check("标高：一层为 0", pb.elevation_of(1, 3000), 0)
    check("标高：二层 +层高", pb.elevation_of(2, 3000), 3000)
    check("标高：负一层 -层高", pb.elevation_of(-1, 3000), -3000)


def test_verify_building():
    section("建模核对：多层按层号逐层比对")
    import plan_verify as pv

    plan = bedroom_plan()
    building = {
        "schema": "design-agent/building@1",
        "storey": {"height": 2800},
        "bounds": plan["bounds"],
        "floors": [
            {"level": 1, "name": "一层平面图", "elevation": 0, "plan": plan},
            {"level": 2, "name": "二层平面图", "elevation": 2800, "plan": plan},
        ],
    }
    model = {"status": "ok", "floors": [dict(fake_measure(plan), level="1"), dict(fake_measure(plan), level="2")]}
    _, issues = pv.compare(building, model)
    check("两层都对上：没有不一致项", issues, [])

    model["floors"].pop()
    _, issues = pv.compare(building, model)
    check("少一层能报出来", any("第 2 层" in text for text in issues), True)


def test_columns_and_stairs():
    section("柱与楼梯间：柱输出到 plan.json，楼梯间标成通高洞口")
    import plan_core

    def line(a, b):
        return {"layer": "WALL", "type": "LINE", "points": [a, b], "closed": False}

    walls = []
    for (x0, y0, x1, y1) in ((0, 0, 4000, 0), (0, 3000, 4000, 3000)):
        walls += [line((x0, y0 - 100), (x1, y1 - 100)), line((x0, y0 + 100), (x1, y1 + 100))]
    for x in (0, 4000):
        walls += [line((x - 100, 0), (x - 100, 3000)), line((x + 100, 0), (x + 100, 3000))]
    room = {"layer": "ROOM", "type": "LWPOLYLINE", "closed": True, "points": [(100, 100), (3900, 100), (3900, 2900), (100, 2900)]}
    column = {"layer": "COLUMN", "type": "LWPOLYLINE", "closed": True, "points": [(1900, 1400), (2100, 1400), (2100, 1600), (1900, 1600)]}

    stair = plan_core.build_plan(
        {"wall": walls, "door": [], "window": [], "room": [room], "column": [column]},
        [{"text": "楼梯间", "anchor": (1000, 800), "height": 300, "layer": "ROOM"}],
    )
    check("柱写进 plan.columns", len(stair["columns"]), 1)
    check("柱截面 200×200", (stair["columns"][0]["width"], stair["columns"][0]["depth"]), (200, 200))
    check("柱高取层高", stair["columns"][0]["height"], 2800, tol=1)
    check("楼梯间类型", stair["rooms"][0]["type"], "stair")
    check("结构校验", plan_core.validate_plan(stair), [])

    ordinary = plan_core.build_plan(
        {"wall": walls, "door": [], "window": [], "room": [room], "column": []},
        [{"text": "教室", "anchor": (1000, 800), "height": 300, "layer": "ROOM"}],
    )
    check("普通房间类型", ordinary["rooms"][0]["type"], "room")
    check("没有柱时不输出柱", ordinary["columns"], [])


def test_room_outline_corners():
    section("房间轮廓转角：薄墙凹角不被抹成斜边，L 形转角内侧不被咬一块，前室不是楼梯洞口")
    import plan_core

    def line(a, b):
        return {"layer": "WALL", "type": "LINE", "points": [a, b], "closed": False}

    def wall(x0, y0, x1, y1, t):
        h = t / 2
        if y0 == y1:
            return [line((x0, y0 - h), (x1, y0 - h)), line((x0, y0 + h), (x1, y0 + h))]
        return [line((x0 - h, y0), (x0 - h, y1)), line((x0 + h, y0), (x0 + h, y1))]

    def l_room(t):
        walls = []
        for x0, y0, x1, y1 in ((0, 0, 6000, 0), (0, 6000, 3000, 6000), (0, 0, 0, 6000), (6000, 0, 6000, 3000), (3000, 3000, 6000, 3000), (3000, 3000, 3000, 6000)):
            walls += wall(x0, y0, x1, y1, t)
        texts = [{"text": "客厅", "anchor": (1000, 1000), "point": (1200, 1100), "height": 300, "layer": "T"}]
        return plan_core.build_plan({"wall": walls, "door": [], "window": [], "room": []}, texts)["rooms"][0]

    # 60 厚隔墙：净空 (6000-60)×(3000-60) + (3000-60)×3000 = 26.28㎡
    thin = l_room(60)
    check("薄墙 L 形：面积", thin["area_m2"], 26.28)
    check("薄墙 L 形：6 个顶点（凹角没被拉成斜边）", len(thin["polygon"]), 6)
    # 200 厚：(6000-200)×(3000-200) + (3000-200)×3000 = 24.64㎡
    thick = l_room(200)
    check("200 墙 L 形：面积", thick["area_m2"], 24.64)
    check("200 墙 L 形：6 个顶点（转角内侧没被咬一块）", len(thick["polygon"]), 6)

    check("楼梯间是通高洞口", bool(plan_core.STAIR_ROOM_RE.search("楼梯间")), True)
    check("电梯井是通高洞口", bool(plan_core.STAIR_ROOM_RE.search("电梯井")), True)
    check("消防前室有楼板，不是洞口", bool(plan_core.STAIR_ROOM_RE.search("消防前室")), False)


def main():
    test_quantity_bedroom()
    test_quantity_bathroom()
    test_quantity_ceiling_height()
    test_codecheck()
    test_codecheck_wide_door()
    test_price()
    test_xlsx()
    test_extract_two_rooms()
    test_extract_roundtrip()
    test_extract_multi_frame()
    test_extract_columns_and_codes()
    test_opening_width_from_code()
    test_room_confidence()
    test_building_type()
    test_codecheck_uncovered()
    test_frames_tiled_sheet()
    test_text_point()
    test_room_regions()
    test_codecheck_low_coverage()
    test_room_region_merged_labels()
    test_verify_closed_loop()
    test_building_levels()
    test_verify_building()
    test_columns_and_stairs()
    test_room_outline_corners()

    print(f"\n通过 {len(PASS)}，失败 {len(FAIL)}")
    if FAIL:
        for name, got, want in FAIL:
            print(f"  ❌ {name}：得到 {got!r}，期望 {want!r}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
