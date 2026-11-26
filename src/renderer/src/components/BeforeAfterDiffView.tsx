import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Columns2, History, MoveHorizontal, RotateCcw, SplitSquareHorizontal } from 'lucide-react'
import clsx from 'clsx'
import type { FileSnapshotEntry } from '@shared/ipc'

interface BeforeAfterDiffViewProps {
  filePath: string
  rootDir?: string
  currentKind: 'text' | 'image' | 'binary'
  currentContent?: string
  currentSize?: number
  snapshots: FileSnapshotEntry[]
  explicitBeforePath?: string
  onRestored: () => void
  onClose: () => void
}

interface DiffLine {
  type: 'same' | 'add' | 'del'
  text: string
  beforeLine?: number
  afterLine?: number
}

function computeLineDiff(beforeText: string, afterText: string): {
  lines: DiffLine[]
  added: number
  removed: number
} {
  const a = beforeText.split(/\r?\n/)
  const b = afterText.split(/\r?\n/)
  const n = a.length
  const m = b.length

  // 对超长文件走头尾裁切 + LCS（上限 600×600 DP 保证前端瞬时响应）
  if (n > 600 || m > 600) {
    const out: DiffLine[] = []
    const maxLen = Math.max(n, m)
    let added = 0
    let removed = 0
    for (let i = 0; i < Math.min(maxLen, 800); i++) {
      if (i < n && i < m && a[i] === b[i]) {
        out.push({ type: 'same', text: a[i], beforeLine: i + 1, afterLine: i + 1 })
      } else {
        if (i < n) {
          out.push({ type: 'del', text: a[i], beforeLine: i + 1 })
          removed++
        }
        if (i < m) {
          out.push({ type: 'add', text: b[i], afterLine: i + 1 })
          added++
        }
      }
    }
    return { lines: out, added, removed }
  }

  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? 1 + dp[i + 1][j + 1] : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  const lines: DiffLine[] = []
  let i = 0
  let j = 0
  let added = 0
  let removed = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      lines.push({ type: 'same', text: a[i], beforeLine: i + 1, afterLine: j + 1 })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      lines.push({ type: 'del', text: a[i], beforeLine: i + 1 })
      removed++
      i++
    } else {
      lines.push({ type: 'add', text: b[j], afterLine: j + 1 })
      added++
      j++
    }
  }
  while (i < n) {
    lines.push({ type: 'del', text: a[i], beforeLine: i + 1 })
    removed++
    i++
  }
  while (j < m) {
    lines.push({ type: 'add', text: b[j], afterLine: j + 1 })
    added++
    j++
  }
  return { lines, added, removed }
}

const TOOL_LABELS: Record<string, string> = {
  edit_file: '局部编辑',
  write_file: '覆写文件',
  generate_image: '文生图覆盖',
  edit_image_with_ref: '图生图原图',
  manual_edit: '手动编辑',
  pre_rollback: '回滚前备份'
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}

