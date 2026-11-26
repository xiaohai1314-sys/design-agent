#!/usr/bin/env python3
"""CAD（.dwg/.dxf）解析工具箱。用法：python cad.py <命令> <图纸> [参数]

  info    概览：单位、Layout、图幅（图框与图名）、图层、块
  texts   文字（含块属性与块内文字，可带尺寸文字）：按范围/图层/正则过滤，按位置/字号/查询排序
  dims    尺寸标注：测量值、显示文字、方向、两端测量点
  geom    几何：炸开块、离散曲线后的线与轮廓；按图层/类型/闭合/方向/长度/尺寸过滤
  blocks  块引用：名称、插入点、旋转、缩放、包围盒、属性
  render  出图：总览、图幅或任意范围；可只画或高亮指定图层
  export  把范围内的几何（可带文字）平移到原点导出 DXF/JSON，作建模底图或叠合校核

默认把结果打印到 stdout；给 --out 时写入该路径（render 为图片目录），stdout 只回执路径与数量。
"""
import argparse
import base64
import hashlib
import json
import re
import statistics
import sys
import time
from collections import Counter
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import cad_core  # noqa: E402
from cad_core import CadError  # noqa: E402


DEFAULT_LIMIT = 200
# execute 工具单次上限 300s（agent-runtime src/backend/index.ts）；留出启动、读图与收尾的余量。
RENDER_TIME_BUDGET = 240
# 低于这个中位字高就提示缩小范围。出图尺寸按 cad_core.TARGET_TEXT_PIXELS 定，这里是更宽松的「还能读」下限。
READABLE_TEXT_PIXELS = 10
KIND_LABELS = {"modelspace": "模型空间", "paperspace": "图纸空间"}
ORIENTATION_LABELS = {"h": "水平", "v": "竖直"}
ORDER_LABELS = {"query": "按与查询的相关度", "size": "按字号从大到小", "position": "按阅读顺序"}


# ---------------------------------------------------------------------------
# 参数与上下文
# ---------------------------------------------------------------------------


def parse_numbers(text, count, flag):
    try:
        values = [float(part) for part in str(text).replace("，", ",").split(",")]
    except ValueError as error:
        raise CadError(f"{flag} 须为 {count} 个逗号分隔的数字，收到「{text}」") from error
    if len(values) != count:
        raise CadError(f"{flag} 须为 {count} 个逗号分隔的数字，收到「{text}」")
    return values


def parse_bbox(text):
    x0, y0, x1, y1 = parse_numbers(text, 4, "--bbox")
    return [min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1)]


class Context:
    """一次命令的读图结果：文档、目标 Layout、按需抽取的文字/尺寸/图框，以及查询范围与坐标原点。"""

    def __init__(self, args):
        self.args = args
        self.source = Path(args.input)
        self.document, warnings = cad_core.open_document(self.source)
        self.warnings = list(warnings)
        tangent = cad_core.tangent_warning(self.document)
        if tangent:
            self.warnings.append(tangent)
        self.spec = cad_core.find_layout(self.document, getattr(args, "layout", None) or "model")
        self._collected = None
        self._cache_key = None
        self._extents = None

    @property
    def cache_key(self):
        """遍历结果的缓存键；原件读不了或缓存目录不可写时为 None，命令照常现算。"""
        if self._cache_key is None:
            try:
                self._cache_key = cad_core.source_cache_key(self.source)
            except OSError:
                self._cache_key = ""
        return self._cache_key or None

    def collect(self, spec):
        """某个 Layout 的文字/尺寸/图框抽取结果；同一张图的后续命令直接读缓存，不再炸开整张图的块。"""
        return cad_core.collect_layout_cached(spec, self.cache_key)

    @property
    def collected(self):
        if self._collected is None:
            self._collected = self.collect(self.spec)
        return self._collected

    def extents(self, region):
        """按范围查询时用的顶层实体包围盒；没有范围时不需要，返回 None。"""
        if region is None:
            return None
        if self._extents is None:
            self._extents = cad_core.top_level_extents(self.spec, self.cache_key)
        return self._extents

    def regions(self):
        boxes = [parse_bbox(value) for value in getattr(self.args, "bbox", None) or []]
        boxes += [cad_core.find_frame(self.collected, key)["bbox"] for key in getattr(self.args, "frame", None) or []]
        return boxes

    def region(self):
        """--bbox 或 --frame 给出的查询范围；都没给时为 None（整个 Layout）。"""
        boxes = self.regions()
        if len(boxes) > 1:
            raise CadError("查询命令一次只接受一个范围（--bbox 或 --frame 只给一个）")
        return boxes[0] if boxes else None

    def origin(self, region):
        value = getattr(self.args, "origin", None)
        if not value:
            return (0.0, 0.0)
        if str(value).strip().casefold() == "bbox":
            if region is None:
                raise CadError("--origin bbox 需要同时给出 --bbox 或 --frame")
            return (region[0], region[1])
        x, y = parse_numbers(value, 2, "--origin")
        return (x, y)


class Coords:
    """输出坐标：减去原点并保留 3 位小数。"""

    def __init__(self, origin):
        self.ox, self.oy = origin

    def point(self, point):
        return [round(point[0] - self.ox, 3), round(point[1] - self.oy, 3)] if point else None

    def box(self, box):
        if not box:
            return None
        return [round(box[0] - self.ox, 3), round(box[1] - self.oy, 3), round(box[2] - self.ox, 3), round(box[3] - self.oy, 3)]


def query_text(args):
    if getattr(args, "query_base64", None):
        try:
            return base64.b64decode(args.query_base64, validate=True).decode("utf-8")
        except (ValueError, UnicodeDecodeError) as error:
            raise CadError(f"--query-base64 不是有效的 UTF-8 Base64: {error}") from error
    return getattr(args, "query", None) or ""


def effective_limit(args):
    if args.limit is not None:
        return max(0, args.limit)
    return 0 if args.out else DEFAULT_LIMIT


def limited(items, args):
    limit = effective_limit(args)
    return (items[:limit] if limit else items), len(items)


# ---------------------------------------------------------------------------
# 输出
# ---------------------------------------------------------------------------


def fmt_number(value):
    if value is None:
        return "?"
    text = f"{float(value):.1f}"
    return text[:-2] if text.endswith(".0") else text


