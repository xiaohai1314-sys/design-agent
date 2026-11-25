#!/usr/bin/env python3
"""离线诊断 CAD 图幅异常，不修改原件或 cad.py 的解析产物。"""
import argparse
import hashlib
import json
import math
import statistics
import sys
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import cad_core


SCHEMA_VERSION = "cad-outlier-diagnostic/v1"
OUTLIER_FENCE_MULTIPLIER = 3.0
PROXY_ENTITY_TYPES = {"ACAD_PROXY_ENTITY", "ACAD_PROXY_OBJECT"}


def rounded(value):
    return round(float(value), 6)


def entity_handle(entity):
    value = entity.dxf.get("handle", "")
    return "" if value is None else str(value)


def entity_bbox(entity, cache):
    """用 ezdxf 的快速包围盒计算单个顶层实体，失败时保留无 bbox 状态。"""
    try:
        from ezdxf import bbox

        box = bbox.extents([entity], fast=True, cache=cache)
    except Exception:
        return None
    if not box.has_data:
        return None
    values = [box.extmin.x, box.extmin.y, box.extmax.x, box.extmax.y]
    if not all(math.isfinite(float(value)) for value in values):
        return None
    return [rounded(value) for value in values]


def merge_bboxes(boxes):
    boxes = [box for box in boxes if box]
    if not boxes:
        return None
    return [
        min(box[0] for box in boxes),
        min(box[1] for box in boxes),
        max(box[2] for box in boxes),
        max(box[3] for box in boxes),
    ]


def percentile(values, fraction):
    ordered = sorted(float(value) for value in values)
    if not ordered:
        return None
    position = (len(ordered) - 1) * fraction
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    weight = position - lower
    return ordered[lower] * (1.0 - weight) + ordered[upper] * weight


def tukey_fence(values):
    if len(values) < 4:
        return None
    q1 = percentile(values, 0.25)
    q3 = percentile(values, 0.75)
    spread = q3 - q1
    if spread <= 0:
        center = statistics.median(values)
        spread = max(abs(center) * 1e-9, 1e-6)
    return [
        rounded(q1 - OUTLIER_FENCE_MULTIPLIER * spread),
        rounded(q3 + OUTLIER_FENCE_MULTIPLIER * spread),
    ]


def outlier_fences(records):
    centers_x = [(item["bbox"][0] + item["bbox"][2]) / 2.0 for item in records]
    centers_y = [(item["bbox"][1] + item["bbox"][3]) / 2.0 for item in records]
    spans_x = [item["bbox"][2] - item["bbox"][0] for item in records]
    spans_y = [item["bbox"][3] - item["bbox"][1] for item in records]
    return {
        "centerX": tukey_fence(centers_x),
        "centerY": tukey_fence(centers_y),
        "spanX": tukey_fence(spans_x),
        "spanY": tukey_fence(spans_y),
    }


def detect_outliers(records, fences):
    outliers = []
    for item in records:
        box = item["bbox"]
        center = [(box[0] + box[2]) / 2.0, (box[1] + box[3]) / 2.0]
        span = [box[2] - box[0], box[3] - box[1]]
        reasons = []
        for key, value in (("centerX", center[0]), ("centerY", center[1])):
            fence = fences[key]
            if fence and (value < fence[0] or value > fence[1]):
                reasons.append(key)
        for key, center_key, value in (("spanX", "centerX", span[0]), ("spanY", "centerY", span[1])):
            fence = fences[key]
            center_fence = fences[center_key]
            central_span = center_fence[1] - center_fence[0] if center_fence else 0
            if fence and value > fence[1] and value > central_span * 2:
                reasons.append(key)
        if not reasons:
            continue
        outliers.append(
            {
                "handle": item["handle"] or item["ownerHandle"],
                "virtualHandle": item["handle"] or None,
                "ownerHandle": item["ownerHandle"],
                "entityType": item["entityType"],
                "layer": item["layer"],
                "coordinates": {
                    "min": [box[0], box[1]],
                    "max": [box[2], box[3]],
                    "center": [rounded(center[0]), rounded(center[1])],
                },
                "reasons": reasons,
            }
        )
    return outliers


def text_height(entity, entity_type):
    try:
        if entity_type == "MTEXT":
            value = float(entity.dxf.char_height)
        else:
            value = float(entity.dxf.height)
    except Exception:
        return None
    return value if math.isfinite(value) and value > 0 else None