export const BeforeAfterDiffView: React.FC<BeforeAfterDiffViewProps> = ({
  filePath,
  rootDir,
  currentKind,
  currentContent,
  currentSize,
  snapshots,
  explicitBeforePath,
  onRestored,
  onClose
}) => {
  const [selectedId, setSelectedId] = useState<string>('__explicit__')
  const [beforeState, setBeforeState] = useState<{
    loading: boolean
    kind?: 'text' | 'image' | 'binary'
    content?: string
    error?: string
  }>({ loading: false })
  const [splitPct, setSplitPct] = useState<number>(50)
  const [imageLayout, setImageLayout] = useState<'slider' | 'side'>('slider')
  const [onlyChanged, setOnlyChanged] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [restoredNotice, setRestoredNotice] = useState<string | null>(null)
  const sliderRef = useRef<HTMLDivElement | null>(null)
  const draggingRef = useRef(false)

  useEffect(() => {
    if (snapshots.length > 0) {
      setSelectedId(snapshots[0].id)
    } else if (explicitBeforePath) {
      setSelectedId('__explicit__')
    }
  }, [filePath, snapshots, explicitBeforePath])

  const selectedSnapshot = snapshots.find((s) => s.id === selectedId) ?? null
  const beforePath = selectedSnapshot?.snapshotPath || explicitBeforePath || ''

  useEffect(() => {
    if (!beforePath) {
      setBeforeState({ loading: false })
      return
    }
    let cancelled = false
    setBeforeState({ loading: true })
    window.designAgent.files
      .readPreview(beforePath)
      .then((res) => {
        if (!cancelled) {
          setBeforeState({ loading: false, kind: res.kind, content: res.content })
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setBeforeState({
            loading: false,
            error: err instanceof Error ? err.message : String(err)
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [beforePath])

  const diffResult = useMemo(() => {
    if (currentKind !== 'text' || beforeState.kind !== 'text') return null
    return computeLineDiff(beforeState.content ?? '', currentContent ?? '')
  }, [currentKind, beforeState.kind, beforeState.content, currentContent])

  const updateSliderFromClientX = (clientX: number): void => {
    const el = sliderRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0) return
    const pct = ((clientX - rect.left) / rect.width) * 100
    setSplitPct(Math.max(4, Math.min(96, Math.round(pct * 10) / 10)))
  }

  const handleRestore = async (): Promise<void> => {
    if (!selectedSnapshot || restoring) return
    setRestoring(true)
    try {
      const res = await window.designAgent.files.restoreSnapshot(filePath, selectedSnapshot.id, rootDir)
      if (res.ok) {
        setRestoredNotice('已回滚至所选版本（当前版已自动另存备份）')
        onRestored()
        setTimeout(() => setRestoredNotice(null), 2600)
      } else {
        setRestoredNotice(res.error || '回滚失败')
      }
    } finally {
      setRestoring(false)
    }
  }

  if (!beforePath) {
    return (
      <div className="flex-1 min-h-0 flex flex-col items-center justify-center rounded-xl border border-zinc-200 bg-zinc-50 p-6 text-center space-y-2">
        <History className="w-6 h-6 text-zinc-300" />
        <div className="text-xs font-medium text-zinc-700">当前文件暂无可对比的历史快照</div>
        <p className="text-[11px] text-zinc-400">
          当 Agent 修改代码、文本或执行图生图重绘时，系统会自动留存 Before 快照。
        </p>
        <button
          type="button"
          onClick={onClose}
          className="px-3 py-1 rounded-lg border border-zinc-200 bg-white text-xs text-zinc-700 hover:bg-zinc-100 cursor-pointer"
        >
          返回正常预览
        </button>
      </div>
    )
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-2">
      {/* 顶部版本选择 & 一键回滚条 */}
      <div className="rounded-xl border border-zinc-200 bg-zinc-50/80 p-2 space-y-2 shrink-0">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-1.5 text-[11px] font-medium text-zinc-700">
            <History className="w-3.5 h-3.5 text-blue-600" />
            <span>版本对比（Before / After）</span>
            {snapshots.length > 0 && (
              <span className="px-1.5 py-0.5 rounded bg-white border border-zinc-200 text-[10px] text-zinc-500">
                共 {snapshots.length} 个历史快照
              </span>
            )}
          </div>

          <div className="flex items-center gap-1.5">
            {currentKind === 'image' && (
              <div className="inline-flex rounded-lg border border-zinc-200 bg-white p-0.5 text-[10px]">
                <button
                  type="button"
                  onClick={() => setImageLayout('slider')}
                  className={clsx(
                    'inline-flex items-center gap-1 px-2 py-0.5 rounded-md cursor-pointer transition-colors',
                    imageLayout === 'slider' ? 'bg-zinc-900 text-white' : 'text-zinc-600 hover:bg-zinc-100'
                  )}
                >
                  <SplitSquareHorizontal className="w-3 h-3" />
                  <span>滑块对比</span>
                </button>
                <button
                  type="button"
                  onClick={() => setImageLayout('side')}
                  className={clsx(
                    'inline-flex items-center gap-1 px-2 py-0.5 rounded-md cursor-pointer transition-colors',
                    imageLayout === 'side' ? 'bg-zinc-900 text-white' : 'text-zinc-600 hover:bg-zinc-100'
                  )}
                >
                  <Columns2 className="w-3 h-3" />
                  <span>并排</span>
                </button>
              </div>
            )}

            {selectedSnapshot && (
              <button
                type="button"
                disabled={restoring}
                onClick={() => void handleRestore()}
                title="将磁盘文件一键还原为此历史快照"
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50 text-[11px] font-medium cursor-pointer"
              >
                <RotateCcw className="w-3 h-3" />
                <span>{restoring ? '回滚中…' : '一键回滚'}</span>
              </button>
            )}

            <button
              type="button"
              onClick={onClose}
              className="px-2 py-1 rounded-lg border border-zinc-200 bg-white text-[11px] text-zinc-600 hover:bg-zinc-100 cursor-pointer"
            >
              退出对比
            </button>
          </div>
        </div>

        {snapshots.length > 0 && (
          <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5">
            {snapshots.map((snap) => {
              const active = snap.id === selectedId
              const label = TOOL_LABELS[snap.sourceTool] ?? snap.sourceTool
              return (
                <button
                  key={snap.id}
                  type="button"
                  onClick={() => setSelectedId(snap.id)}
                  title={snap.summary || label}
                  className={clsx(
                    'inline-flex items-center gap-1 px-2 py-1 rounded-lg border text-[10px] whitespace-nowrap cursor-pointer transition-colors shrink-0',
                    active
                      ? 'bg-blue-600 border-blue-600 text-white font-medium'
                      : 'bg-white border-zinc-200 text-zinc-600 hover:border-zinc-300'
                  )}
                >
                  <span className="font-mono">{formatTime(snap.createdAt)}</span>
                  <span>·</span>
                  <span>{label}</span>
                </button>
              )
            })}
          </div>
        )}

        {restoredNotice && (
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-emerald-50 border border-emerald-200 text-[11px] text-emerald-800">
            <Check className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
            <span>{restoredNotice}</span>
          </div>
        )}
      </div>

      {/* 主体对比画布 */}
      <div className="flex-1 min-h-0 rounded-xl border border-zinc-200 bg-zinc-50/50 overflow-auto p-3 flex flex-col">
        {beforeState.loading ? (
          <div className="py-12 text-center text-xs text-zinc-400">正在加载历史版本…</div>
        ) : beforeState.error ? (
          <div className="py-12 text-center text-xs text-rose-600">{beforeState.error}</div>
        ) : currentKind === 'image' && beforeState.kind === 'image' && beforeState.content && currentContent ? (
          imageLayout === 'slider' ? (
            <div className="flex-1 min-h-[260px] flex flex-col items-center justify-center gap-2">
              <div
                ref={sliderRef}
                onPointerDown={(e) => {
                  draggingRef.current = true
                  e.currentTarget.setPointerCapture(e.pointerId)
                  updateSliderFromClientX(e.clientX)
                }}
                onPointerMove={(e) => {
                  if (draggingRef.current) updateSliderFromClientX(e.clientX)
                }}
                onPointerUp={(e) => {
                  draggingRef.current = false
                  if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                    e.currentTarget.releasePointerCapture(e.pointerId)
                  }
                }}
                className="relative w-full max-w-full overflow-hidden rounded-lg border border-zinc-200 bg-zinc-900/5 select-none cursor-col-resize"
              >
                {/* 底层：After 当前成图 */}
                <img
                  src={currentContent}
                  alt="After"
                  draggable={false}
                  className="block w-full h-auto max-h-[540px] object-contain pointer-events-none"
                />
                {/* 顶层：Before 原图（按滑块位置裁切） */}
                <div
                  className="absolute inset-0 pointer-events-none"
                  style={{ clipPath: `inset(0 ${100 - splitPct}% 0 0)` }}
                >
                  <img
                    src={beforeState.content}
                    alt="Before"
                    draggable={false}
                    className="block w-full h-full object-contain"
                  />
                </div>
                {/* 垂直分割线与拖动手柄 */}
                <div
                  className="absolute inset-y-0 w-0.5 bg-white shadow-[0_0_8px_rgba(0,0,0,0.45)] pointer-events-none"
                  style={{ left: `${splitPct}%` }}
                >
                  <div className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 w-7 h-7 rounded-full bg-white text-zinc-800 shadow-md border border-zinc-200 flex items-center justify-center">
                    <MoveHorizontal className="w-3.5 h-3.5" />
                  </div>
                </div>
                <span className="absolute left-2.5 top-2.5 px-2 py-0.5 rounded bg-black/60 text-white text-[10px] font-medium pointer-events-none">
                  Before（原版本）
                </span>
                <span className="absolute right-2.5 top-2.5 px-2 py-0.5 rounded bg-blue-600/85 text-white text-[10px] font-medium pointer-events-none">
                  After（当前）
                </span>
              </div>
              <div className="text-[11px] text-zinc-400">
                左右拖动画面中线对比细节变化（当前分割 {Math.round(splitPct)}%）
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="space-y-1">
                <div className="text-[11px] font-medium text-zinc-600">Before（原版本）</div>
                <img
                  src={beforeState.content}
                  alt="Before"
                  className="w-full h-auto rounded-lg border border-zinc-200 bg-white"
                />
              </div>
              <div className="space-y-1">
                <div className="text-[11px] font-medium text-blue-700">After（当前版本）</div>
                <img
                  src={currentContent}
                  alt="After"
                  className="w-full h-auto rounded-lg border border-blue-200 bg-white"
                />
              </div>
            </div>
          )
        ) : diffResult ? (
          <div className="space-y-2 flex-1 min-h-0 flex flex-col">
            <div className="flex items-center justify-between text-[11px] shrink-0">
              <div className="flex items-center gap-2">
                <span className="px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 font-mono">
                  +{diffResult.added} 行
                </span>
                <span className="px-2 py-0.5 rounded bg-rose-50 text-rose-700 font-mono">
                  -{diffResult.removed} 行
                </span>
              </div>
              <button
                type="button"
                onClick={() => setOnlyChanged((v) => !v)}
                className="px-2 py-0.5 rounded border border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-100 cursor-pointer"
              >
                {onlyChanged ? '显示全部行' : '只看变更行'}
              </button>
            </div>
            <div className="flex-1 min-h-0 overflow-auto rounded-lg border border-zinc-200 bg-white font-mono text-[11px] leading-relaxed">
              {diffResult.lines
                .filter((l) => !onlyChanged || l.type !== 'same')
                .map((line, idx) => (
                  <div
                    key={idx}
                    className={clsx(
                      'flex gap-2 px-2.5 py-0.5 whitespace-pre-wrap break-all',
                      line.type === 'add'
                        ? 'bg-emerald-50/90 text-emerald-900'
                        : line.type === 'del'
                          ? 'bg-rose-50/90 text-rose-900 line-through decoration-rose-400/70'
                          : 'text-zinc-600'
                    )}
                  >
                    <span className="w-8 shrink-0 text-right text-zinc-400 select-none">
                      {line.type === 'del' ? line.beforeLine : line.afterLine}
                    </span>
                    <span className="w-3 shrink-0 font-bold select-none">
                      {line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '}
                    </span>
                    <span className="flex-1">{line.text || ' '}</span>
                  </div>
                ))}
            </div>
          </div>
        ) : (
          <div className="py-10 text-center space-y-2 text-xs text-zinc-600">
            <div>
              选中快照：{selectedSnapshot ? `${formatTime(selectedSnapshot.createdAt)} · ${TOOL_LABELS[selectedSnapshot.sourceTool] ?? selectedSnapshot.sourceTool}` : '参考原版本'}
            </div>
            <div className="text-[11px] text-zinc-400">
              快照大小：{selectedSnapshot ? `${Math.round(selectedSnapshot.size / 1024)} KB` : ''} · 当前大小：
              {currentSize ? `${Math.round(currentSize / 1024)} KB` : ''}
            </div>
            <div className="text-[11px] text-zinc-400">
              该格式为二进制工程文件，可点击右上角「一键回滚」恢复到该版本。
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
