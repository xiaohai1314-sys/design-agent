"""施工图分幅：把模型空间里的图框列成候选平面，供 plan_extract 用 --frame N 选择。

施工图通常把各层平面、剖面、立面画在同一个模型空间里，按图框分开排布。
整张一起提取会把几个平面混成一张（墙、门窗、房间全串在一起），所以先列出图框再选一个。
"""
import cad_core


def _center(box):
    return ((box[0] + box[2]) / 2.0, (box[1] + box[3]) / 2.0)


def _record_in_frame(frame_box, record_box):
    if not record_box:
        return False
    cx, cy = _center(record_box)
    return frame_box[0] <= cx <= frame_box[2] and frame_box[1] <= cy <= frame_box[3]


def describe_plans(collected, records=None):
    """列出顶层图框：编号、图名、尺寸、框内图元数与主要图层。

    records 为 None 时只给图名和尺寸（不做整图离散，列清单很快）。
    """
    frames = cad_core.top_level_frames(collected)
    texts = collected.get("texts") or []
    plans = []
    for index, frame in enumerate(frames, start=1):
        box = frame["bbox"]
        plan = {
            "index": index,
            "frame": frame["id"],
            "label": frame.get("label") or frame.get("largestText") or "",
            "bbox": [round(value, 1) for value in box],
            "size": [round(box[2] - box[0], 1), round(box[3] - box[1], 1)],
            "texts": sum(1 for text in texts if cad_core.point_in_bbox(text["anchor"], box)),
        }
        if records is not None:
            inside = [record for record in records if _record_in_frame(box, record.get("bbox"))]
            plan["entities"] = len(inside)
            counts = {}
            for record in inside:
                counts[record["layer"]] = counts.get(record["layer"], 0) + 1
            plan["layers"] = dict(sorted(counts.items(), key=lambda item: -item[1])[:6])
        plans.append(plan)
    return plans


def format_plan_list(plans, *, with_layers=True):
    if not plans:
        return "没有识别到图框：整张图按一个平面处理，可直接提取。"
    lines = [f"候选平面（共 {len(plans)} 个图框，按阅读顺序编号）："]
    for plan in plans:
        width, height = plan["size"]
        parts = [
            f"{plan['index']:>2d}.",
            f"{plan['label'] or '（未识别图名）'}",
            f"{width / 1000:.1f}×{height / 1000:.1f} m",
            f"文字 {plan['texts']} 条",
        ]
        if "entities" in plan:
            parts.append(f"图元 {plan['entities']} 个")
        lines.append("  " + "  ".join(parts))
        if with_layers and plan.get("layers"):
            top = "、".join(f"{name}({count})" for name, count in plan["layers"].items())
            lines.append(f"      图层：{top}")
    lines.append("用 --frame N 选择其中一个平面，例如 --frame 3。")
    return "\n".join(lines)