def fmt_point(point):
    return f"({fmt_number(point[0])}, {fmt_number(point[1])})" if point else "?"


def fmt_box(box):
    return "[" + ", ".join(fmt_number(value) for value in box) + "]" if box else "无"


def short_id(item_id):
    return str(item_id).split(":", 1)[-1]


def header_lines(title, ctx, region=None, origin=(0.0, 0.0)):
    lines = [f"# {title}：{ctx.source.name} · {ctx.spec.id}（{ctx.spec.name}）"]
    if region is not None:
        lines.append(f"- 范围：{fmt_box(region)}")
    if origin != (0.0, 0.0):
        lines.append(f"- 坐标已减去原点 {fmt_point(origin)}")
    for warning in ctx.warnings:
        lines.append(f"- 警告：{warning}")
    return lines


def truncation_line(shown, total, noun):
    if shown < total:
        return f"- 共 {total} 条{noun}，只列出前 {shown} 条；用 --limit 0 或 --out 取全部，或收窄范围/过滤条件。"
    return None


def emit(args, payload, to_text, noun, total):
    """不给 --out 打印到 stdout；给了就写文件（格式看 --format，缺省按扩展名：.json 为 JSON，其余为文本）。"""
    output_format = args.format
    if args.out:
        path = Path(args.out)
        output_format = output_format or ("json" if path.suffix.lower() == ".json" else "text")
        path.parent.mkdir(parents=True, exist_ok=True)
        body = json.dumps(payload, ensure_ascii=False, indent=1) + "\n" if output_format == "json" else to_text(payload)
        path.write_text(body, encoding="utf-8")
        print(f"已写入 {path.resolve()}（{noun} {total} 条，{output_format}）")
        return
    if (output_format or "text") == "json":
        print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    else:
        print(to_text(payload), end="")


def base_payload(command, ctx, region=None, origin=(0.0, 0.0)):
    payload = {
        "command": command,
        "source": {"name": ctx.source.name, "path": str(ctx.source.resolve())},
        "layout": {"id": ctx.spec.id, "name": ctx.spec.name, "kind": ctx.spec.kind},
    }
    if region is not None:
        payload["region"] = [round(value, 3) for value in region]
    if origin != (0.0, 0.0):
        payload["origin"] = [round(origin[0], 3), round(origin[1], 3)]
    if ctx.warnings:
        payload["warnings"] = list(ctx.warnings)
    return payload


# ---------------------------------------------------------------------------
# 范围判定
# ---------------------------------------------------------------------------


def segment_hits_box(start, end, box):
    """线段与矩形是否相交（Liang–Barsky 裁剪）。"""
    x0, y0, x1, y1 = box
    dx, dy = end[0] - start[0], end[1] - start[1]
    low, high = 0.0, 1.0
    for p, q in ((-dx, start[0] - x0), (dx, x1 - start[0]), (-dy, start[1] - y0), (dy, y1 - start[1])):
        if p == 0:
            if q < 0:
                return False
            continue
        t = q / p
        if p < 0:
            low = max(low, t)
        else:
            high = min(high, t)
        if low > high:
            return False
    return True


def shape_in_region(points, closed, region, inside):
    """inside：全部顶点都在范围内；否则只要有顶点在范围内或有边穿过范围。"""
    if inside:
        return all(cad_core.point_in_bbox(point, region) for point in points)
    if any(cad_core.point_in_bbox(point, region) for point in points):
        return True
    ends = points[1:] + ([points[0]] if closed and len(points) > 2 else [])
    return any(segment_hits_box(start, end, region) for start, end in zip(points, ends))


# ---------------------------------------------------------------------------
# info
# ---------------------------------------------------------------------------


def frame_payload(frame, coords):
    item = {"id": frame["id"], "bbox": coords.box(frame["bbox"])}
    for key in ("within", "label", "largestText"):
        if key in frame:
            item[key] = frame[key]
    return item


