#!/usr/bin/env python3
"""按 plan.json 计算装修工程量，可套用单价表生成报价单（Excel，金额用公式，改单价即自动重算）。

用法：
  python plan_quantity.py --plan xxx.plan.json [--prices 单价表.json] [--ceiling-height 2600] [--out 报价.xlsx]

- 不给 --prices 时只输出工程量；单价表格式见 resources/presets/price-table.sample.json（其中数值仅为示例，请换成自己的单价）。
- --out 后缀为 .xlsx 时生成 Excel（房间明细 / 工程量汇总 / 报价单三张表），为 .json 时输出 JSON。
- 默认写到 plan.json 同目录的 <图名>.quote.xlsx；stdout 打印工程量汇总与报价合计。
"""
import argparse
import json
import math
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import plan_geom as pg  # noqa: E402

BASIS_LABELS = {
    "floor_area_dry": ("干区地面面积", "㎡"),
    "floor_area_wet": ("湿区地面面积（厨卫阳台）", "㎡"),
    "floor_area_all": ("全部地面面积", "㎡"),
    "wall_area_dry": ("干区墙面面积（扣门窗洞口）", "㎡"),
    "wall_area_wet": ("湿区墙面面积（扣门窗洞口）", "㎡"),
    "ceiling_area_dry": ("干区顶棚面积", "㎡"),
    "ceiling_area_wet": ("湿区顶棚面积", "㎡"),
    "skirting_length": ("踢脚线长度（干区，扣门洞）", "m"),
    "waterproof_area": ("防水面积（湿区地面 + 卫生间墙面 1.8m 高 / 其他湿区 0.3m 高）", "㎡"),
    "door_swing_count": ("平开门", "樘"),
    "door_sliding_count": ("推拉门", "樘"),
    "window_area": ("窗洞面积", "㎡"),
    "window_count": ("窗", "樘"),
    "wall_volume": ("墙体体积（扣洞口）", "m³"),
    "room_count": ("房间数", "间"),
    "lump_sum": ("项", "项"),
}

CONFIDENCE_LABELS = {"high": "高", "medium": "中", "low": "低"}


def compute(plan, ceiling_height=None):
    storey = float(plan.get("storey", {}).get("height", 2800))
    clear = float(ceiling_height) if ceiling_height else storey
    walls = {w["id"]: w for w in plan.get("walls", [])}
    index = pg.opening_index(plan)

    rooms = []
    for room in plan.get("rooms", []):
        poly = room["polygon"]
        area = pg.polygon_area(poly) / 1e6
        perim = pg.polygon_perimeter(poly) / 1000
        hole_area, door_width = 0.0, 0.0
        for item in index:
            if room not in item["rooms"]:
                continue
            o = item["opening"]
            h = min(float(o["height"]) + float(o.get("sill", 0)), clear) - float(o.get("sill", 0))
            hole_area += max(0.0, float(o["width"]) * h) / 1e6
            if o["type"] in ("door", "passage"):
                door_width += float(o["width"]) / 1000
        wall_area = max(0.0, perim * clear / 1000 - hole_area)
        wet = pg.is_wet(room["name"])
        rtype = pg.room_type(room["name"])
        rooms.append(
            {
                "id": room["id"],
                "name": room["name"],
                "type": pg.ROOM_TYPE_LABELS[rtype],
                "wet": wet,
                "confidence": room.get("confidence", "medium"),
                "floor_area": round(area, 2),
                "perimeter": round(perim, 2),
                "wall_area": round(wall_area, 2),
                "ceiling_area": round(area, 2),
                "skirting_length": 0.0 if wet else round(max(0.0, perim - door_width), 2),
                "waterproof_area": round(area + perim * (1.8 if rtype == "bathroom" else 0.3), 2) if wet else 0.0,
            }
        )

    wall_volume = 0.0
    for w in walls.values():
        length = math.dist(w["start"], w["end"])
        v = length * float(w["thickness"]) * float(w["height"])
        for o in plan.get("openings", []):
            if o["wall"] == w["id"]:
                v -= float(o["width"]) * float(w["thickness"]) * float(o["height"])
        wall_volume += v / 1e9
    windows = [o for o in plan.get("openings", []) if o["type"] == "window"]
    doors = [o for o in plan.get("openings", []) if o["type"] == "door"]

    def total(key, pred=lambda r: True):
        return round(sum(r[key] for r in rooms if pred(r)), 2)

    q = {
        "floor_area_dry": total("floor_area", lambda r: not r["wet"]),
        "floor_area_wet": total("floor_area", lambda r: r["wet"]),
        "floor_area_all": total("floor_area"),
        "wall_area_dry": total("wall_area", lambda r: not r["wet"]),
        "wall_area_wet": total("wall_area", lambda r: r["wet"]),
        "ceiling_area_dry": total("ceiling_area", lambda r: not r["wet"]),
        "ceiling_area_wet": total("ceiling_area", lambda r: r["wet"]),
        "skirting_length": total("skirting_length"),
        "waterproof_area": total("waterproof_area"),
        "door_swing_count": sum(1 for o in doors if o.get("style") != "sliding"),
        "door_sliding_count": sum(1 for o in doors if o.get("style") == "sliding"),
        "window_area": round(sum(float(o["width"]) * float(o["height"]) for o in windows) / 1e6, 2),
        "window_count": len(windows),
        "wall_volume": round(wall_volume, 2),
        "room_count": len(rooms),
        "lump_sum": 1,
    }
    door_sizes = {}
    for o in doors:
        key = f"{'推拉门' if o.get('style') == 'sliding' else '平开门'} {int(round(float(o['width'])))}×{int(round(float(o['height'])))}"
        door_sizes[key] = door_sizes.get(key, 0) + 1
    window_sizes = {}
    for o in windows:
        key = f"窗 {int(round(float(o['width'])))}×{int(round(float(o['height'])))}"
        window_sizes[key] = window_sizes.get(key, 0) + 1
    assumptions = [
        f"墙面与开孔按净高 {int(clear)} mm 计算" + ("（未指定吊顶后净高，取层高）" if not ceiling_height else ""),
        "湿区按房间名识别：厨房、卫生间、阳台等",
    ]
    low = [r for r in rooms if r["confidence"] == "low"]
    if low:
        assumptions.append(
            "以下房间的面积置信度低（轮廓没被墙完整围住，或与图上标注的面积差得多），这几行的工程量要人工核对："
            + "、".join(f"{r['name']} {r['floor_area']}㎡" for r in low)
        )
    return {
        "assumptions": assumptions,
        "rooms": rooms,
        "quantities": q,
        "door_schedule": door_sizes,
        "window_schedule": window_sizes,
    }


