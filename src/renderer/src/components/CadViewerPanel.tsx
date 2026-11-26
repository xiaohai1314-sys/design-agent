import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Crosshair,
  Info,
  Layers,
  LoaderCircle,
  Maximize2,
  MessageSquarePlus,
  MousePointer,
  Ruler,
  Search,
  SquarePen,
  Trash2
} from 'lucide-react'
import clsx from 'clsx'
import type { CadEntity, CadLayerInfo, CadPreviewResult, CadSnapPoint } from '@shared/ipc'
import { distPointToSeg, segSegIntersect } from '@shared/cadGeometry'
import type { ModelAnnotationRef } from '@shared/protocol'

interface CadBoxAnnotation {
  id: string
  x0: number
  y0: number
  x1: number
  y1: number
  note: string
}

interface CadViewerPanelProps {
  filePath: string
  title: string
  onAttachAnnotations: (ref: ModelAnnotationRef) => void
}

const SNAP_LABELS: Record<CadSnapPoint['kind'] | 'intersection' | 'perpendicular', string> = {
  endpoint: '端点',
  midpoint: '中点',
  center: '圆心',
  intersection: '交点',
  perpendicular: '垂足'
}

interface DynamicSnapPoint {
  x: number
  y: number
  kind: CadSnapPoint['kind'] | 'intersection' | 'perpendicular'
  layer: string
}