def cmd_info(args):
    ctx = Context(args)
    document = ctx.document
    code, unit = cad_core.drawing_units(document)
    states = cad_core.layer_states(document)
    coords = Coords((0.0, 0.0))

    layouts = []
    for spec in cad_core.iter_layouts(document):
        collected = ctx.collected if spec.id == ctx.spec.id else ctx.collect(spec)
        layouts.append(
            {
                "id": spec.id,
                "name": spec.name,
                "kind": spec.kind,
                "empty": cad_core.layout_is_empty(collected),
                "entityCount": len(spec.layout),
                "textCount": len(collected["texts"]),
                "dimensionCount": len(collected["dimensions"]),
                "viewportCount": len(collected["viewports"]),
                "evidenceBbox": collected["evidenceBbox"],
                "renderBbox": collected["renderBbox"],
                "clippedOutlierCount": collected["clippedOutlierCount"],
                "medianTextHeight": collected["medianTextHeight"],
                "frames": [frame_payload(frame, coords) for frame in collected["frames"]],
            }
        )

    model = document.modelspace()
    layer_counts = Counter(str(entity.dxf.get("layer", "0") or "0") for entity in model)
    layers = sorted(
        ({"name": name, "entities": layer_counts.get(name, 0), **state} for name, state in states.items()),
        key=lambda item: (-item["entities"], item["name"]),
    )
    warnings = list(ctx.warnings)
    total = sum(layer_counts.values())
    hidden = sum(count for name, count in layer_counts.items() if not states.get(name, {}).get("on", True) or states.get(name, {}).get("frozen"))
    if total and hidden / total > 0.5:
        warnings.append(
            f"模型空间 {hidden / total:.0%} 的实体在关闭或冻结的图层上；出图空白时给 render 加 --all-layers"
            "（也可能是 DWG 转换读错了图层开关）"
        )
    blocks = Counter(str(entity.dxf.get("name", "")) for entity in model.query("INSERT"))
    payload = {
        "command": "info",
        "source": {
            "name": ctx.source.name,
            "path": str(ctx.source.resolve()),
            "format": ctx.source.suffix.lower().lstrip("."),
            "dxfversion": document.dxfversion,
        },
        "units": {"code": code, "name": unit},
        "layouts": layouts,
        "layers": layers,
        "blocks": [{"name": name, "count": count} for name, count in blocks.most_common()],
        "warnings": warnings,
    }

    def to_text(data):
        source = data["source"]
        converted = "（由 DWG 转换）" if source["format"] == "dwg" else ""
        lines = [
            f"# CAD 概览：{source['name']}",
            f"- 路径：{source['path']}",
            f"- 格式：DXF {source['dxfversion']}{converted}；单位：{data['units']['name']}（$INSUNITS={data['units']['code']}）；坐标均为图纸单位",
        ]
        lines.extend(f"- 警告：{warning}" for warning in data["warnings"])
        empty = []
        for layout in data["layouts"]:
            if layout["kind"] == "paperspace" and layout["empty"]:
                empty.append(f"{layout['id']}（{layout['name']}）")
                continue
            lines.extend(
                [
                    "",
                    f"## {layout['id']} · {layout['name']}（{KIND_LABELS.get(layout['kind'], layout['kind'])}）",
                    f"- 顶层实体 {layout['entityCount']}；文字 {layout['textCount']}；尺寸 {layout['dimensionCount']}；viewport {layout['viewportCount']}",
                ]
            )
            if layout["evidenceBbox"]:
                lines.append(f"- 文字/尺寸坐标范围：{fmt_box(layout['evidenceBbox'])}")
            note = f"；排除了 {layout['clippedOutlierCount']} 处离群坐标" if layout["clippedOutlierCount"] else ""
            lines.append(f"- 默认出图范围：{fmt_box(layout['renderBbox'])}{note}")
            if layout["medianTextHeight"]:
                lines.append(f"- 中位字高：{fmt_number(layout['medianTextHeight'])}")
            top = [frame for frame in layout["frames"] if "within" not in frame]
            nested = len(layout["frames"]) - len(top)
            if top:
                lines.append(f"- 图幅（顶层图框 {len(top)} 个，按阅读顺序；图名取自图签里各图不同的字段，识别不出时留空）：")
                for frame in top:
                    parts = []
                    if frame.get("label"):
                        parts.append(f"图名：{frame['label']}")
                    if frame.get("largestText") and frame["largestText"] not in frame.get("label", ""):
                        parts.append(f"最大字号文字：{frame['largestText']}")
                    title = f"  {'｜'.join(parts)}" if parts else ""
                    lines.append(f"  - {short_id(frame['id'])} {fmt_box(frame['bbox'])}{title}")
                if nested:
                    lines.append(f"  - 另有嵌套图框 {nested} 个（内边框等），见 --format json")
        if empty:
            lines.extend(["", f"- 空白图纸空间：{'、'.join(empty)}"])

        used = [layer for layer in data["layers"] if layer["entities"]]
        lines.extend(["", f"## 图层（共 {len(data['layers'])} 个；按模型空间顶层实体数，列出有实体的 {min(len(used), 40)} 个）"])
        for layer in used[:40]:
            flags = "".join(flag for flag, on in (("，关闭", not layer["on"]), ("，冻结", layer["frozen"])) if on)
            lines.append(f"- {layer['name']}：{layer['entities']}{flags}")
        if data["blocks"]:
            shown = "；".join(f"{block['name']} ×{block['count']}" for block in data["blocks"][:20])
            lines.extend(["", f"## 块（模型空间顶层插入次数，共 {len(data['blocks'])} 种）", f"- {shown}"])
        script = SCRIPT_DIR / "cad.py"
        lines.extend(
            [
                "",
                "## 下一步",
                f"- 文字：python \"{script}\" texts \"{source['path']}\" --frame <编号> [--match 正则] [--query 问题]",
                f"- 尺寸 / 块：dims、blocks，参数同上；几何：geom --frame <编号> --layer <图层> [--closed] [--orient h]",
                f"- 看图：render --frame <编号> 或 --panels；导出底图：export --frame <编号> --origin bbox --out <路径.dxf>",
            ]
        )
        return "\n".join(lines) + "\n"

    emit(args, payload, to_text, "Layout", len(layouts))


# ---------------------------------------------------------------------------
# texts
# ---------------------------------------------------------------------------


def dimension_as_text(dimension):
    label = dimension.get("text") or (fmt_number(dimension["measurement"]) if dimension["measurement"] is not None else "")
    if not label or not dimension.get("anchor"):
        return None
    return {
        "id": dimension["id"],
        "type": "DIMENSION",
        "text": label,
        "layer": dimension["layer"],
        "anchor": dimension["anchor"],
        "height": 0.0,
        "bbox": [*dimension["anchor"], *dimension["anchor"]],
    }


def sort_by_position(items):
    """阅读顺序：按行（行高取中位字高的 1.5 倍）从上到下，行内从左到右。"""
    heights = [item["height"] for item in items if item.get("height")]
    row = (statistics.median(heights) if heights else 1.0) * 1.5
    return sorted(items, key=lambda item: (-round(item["anchor"][1] / row), item["anchor"][0]))


def cmd_texts(args):
    ctx = Context(args)
    region = ctx.region()
    origin = ctx.origin(region)
    coords = Coords(origin)
    query = query_text(args)
    layer_match = cad_core.name_matcher(args.layer)
    pattern = re.compile(args.match, re.IGNORECASE) if args.match else None

    items = list(ctx.collected["texts"])
    if args.with_dims:
        items += [text for text in map(dimension_as_text, ctx.collected["dimensions"]) if text]
    matched = []
    for item in items:
        if region is not None and not cad_core.point_in_bbox(item["anchor"], region):
            continue
        if layer_match and not layer_match(item["layer"]):
            continue
        if pattern and not (pattern.search(item["text"]) or pattern.search(item.get("searchText", ""))):
            continue
        if args.min_height and item["height"] < args.min_height:
            continue
        matched.append(item)
    if args.unique:
        matched = cad_core.unique_texts(matched)

    order = args.sort or ("query" if query else "position")
    if order == "query":
        position = {id(item): index for index, item in enumerate(sort_by_position(matched))}
        matched.sort(key=lambda item: (-cad_core.query_match_score(item.get("searchText") or item["text"], query), position[id(item)]))
    elif order == "size":
        matched.sort(key=lambda item: (-item["height"], item["anchor"][0]))
    else:
        matched = sort_by_position(matched)

    shown, total = limited(matched, args)
    payload = base_payload("texts", ctx, region, origin)
    payload.update({"total": total, "order": order, "items": []})
    for item in shown:
        record = {key: item[key] for key in ("id", "type", "text", "layer") if key in item}
        record["anchor"] = coords.point(item["anchor"])
        record["height"] = item["height"]
        for key in ("rotation", "block", "searchText"):
            if key in item:
                record[key] = item[key]
        payload["items"].append(record)

    def to_text(data):
        lines = header_lines("文字", ctx, region, origin)
        lines.append(f"- 匹配 {data['total']} 条（{ORDER_LABELS[order]}）；格式：[id] [图层] 文字 @锚点 h=字高")
        for item in data["items"]:
            extras = []
            if item.get("height"):
                extras.append(f"h={fmt_number(item['height'])}")
            if item.get("rotation"):
                extras.append(f"旋转 {fmt_number(item['rotation'])}°")
            if item.get("block"):
                extras.append(f"块 {item['block']}")
            if item["type"] == "DIMENSION":
                extras.append("尺寸")
            text = cad_core.one_line(item["text"])
            lines.append(f"- [{short_id(item['id'])}] [{item['layer']}] {text} @{fmt_point(item['anchor'])} {' '.join(extras)}".rstrip())
        note = truncation_line(len(data["items"]), data["total"], "文字")
        if note:
            lines.append(note)
        return "\n".join(lines) + "\n"

    emit(args, payload, to_text, "文字", total)