def price(result, prices):
    q = result["quantities"]
    lines, missing = [], []
    for item in prices.get("items", []):
        basis = item.get("basis", "lump_sum")
        if basis not in q:
            missing.append(f"{item.get('name')}：未知的工程量依据 {basis}")
            continue
        qty = float(item["qty"]) if "qty" in item else float(q[basis]) * float(item.get("factor", 1))
        waste = float(item.get("waste", 0))
        unit_price = float(item.get("price", 0))
        lines.append(
            {
                "category": item.get("category", ""),
                "code": item.get("code", ""),
                "name": item.get("name", ""),
                "spec": item.get("spec", ""),
                "unit": item.get("unit") or BASIS_LABELS.get(basis, ("", ""))[1],
                "basis": basis,
                "qty": round(qty, 2),
                "waste": waste,
                "price": unit_price,
                "amount": round(qty * (1 + waste) * unit_price, 2),
            }
        )
    subtotal = round(sum(line["amount"] for line in lines), 2)
    fees = []
    for fee in prices.get("fees", []):
        fees.append({"name": fee["name"], "rate": float(fee["rate"]), "amount": round(subtotal * float(fee["rate"]), 2)})
    return {
        "currency": prices.get("currency", "CNY"),
        "note": prices.get("note", ""),
        "lines": lines,
        "subtotal": subtotal,
        "fees": fees,
        "total": round(subtotal + sum(f["amount"] for f in fees), 2),
        "missing": missing,
    }


