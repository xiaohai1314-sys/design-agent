#!/usr/bin/env python3
"""方案汇报包：把项目档案、平面图、规范初查、工程量报价、效果图和分析要点组装成一份 16:9 汇报 PPT。

用法：
  python build_deck.py --manifest deck.json

deck.json 示例（路径可以是绝对路径，或相对 deck.json 所在目录）：
{
  "title": "××住宅室内设计方案",
  "subtitle": "方案汇报 · 第一版",
  "date": "2026-11-27",
  "project_profile": ".design-agent/project.json",
  "plan_image": ".design-agent/plans/plan.codecheck.png",
  "codecheck_json": ".design-agent/plans/plan.codecheck.json",
  "quantity_json": ".design-agent/plans/plan.quote.json",
  "analysis": [{"title": "功能与动线", "bullets": ["……"], "image": "renders/flow.png"}],
  "moodboard": "renders/moodboard.png",
  "renders": [{"path": "renders/living.png", "caption": "客厅 · 现代极简"}],
  "next_steps": ["确认主材样板", "……"],
  "out": "汇报/方案汇报.pptx"
}
缺少的部分自动跳过；输出路径默认为 deck.json 同目录的 <title>.pptx。
"""
import argparse
import json
import sys
from pathlib import Path

from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN
from pptx.util import Emu, Inches, Pt

W, H = Inches(13.333), Inches(7.5)
PRIMARY = RGBColor(0x1F, 0x3A, 0x5F)
ACCENT = RGBColor(0xC2, 0x7C, 0x2C)
TEXT = RGBColor(0x33, 0x33, 0x33)
MUTED = RGBColor(0x88, 0x88, 0x88)
FONT = "Microsoft YaHei"


def resolve(base, value):
    if not value:
        return None
    p = Path(value)
    p = p if p.is_absolute() else base / p
    return p if p.exists() else None


def textbox(slide, x, y, w, h, text, size=16, bold=False, color=TEXT, align=PP_ALIGN.LEFT):
    box = slide.shapes.add_textbox(x, y, w, h)
    frame = box.text_frame
    frame.word_wrap = True
    lines = text if isinstance(text, list) else [text]
    for i, line in enumerate(lines):
        para = frame.paragraphs[0] if i == 0 else frame.add_paragraph()
        para.alignment = align
        run = para.add_run()
        run.text = str(line)
        run.font.size = Pt(size)
        run.font.bold = bold
        run.font.color.rgb = color
        run.font.name = FONT
        para.space_after = Pt(6)
    return box


def page(prs, title, number):
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    bar = slide.shapes.add_shape(1, 0, 0, W, Inches(0.12))
    bar.fill.solid()
    bar.fill.fore_color.rgb = PRIMARY
    bar.line.fill.background()
    textbox(slide, Inches(0.6), Inches(0.35), Inches(11), Inches(0.8), title, size=26, bold=True, color=PRIMARY)
    textbox(slide, Inches(12.2), Inches(7.0), Inches(0.9), Inches(0.4), str(number), size=11, color=MUTED, align=PP_ALIGN.RIGHT)
    return slide


def picture(slide, path, x, y, max_w, max_h):
    try:
        from PIL import Image

        with Image.open(path) as img:
            iw, ih = img.size
    except Exception:
        iw, ih = 16, 9
    scale = min(max_w / iw, max_h / ih)
    w, h = int(iw * scale), int(ih * scale)
    slide.shapes.add_picture(str(path), x + (max_w - w) // 2, y + (max_h - h) // 2, w, h)


def table(slide, x, y, w, rows, col_widths, font_size=12):
    shape = slide.shapes.add_table(len(rows), len(rows[0]), x, y, w, Emu(int(Inches(0.38)) * len(rows)))
    tbl = shape.table
    total = sum(col_widths)
    for i, cw in enumerate(col_widths):
        tbl.columns[i].width = int(w * cw / total)
    for r, row in enumerate(rows):
        for c, value in enumerate(row):
            cell = tbl.cell(r, c)
            para = cell.text_frame.paragraphs[0]
            run = para.add_run()
            run.text = "" if value is None else str(value)
            run.font.size = Pt(font_size)
            run.font.name = FONT
            if r == 0:
                cell.fill.solid()
                cell.fill.fore_color.rgb = PRIMARY
                run.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)
                run.font.bold = True
    return tbl