# ---------------------------------------------------------------------------
# dims
# ---------------------------------------------------------------------------


def cmd_dims(args):
    ctx = Context(args)
    region = ctx.region()
    origin = ctx.origin(region)
    coords = Coords(origin)
    layer_match = cad_core.name_matcher(args.layer)
    value_range = parse_numbers(args.range, 2, "--range") if args.range else None

    matched = []
    for item in ctx.collected["dimensions"]:
        points = [point for point in (item.get("p1"), item.get("p2"), item.get("anchor")) if point]
        if region is not None:
            test = all if args.inside else any
            if not points or not test(cad_core.point_in_bbox(point, region) for point in points):
                continue
        if layer_match and not layer_match(item["layer"]):
            continue
        if args.orient and item.get("orientation") != args.orient:
            continue
        if value_range and (item["measurement"] is None or not value_range[0] <= item["measurement"] <= value_range[1]):
            continue
        matched.append(item)
    matched.sort(key=lambda item: (-round((item.get("anchor") or [0, 0])[1]), (item.get("anchor") or [0, 0])[0]))

    shown, total = limited(matched, args)
    payload = base_payload("dims", ctx, region, origin)
    payload.update({"total": total, "items": []})
    for item in shown:
        record = {key: item[key] for key in ("id", "layer", "kind", "measurement", "text", "orientation", "block") if key in item}
        for key in ("p1", "p2", "anchor"):
            if item.get(key):
                record[key] = coords.point(item[key])
        payload["items"].append(record)

    def to_text(data):
        lines = header_lines("尺寸标注", ctx, region, origin)
        lines.append(f"- 匹配 {data['total']} 条；格式：[id] 测量值（图上显示文字） 方向 测量点1→测量点2 @文字位置 [图层]")
        for item in data["items"]:
            value = fmt_number(item["measurement"])
            label = f"{value}（显示「{cad_core.one_line(item['text'])}」）" if item.get("text") else value
            orientation = ORIENTATION_LABELS.get(item.get("orientation"), item.get("orientation") or item["kind"])
            span = f" {fmt_point(item['p1'])}→{fmt_point(item['p2'])}" if item.get("p1") else ""
            lines.append(f"- [{short_id(item['id'])}] {label} {orientation}{span} @{fmt_point(item.get('anchor'))} [{item['layer']}]")
        note = truncation_line(len(data["items"]), data["total"], "尺寸")
        if note:
            lines.append(note)
        return "\n".join(lines) + "\n"

    emit(args, payload, to_text, "尺寸", total)


# ---------------------------------------------------------------------------
# geom
# ---------------------------------------------------------------------------


def size_limits(text, flag):
    if not text:
        return None
    parts = str(text).replace("，", ",").split(",")
    values = parse_numbers(text, len(parts), flag)
    if len(values) == 1:
        return (values[0], values[0])
    if len(values) == 2:
        return tuple(values)
    raise CadError(f"{flag} 须为「边长」或「宽,高」")


def filtered_geometry(ctx, args, region):
    tolerance = args.tolerance or cad_core.default_tolerance(ctx.document)
    layer_match = cad_core.name_matcher(args.layer)
    type_match = {kind.upper() for kind in cad_core.split_patterns(getattr(args, "type", None))}
    min_size = size_limits(getattr(args, "min_size", None), "--min-size")
    max_size = size_limits(getattr(args, "max_size", None), "--max-size")
    closed_only = getattr(args, "closed", False)
    open_only = getattr(args, "open", False)
    orient = getattr(args, "orient", None)
    min_length = getattr(args, "min_length", None)
    matched = []
    for record in cad_core.iter_geometry(
        ctx.spec,
        region=region,
        tolerance=tolerance,
        include_dimensions=args.include_dims,
        top_level_only=args.top_level,
        layer_match=layer_match,
        types=type_match,
        extents=ctx.extents(region),
    ):
        if closed_only and not record["closed"]:
            continue
        if open_only and record["closed"]:
            continue
        box = record["bbox"]
        width, height = box[2] - box[0], box[3] - box[1]
        if orient and cad_core.axis_orientation(width, height) != orient:
            continue
        if min_length and record["length"] < min_length:
            continue
        if min_size and (width < min_size[0] or height < min_size[1]):
            continue
        if max_size and (width > max_size[0] or height > max_size[1]):
            continue
        if region is not None and not shape_in_region(record["points"], record["closed"], region, args.inside):
            continue
        matched.append(record)
    return matched, tolerance


def geometry_payload(record, coords, with_points=True):
    item = {
        "id": record["id"],
        "type": record["type"],
        "layer": record["layer"],
        "closed": record["closed"],
        "bbox": coords.box(record["bbox"]),
        "length": round(record["length"], 3),
    }
    if "area" in record:
        item["area"] = round(record["area"], 3)
    for key in ("block", "dimension"):
        if key in record:
            item[key] = record[key]
    if with_points:
        item["points"] = [coords.point(point) for point in record["points"]]
    return item