def write_xlsx(path, plan_path, result, quote):
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
    from openpyxl.utils import get_column_letter

    wb = Workbook()
    head_fill = PatternFill("solid", fgColor="1F3A5F")
    head_font = Font(bold=True, color="FFFFFF")
    thin = Side(style="thin", color="C9CED6")
    border = Border(left=thin, right=thin, top=thin, bottom=thin)

    def sheet(ws, headers, rows, widths):
        ws.append(headers)
        for cell in ws[1]:
            cell.fill, cell.font, cell.border = head_fill, head_font, border
            cell.alignment = Alignment(horizontal="center", vertical="center")
        for row in rows:
            ws.append(row)
        for row in ws.iter_rows(min_row=2):
            for cell in row:
                cell.border = border
        for i, w in enumerate(widths, start=1):
            ws.column_dimensions[get_column_letter(i)].width = w
        ws.freeze_panes = "A2"

    ws = wb.active
    ws.title = "房间明细"
    sheet(
        ws,
        ["编号", "房间", "类型", "湿区", "地面㎡", "周长m", "墙面㎡(扣洞口)", "顶棚㎡", "踢脚线m", "防水㎡", "面积置信度"],
        [
            [r["id"], r["name"], r["type"], "是" if r["wet"] else "", r["floor_area"], r["perimeter"], r["wall_area"], r["ceiling_area"], r["skirting_length"], r["waterproof_area"], CONFIDENCE_LABELS.get(r["confidence"], "")]
            for r in result["rooms"]
        ],
        [8, 12, 10, 6, 10, 10, 16, 10, 10, 10, 12],
    )
    n = len(result["rooms"]) + 1
    ws.append(["合计", "", "", "", f"=SUM(E2:E{n})", f"=SUM(F2:F{n})", f"=SUM(G2:G{n})", f"=SUM(H2:H{n})", f"=SUM(I2:I{n})", f"=SUM(J2:J{n})"])
    for cell in ws[n + 1]:
        cell.font = Font(bold=True)
        cell.border = border

    ws2 = wb.create_sheet("工程量汇总")
    rows = [[BASIS_LABELS[k][0], BASIS_LABELS[k][1], v, k] for k, v in result["quantities"].items() if k != "lump_sum"]
    rows += [["门窗表：" + k, "樘", v, ""] for k, v in {**result["door_schedule"], **result["window_schedule"]}.items()]
    sheet(ws2, ["项目", "单位", "数量", "依据代码"], rows, [44, 8, 12, 20])
    ws2.append([])
    for text in result["assumptions"]:
        ws2.append(["说明：" + text])

    if quote:
        ws3 = wb.create_sheet("报价单", 0)
        sheet(
            ws3,
            ["分类", "编号", "项目", "规格", "单位", "工程量", "损耗率", "单价", "金额"],
            [],
            [10, 8, 22, 26, 6, 10, 8, 10, 14],
        )
        for line in quote["lines"]:
            ws3.append([line["category"], line["code"], line["name"], line["spec"], line["unit"], line["qty"], line["waste"], line["price"], None])
            r = ws3.max_row
            ws3.cell(r, 9).value = f"=ROUND(F{r}*(1+G{r})*H{r},2)"
            for c in range(1, 10):
                ws3.cell(r, c).border = border
            ws3.cell(r, 7).number_format = "0%"
            ws3.cell(r, 8).number_format = "#,##0.00"
            ws3.cell(r, 9).number_format = "#,##0.00"
        last = ws3.max_row
        ws3.append(["", "", "直接费小计", "", "", "", "", "", f"=SUM(I2:I{last})"])
        sub_row = ws3.max_row
        fee_rows = []
        for fee in quote["fees"]:
            ws3.append(["", "", fee["name"], "", "", "", fee["rate"], "", f"=ROUND(I{sub_row}*G{ws3.max_row + 1},2)"])
            fee_rows.append(ws3.max_row)
            ws3.cell(ws3.max_row, 7).number_format = "0.0%"
        ws3.append(["", "", "合计", "", "", "", "", "", f"=I{sub_row}" + "".join(f"+I{r}" for r in fee_rows)])
        for r in range(sub_row, ws3.max_row + 1):
            ws3.cell(r, 3).font = Font(bold=True)
            ws3.cell(r, 9).font = Font(bold=True)
            ws3.cell(r, 9).number_format = "#,##0.00"
        ws3.append([])
        ws3.append([f"币种：{quote['currency']}；工程量依据 {Path(plan_path).name}。单价、损耗率可直接修改，金额自动重算。"])
        if quote.get("note"):
            ws3.append([quote["note"]])
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    wb.save(path)


def main():
    parser = argparse.ArgumentParser(description="plan.json → 工程量与报价")
    parser.add_argument("--plan", required=True)
    parser.add_argument("--prices", help="单价表 JSON")
    parser.add_argument("--ceiling-height", type=float, help="吊顶后净高（mm），默认取层高")
    parser.add_argument("--out", help="输出 .xlsx 或 .json")
    args = parser.parse_args()
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except Exception:
            pass
    try:
        plan = pg.load_plan(args.plan)
    except (OSError, ValueError) as error:
        sys.exit(f"ERROR: {error}")
    result = compute(plan, args.ceiling_height)
    quote = None
    if args.prices:
        quote = price(result, json.loads(Path(args.prices).read_text(encoding="utf-8")))

    plan_path = Path(args.plan)
    stem = plan_path.name.replace(".plan.json", "").replace(".json", "")
    target = Path(args.out) if args.out else plan_path.with_name(f"{stem}.quote.xlsx")
    if target.suffix.lower() == ".json":
        target.write_text(json.dumps({"quantities": result, "quote": quote}, ensure_ascii=False, indent=1), encoding="utf-8")
    else:
        write_xlsx(target, plan_path, result, quote)

    q = result["quantities"]
    lines = [
        f"# 工程量：{plan_path.name}",
        f"- 已写入 {target.resolve()}",
        f"- 地面 干区 {q['floor_area_dry']}㎡ / 湿区 {q['floor_area_wet']}㎡；墙面 干区 {q['wall_area_dry']}㎡ / 湿区 {q['wall_area_wet']}㎡；顶棚 {q['ceiling_area_dry'] + q['ceiling_area_wet']:.2f}㎡",
        f"- 踢脚线 {q['skirting_length']}m；防水 {q['waterproof_area']}㎡；平开门 {q['door_swing_count']} 樘、推拉门 {q['door_sliding_count']} 樘；窗 {q['window_count']} 樘 / {q['window_area']}㎡",
    ]
    for text in result["assumptions"]:
        lines.append(f"- 说明：{text}")
    if quote:
        lines.append(f"- 报价：{len(quote['lines'])} 项，直接费 {quote['subtotal']:,.2f}，合计 {quote['total']:,.2f} {quote['currency']}")
        for text in quote["missing"]:
            lines.append(f"- 警告：{text}")
        if quote.get("note"):
            lines.append(f"- 单价表说明：{quote['note']}")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