def collect_text_heights(entities, depth=0):
    if depth > 6:
        return []
    heights = []
    for entity in entities:
        entity_type = entity.dxftype()
        if entity_type in ("TEXT", "MTEXT", "ATTRIB"):
            height = text_height(entity, entity_type)
            if height is not None:
                heights.append(height)
        if entity_type != "INSERT":
            continue
        for attribute in getattr(entity, "attribs", []):
            height = text_height(attribute, "ATTRIB")
            if height is not None:
                heights.append(height)
        try:
            heights.extend(collect_text_heights(entity.virtual_entities(), depth + 1))
        except Exception:
            pass
    return heights


def diagnostic_bbox(entity, entity_type, cache):
    """文字沿用 cad_core 的锚点框，其余实体使用 ezdxf 几何框。"""
    if entity_type in ("TEXT", "MTEXT", "ATTRIB"):
        try:
            raw = entity.plain_text() if entity_type == "MTEXT" else entity.dxf.text
            box, _quality = cad_core.text_bbox(entity, entity_type, str(raw))
            return box
        except Exception:
            return None
    return entity_bbox(entity, cache)


def expanded_entity_records(entity, cache, owner_handle=None, depth=0):
    """保留顶层实体并展开 INSERT，暴露块内文字等被外壳 bbox 隐藏的坐标。"""
    if depth > 6:
        return []
    entity_type = entity.dxftype()
    direct_handle = entity_handle(entity)
    owner_handle = owner_handle or direct_handle
    records = [
        {
            "handle": direct_handle,
            "ownerHandle": owner_handle,
            "entityType": entity_type,
            "layer": str(entity.dxf.get("layer", "0")),
            "bbox": diagnostic_bbox(entity, entity_type, cache),
            "virtualDepth": depth,
        }
    ]
    if entity_type != "INSERT":
        return records
    for attribute in getattr(entity, "attribs", []):
        records.extend(expanded_entity_records(attribute, cache, owner_handle, depth + 1))
    try:
        for virtual in entity.virtual_entities():
            records.extend(expanded_entity_records(virtual, cache, owner_handle, depth + 1))
    except Exception:
        pass
    return records


def text_height_summary(heights):
    if not heights:
        return {"count": 0, "minimum": None, "median": None, "maximum": None}
    return {
        "count": len(heights),
        "minimum": rounded(min(heights)),
        "median": rounded(statistics.median(heights)),
        "maximum": rounded(max(heights)),
    }


def bbox_groups(records, overall_bbox):
    groups = {}
    for item in records:
        group = groups.setdefault(item["entityType"], {"entityCount": 0, "boundedCount": 0, "boxes": []})
        group["entityCount"] += 1
        if item["bbox"]:
            group["boundedCount"] += 1
            group["boxes"].append(item["bbox"])

    overall_width = overall_bbox[2] - overall_bbox[0] if overall_bbox else 0
    overall_height = overall_bbox[3] - overall_bbox[1] if overall_bbox else 0
    tolerance = max(abs(overall_width), abs(overall_height), 1.0) * 1e-9
    result = {}
    for entity_type in sorted(groups):
        group = groups[entity_type]
        box = merge_bboxes(group.pop("boxes"))
        edges = []
        if box and overall_bbox:
            if abs(box[0] - overall_bbox[0]) <= tolerance:
                edges.append("minX")
            if abs(box[1] - overall_bbox[1]) <= tolerance:
                edges.append("minY")
            if abs(box[2] - overall_bbox[2]) <= tolerance:
                edges.append("maxX")
            if abs(box[3] - overall_bbox[3]) <= tolerance:
                edges.append("maxY")
        result[entity_type] = {
            **group,
            "bbox": box,
            "spanRatio": {
                "x": rounded((box[2] - box[0]) / overall_width) if box and overall_width > 0 else None,
                "y": rounded((box[3] - box[1]) / overall_height) if box and overall_height > 0 else None,
            },
            "contributingEdges": edges,
        }
    return result