def cmd_geom(args):
    ctx = Context(args)
    region = ctx.region()
    origin = ctx.origin(region)
    coords = Coords(origin)
    matched, tolerance = filtered_geometry(ctx, args, region)
    shown, total = limited(matched, args)
    payload = base_payload("geom", ctx, region, origin)
    payload.update(
        {
            "total": total,
            "tolerance": tolerance,
            "byLayer": dict(Counter(record["layer"] for record in matched).most_common()),
            "byType": dict(Counter(record["type"] for record in matched).most_common()),
            "items": [geometry_payload(record, coords) for record in shown],
        }
    )

    def to_text(data):
        lines = header_lines("几何", ctx, region, origin)
        layers = "，".join(f"{name} {count}" for name, count in list(data["byLayer"].items())[:15])
        types = "，".join(f"{name} {count}" for name, count in data["byType"].items())
        blocks_note = "只含顶层实体，块未炸开" if args.top_level else "块已炸开，块内 0 层实体随块引用图层"
        lines.append(f"- 匹配 {data['total']} 条（曲线按弦高 {fmt_number(data['tolerance'])} 离散；{blocks_note}）")
        if data["total"]:
            lines.append(f"- 按图层：{layers}{'，…' if len(data['byLayer']) > 15 else ''}")
            lines.append(f"- 按类型：{types}")
        for item in data["items"]:
            points = item["points"]
            suffix = f"（块 {item['block']}）" if item.get("block") else ""
            if len(points) == 2 and not item["closed"]:
                lines.append(
                    f"- [{short_id(item['id'])}] {item['type']} [{item['layer']}] 长 {fmt_number(item['length'])} "
                    f"{fmt_point(points[0])}→{fmt_point(points[1])}{suffix}"
                )
                continue
            shape = "闭合" if item["closed"] else "开放"
            area = f" 面积 {fmt_number(item['area'])}" if "area" in item else ""
            line = (
                f"- [{short_id(item['id'])}] {item['type']} [{item['layer']}] {shape} 包围盒 {fmt_box(item['bbox'])} "
                f"长 {fmt_number(item['length'])}{area} 顶点 {len(points)}{suffix}"
            )
            if args.points or len(points) <= 8:
                line += " 点：" + " ".join(fmt_point(point) for point in points)
            lines.append(line)
        note = truncation_line(len(data["items"]), data["total"], "几何")
        if note:
            lines.append(note)
        return "\n".join(lines) + "\n"

    emit(args, payload, to_text, "几何", total)


# ---------------------------------------------------------------------------
# blocks
# ---------------------------------------------------------------------------


def cmd_blocks(args):
    ctx = Context(args)
    region = ctx.region()
    origin = ctx.origin(region)
    coords = Coords(origin)
    layer_match = cad_core.name_matcher(args.layer)
    name_match = cad_core.name_matcher(args.name)

    matched = []
    for record in cad_core.iter_block_references(ctx.spec, region=region, nested=args.nested, extents=ctx.extents(region)):
        if layer_match and not layer_match(record["layer"]):
            continue
        if name_match and not name_match(record["name"]):
            continue
        if region is not None:
            box = record["bbox"] or [*record["insert"], *record["insert"]]
            if args.inside:
                hit = cad_core.box_contains(region, box)
            elif box[0] == box[2] or box[1] == box[3]:
                hit = cad_core.point_in_bbox(record["insert"], region)
            else:
                hit = cad_core.boxes_overlap(box, region)
            if not hit:
                continue
        matched.append(record)

    shown, total = limited(matched, args)
    payload = base_payload("blocks", ctx, region, origin)
    payload.update({"total": total, "byName": dict(Counter(record["name"] for record in matched).most_common()), "items": []})
    for record in shown:
        item = {
            "id": record["id"],
            "name": record["name"],
            "layer": record["layer"],
            "insert": coords.point(record["insert"]),
            "rotation": round(record["rotation"], 3),
            "scale": [round(value, 6) for value in record["scale"]],
            "bbox": coords.box(record["bbox"]),
        }
        if record["attributes"]:
            item["attributes"] = record["attributes"]
        if "parentBlock" in record:
            item["parentBlock"] = record["parentBlock"]
        payload["items"].append(item)

    def to_text(data):
        lines = header_lines("块引用", ctx, region, origin)
        names = "；".join(f"{name} ×{count}" for name, count in list(data["byName"].items())[:20])
        lines.append(f"- 匹配 {data['total']} 个{'（含嵌套块）' if args.nested else '（顶层）'}：{names or '无'}")
        for item in data["items"]:
            extras = []
            if item["rotation"]:
                extras.append(f"旋转 {fmt_number(item['rotation'])}°")
            if item["scale"] != [1.0, 1.0]:
                extras.append(f"缩放 {item['scale'][0]:g}×{item['scale'][1]:g}")
            if item.get("parentBlock"):
                extras.append(f"在块 {item['parentBlock']} 内")
            attributes = "；".join(f"{tag}={value}" for tag, value in (item.get("attributes") or {}).items())
            if attributes:
                extras.append(f"属性：{attributes}")
            lines.append(
                f"- [{short_id(item['id'])}] {item['name']} [{item['layer']}] @{fmt_point(item['insert'])} "
                f"包围盒 {fmt_box(item['bbox'])} {' '.join(extras)}".rstrip()
            )
        note = truncation_line(len(data["items"]), data["total"], "块引用")
        if note:
            lines.append(note)
        return "\n".join(lines) + "\n"

    emit(args, payload, to_text, "块引用", total)


# ---------------------------------------------------------------------------
# render
# ---------------------------------------------------------------------------


def bbox_view_id(box):
    digest = hashlib.sha1(",".join(f"{value:.3f}" for value in box).encode("ascii")).hexdigest()[:8]
    return f"bbox-{digest}"


def texts_in(texts, box):
    return [text for text in texts if cad_core.point_in_bbox(text["anchor"], box)]


def panel_views(collected, overview_path, overview_view, existing_ids):
    """--panels 的分幅：顶层图框能当图幅时按图框（模型坐标精确、带图名）；否则按总览图里的竖向留白切。"""
    frames = cad_core.sheet_frames(collected)
    if frames:
        return [
            (short_id(frame["id"]), frame["bbox"], cad_core.frame_title(frame))
            for frame in frames
            if short_id(frame["id"]) not in existing_ids
        ]
    return [
        (f"panel-{number}", cad_core.pixel_to_model(pixel_box, overview_view), None)
        for number, pixel_box in enumerate(cad_core.detect_panels(overview_path), start=1)
    ]


