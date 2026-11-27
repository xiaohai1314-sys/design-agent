---
name: report-pack
description: 一键方案汇报包：把读图、平面数据、项目档案、规范初查、工程量报价、情绪板、效果图串成一套带检查点的流程，最后组装成汇报 PPT。用户要“出一套方案汇报”“做方案汇报包 / 提案 PPT”“从图纸到汇报全流程”时使用；只做其中单项（只出图、只算量）时直接用对应技能，不走本流程。
---

# 方案汇报包

一套从图纸到汇报的固定流程。每个阶段结束都有**检查点**：把本阶段结果简要告诉用户，用 `ask_user` 确认或修正后再进入下一阶段。所有中间产物放在工作区的 `.design-agent/report/` 下，最终 PPT 用 `deliver` 交付。

开工先用 `write_todos` 列出下面七个阶段，逐个推进；中途中断后可以从断点继续，已完成的阶段不要重做。

## 阶段与检查点

| # | 阶段 | 做什么 | 检查点（问用户） |
|---|---|---|---|
| 1 | 资料与档案 | 读 `project_profile(action="get")`；缺少类型、面积、风格方向、预算、硬约束时用 `ask_user` 一次问齐，确认后 `update` 写回 | 档案内容是否正确 |
| 2 | 平面数据 | 有 DWG / DXF 时用 cad 技能的 `plan_extract.py` 生成 plan.json，把墙、门窗、房间面积和“需确认”的默认值告诉用户；确认后 `project_profile(action="import_plan")` | 识别结果与层高、门高等默认值 |
| 3 | 规范初查 | `plan_codecheck.py --plan …`，得到问题清单和标注图。对“不满足”的条目，用 `retrieve_regulation_chunks` 检索现行条文核对后再下结论 | 问题是否要调整平面，或在汇报中标注为待解决 |
| 4 | 工程量与报价 | `plan_quantity.py --plan … --prices <单价表> --out .design-agent/report/quote.json`，同时再输出一份 `.xlsx` 给用户。没有单价表时先问用户；只能用示例单价表时必须在汇报里注明“示例单价” | 吊顶后净高、单价表、造价是否在预算内 |
| 5 | 风格意向 | 按 image-prompt-rewrite 技能出一张情绪板（moodboard），风格、主材、否决项以项目档案为准；用 `review_image` 审查 | 风格方向 |
| 6 | 效果图 | 选 3–5 个关键空间（默认客厅、餐厅、主卧，按用户要求增减）。有 SketchUp 白模时用模型视图作底图 `edit_image_with_ref`，否则用平面与档案写提示词 `generate_image`。每张都 `review_image`，不通过按 `prompt_fix` 重出一次 | 是否满意、哪张要重出 |
| 7 | 组装汇报 | 写 `.design-agent/report/deck.json`，运行本技能的 `build_deck.py`，检查输出页数和“跳过”提示，`deliver` 交付 PPT（以及第 4 步的 Excel） | — |

用户说“直接出，不用每步问我”时，可以跳过检查点连续执行，但第 2 步的“需确认”默认值和第 3 步的“不满足”条目仍要在最终回复里列出来。

## 组装 PPT：build_deck.py

```bash
python <技能目录>/scripts/build_deck.py --manifest .design-agent/report/deck.json
```

deck.json 里的路径可以写绝对路径，或相对 deck.json 所在目录；缺少的部分会自动跳过并在输出里提示：

```json
{
  "title": "××住宅室内设计方案",
  "subtitle": "方案汇报 · 第一版",
  "date": "2026-11-27",
  "project_profile": "<项目档案 project.json 的路径>",
  "plan_image": "<plan_codecheck.py 输出的 .png>",
  "codecheck_json": "<plan_codecheck.py 输出的 .json>",
  "quantity_json": "quote.json",
  "analysis": [
    { "title": "功能与动线", "bullets": ["要点一", "要点二"], "image": "<可选，分析图>" }
  ],
  "moodboard": "<情绪板图片>",
  "renders": [{ "path": "<效果图>", "caption": "客厅 · 现代极简" }],
  "next_steps": ["确认主材样板", "确认户门加宽方案"],
  "out": "方案汇报.pptx"
}
```

生成的页面依次是：封面（用第一张效果图）、项目概况、空间清单、平面布置、分析页、风格意向、效果图、规范初查、工程量与造价估算、下一步。

## 注意

- 汇报里的面积、层高、房间名、风格、主材一律取自 project.json 和 plan.json，不要在分析文字里另写数字。
- 规范初查是初查：汇报中引用时写明“依据 ×× 初查，正式结论以现行规范为准”。
- 报价用的是示例单价表时，汇报和回复里都要写明“示例单价，非市场价”。
- 需要更讲究的版式时，可以在 build_deck.py 生成的基础上用 pptx 技能继续修改。