export const CadViewerPanel: React.FC<CadViewerPanelProps> = ({
  filePath,
  title,
  onAttachAnnotations
}) => {
  const [loading, setLoading] = useState(true)
  const [data, setData] = useState<CadPreviewResult | null>(null)
  const [layerVis, setLayerVis] = useState<Record<string, boolean>>({})
  const [layerPanelOpen, setLayerPanelOpen] = useState(false)
  const [layerSearch, setLayerSearch] = useState('')
  const [inspectedEntity, setInspectedEntity] = useState<CadEntity | null>(null)

  const [toolMode, setToolMode] = useState<'pan' | 'measure' | 'annotate' | 'inspect'>('pan')
  const [snapEnabled, setSnapEnabled] = useState(true)
  const [hoverSnap, setHoverSnap] = useState<DynamicSnapPoint | null>(null)
  const [cursorWorld, setCursorWorld] = useState<[number, number] | null>(null)

  // 测量状态
  const [measurePts, setMeasurePts] = useState<Array<[number, number]>>([])
  // 框选批注状态
  const [dragStartWorld, setDragStartWorld] = useState<[number, number] | null>(null)
  const [pendingBox, setPendingBox] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  const [noteInput, setNoteInput] = useState('')
  const [annotations, setAnnotations] = useState<CadBoxAnnotation[]>([])

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)

  // 视图变换：screenX = (worldX - centerX) * scale + width/2, screenY = height/2 - (worldY - centerY) * scale
  const viewRef = useRef({ centerX: 0, centerY: 0, scale: 1 })
  const panDragRef = useRef<{ startX: number; startY: number; origCX: number; origCY: number } | null>(null)
  const [renderTick, setRenderTick] = useState(0)

  const triggerRedraw = useCallback(() => setRenderTick((t) => t + 1), [])

  const fitView = useCallback(
    (bbox?: { minX: number; minY: number; maxX: number; maxY: number }) => {
      const box = bbox ?? data?.bbox
      const el = containerRef.current
      if (!box || !el) return
      const w = Math.max(1, el.clientWidth)
      const h = Math.max(1, el.clientHeight)
      const bw = Math.max(1e-3, box.maxX - box.minX)
      const bh = Math.max(1e-3, box.maxY - box.minY)
      const scale = Math.min((w * 0.86) / bw, (h * 0.86) / bh)
      viewRef.current = {
        centerX: (box.minX + box.maxX) / 2,
        centerY: (box.minY + box.maxY) / 2,
        scale: Number.isFinite(scale) && scale > 0 ? scale : 1
      }
      triggerRedraw()
    },
    [data?.bbox, triggerRedraw]
  )

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setAnnotations([])
    setMeasurePts([])
    setPendingBox(null)

    window.designAgent.cadPreview
      .prepare(filePath)
      .then((res) => {
        if (cancelled) return
        setData(res)
        const vis: Record<string, boolean> = {}
        for (const l of res.layers ?? []) vis[l.name] = l.visible
        setLayerVis(vis)
        setLoading(false)
        setTimeout(() => fitView(res.bbox), 30)
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setData({ ok: false, error: err instanceof Error ? err.message : String(err) })
          setLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [filePath, fitView])

  const layerColorMap = useMemo(() => {
    const m = new Map<string, string>()
    for (const l of data?.layers ?? []) m.set(l.name, l.color)
    return m
  }, [data?.layers])

  const screenToWorld = (sx: number, sy: number): [number, number] => {
    const el = canvasRef.current
    const w = el?.clientWidth ?? 1
    const h = el?.clientHeight ?? 1
    const { centerX, centerY, scale } = viewRef.current
    return [centerX + (sx - w / 2) / scale, centerY - (sy - h / 2) / scale]
  }

  const worldToScreen = (wx: number, wy: number, w: number, h: number): [number, number] => {
    const { centerX, centerY, scale } = viewRef.current
    return [(wx - centerX) * scale + w / 2, h / 2 - (wy - centerY) * scale]
  }

  // Canvas 主渲染循环
  useEffect(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container || !data?.ok || !data.entities) return

    const dpr = window.devicePixelRatio || 1
    const w = container.clientWidth
    const h = container.clientHeight
    if (w <= 0 || h <= 0) return

    canvas.width = Math.floor(w * dpr)
    canvas.height = Math.floor(h * dpr)
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = '#141619'
    ctx.fillRect(0, 0, w, h)

    const { scale } = viewRef.current
    ctx.lineWidth = 1

    for (const ent of data.entities) {
      if (layerVis[ent.layer] === false) continue
      const stroke = ent.color ?? layerColorMap.get(ent.layer) ?? '#e4e4e7'

      if (ent.kind === 'polyline') {
        if (ent.pts.length < 2) continue
        ctx.strokeStyle = stroke
        if (ent.dashed) ctx.setLineDash([6, 4])
        else ctx.setLineDash([])

        ctx.beginPath()
        const [sx0, sy0] = worldToScreen(ent.pts[0][0], ent.pts[0][1], w, h)
        ctx.moveTo(sx0, sy0)
        for (let k = 1; k < ent.pts.length; k++) {
          const [sx, sy] = worldToScreen(ent.pts[k][0], ent.pts[k][1], w, h)
          ctx.lineTo(sx, sy)
        }
        if (ent.closed) ctx.closePath()
        ctx.stroke()
      } else if (ent.kind === 'circle') {
        const sr = ent.r * scale
        if (sr < 0.4) continue
        const [cx, cy] = worldToScreen(ent.cx, ent.cy, w, h)
        if (cx + sr < 0 || cx - sr > w || cy + sr < 0 || cy - sr > h) continue
        ctx.setLineDash([])
        ctx.strokeStyle = stroke
        ctx.beginPath()
        ctx.arc(cx, cy, sr, 0, Math.PI * 2)
        ctx.stroke()
      } else if (ent.kind === 'arc') {
        const sr = ent.r * scale
        if (sr < 0.4) continue
        const [cx, cy] = worldToScreen(ent.cx, ent.cy, w, h)
        ctx.setLineDash([])
        ctx.strokeStyle = stroke
        ctx.beginPath()
        // Canvas Y 轴向下，DXF 逆时针角度映射为负角逆时针绘制
        ctx.arc(cx, cy, sr, -ent.startAngle, -ent.endAngle, true)
        ctx.stroke()
      } else if (ent.kind === 'text') {
        const pxH = ent.height * scale
        if (pxH < 5 || pxH > 200) continue
        const [tx, ty] = worldToScreen(ent.x, ent.y, w, h)
        if (tx < -150 || tx > w + 150 || ty < -60 || ty > h + 60) continue
        ctx.save()
        ctx.translate(tx, ty)
        if (ent.rotation) ctx.rotate((-ent.rotation * Math.PI) / 180)
        ctx.fillStyle = stroke
        ctx.font = `${Math.min(28, Math.max(8, Math.round(pxH)))}px sans-serif`
        ctx.fillText(ent.text, 0, 0)
        ctx.restore()
      }
    }

    ctx.setLineDash([])

    // 绘制已保存的批注框
    annotations.forEach((ann, idx) => {
      const [sx0, sy0] = worldToScreen(ann.x0, ann.y0, w, h)
      const [sx1, sy1] = worldToScreen(ann.x1, ann.y1, w, h)
      const left = Math.min(sx0, sx1)
      const top = Math.min(sy0, sy1)
      const bw = Math.abs(sx1 - sx0)
      const bh = Math.abs(sy1 - sy0)
      ctx.fillStyle = 'rgba(59, 130, 246, 0.16)'
      ctx.strokeStyle = '#60a5fa'
      ctx.lineWidth = 1.5
      ctx.fillRect(left, top, bw, bh)
      ctx.strokeRect(left, top, bw, bh)

      ctx.fillStyle = '#2563eb'
      ctx.fillRect(left, top - 18, 22, 18)
      ctx.fillStyle = '#ffffff'
      ctx.font = 'bold 11px sans-serif'
      ctx.fillText(`#${idx + 1}`, left + 4, top - 5)
    })

    // 绘制正在拉框的待填批注区域
    const boxToDraw =
      pendingBox ??
      (dragStartWorld && cursorWorld
        ? {
            x0: dragStartWorld[0],
            y0: dragStartWorld[1],
            x1: cursorWorld[0],
            y1: cursorWorld[1]
          }
        : null)

    if (boxToDraw) {
      const [sx0, sy0] = worldToScreen(boxToDraw.x0, boxToDraw.y0, w, h)
      const [sx1, sy1] = worldToScreen(boxToDraw.x1, boxToDraw.y1, w, h)
      ctx.strokeStyle = '#fbbf24'
      ctx.lineWidth = 1.5
      ctx.setLineDash([5, 3])
      ctx.strokeRect(
        Math.min(sx0, sx1),
        Math.min(sy0, sy1),
        Math.abs(sx1 - sx0),
        Math.abs(sy1 - sy0)
      )
      ctx.setLineDash([])
    }

    // 绘制测量线
    if (measurePts.length >= 1) {
      const p0 = measurePts[0]
      const p1 = measurePts[1] ?? (hoverSnap ? [hoverSnap.x, hoverSnap.y] : cursorWorld)
      const [sx0, sy0] = worldToScreen(p0[0], p0[1], w, h)
      ctx.fillStyle = '#f97316'
      ctx.beginPath()
      ctx.arc(sx0, sy0, 4, 0, Math.PI * 2)
      ctx.fill()

      if (p1) {
        const [sx1, sy1] = worldToScreen(p1[0], p1[1], w, h)
        ctx.strokeStyle = '#f97316'
        ctx.lineWidth = 1.5
        ctx.setLineDash([4, 3])
        ctx.beginPath()
        ctx.moveTo(sx0, sy0)
        ctx.lineTo(sx1, sy1)
        ctx.stroke()
        ctx.setLineDash([])

        ctx.beginPath()
        ctx.arc(sx1, sy1, 4, 0, Math.PI * 2)
        ctx.fill()
      }
    }

    // 绘制捕捉特征点标记（端点方框 / 中点三角 / 圆心圆圈）
    if (hoverSnap && (toolMode === 'measure' || snapEnabled)) {
      const [hx, hy] = worldToScreen(hoverSnap.x, hoverSnap.y, w, h)
      ctx.lineWidth = 2
      if (hoverSnap.kind === 'endpoint') {
        ctx.strokeStyle = '#22c55e'
        ctx.strokeRect(hx - 5, hy - 5, 10, 10)
      } else if (hoverSnap.kind === 'midpoint') {
        ctx.strokeStyle = '#06b6d4'
        ctx.beginPath()
        ctx.moveTo(hx, hy - 6)
        ctx.lineTo(hx - 6, hy + 5)
        ctx.lineTo(hx + 6, hy + 5)
        ctx.closePath()
        ctx.stroke()
      } else if (hoverSnap.kind === 'intersection') {
        // 交点用叉号，和圆心圆圈区分开
        ctx.strokeStyle = '#f472b6'
        ctx.beginPath()
        ctx.moveTo(hx - 5, hy - 5)
        ctx.lineTo(hx + 5, hy + 5)
        ctx.moveTo(hx + 5, hy - 5)
        ctx.lineTo(hx - 5, hy + 5)
        ctx.stroke()
      } else {
        ctx.strokeStyle = '#eab308'
        ctx.beginPath()
        ctx.arc(hx, hy, 5, 0, Math.PI * 2)
        ctx.stroke()
      }
    }

    // 十字光标叠层：贯穿画布的十字线 + 中心拾取框
    if (cursorWorld && !panDragRef.current) {
      const [cx, cy] = worldToScreen(cursorWorld[0], cursorWorld[1], w, h)
      ctx.save()
      ctx.lineWidth = 1
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.45)'
      ctx.beginPath()
      ctx.moveTo(0, cy)
      ctx.lineTo(w, cy)
      ctx.moveTo(cx, 0)
      ctx.lineTo(cx, h)
      ctx.stroke()
      // 拾取框：开捕捉时略大，便于对齐
      const box = snapEnabled ? 9 : 6
      ctx.strokeStyle = 'rgba(226, 232, 240, 0.85)'
      ctx.strokeRect(cx - box, cy - box, box * 2, box * 2)
      ctx.restore()
    }

    // UCS 坐标轴图标：二维视图不旋转，X 恒朝右、Y 恒朝上
    {
      const ox = 36
      const oy = h - 36
      const len = 24
      ctx.save()
      ctx.lineWidth = 2
      ctx.strokeStyle = '#ef4444'
      ctx.beginPath()
      ctx.moveTo(ox, oy)
      ctx.lineTo(ox + len, oy)
      ctx.stroke()
      ctx.strokeStyle = '#22c55e'
      ctx.beginPath()
      ctx.moveTo(ox, oy)
      ctx.lineTo(ox, oy - len)
      ctx.stroke()
      ctx.font = '11px ui-sans-serif, system-ui, sans-serif'
      ctx.fillStyle = '#ef4444'
      ctx.fillText('X', ox + len + 4, oy + 4)
      ctx.fillStyle = '#22c55e'
      ctx.fillText('Y', ox - 5, oy - len - 5)
      ctx.restore()
    }
  }, [
    data,
    layerVis,
    layerColorMap,
    renderTick,
    annotations,
    pendingBox,
    dragStartWorld,
    cursorWorld,
    measurePts,
    hoverSnap,
    toolMode,
    snapEnabled
  ])

  // 监听容器尺寸变化重绘
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => triggerRedraw())
    ro.observe(el)
    return () => ro.disconnect()
  }, [triggerRedraw])

  const findNearestSnap = (wx: number, wy: number): DynamicSnapPoint | null => {
    if (!snapEnabled || !data) return null
    const maxDistWorld = 12 / viewRef.current.scale
    const maxDistSq = maxDistWorld * maxDistWorld
    let best: DynamicSnapPoint | null = null
    let bestSq = maxDistSq
    for (const sp of data.snapPoints ?? []) {
      if (layerVis[sp.layer] === false) continue
      const dx = sp.x - wx
      const dy = sp.y - wy
      const d2 = dx * dx + dy * dy
      if (d2 < bestSq) {
        bestSq = d2
        best = sp
      }
    }
    // 若未命中固定特征点且已有测量起点，补算线段垂足捕捉
    if (!best && toolMode === 'measure' && measurePts.length === 1 && data.entities) {
      const [ox, oy] = measurePts[0]
      for (const ent of data.entities) {
        if (layerVis[ent.layer] === false || ent.kind !== 'polyline') continue
        for (let i = 0; i + 1 < ent.pts.length; i++) {
          const [ax, ay] = ent.pts[i]
          const [bx, by] = ent.pts[i + 1]
          const perp = distPointToSeg(ox, oy, ax, ay, bx, by)
          const d2 = (perp.footX - wx) ** 2 + (perp.footY - wy) ** 2
          if (d2 < bestSq) {
            bestSq = d2
            best = { x: perp.footX, y: perp.footY, kind: 'perpendicular', layer: ent.layer }
          }
        }
      }
    }
    // 交点捕捉：只拿光标附近的线段两两求交，避免整图 O(n²)
    if (!best && data.entities) {
      const near: Array<{ a: [number, number]; b: [number, number]; layer: string }> = []
      const radius = maxDistWorld * 4
      for (const ent of data.entities) {
        if (layerVis[ent.layer] === false || ent.kind !== 'polyline') continue
        for (let i = 0; i + 1 < ent.pts.length; i += 1) {
          const a = ent.pts[i]
          const b = ent.pts[i + 1]
          if (distPointToSeg(wx, wy, a[0], a[1], b[0], b[1]).dist <= radius) {
            near.push({ a, b, layer: ent.layer })
          }
          if (near.length >= 200) break
        }
        if (near.length >= 200) break
      }
      for (let i = 0; i < near.length; i += 1) {
        for (let j = i + 1; j < near.length; j += 1) {
          const p = segSegIntersect(near[i].a, near[i].b, near[j].a, near[j].b)
          if (!p) continue
          const d2 = (p[0] - wx) ** 2 + (p[1] - wy) ** 2
          if (d2 < bestSq) {
            bestSq = d2
            best = { x: p[0], y: p[1], kind: 'intersection', layer: near[i].layer }
          }
        }
      }
    }
    return best
  }

  const pickEntityAt = (wx: number, wy: number): CadEntity | null => {
    if (!data?.entities) return null
    const tol = 10 / viewRef.current.scale
    let best: CadEntity | null = null
    let bestDist = tol
    for (const ent of data.entities) {
      if (layerVis[ent.layer] === false) continue
      if (ent.kind === 'polyline') {
        for (let i = 0; i + 1 < ent.pts.length; i++) {
          const d = distPointToSeg(wx, wy, ent.pts[i][0], ent.pts[i][1], ent.pts[i + 1][0], ent.pts[i + 1][1]).dist
          if (d < bestDist) {
            bestDist = d
            best = ent
          }
        }
      } else if (ent.kind === 'circle' || ent.kind === 'arc') {
        const d = Math.abs(Math.hypot(wx - ent.cx, wy - ent.cy) - ent.r)
        if (d < bestDist) {
          bestDist = d
          best = ent
        }
      } else if (ent.kind === 'text') {
        const d = Math.hypot(wx - ent.x, wy - ent.y)
        if (d < bestDist * 2.5) {
          bestDist = d
          best = ent
        }
      }
    }
    return best
  }

  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>): void => {
    e.preventDefault()
    const rect = e.currentTarget.getBoundingClientRect()
    const sx = e.clientX - rect.left
    const sy = e.clientY - rect.top
    const [wxBefore, wyBefore] = screenToWorld(sx, sy)
    const factor = e.deltaY < 0 ? 1.18 : 1 / 1.18
    const nextScale = Math.min(500, Math.max(1e-5, viewRef.current.scale * factor))
    const w = rect.width
    const h = rect.height
    viewRef.current = {
      scale: nextScale,
      centerX: wxBefore - (sx - w / 2) / nextScale,
      centerY: wyBefore + (sy - h / 2) / nextScale
    }
    triggerRedraw()
  }

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect()
    const sx = e.clientX - rect.left
    const sy = e.clientY - rect.top
    const [wx, wy] = screenToWorld(sx, sy)

    if (toolMode === 'inspect' && e.button === 0) {
      setInspectedEntity(pickEntityAt(wx, wy))
      return
    }

    if (toolMode === 'measure' && e.button === 0) {
      const pt: [number, number] = hoverSnap ? [hoverSnap.x, hoverSnap.y] : [wx, wy]
      setMeasurePts((prev) => (prev.length >= 2 ? [pt] : [...prev, pt]))
      return
    }

    if (toolMode === 'annotate' && e.button === 0) {
      setPendingBox(null)
      setDragStartWorld([wx, wy])
      return
    }

    panDragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      origCX: viewRef.current.centerX,
      origCY: viewRef.current.centerY
    }
  }

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect()
    const sx = e.clientX - rect.left
    const sy = e.clientY - rect.top
    const [wx, wy] = screenToWorld(sx, sy)
    setCursorWorld([wx, wy])

    if (panDragRef.current) {
      const dx = e.clientX - panDragRef.current.startX
      const dy = e.clientY - panDragRef.current.startY
      viewRef.current.centerX = panDragRef.current.origCX - dx / viewRef.current.scale
      viewRef.current.centerY = panDragRef.current.origCY + dy / viewRef.current.scale
      triggerRedraw()
      return
    }

    if (toolMode === 'measure' || snapEnabled) {
      setHoverSnap(findNearestSnap(wx, wy))
    }
  }

  const handleMouseUp = (e: React.MouseEvent<HTMLCanvasElement>): void => {
    if (panDragRef.current) {
      panDragRef.current = null
      return
    }
    if (toolMode === 'annotate' && dragStartWorld) {
      const rect = e.currentTarget.getBoundingClientRect()
      const [wx, wy] = screenToWorld(e.clientX - rect.left, e.clientY - rect.top)
      const x0 = Math.min(dragStartWorld[0], wx)
      const y0 = Math.min(dragStartWorld[1], wy)
      const x1 = Math.max(dragStartWorld[0], wx)
      const y1 = Math.max(dragStartWorld[1], wy)
      setDragStartWorld(null)
      if (Math.abs(x1 - x0) * viewRef.current.scale > 6 && Math.abs(y1 - y0) * viewRef.current.scale > 6) {
        setPendingBox({ x0, y0, x1, y1 })
      }
    }
  }

  const addBoxAnnotation = (): void => {
    if (!pendingBox || !noteInput.trim()) return
    setAnnotations((prev) => [
      ...prev,
      {
        id: `cad_ann_${Date.now()}`,
        ...pendingBox,
        note: noteInput.trim()
      }
    ])
    setPendingBox(null)
    setNoteInput('')
    setToolMode('pan')
  }

  const sendAnnotationsToChat = (): void => {
    if (annotations.length === 0) return
    const unit = data?.unitLabel ?? 'mm'
    const lines = annotations.map(
      (a, idx) =>
        `${idx + 1}. 图纸框选区域 --bbox ${Math.round(a.x0)},${Math.round(a.y0)},${Math.round(a.x1)},${Math.round(a.y1)} (${unit})：${a.note}`
    )
    onAttachAnnotations({
      title,
      path: filePath,
      count: annotations.length,
      text: lines.join('\n')
    })
  }

  if (loading) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-2 text-xs text-zinc-500">
        <LoaderCircle className="w-5 h-5 animate-spin text-blue-600" />
        <span>正在转换并解析 CAD 图纸几何与图层…</span>
      </div>
    )
  }

  if (!data?.ok) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-6 text-center gap-2">
        <p className="text-xs text-rose-600 font-medium">{data?.error || '图纸解析失败'}</p>
        <p className="text-[11px] text-zinc-400">可点击右上角调用本机 AutoCAD 打开查看</p>
      </div>
    )
  }

  const measureInfo =
    measurePts.length === 2
      ? {
          dx: Math.abs(measurePts[1][0] - measurePts[0][0]),
          dy: Math.abs(measurePts[1][1] - measurePts[0][1]),
          dist: Math.hypot(
            measurePts[1][0] - measurePts[0][0],
            measurePts[1][1] - measurePts[0][1]
          )
        }
      : null

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-2">
      {/* CAD 交互工具条 */}
      <div className="flex items-center justify-between gap-1 px-2 py-1.5 rounded-xl bg-zinc-900 text-zinc-200 text-[11px]">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setToolMode('pan')}
            className={clsx(
              'inline-flex items-center gap-1 px-2 py-1 rounded-md cursor-pointer',
              toolMode === 'pan' ? 'bg-blue-600 text-white' : 'hover:bg-zinc-800'
            )}
          >
            <MousePointer className="w-3.5 h-3.5" />
            <span>漫游</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setToolMode('measure')
              setMeasurePts([])
            }}
            className={clsx(
              'inline-flex items-center gap-1 px-2 py-1 rounded-md cursor-pointer',
              toolMode === 'measure' ? 'bg-orange-600 text-white' : 'hover:bg-zinc-800'
            )}
          >
            <Ruler className="w-3.5 h-3.5" />
            <span>量尺</span>
          </button>
          <button
            type="button"
            onClick={() => setToolMode('annotate')}
            className={clsx(
              'inline-flex items-center gap-1 px-2 py-1 rounded-md cursor-pointer',
              toolMode === 'annotate' ? 'bg-blue-600 text-white' : 'hover:bg-zinc-800'
            )}
          >
            <SquarePen className="w-3.5 h-3.5" />
            <span>框选批注</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setToolMode(toolMode === 'inspect' ? 'pan' : 'inspect')
              setInspectedEntity(null)
            }}
            title="点击图纸对象查看图层与几何属性"
            className={clsx(
              'inline-flex items-center gap-1 px-2 py-1 rounded-md cursor-pointer',
              toolMode === 'inspect' ? 'bg-indigo-600 text-white' : 'hover:bg-zinc-800'
            )}
          >
            <Info className="w-3.5 h-3.5" />
            <span>属性</span>
          </button>
          <button
            type="button"
            onClick={() => setSnapEnabled(!snapEnabled)}
            title="端点/中点/圆心自动捕捉"
            className={clsx(
              'inline-flex items-center gap-1 px-2 py-1 rounded-md cursor-pointer',
              snapEnabled ? 'text-emerald-400 bg-zinc-800' : 'text-zinc-500 hover:bg-zinc-800'
            )}
          >
            <Crosshair className="w-3.5 h-3.5" />
            <span>捕捉</span>
          </button>
        </div>

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setLayerPanelOpen(!layerPanelOpen)}
            className={clsx(
              'inline-flex items-center gap-1 px-2 py-1 rounded-md cursor-pointer',
              layerPanelOpen ? 'bg-zinc-700 text-white' : 'hover:bg-zinc-800'
            )}
          >
            <Layers className="w-3.5 h-3.5" />
            <span>图层 ({data.layers?.length ?? 0})</span>
          </button>
          <button
            type="button"
            onClick={() => fitView()}
            title="全图居中"
            className="p-1 rounded-md hover:bg-zinc-800 cursor-pointer"
          >
            <Maximize2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* 主画布容器 */}
      <div
        ref={containerRef}
        className="relative flex-1 min-h-[320px] rounded-xl overflow-hidden border border-zinc-800 bg-[#141619]"
      >
        <canvas
          ref={canvasRef}
          onWheel={handleWheel}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          className={clsx(
            'w-full h-full block',
            toolMode === 'pan' ? 'cursor-grab active:cursor-grabbing' : 'cursor-crosshair'
          )}
        />

        {/* 左下角实时坐标与捕捉提示 */}
        <div className="absolute left-2.5 bottom-2 px-2 py-0.5 rounded bg-black/65 text-[10px] font-mono text-zinc-300 pointer-events-none flex items-center gap-2">
          {cursorWorld && (
            <span>
              X:{Math.round(cursorWorld[0])} Y:{Math.round(cursorWorld[1])} {data.unitLabel}
            </span>
          )}
          {hoverSnap && (
            <span className="text-emerald-400">● {SNAP_LABELS[hoverSnap.kind]}</span>
          )}
        </div>

        {/* MeasureCard 测量结果浮窗 */}
        {measureInfo && (
          <div className="absolute left-2.5 top-2.5 rounded-lg bg-zinc-900/95 border border-orange-500/50 px-3 py-2 text-[11px] text-zinc-100 shadow-lg space-y-0.5">
            <div className="font-semibold text-orange-400">
              距离：{measureInfo.dist.toFixed(1)} {data.unitLabel}
            </div>
            <div className="text-zinc-400 font-mono text-[10px]">
              ΔX: {measureInfo.dx.toFixed(1)} · ΔY: {measureInfo.dy.toFixed(1)}
            </div>
          </div>
        )}

        {/* 图元属性检视浮窗 */}
        {toolMode === 'inspect' && inspectedEntity && (
          <div className="absolute left-2.5 top-2.5 rounded-xl bg-zinc-900/95 border border-indigo-500/50 px-3 py-2 text-[11px] text-zinc-100 shadow-lg max-w-64 space-y-1">
            <div className="flex items-center justify-between gap-2 text-indigo-300 font-semibold">
              <span>图元属性 ({inspectedEntity.kind})</span>
              <button
                type="button"
                onClick={() => setInspectedEntity(null)}
                className="text-zinc-400 hover:text-white cursor-pointer"
              >
                ×
              </button>
            </div>
            <div>图层：{inspectedEntity.layer}</div>
            {inspectedEntity.kind === 'text' && (
              <div className="text-zinc-300">文本：{inspectedEntity.text}</div>
            )}
            {(inspectedEntity.kind === 'circle' || inspectedEntity.kind === 'arc') && (
              <div className="font-mono text-[10px] text-zinc-300">
                半径 R={inspectedEntity.r.toFixed(1)} · 圆心({Math.round(inspectedEntity.cx)}, {Math.round(inspectedEntity.cy)})
              </div>
            )}
            {inspectedEntity.kind === 'polyline' && (
              <div className="font-mono text-[10px] text-zinc-300">
                顶点数：{inspectedEntity.pts.length} · {inspectedEntity.closed ? '闭合' : '开放'}
              </div>
            )}
          </div>
        )}

        {/* 待确认框选批注输入浮层 */}
        {pendingBox && (
          <div className="absolute inset-x-3 bottom-9 rounded-xl bg-zinc-900/95 border border-blue-500/60 p-2.5 shadow-xl space-y-2">
            <div className="text-[11px] text-blue-300 font-medium">
              输入该框选图纸区域的修改或审查要求：
            </div>
            <div className="flex items-center gap-1.5">
              <input
                type="text"
                autoFocus
                value={noteInput}
                onChange={(e) => setNoteInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') addBoxAnnotation()
                }}
                placeholder="例如：把这面非承重墙拆改后与客厅打通…"
                className="flex-1 px-2.5 py-1.5 rounded-lg bg-zinc-800 border border-zinc-700 text-xs text-white outline-none focus:border-blue-400"
              />
              <button
                type="button"
                onClick={() => setPendingBox(null)}
                className="px-2 py-1.5 rounded-lg text-xs text-zinc-400 hover:text-white cursor-pointer"
              >
                取消
              </button>
              <button
                type="button"
                onClick={addBoxAnnotation}
                className="px-3 py-1.5 rounded-lg bg-blue-600 text-white text-xs font-medium hover:bg-blue-500 cursor-pointer"
              >
                添加
              </button>
            </div>
          </div>
        )}

        {/* LayerPanel 图层抽屉（支持搜索过滤与单独隔离显示） */}
        {layerPanelOpen && data.layers && (
          <div className="absolute right-2 top-2 bottom-2 w-56 rounded-xl bg-zinc-900/95 border border-zinc-700 p-2.5 flex flex-col shadow-xl">
            <div className="flex items-center justify-between pb-1.5 mb-1.5 border-b border-zinc-800 text-[11px] text-zinc-300">
              <span className="font-semibold">图层列表</span>
              <div className="flex gap-1.5 text-[10px]">
                <button
                  type="button"
                  onClick={() => {
                    const next: Record<string, boolean> = {}
                    for (const l of data.layers ?? []) next[l.name] = true
                    setLayerVis(next)
                  }}
                  className="text-blue-400 hover:underline cursor-pointer"
                >
                  全部显示
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const next: Record<string, boolean> = {}
                    for (const l of data.layers ?? []) next[l.name] = false
                    setLayerVis(next)
                  }}
                  className="text-zinc-400 hover:underline cursor-pointer"
                >
                  全隐
                </button>
              </div>
            </div>
            <div className="relative mb-1.5">
              <Search className="w-3 h-3 text-zinc-500 absolute left-2 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={layerSearch}
                onChange={(e) => setLayerSearch(e.target.value)}
                placeholder="搜索图层…"
                className="w-full pl-6 pr-2 py-1 rounded bg-zinc-800 border border-zinc-700 text-[11px] text-zinc-100 placeholder:text-zinc-500 outline-none focus:border-blue-500"
              />
            </div>
            <div className="flex-1 overflow-y-auto space-y-1">
              {data.layers
                .filter((l: CadLayerInfo) =>
                  layerSearch.trim()
                    ? l.name.toLowerCase().includes(layerSearch.trim().toLowerCase())
                    : true
                )
                .map((l: CadLayerInfo) => (
                  <div
                    key={l.name}
                    className="group flex items-center gap-1.5 px-1.5 py-1 rounded hover:bg-zinc-800 text-[11px] text-zinc-200"
                  >
                    <label className="flex items-center gap-1.5 flex-1 min-w-0 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={layerVis[l.name] !== false}
                        onChange={(e) =>
                          setLayerVis((prev) => ({ ...prev, [l.name]: e.target.checked }))
                        }
                      />
                      <span
                        className="w-2.5 h-2.5 rounded-xs shrink-0"
                        style={{ backgroundColor: l.color }}
                      />
                      <span className="truncate flex-1" title={l.name}>
                        {l.name}
                      </span>
                    </label>
                    <button
                      type="button"
                      onClick={() => {
                        const next: Record<string, boolean> = {}
                        for (const item of data.layers ?? []) next[item.name] = item.name === l.name
                        setLayerVis(next)
                      }}
                      title="仅显示此图层"
                      className="opacity-0 group-hover:opacity-100 text-[10px] text-blue-400 hover:underline cursor-pointer shrink-0"
                    >
                      单显
                    </button>
                    <span className="text-[10px] text-zinc-500 tabular-nums">{l.entityCount}</span>
                  </div>
                ))}
            </div>
          </div>
        )}
      </div>

      {/* 底部已添加的图纸批注条与“加入对话”按钮 */}
      {annotations.length > 0 && (
        <div className="rounded-xl border border-blue-200 bg-blue-50/60 p-2.5 space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-blue-900">
              已标记 {annotations.length} 处图纸批注
            </span>
            <button
              type="button"
              onClick={sendAnnotationsToChat}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 cursor-pointer"
            >
              <MessageSquarePlus className="w-3.5 h-3.5" />
              <span>加入对话</span>
            </button>
          </div>
          <div className="space-y-1 max-h-24 overflow-y-auto">
            {annotations.map((a, idx) => (
              <div key={a.id} className="flex items-center justify-between gap-2 text-[11px] text-zinc-700">
                <span className="truncate">
                  <strong className="text-blue-700">#{idx + 1}</strong> {a.note}
                </span>
                <button
                  type="button"
                  onClick={() => setAnnotations((prev) => prev.filter((x) => x.id !== a.id))}
                  className="text-zinc-400 hover:text-rose-600 cursor-pointer shrink-0"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