def plan_region_filter(requested, overview_box, ctx=None):
    """只画局部时跳过范围外的顶层实体；局部加起来接近整图时过滤不划算，直接全画。"""
    regions = [cad_core.pad_bbox(box, 0.05) for box in requested]
    if overview_box and sum(cad_core.bbox_area(region) for region in regions) >= 0.6 * cad_core.bbox_area(overview_box):
        return None
    known = cad_core.extents_by_handle(ctx.spec, ctx.extents(regions)) if ctx is not None else None
    return cad_core.region_filter(regions, known)


def cmd_render(args):
    started = time.monotonic()
    deadline = started + args.time_budget
    ctx = Context(args)
    collected = ctx.collected
    requested = [(bbox_view_id(box), box, None) for box in map(parse_bbox, args.bbox or [])]
    for key in args.frame or []:
        frame = cad_core.find_frame(collected, key)
        requested.append((short_id(frame["id"]), frame["bbox"], cad_core.frame_title(frame)))
    want_overview = args.panels or not requested
    overview_box = collected["renderBbox"] or collected["nativeBbox"]
    if want_overview and not overview_box:
        raise CadError(f"{ctx.spec.name}（{ctx.spec.id}）没有可渲染的内容")
    loaded_at = time.monotonic()

    output_dir = Path(args.out) if args.out else Path.cwd() / ".design-agent" / "cad" / ctx.source.stem
    output_dir.mkdir(parents=True, exist_ok=True)

    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    warnings = list(ctx.warnings)
    only = cad_core.name_matcher(args.layer)
    if only or args.all_layers:
        hidden = cad_core.apply_layer_visibility(ctx.document, only=only, all_layers=args.all_layers)
        if only:
            warnings.append(f"只画匹配 {'、'.join(cad_core.split_patterns(args.layer))} 的图层（关掉了 {hidden} 个图层）")
    highlight = cad_core.name_matcher(args.highlight)
    cad_core.prepare_fonts(ctx.document)
    cad_core.decode_text_escapes(ctx.document)
    fig = plt.figure(figsize=(10, 10), dpi=cad_core.RENDER_DPI)
    ax = fig.add_axes([0, 0, 1, 1])
    report = cad_core.RenderIsolationReport()
    try:
        cad_core.draw_layout_isolated(
            ctx.document,
            ctx.spec.layout,
            cad_core.make_backend(ax),
            report,
            config=cad_core.render_configuration(args.monochrome),
            filter_func=None if want_overview else plan_region_filter([box for _, box, _ in requested], overview_box, ctx),
            deadline=deadline,
            property_override=cad_core.highlight_override(highlight) if highlight else None,
        )
    except cad_core.RenderBudgetExceeded as exceeded:
        plt.close(fig)
        raise CadError(
            f"绘制超过时间预算 {args.time_budget:g}s（已画 {exceeded.done}/{exceeded.total} 个顶层实体）。"
            "请用 --bbox/--frame 只画需要的区域，或先用 texts/dims/geom 的文字与坐标作答。"
        ) from exceeded
    drawn_at = time.monotonic()

    queue = []
    if want_overview:
        queue.append(("overview", overview_box, None))
    queue.extend(requested)
    views, skipped_views = [], []
    last_duration = 0.0
    index = 0
    while index < len(queue):
        view_id, box, title = queue[index]
        index += 1
        # 单张出图无法中途打断；按上一张的耗时预估，放不下就不开始，把机会留给下一次调用。
        if time.monotonic() + last_duration > deadline:
            skipped_views.append({"id": view_id, "modelBbox": box})
            continue
        view_started = time.monotonic()
        inside = texts_in(collected["texts"], box)
        heights = [text["height"] for text in inside]
        text_height = statistics.median(heights) if heights else collected["medianTextHeight"]
        long_edge = cad_core.choose_long_edge(cad_core.pad_bbox(box), text_height, args.max_edge)
        destination = output_dir / f"{cad_core.VIEW_FILE_PREFIX}{ctx.spec.id}-{view_id}.png"
        view = {"id": view_id, **cad_core.rasterize_view(fig, ax, box, destination, long_edge)}
        if title:
            view["title"] = title
        view["textCount"] = len(inside)
        if text_height:
            view["textPixelHeight"] = round(text_height * view["pixelsPerUnit"], 1)
            view["textReadable"] = view["textPixelHeight"] >= READABLE_TEXT_PIXELS
        largest = cad_core.unique_texts(sorted(inside, key=lambda text: -text["height"]))[:3]
        if largest:
            view["largestTexts"] = [cad_core.one_line(text["text"]) for text in largest]
        views.append(view)
        last_duration = time.monotonic() - view_started

        if view_id == "overview" and args.panels:
            panels = panel_views(collected, destination, view, {item[0] for item in queue})
            queue[index:index] = panels
            if not panels:
                warnings.append("未检测到可分离的图幅（既无 2 个以上框住多数文字的顶层图框，也没有竖向留白隔开的图幅）；需要细节请用 --bbox")
    plt.close(fig)

    isolation = report.fields()
    if isolation["skippedEntityCount"]:
        warnings.append(f"有 {isolation['skippedEntityCount']} 个实体因渲染错误跳过（占 {isolation['skippedEntityRatio']:.2%}）")
    if isolation["degraded"]:
        warnings.append("CAD_RENDER_DEGRADED：跳过的实体超过 10%，图面可能缺内容，不能单凭图片下「不存在」的结论")
    if views and all(view["blank"] for view in views) and not args.all_layers:
        warnings.append("所有视图都是空白；若 info 提示多数实体在关闭的图层上，加 --all-layers 重试")

    payload = base_payload("render", ctx)
    payload.update(
        {
            "outDir": str(output_dir.resolve()),
            "views": views,
            "skippedViews": skipped_views,
            "renderIsolation": isolation,
            "warnings": warnings,
            "timing": {
                "loadSeconds": round(loaded_at - started, 1),
                "drawSeconds": round(drawn_at - loaded_at, 1),
                "rasterSeconds": round(time.monotonic() - drawn_at, 1),
            },
        }
    )
    if args.format == "json":
        print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
        return

    lines = [f"# CAD 视图：{ctx.source.name} · {ctx.spec.id}（{ctx.spec.name}）", f"- 输出目录：{payload['outDir']}"]
    for view in views:
        line = (
            f"- {view['id']}：{Path(view['path']).name}  {view['width']}×{view['height']}px  "
            f"模型范围 {fmt_box(view['modelBbox'])}  比例 {view['pixelsPerUnit']:.6g} px/单位"
        )
        if "textPixelHeight" in view:
            line += f"  字高≈{view['textPixelHeight']:g}px"
            if not view["textReadable"]:
                line += "（偏小；看细节请缩小范围：--panels、--frame 或 --bbox）"
        if view["blank"]:
            line += "  空白：范围内没有可见实体"
        lines.append(line)
        if view.get("title"):
            lines.append(f"  - 图名：{view['title']}")
        elif view.get("largestTexts"):
            lines.append(f"  - 范围内文字 {view['textCount']} 条，字号最大的：{' | '.join(view['largestTexts'])}")
    if views:
        lines.append("- 像素换算：像素x = (X − 范围x0) × 比例；像素y = (范围y1 − Y) × 比例（y 轴向下）")
    for skipped in skipped_views:
        lines.append(f"- 未出图（时间预算已用完）：{skipped['id']} 范围 {fmt_box(skipped['modelBbox'])}，请用 --bbox 单独再调")
    lines.extend(f"- 警告：{warning}" for warning in warnings)
    timing = payload["timing"]
    lines.append(f"- 耗时：读图 {timing['loadSeconds']}s，绘制 {timing['drawSeconds']}s，出图 {timing['rasterSeconds']}s")
    print("\n".join(lines))