def build(manifest_path):
    manifest_path = Path(manifest_path)
    base = manifest_path.parent
    m = json.loads(manifest_path.read_text(encoding="utf-8"))
    prs = Presentation()
    prs.slide_width, prs.slide_height = W, H
    n = 0
    skipped = []

    # 封面
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    bg = slide.shapes.add_shape(1, 0, 0, W, H)
    bg.fill.solid()
    bg.fill.fore_color.rgb = PRIMARY
    bg.line.fill.background()
    cover = resolve(base, (m.get("renders") or [{}])[0].get("path") if m.get("renders") else None)
    if cover:
        picture(slide, cover, Inches(6.9), Inches(0.6), Inches(6.0), Inches(6.3))
    textbox(slide, Inches(0.7), Inches(2.4), Inches(6.0), Inches(1.4), m.get("title", "设计方案汇报"), size=36, bold=True, color=RGBColor(0xFF, 0xFF, 0xFF))
    textbox(slide, Inches(0.7), Inches(3.8), Inches(6.0), Inches(0.8), m.get("subtitle", ""), size=18, color=RGBColor(0xE6, 0xD3, 0xB8))
    textbox(slide, Inches(0.7), Inches(6.5), Inches(6.0), Inches(0.5), m.get("date", ""), size=12, color=RGBColor(0xC8, 0xD2, 0xE0))
    n += 1

    # 项目概况
    profile_path = resolve(base, m.get("project_profile"))
    if profile_path:
        p = json.loads(profile_path.read_text(encoding="utf-8"))
        n += 1
        slide = page(prs, "项目概况", n)
        facts = []
        for label, key in (("项目", "name"), ("类型", "building_type"), ("地点", "location")):
            if p.get(key):
                facts.append(f"{label}：{p[key]}")
        if p.get("total_area_m2") is not None:
            facts.append(f"套内面积：{p['total_area_m2']} ㎡")
        if p.get("storey_height_mm") is not None:
            facts.append(f"层高：{p['storey_height_mm']} mm")
        style = p.get("style") or {}
        if style.get("direction") or style.get("keywords"):
            facts.append("风格：" + "、".join([style.get("direction", "")] + style.get("keywords", [])).strip("、"))
        budget = p.get("budget") or {}
        if budget.get("total") is not None:
            facts.append(f"预算：{budget['total']:,} {budget.get('currency', '元')}")
        textbox(slide, Inches(0.7), Inches(1.4), Inches(5.8), Inches(5.5), facts or ["（档案中暂无概况信息）"], size=16)
        right = []
        if p.get("constraints"):
            right.append("硬约束")
            right += [f"· {c}" for c in p["constraints"]]
        if p.get("rejected"):
            right.append("不采用")
            right += [f"· {c}" for c in p["rejected"]]
        if p.get("materials"):
            right.append("主材")
            right += [f"· {x['item']}：{x['spec']}" for x in p["materials"]]
        if right:
            textbox(slide, Inches(6.9), Inches(1.4), Inches(5.8), Inches(5.5), right, size=14)
        if p.get("rooms"):
            n += 1
            slide = page(prs, "空间清单", n)
            rows = [["房间", "面积（㎡）", "功能 / 备注"]] + [[r.get("name", ""), r.get("area_m2", ""), r.get("function") or r.get("notes") or ""] for r in p["rooms"]]
            table(slide, Inches(0.7), Inches(1.4), Inches(11.9), rows[:16], [3, 2, 7])
    else:
        skipped.append("项目概况（未提供 project_profile）")

    # 平面
    plan_image = resolve(base, m.get("plan_image"))
    if plan_image:
        n += 1
        slide = page(prs, "平面布置", n)
        picture(slide, plan_image, Inches(0.6), Inches(1.2), Inches(12.1), Inches(5.9))
    else:
        skipped.append("平面图")

    # 分析
    for block in m.get("analysis", []):
        n += 1
        slide = page(prs, block.get("title", "设计分析"), n)
        img = resolve(base, block.get("image"))
        if img:
            textbox(slide, Inches(0.7), Inches(1.4), Inches(4.6), Inches(5.6), block.get("bullets", []), size=15)
            picture(slide, img, Inches(5.6), Inches(1.2), Inches(7.1), Inches(5.9))
        else:
            textbox(slide, Inches(0.7), Inches(1.4), Inches(11.9), Inches(5.6), block.get("bullets", []), size=17)

    # 情绪板
    mood = resolve(base, m.get("moodboard"))
    if mood:
        n += 1
        slide = page(prs, "风格意向", n)
        picture(slide, mood, Inches(0.6), Inches(1.2), Inches(12.1), Inches(5.9))

    # 效果图
    for item in m.get("renders", []):
        img = resolve(base, item.get("path"))
        if not img:
            skipped.append(f"效果图 {item.get('path')}（文件不存在）")
            continue
        n += 1
        slide = page(prs, item.get("caption", "效果图"), n)
        picture(slide, img, Inches(0.6), Inches(1.2), Inches(12.1), Inches(5.9))

    # 规范初查
    codecheck = resolve(base, m.get("codecheck_json"))
    if codecheck:
        data = json.loads(codecheck.read_text(encoding="utf-8"))
        findings = data.get("findings", [])
        bad = [f for f in findings if f["status"] != "pass"]
        n += 1
        slide = page(prs, "规范初查", n)
        summary = f"共 {len(findings)} 项，不满足 {sum(1 for f in bad if f['status'] == 'fail')} 项，需注意 {sum(1 for f in bad if f['status'] == 'warn')} 项（{data.get('rules', '')}；正式结论以现行规范条文为准）"
        textbox(slide, Inches(0.7), Inches(1.2), Inches(11.9), Inches(0.6), summary, size=13, color=MUTED)
        rows = [["状态", "项目", "位置", "实际 / 要求", "依据"]] + [["不满足" if f["status"] == "fail" else "需注意", f["item"], f["location"], f["detail"], f["clause"]] for f in bad[:10]]
        if len(rows) == 1:
            rows.append(["满足", "全部项目", "", "", ""])
        table(slide, Inches(0.7), Inches(1.9), Inches(11.9), rows, [1.2, 1.8, 3.2, 3.6, 2.6], font_size=11)

    # 工程量与报价
    quantity = resolve(base, m.get("quantity_json"))
    if quantity:
        data = json.loads(quantity.read_text(encoding="utf-8"))
        q = data.get("quantities", {}).get("quantities", {})
        quote = data.get("quote")
        n += 1
        slide = page(prs, "工程量与造价估算", n)
        rows = [
            ["项目", "数量"],
            ["地面（干区 / 湿区）", f"{q.get('floor_area_dry', 0)} / {q.get('floor_area_wet', 0)} ㎡"],
            ["墙面（干区 / 湿区）", f"{q.get('wall_area_dry', 0)} / {q.get('wall_area_wet', 0)} ㎡"],
            ["顶棚", f"{round(q.get('ceiling_area_dry', 0) + q.get('ceiling_area_wet', 0), 2)} ㎡"],
            ["防水", f"{q.get('waterproof_area', 0)} ㎡"],
            ["踢脚线", f"{q.get('skirting_length', 0)} m"],
            ["门（平开 / 推拉）", f"{q.get('door_swing_count', 0)} / {q.get('door_sliding_count', 0)} 樘"],
            ["窗", f"{q.get('window_count', 0)} 樘 / {q.get('window_area', 0)} ㎡"],
        ]
        table(slide, Inches(0.7), Inches(1.4), Inches(5.6), rows, [3, 2])
        if quote:
            lines = [f"直接费：{quote['subtotal']:,.2f} {quote['currency']}"] + [f"{f['name']}（{f['rate']:.0%}）：{f['amount']:,.2f}" for f in quote.get("fees", [])]
            lines.append(f"合计：{quote['total']:,.2f} {quote['currency']}")
            textbox(slide, Inches(6.9), Inches(1.4), Inches(5.8), Inches(3.0), lines, size=20, bold=True, color=PRIMARY)
            if quote.get("note"):
                textbox(slide, Inches(6.9), Inches(4.6), Inches(5.8), Inches(2.0), quote["note"], size=12, color=MUTED)

    # 下一步
    if m.get("next_steps"):
        n += 1
        slide = page(prs, "下一步", n)
        textbox(slide, Inches(0.7), Inches(1.4), Inches(11.9), Inches(5.6), [f"{i + 1}. {s}" for i, s in enumerate(m["next_steps"])], size=18)

    out = Path(m["out"]) if m.get("out") else base / f"{m.get('title', '方案汇报')}.pptx"
    out = out if out.is_absolute() else base / out
    out.parent.mkdir(parents=True, exist_ok=True)
    prs.save(out)
    return out, n, skipped


def main():
    parser = argparse.ArgumentParser(description="组装方案汇报 PPT")
    parser.add_argument("--manifest", required=True)
    args = parser.parse_args()
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except Exception:
            pass
    try:
        out, count, skipped = build(args.manifest)
    except (OSError, ValueError, KeyError) as error:
        sys.exit(f"ERROR: {error}")
    print(f"# 方案汇报包\n- 已写入 {out.resolve()}（{count} 页）")
    for text in skipped:
        print(f"- 跳过：{text}")


if __name__ == "__main__":
    main()