def unresolved_xrefs(document, source_path):
    unresolved = []
    source_dir = source_path.resolve().parent
    xref_names = set()
    for block in document.blocks:
        block_header = block.block
        if not getattr(block_header, "is_xref", False):
            continue
        name = str(block.name)
        xref_names.add(name.casefold())
        raw_path = str(block_header.dxf.get("xref_path", ""))
        candidate = Path(raw_path)
        resolved_path = candidate if candidate.is_absolute() else source_dir / candidate
        unresolved.append(
            {
                "kind": "xref_definition",
                "handle": entity_handle(block_header),
                "name": name,
                "path": raw_path,
                "fileExists": bool(raw_path) and resolved_path.exists(),
                "materialized": False,
            }
        )
    return unresolved, xref_names


def unresolved_layout_entities(document, layout, xref_names):
    unresolved = []
    for entity in layout:
        entity_type = entity.dxftype()
        if entity_type in PROXY_ENTITY_TYPES or type(entity).__name__ == "DXFTagStorage":
            unresolved.append(
                {
                    "kind": "proxy_entity",
                    "layout": layout.name,
                    "handle": entity_handle(entity),
                    "entityType": entity_type,
                    "layer": str(entity.dxf.get("layer", "0")),
                }
            )
            continue
        if entity_type != "INSERT":
            continue
        name = str(entity.dxf.get("name", ""))
        if name.casefold() in xref_names:
            unresolved.append(
                {
                    "kind": "xref_insert",
                    "layout": layout.name,
                    "handle": entity_handle(entity),
                    "name": name,
                    "layer": str(entity.dxf.get("layer", "0")),
                }
            )
            continue
        try:
            document.blocks.get(name)
        except Exception:
            unresolved.append(
                {
                    "kind": "missing_block_reference",
                    "layout": layout.name,
                    "handle": entity_handle(entity),
                    "name": name,
                    "layer": str(entity.dxf.get("layer", "0")),
                }
            )
    return unresolved


def diagnose_layout(document, layout, xref_names):
    from ezdxf import bbox

    cache = bbox.Cache()
    records = []
    for entity in layout:
        records.extend(expanded_entity_records(entity, cache))
    bounded = [item for item in records if item["bbox"]]
    overall = merge_bboxes(item["bbox"] for item in bounded)
    fences = outlier_fences(bounded)
    return {
        "name": layout.name,
        "kind": "modelspace" if layout.name.casefold() == "model" else "paperspace",
        "entityCount": len(layout),
        "expandedEntityCount": len(records),
        "boundedEntityCount": len(bounded),
        "overallBbox": overall,
        "bboxByEntityType": bbox_groups(records, overall),
        "outlierMethod": {
            "name": "tukey_entity_center_and_span",
            "fenceMultiplier": OUTLIER_FENCE_MULTIPLIER,
            "fences": fences,
        },
        "outliers": detect_outliers(bounded, fences),
        "nativeTextHeights": text_height_summary(collect_text_heights(layout)),
        "unresolvedEntities": unresolved_layout_entities(document, layout, xref_names),
    }


def sha256_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def diagnose_document(document, source_path):
    source_path = Path(source_path)
    xrefs, xref_names = unresolved_xrefs(document, source_path)
    layouts = [diagnose_layout(document, layout, xref_names) for layout in document.layouts]
    unresolved = xrefs + [item for layout in layouts for item in layout["unresolvedEntities"]]
    return {
        "schemaVersion": SCHEMA_VERSION,
        "source": {
            "path": str(source_path.resolve()),
            "size": source_path.stat().st_size if source_path.exists() else None,
            "sha256": sha256_file(source_path) if source_path.exists() else None,
        },
        "layouts": layouts,
        "unresolvedReferences": unresolved,
    }


def load_document(source_path):
    import ezdxf

    source_path = Path(source_path)
    # DWG 转换结果在 cad_core 的内容寻址缓存里，与 cad.py 共用，这里只读不删。
    return ezdxf.readfile(cad_core.dxf_path_for(source_path))


def main():
    parser = argparse.ArgumentParser(description="离线输出 CAD bbox、离群实体、文字字高与未解析引用诊断")
    parser.add_argument("source", type=Path, help="待诊断的 DWG 或 DXF")
    parser.add_argument("--output", type=Path, help="可选 JSON 输出路径；未指定时写 stdout")
    args = parser.parse_args()

    try:
        document = load_document(args.source)
    except cad_core.CadError as error:
        sys.exit(f"ERROR: {error}")
    result = diagnose_document(document, args.source)

    payload = json.dumps(result, ensure_ascii=False, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(payload + "\n", encoding="utf-8")
        print(args.output.resolve())
    else:
        print(payload)


if __name__ == "__main__":
    main()