# ---------------------------------------------------------------------------
# export
# ---------------------------------------------------------------------------


def cmd_export(args):
    ctx = Context(args)
    region = ctx.region()
    origin = ctx.origin(region)
    coords = Coords(origin)
    records, tolerance = filtered_geometry(ctx, args, region)
    texts = []
    if args.with_text:
        layer_match = cad_core.name_matcher(args.layer)
        texts = [
            text
            for text in ctx.collected["texts"]
            if (region is None or cad_core.point_in_bbox(text["anchor"], region)) and (not layer_match or layer_match(text["layer"]))
        ]

    target = Path(args.out) if args.out else Path.cwd() / ".design-agent" / "cad" / ctx.source.stem / f"{ctx.source.stem}-{ctx.spec.id}-export.dxf"
    target.parent.mkdir(parents=True, exist_ok=True)
    code, unit = cad_core.drawing_units(ctx.document)
    if target.suffix.lower() == ".json":
        payload = base_payload("export", ctx, region, origin)
        payload.update(
            {
                "units": {"code": code, "name": unit},
                "tolerance": tolerance,
                "entities": [geometry_payload(record, coords) for record in records],
                "texts": [
                    {"id": text["id"], "text": text["text"], "layer": text["layer"], "anchor": coords.point(text["anchor"]), "height": text["height"], "rotation": text.get("rotation", 0.0)}
                    for text in texts
                ],
            }
        )
        target.write_text(json.dumps(payload, ensure_ascii=False) + "\n", encoding="utf-8")
    else:
        import ezdxf

        output = ezdxf.new("R2013")
        output.units = code
        states = cad_core.layer_states(ctx.document)
        model = output.modelspace()

        def ensure_layer(name):
            if name not in output.layers:
                output.layers.add(name, color=states.get(name, {}).get("color", 7))

        for record in records:
            ensure_layer(record["layer"])
            model.add_lwpolyline(
                [coords.point(point) for point in record["points"]],
                close=record["closed"],
                dxfattribs={"layer": record["layer"]},
            )
        for text in texts:
            ensure_layer(text["layer"])
            model.add_text(
                text["text"],
                height=text["height"],
                rotation=text.get("rotation", 0.0),
                dxfattribs={"layer": text["layer"], "insert": (*coords.point(text["anchor"]), 0)},
            )
        output.saveas(target)

    lines = header_lines("导出", ctx, region, origin)
    lines.append(f"- 已写入 {target.resolve()}")
    lines.append(
        f"- 几何 {len(records)} 条（{'只含顶层实体' if args.top_level else '块已炸开'}、曲线按弦高 {fmt_number(tolerance)} 离散为多段线，保留原图层）；文字 {len(texts)} 条；"
        f"单位 {unit}，比例 1:1"
    )
    layers = Counter(record["layer"] for record in records)
    if layers:
        lines.append("- 图层：" + "，".join(f"{name} {count}" for name, count in layers.most_common(15)))
    print("\n".join(lines))


# ---------------------------------------------------------------------------
# 命令行
# ---------------------------------------------------------------------------


def add_source(parser):
    parser.add_argument("input", help="CAD 文件（.dwg 或 .dxf）")
    parser.add_argument("--layout", default="model", help="Layout 的 id（model、layout-01…）或名称，默认 model")


def add_region(parser, *, multiple=False):
    parser.add_argument(
        "--bbox",
        action="append",
        help="范围 x0,y0,x1,y1（图纸坐标）" + ("，可重复" if multiple else ""),
    )
    parser.add_argument(
        "--frame",
        action="append",
        help="图框编号（info 列出的 frame-N 或 N），用它的范围" + ("，可重复" if multiple else ""),
    )


def add_query_options(parser, *, inside_help="只要完全落在范围内的（默认与范围相交即算）"):
    add_region(parser)
    parser.add_argument("--inside", action="store_true", help=inside_help)
    parser.add_argument("--layer", action="append", help="图层过滤；逗号分隔多个，含 * ? 为通配，否则按子串，不区分大小写")
    parser.add_argument("--origin", help="输出坐标减去的原点：x,y；或 bbox（取查询范围左下角）")


def add_output(parser, *, formats=("text", "json")):
    parser.add_argument("--out", help="写入该文件（.json 为 JSON，其余为文本），stdout 只回执；不给则打印到 stdout")
    parser.add_argument("--format", choices=formats, help="输出格式；缺省 stdout 为 text，文件按扩展名")
    parser.add_argument("--limit", type=int, help=f"最多输出条数；stdout 默认 {DEFAULT_LIMIT}，写文件默认不限，0 为不限")


