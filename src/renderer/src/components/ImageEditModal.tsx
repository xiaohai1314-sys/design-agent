import React, { useEffect, useRef, useState } from 'react'
import { Brush, Check, RotateCcw, Square, X } from 'lucide-react'
import clsx from 'clsx'

interface ImageEditModalProps {
  hint: string
  imagePath: string
  rootDir?: string
  onConfirm: (annotatedPath: string) => Promise<void>
  onCancel: () => Promise<void>
}

export const ImageEditModal: React.FC<ImageEditModalProps> = ({
  hint,
  imagePath,
  rootDir,
  onConfirm,
  onCancel
}) => {
  const [baseDataUrl, setBaseDataUrl] = useState<string | null>(null)
  const [mode, setMode] = useState<'brush' | 'rect'>('brush')
  const [brushSize, setBrushSize] = useState(18)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const baseCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const drawCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const drawingRef = useRef<{
    active: boolean
    startX: number
    startY: number
    snapshot: ImageData | null
  }>({ active: false, startX: 0, startY: 0, snapshot: null })

  useEffect(() => {
    let cancelled = false
    window.zmo.files
      .readPreview(imagePath)
      .then((res) => {
        if (!cancelled) {
          if (res.kind === 'image' && res.content) setBaseDataUrl(res.content)
          else setError('无法读取底图进行标注')
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [imagePath])

  useEffect(() => {
    if (!baseDataUrl) return
    const img = new Image()
    img.onload = () => {
      const bCanvas = baseCanvasRef.current
      const dCanvas = drawCanvasRef.current
      if (!bCanvas || !dCanvas) return
      const maxW = 820
      const maxH = 520
      const ratio = Math.min(1, maxW / img.width, maxH / img.height)
      const w = Math.round(img.width * ratio)
      const h = Math.round(img.height * ratio)
      bCanvas.width = w
      bCanvas.height = h
      dCanvas.width = w
      dCanvas.height = h
      const bCtx = bCanvas.getContext('2d')
      bCtx?.drawImage(img, 0, 0, w, h)
    }
    img.src = baseDataUrl
  }, [baseDataUrl])

  const clearOverlay = (): void => {
    const dCanvas = drawCanvasRef.current
    if (!dCanvas) return
    const ctx = dCanvas.getContext('2d')
    ctx?.clearRect(0, 0, dCanvas.width, dCanvas.height)
  }

  const getCanvasCoords = (e: React.MouseEvent<HTMLCanvasElement>): [number, number] => {
    const c = e.currentTarget
    const rect = c.getBoundingClientRect()
    return [
      ((e.clientX - rect.left) / rect.width) * c.width,
      ((e.clientY - rect.top) / rect.height) * c.height
    ]
  }

  const onMouseDown = (e: React.MouseEvent<HTMLCanvasElement>): void => {
    const dCanvas = drawCanvasRef.current
    const ctx = dCanvas?.getContext('2d')
    if (!dCanvas || !ctx) return
    const [x, y] = getCanvasCoords(e)
    drawingRef.current = {
      active: true,
      startX: x,
      startY: y,
      snapshot: ctx.getImageData(0, 0, dCanvas.width, dCanvas.height)
    }
    if (mode === 'brush') {
      ctx.strokeStyle = 'rgba(239, 68, 68, 0.78)'
      ctx.lineWidth = brushSize
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.beginPath()
      ctx.moveTo(x, y)
    }
  }

  const onMouseMove = (e: React.MouseEvent<HTMLCanvasElement>): void => {
    if (!drawingRef.current.active) return
    const dCanvas = drawCanvasRef.current
    const ctx = dCanvas?.getContext('2d')
    if (!dCanvas || !ctx) return
    const [x, y] = getCanvasCoords(e)

    if (mode === 'brush') {
      ctx.lineTo(x, y)
      ctx.stroke()
    } else if (drawingRef.current.snapshot) {
      ctx.putImageData(drawingRef.current.snapshot, 0, 0)
      const sx = drawingRef.current.startX
      const sy = drawingRef.current.startY
      ctx.fillStyle = 'rgba(239, 68, 68, 0.22)'
      ctx.strokeStyle = 'rgba(239, 68, 68, 0.95)'
      ctx.lineWidth = 3
      ctx.fillRect(Math.min(sx, x), Math.min(sy, y), Math.abs(x - sx), Math.abs(y - sy))
      ctx.strokeRect(Math.min(sx, x), Math.min(sy, y), Math.abs(x - sx), Math.abs(y - sy))
    }
  }

  const onMouseUp = (): void => {
    drawingRef.current.active = false
  }

  const handleConfirm = async (): Promise<void> => {
    const bCanvas = baseCanvasRef.current
    const dCanvas = drawCanvasRef.current
    if (!bCanvas || !dCanvas) return
    setSubmitting(true)
    try {
      const merged = document.createElement('canvas')
      merged.width = bCanvas.width
      merged.height = bCanvas.height
      const mCtx = merged.getContext('2d')!
      mCtx.drawImage(bCanvas, 0, 0)
      mCtx.drawImage(dCanvas, 0, 0)
      const dataUrl = merged.toDataURL('image/png')
      const savedPath = await window.zmo.agent.saveAnnotatedImage({
        sourcePath: imagePath,
        dataUrl,
        rootDir
      })
      await onConfirm(savedPath)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
      <div className="rounded-2xl bg-white border border-zinc-200 shadow-2xl overflow-hidden flex flex-col max-w-4xl w-full max-h-[90vh]">
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-zinc-200 bg-zinc-50">
          <div>
            <div className="text-xs font-semibold text-blue-600">图片局部涂抹 / 框选标注</div>
            <div className="text-sm font-semibold text-zinc-900 mt-0.5">{hint}</div>
          </div>
          <button
            type="button"
            onClick={() => void onCancel()}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-800 hover:bg-zinc-200/60 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex items-center justify-between px-4 py-2 border-b border-zinc-100 text-xs">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setMode('brush')}
              className={clsx(
                'inline-flex items-center gap-1.5 px-3 py-1 rounded-lg font-medium cursor-pointer',
                mode === 'brush' ? 'bg-zinc-900 text-white' : 'bg-zinc-100 text-zinc-700'
              )}
            >
              <Brush className="w-3.5 h-3.5" />
              <span>画笔涂抹</span>
            </button>
            <button
              type="button"
              onClick={() => setMode('rect')}
              className={clsx(
                'inline-flex items-center gap-1.5 px-3 py-1 rounded-lg font-medium cursor-pointer',
                mode === 'rect' ? 'bg-zinc-900 text-white' : 'bg-zinc-100 text-zinc-700'
              )}
            >
              <Square className="w-3.5 h-3.5" />
              <span>矩形框选</span>
            </button>
            {mode === 'brush' && (
              <label className="flex items-center gap-2 ml-2 text-zinc-600">
                <span>笔刷大小</span>
                <input
                  type="range"
                  min={6}
                  max={48}
                  value={brushSize}
                  onChange={(e) => setBrushSize(Number(e.target.value))}
                  className="w-24"
                />
              </label>
            )}
          </div>

          <button
            type="button"
            onClick={clearOverlay}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-zinc-600 hover:bg-zinc-100 cursor-pointer"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>清空重画</span>
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-auto bg-zinc-900 p-4 flex items-center justify-center">
          {error ? (
            <div className="text-xs text-rose-400">{error}</div>
          ) : (
            <div className="relative inline-block shadow-lg">
              <canvas ref={baseCanvasRef} className="block rounded" />
              <canvas
                ref={drawCanvasRef}
                onMouseDown={onMouseDown}
                onMouseMove={onMouseMove}
                onMouseUp={onMouseUp}
                onMouseLeave={onMouseUp}
                className="absolute inset-0 cursor-crosshair rounded"
              />
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2.5 px-5 py-3 border-t border-zinc-200 bg-white">
          <button
            type="button"
            onClick={() => void onCancel()}
            className="px-4 py-1.5 rounded-lg text-xs font-medium border border-zinc-300 text-zinc-700 hover:bg-zinc-100 cursor-pointer"
          >
            取消标注
          </button>
          <button
            type="button"
            disabled={submitting || Boolean(error)}
            onClick={() => void handleConfirm()}
            className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 cursor-pointer"
          >
            <Check className="w-3.5 h-3.5" />
            <span>{submitting ? '正在提交…' : '确认提交标注'}</span>
          </button>
        </div>
      </div>
    </div>
  )
}
