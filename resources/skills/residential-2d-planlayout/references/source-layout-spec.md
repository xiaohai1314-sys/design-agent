# 从原图提取平面约束

用于已有二维位图、墙柱或入户必须按原图保留的任务。先读清用户对墙体的说明，再确认原图中结构、入口、改动范围和各段通路。清楚的黑白图和深底 CAD 截图可运行只读扫描，获取原图尺寸、SHA-256 和实心区域候选。白底图定位深色填充，深底图定位浅色中性填充。实心门箭头、文字和家具也可能被扫描到，逐项对照原图确认。图面性质不明的部分标为待核。

`execute` 默认使用 Windows cmd。已提供自动清单时跳过扫描。

```text
python -B "<Skill 路径>/scripts/inspect-plan-structure.py" "<用户原图>" --summary
```

外墙或窗线位置难从预览准确换算时，可在同一命令加 `--linework`。已有图纸主体范围时，加 `--linework-bounds 左 上 右 下`，四值均用原图像素。`horizontal`、`vertical` 返回长线的像素包围框，可据此核对墙角、窗带和凹凸边界。尺寸线也可能进入结果，结合原图确认选用位置。可改多边形及门窗保护区以原图为准。

常规任务直接把查明的位置用于设计。批跑附有同一原图的自动扫描清单时，直接用它与原图对照，省去重复扫描。需提交原图约束 JSON 时，保存以下结构，坐标使用原图像素。`protectedSolidIds` 是确认需要保留的扫描候选编号。`entry` 包住原门洞、门垛与影响进门的邻接区，`point` 落在实际门洞。`edits` 包含可改室内区域与拟改的整段墙厚。每个拟开口的中心点要落在某一可改多边形内部，并避开保护区。保护区与修改区重合时优先保护。

```json
{
  "originalSha256": "从扫描结果复制",
  "imageSize": [800, 600],
  "protectedSolidIds": ["S01", "S03"],
  "entry": {"rect": [205, 135, 255, 201], "point": [230, 169]},
  "edits": [{"id": "living", "points": [[256, 134], [511, 134], [511, 320], [256, 320]]}],
  "openings": [{"id": "living-entry", "from": "玄关", "to": "客厅", "point": [256, 172], "state": "existing"}],
  "layout": "写实际房间安排和需要核实的改动条件。"
}
```

上面坐标是接口示例。可改区里要保留的外窗、燃气表或其它固定设备也放入可选的 `locks`，格式同 `edits`。原题要求洄游时，逐条给出具体开口及相连的两个空间，检查能从不同路径连回起点。拟开口的 `state` 为 `proposed`，需要核实结构或接驳的在 `layout` 中说明。仅在批跑要求约束准备时交这个 JSON。平面交付按主流程继续设计、成图和复核。

用 `compile-plan-requirements.py` 读取原图和该 JSON，按所选编号提取保护多边形。它校验原图身份、点位、编号和范围，并检查拟开口在可改范围内。实际墙体性质、可改范围的合理性及两条通路是否闭合仍需在原图与成图上核对。

```text
python -B "<Skill 路径>/scripts/compile-plan-requirements.py" "<用户原图>" "<source-layout.json>" --summary
```

继续合成时省去 `--summary`，把完整结果保存为 JSON，可直接作为 `compose-and-check-plan.py` 的 `--review-path`。需要复核关键开口或双动线时，可在配方中另填 `crossings`、`routes`，格式见[连续通路与使用检查](layout-use-check.md)。