def add_geometry_filters(parser):
    parser.add_argument("--type", action="append", help="实体类型过滤，如 LINE,LWPOLYLINE,ARC,CIRCLE,HATCH（炸开块之后的类型）")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--closed", action="store_true", help="只要闭合轮廓")
    group.add_argument("--open", action="store_true", help="只要开放线")
    parser.add_argument("--orient", choices=("h", "v"), help="只要水平（h）或竖直（v）的；按包围盒判定，容差约 0.6°")
    parser.add_argument("--min-length", type=float, help="最小长度（闭合轮廓为周长）")
    parser.add_argument("--min-size", help="包围盒下限：边长 或 宽,高")
    parser.add_argument("--max-size", help="包围盒上限：边长 或 宽,高")
    parser.add_argument("--include-dims", action="store_true", help="包含尺寸标注本身的线（默认排除，避免混进墙线等几何）")
    parser.add_argument("--top-level", action="store_true", help="不炸开块，只看直接画在 Layout 上的实体（如立面图里排除嵌入的索引平面块）")
    parser.add_argument("--tolerance", type=float, help="曲线离散弦高（图纸单位），默认约 0.5 毫米")


def build_parser():
    parser = argparse.ArgumentParser(description="CAD（.dwg/.dxf）解析工具箱", formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)

    info = commands.add_parser("info", help="概览：单位、Layout、图幅与图名、图层、块")
    add_source(info)
    add_output(info)
    info.set_defaults(handler=cmd_info)

    texts = commands.add_parser("texts", help="文字查询")
    add_source(texts)
    add_query_options(texts)
    texts.add_argument("--match", help="正则过滤（不区分大小写，也匹配去掉空白后的检索串）")
    texts.add_argument("--query", help="当前问题；按与问题的字符片段重合度排序")
    texts.add_argument("--query-base64", help="--query 的 UTF-8 Base64 形式，查询含引号等特殊字符时用")
    texts.add_argument("--with-dims", action="store_true", help="把尺寸标注的显示文字也当文字列出")
    texts.add_argument("--sort", choices=("position", "size", "query"), help="排序：阅读顺序（默认）、字号、查询相关度（给了 --query 时默认）")
    texts.add_argument("--unique", action="store_true", help="相同文字只保留一条")
    texts.add_argument("--min-height", type=float, help="最小字高")
    add_output(texts)
    texts.set_defaults(handler=cmd_texts)

    dims = commands.add_parser("dims", help="尺寸标注查询")
    add_source(dims)
    add_query_options(dims, inside_help="测量点与文字位置都在范围内才算（默认任一在内即算）")
    dims.add_argument("--orient", choices=("h", "v"), help="只要水平（h）或竖直（v）标注")
    dims.add_argument("--range", help="测量值范围 最小,最大")
    add_output(dims)
    dims.set_defaults(handler=cmd_dims)

    geom = commands.add_parser("geom", help="几何查询：炸开块、离散曲线后的线与轮廓")
    add_source(geom)
    add_query_options(geom, inside_help="全部顶点都在范围内才算（默认有顶点在内或有边穿过即算）")
    add_geometry_filters(geom)
    geom.add_argument("--points", action="store_true", help="文本输出也列出所有顶点（默认只列顶点不超过 8 个的）")
    add_output(geom)
    geom.set_defaults(handler=cmd_geom)

    blocks = commands.add_parser("blocks", help="块引用查询")
    add_source(blocks)
    add_query_options(blocks, inside_help="包围盒完全落在范围内才算（默认相交即算）")
    blocks.add_argument("--name", action="append", help="块名过滤；规则同 --layer")
    blocks.add_argument("--nested", action="store_true", help="也列出块内嵌套的块引用")
    add_output(blocks)
    blocks.set_defaults(handler=cmd_blocks)

    render = commands.add_parser("render", help="出图：总览、图幅或指定范围")
    add_source(render)
    add_region(render, multiple=True)
    render.add_argument("--panels", action="store_true", help="出总览，并把各个图幅分别出图（优先按顶层图框，没有图框时按留白切分）")
    render.add_argument("--layer", action="append", help="只画匹配的图层；规则同其它命令的 --layer")
    render.add_argument("--highlight", action="append", help="匹配的图层画成红色、其余压成浅灰，用来突出墙体等")
    render.add_argument("--all-layers", action="store_true", help="无视图层的关闭/冻结状态，全部画出")
    render.add_argument("--monochrome", action="store_true", help="所有线和字画成黑色；浅色（黄、青）标注看不清时用")
    render.add_argument("--max-edge", type=int, default=cad_core.DEFAULT_MAX_LONG_EDGE, help=f"单张图长边像素上限，默认 {cad_core.DEFAULT_MAX_LONG_EDGE}；实际按字高自动取能看清的尺寸")
    render.add_argument("--time-budget", type=float, default=RENDER_TIME_BUDGET, help=f"本次调用的时间预算（秒），默认 {RENDER_TIME_BUDGET}")
    render.add_argument("--out", help="图片目录；默认 <当前目录>/.design-agent/cad/<图纸名>/")
    render.add_argument("--format", choices=("text", "json"), help="stdout 视图清单的格式，默认 text")
    render.set_defaults(handler=cmd_render)

    export = commands.add_parser("export", help="导出范围内几何为 DXF/JSON（建模底图、叠合校核）")
    add_source(export)
    add_query_options(export, inside_help="只导出全部顶点都在范围内的图元（默认与范围相交即导出）")
    add_geometry_filters(export)
    export.add_argument("--with-text", action="store_true", help="同时导出范围内的文字")
    export.add_argument("--out", help="输出文件，.dxf（默认）或 .json；默认 <当前目录>/.design-agent/cad/<图纸名>/<图纸名>-<layout>-export.dxf")
    export.set_defaults(handler=cmd_export)
    return parser


def main():
    cad_core.configure_stdio()
    args = build_parser().parse_args()
    if getattr(args, "max_edge", None):
        args.max_edge = max(600, min(4096, args.max_edge))
    try:
        args.handler(args)
    except CadError as error:
        sys.exit(f"ERROR: {error}")
    except re.error as error:
        sys.exit(f"ERROR: --match 不是有效的正则：{error}")


if __name__ == "__main__":
    main()
