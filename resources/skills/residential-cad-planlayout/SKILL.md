---
name: residential-cad-planlayout
description: 只在用户上传住宅户型 CAD 文件（DWG / DXF）并要求设计或调整住宅平面布局时使用：读原始户型，保留承重结构，检查家具尺度与通行动线，交付可编辑的 DXF 平面方案。只有户型图片、截图或扫描件时不要用本技能；办公、商铺、酒店等非住宅项目排除；要求三维建模、效果图或施工图时同样排除。
---

# 住宅平面布局（CAD 户型）

把原始 CAD 户型转成满足居住需求的平面方案。先保证结构准确、尺度可用，再谈表达。

## 能力边界

- 只处理**住宅**户型。办公、商铺、酒店客房等按项目用途分流。
- 输入必须是原生 CAD（DWG / DXF）。图片、截图、扫描件走二维平面流程，不要用本技能。
- 输出是**可编辑 DXF**，不是施工图，也不是效果图。默认一版方案，不主动扩展成多方案比选。
- 承重墙、柱、管井一律保留。本技能不判断结构可拆性，方案里不得移动或删除这些构件。

## 工作流

### 1. 读原始户型

CAD 解析工具箱在本技能的兄弟目录：`<技能目录>/../cad/scripts/cad.py`。

```bash
python <技能目录>/../cad/scripts/cad.py info 户型.dwg
```

先 `info` 拿到单位、Layout 与图幅列表，确定哪一帧是平面图。后面所有命令都用 `--frame N`，不要自己估坐标。

```bash
python <技能目录>/../cad/scripts/cad.py render 户型.dwg --frame N            # 先看一眼
python <技能目录>/../cad/scripts/cad.py dims 户型.dwg --frame N              # 开间进深
python <技能目录>/../cad/scripts/cad.py geom 户型.dwg --frame N --layer 墙,WALL,柱 --origin bbox
python <技能目录>/../cad/scripts/cad.py blocks 户型.dwg --frame N --name 门,窗
```

要点：

- 尺寸以 `dims` 的测量值为准，显示文字可能被改写过。
- 墙线按图层过滤；图层名不固定时，先用 `info` 看图层清单再定 `--layer`。
- 门窗按块名找，加 `--nested` 能带出嵌套块。
- `--origin bbox` 把坐标平移到图幅左下角，后续 JSON 一律用这个本地坐标系。

### 2. 先定保留项，再排布

动手之前先列清楚，并写进最终说明：

- 承重墙、剪力墙、柱、管井：不动
- 入户门位置：通常不动
- 卫生间、厨房的排水立管：决定湿区能不能挪
- 外墙开窗：决定房间朝向和采光面

这些是方案的前提，不能只体现在图上。

### 3. 排布并生成 DXF

如果户型已经用 cad 技能出过 `plan.json`，直接转成 `layout.json`，不要手抄一遍：

```bash
python <技能目录>/../cad/scripts/plan_extract.py 户型.dwg --out 户型.plan.json
python <技能目录>/scripts/plan_to_layout.py --plan 户型.plan.json --out layout.json
```

转换会带上墙的中心线与厚度、门窗位置（按沿墙偏移算）和房间多边形。
`plan.json` 里没有家具几何，`furniture` 输出为空数组，排布时自己补。

没有 `plan.json` 时，用 `layout.json` 手写描述方案，先校验再出图：

```bash
python <技能目录>/scripts/plan_dxf.py check layout.json
python <技能目录>/scripts/plan_dxf.py build layout.json 平面方案.dxf
```

结构如下（单位默认 mm）：

```json
{
  "unit": "mm",
  "rooms":     [{"name": "主卧", "x": 0, "y": 0, "w": 4000, "h": 3500}],
  "walls":     [{"x1": 0, "y1": 0, "x2": 8000, "y2": 0, "thickness": 200}],
  "openings":  [{"x": 3000, "y": 0, "width": 900, "orient": "h", "kind": "door"}],
  "furniture": [{"x": 1000, "y": 500, "w": 1800, "h": 2000, "label": "双人床"}]
}
```

- `walls` 给中心线与厚度，脚本按双线绘制。
- `openings` 的 `(x, y)` 是洞口起点，`orient` 是所在墙的走向（`h` 水平 / `v` 竖直），`kind` 取 `door` 或 `window`。
- `furniture` 是外包矩形，`label` 写在矩形中心。
- `rooms` 只用于面积统计和房间名标注，不参与几何。可以只给 `points` 多边形（L 形、扣柱的房间），此时面积按多边形算、房间名放在形心；只给 `x/y/w/h` 时按矩形处理。

校验会拦下：墙段长度为 0、门洞小于 600mm、房间尺寸无效。会提醒：门洞偏窄（< 700mm）、洞口没落在墙上（偏离 > 300mm）、单件家具单边超过 3.2m。

生成的 DXF 分四个图层：`墙体`、`门窗`、`家具`、`标注`，文字用黑体，可在 CAD 里直接编辑。

### 4. 交付

- 给出 DXF 路径
- 用文字说明：保留了哪些结构、动了哪些墙、每个房间的面积、主要家具尺寸
- 明确写出待确认项，例如「主卧衣柜位置需现场核实」

## 尺寸基准

排布时按下面的下限自查，低于下限必须在说明里给出理由：

| 项目 | 下限 |
|---|---|
| 入户门洞 | 900mm |
| 卧室门洞 | 800mm |
| 卫生间 / 厨房门洞 | 700mm |
| 主通道净宽 | 900mm |
| 次通道净宽 | 700mm |
| 床侧通行 | 500mm |
| 衣柜前通行 | 600mm |
| 餐桌边缘到墙 | 800mm |

## 注意

- 不做结构判断。承重墙能否拆除，必须由结构专业确认，本技能只负责不擅自改动。
- 不做效果图、彩平图。需要时转 `image-prompt-rewrite` + `generate_image`。
- 不做三维建模。需要时转 SketchUp / Blender 连接器。
- 交付前建议用 `cad.py render` 或直接用 CAD 打开 DXF 核对一遍。
