---
name: cad
description: 只读的 DWG/DXF 解析工具箱：概览图幅与图名，按范围和图层查文字、尺寸、几何线条、块引用，按图幅或任意范围出图，截取已有几何作建模底图。读图纸内容、按图建模、核对尺寸与标高时使用。只解析，不能编辑或生成 CAD 图纸；要画图、改图请用 CAD 的 MCP 服务（multicad）。
---

# CAD 解析工具箱

## 能力边界

- 本技能只提供**解析**：读取已有的 DWG/DXF，不修改原件。
- **不提供编辑或生成 CAD 图纸的能力**。新建图纸、在图上加改内容、按要求出施工图等，需要用 CAD 的 MCP 服务（multicad，连接 AutoCAD 绘图与编辑）；这类需求不要用本技能的脚本去拼凑。
- `export` 输出的 DXF 只是把原图里已有的几何原样截取、平移到原点，给 SU/Rhino 建模当参考底图或做叠合校核用，不是出图或改图。

```bash
python <技能目录>/scripts/cad.py <命令> <图纸.dwg|.dxf> [参数]
```

DWG 首次使用时自动转换并缓存。遍历整张图的结果（文字、尺寸、图框，以及顶层实体的包围盒）也按原件内容缓存：大图第一次 `info`、第一次带 `--frame`/`--bbox` 的命令各要把整张图遍历一遍，可能要几十秒；之后同一张图的命令直接读缓存，不再重复遍历。

## 推荐流程

1. **先 `info`**：拿到单位、各 Layout、图幅列表（`frame-N`、范围、图名）、图层与块统计，并看清输出里的「警告」。后面的命令都用 `--frame N` 指定图幅，不用自己估坐标。
2. **按需查**：文字用 `texts`，尺寸用 `dims`，墙线、轮廓、标高线用 `geom`，门、家具、图签属性用 `blocks`。
3. **需要看图时用 `render`**：输出 `design-agent-cad-*.png` 后用 read_file 读取，原像素传入。
4. **建模要底图时用 `export`**：导出平移到原点、按 1:1 比例的 DXF，用于导入 SU/Rhino 或做叠合校核。

## 公共参数

| 参数 | 作用 |
|---|---|
| `--layout ID` | `model`（默认）或 `layout-01` 等，也接受 Layout 名 |
| `--frame N` / `--bbox x0,y0,x1,y1` | 查询范围（图纸坐标）；二者只给一个 |
| `--inside` | 必须完全落在范围内才算（默认与范围相交即算） |
| `--layer 模式` | 图层过滤：逗号分隔，含 `*?` 时按通配，否则按子串，不区分大小写。例如 `--layer 墙,WALL` |
| `--origin x,y` / `--origin bbox` | 输出坐标减去原点；`bbox` 取查询范围的左下角，得到本地坐标 |
| `--out 路径` | 写入文件（`.json` 为 JSON，其余为文本），stdout 只回执；不给则直接打印 |
| `--format text\|json` / `--limit N` | 输出格式；stdout 默认最多 200 条，`0` 为不限，写文件时默认不限 |

## 命令

- **`info`**：概览。图名取自图签里各图不同的字段（如"平面布置图 PL-04"），另附框内最大字号文字作线索；两者都识别不出时留空。
- **`texts`**：文字，包括块属性和块内文字，按阅读顺序排列。
  - `--match 正则`：过滤。
  - `--query 问题`：按相关度排序。
  - `--with-dims`：把尺寸的显示文字也列进来。
  - `--sort size`、`--unique`、`--min-height`：按字号排序、去重、限最小字高。
- **`dims`**：尺寸标注，给出测量值、图上显示文字、方向（水平/竖直）和两端测量点。
  - `--orient h|v`：只要水平或竖直标注。
  - `--range 最小,最大`：按测量值过滤。
- **`geom`**：块炸开、曲线离散后的线与轮廓。块内画在 0 层的实体随块引用的图层。
  - `--type LINE,LWPOLYLINE`、`--closed` / `--open`、`--orient h|v`、`--min-length`、`--min-size 宽,高`、`--max-size`：按类型、闭合、方向、长度、尺寸过滤。
  - `--top-level`：不炸块，比如在立面图里排除嵌入的索引平面图。
  - `--include-dims`：包含尺寸线本身。
  - `--points`：列出全部顶点。
- **`blocks`**：块引用的名称、插入点、旋转、缩放、包围盒和属性。`--name 模式` 按块名过滤，`--nested` 同时列出嵌套块。
- **`render`**：出图。
  - 不带范围参数时出总览；`--frame`、`--bbox` 可重复，每个出一张图；`--panels` 出总览外加各图幅。
  - `--layer` 只画指定图层；`--highlight 墙,WALL` 把匹配的图层标红、其余变浅灰；`--monochrome` 全黑出图，用于看清浅色标注；`--all-layers` 忽略图层的关闭和冻结状态。
  - 图片默认写到 `<当前目录>/.design-agent/cad/<图纸名>/`；stdout 列出每张图的模型范围、比例和字高（像素）。
- **`export`**：几何导出为 DXF（默认）或 `.json`。过滤参数同 `geom`；`--with-text` 同时导出文字；保留原图层和单位。

## 示例

下面省略了 `<技能目录>/scripts/` 前缀。

```bash
python cad.py info 施工图.dwg
python cad.py geom 施工图.dwg --frame 5 --layer 墙,WALL --origin bbox            # 平面墙线，转为本地坐标
python cad.py dims 施工图.dwg --frame 5 --orient v --range 1000,20000            # 竖向大尺寸
python cad.py geom 施工图.dwg --frame 14 --top-level --orient h --min-length 3000 --origin 129250,-243492   # 立面标高线
python cad.py texts 施工图.dwg --match "^\+?\d+\.\d{3}$"                        # 标高文字
python cad.py render 施工图.dwg --frame 5 --highlight 墙,WALL
python cad.py export 施工图.dwg --frame 5 --layer 墙,WALL --origin bbox --out 平面底图.dxf
```

## 注意

- 坐标一律是图纸单位（`info` 给出单位）。同一实体在各条命令里的 id 相同：顶层实体用 handle，块内实体用"handle.序号"。
- 文字框是按锚点、字高和字数估算的，锚点坐标是精确的；尺寸以测量值为准，显示文字可能被改写过。
- 图名来自规则识别，不是图纸声明；下结论前，用 `texts --frame N` 或出图核对一下。
- **警告「图中含天正（Tangent）自定义对象」**：天正的墙、门窗、标高、文字、尺寸是私有对象，转换时会丢掉或只剩线条。此时墙体缺失、没有标高文字、没有房间名都是读取的缺失，不是图纸没有；不要据此下结论或开始建模。把警告里的做法告诉用户：在天正里用「图形导出」另存为 T3 版本（普通 DWG，不是仅另存为低版本），换这份副本再解析。
- 按图层或类型查几何时尽量带上 `--layer`、`--type`：它们在离散曲线之前就过滤，范围里不要的图元不会被白白展开。
- `render` 出现"字高偏小"时，要缩小范围（`--frame`/`--bbox`），不要加大像素；出图空白且 `info` 提示多数实体在关闭的图层上时，加 `--all-layers`。
- 出现 `CAD_RENDER_DEGRADED` 说明有较多实体没画出来，不能单凭图片判断某样东西"不存在"。
