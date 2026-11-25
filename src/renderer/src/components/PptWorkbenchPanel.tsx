import React, { useEffect, useMemo, useState } from 'react'
import { Check, CheckSquare, LoaderCircle, Sparkles, X } from 'lucide-react'
import clsx from 'clsx'
import { parsePptxDeck, type PptDeckModel, type PptElementModel } from '@shared/pptParser'
import type { PptProposal, PptReference, PptWorkbenchSelection } from '@shared/protocol'

function decodeBase64ToUint8(b64: string): Uint8Array {
  const bin = atob(b64)
  const arr = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
  return arr
}

function normPath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase()
}

interface PptWorkbenchPanelProps {
  filePath: string
  selection: PptWorkbenchSelection | null
  pendingProposal: PptProposal | null
  onChangeSelection: (sel: PptWorkbenchSelection | null) => void
  onResolveProposal: (pptPath: string, accept: boolean) => Promise<void>
}

export const PptWorkbenchPanel: React.FC<PptWorkbenchPanelProps> = ({
  filePath,
  selection,
  pendingProposal,
  onChangeSelection,
  onResolveProposal
}) => {
  const [deck, setDeck] = useState<PptDeckModel | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeSlideId, setActiveSlideId] = useState<string>('slide-1')
  const [reloadNonce, setReloadNonce] = useState(0)
  const [resolving, setResolving] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    window.zmo.files
      .readBytes(filePath)
      .then(async (res) => {
        if (cancelled) return
        if (!res.ok || !res.base64) {
          setError(res.error || '无法读取 PPTX 文件')
          setLoading(false)
          return
        }
        const parsed = await parsePptxDeck(decodeBase64ToUint8(res.base64), true)
        if (cancelled) return
        setDeck(parsed)
        if (parsed.slides.length > 0 && !parsed.slides.some((s) => s.slideId === activeSlideId)) {
          setActiveSlideId(parsed.slides[0].slideId)
        }
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err))
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [filePath, reloadNonce])

  const activeSlide = useMemo(() => {
    if (!deck || deck.slides.length === 0) return null
    return deck.slides.find((s) => s.slideId === activeSlideId) ?? deck.slides[0]
  }, [deck, activeSlideId])

  const isSelectedRef = (ref: PptReference): boolean => {
    if (!selection || normPath(selection.documentPath) !== normPath(filePath)) return false
    return selection.references.some((r) =>
      ref.kind === 'slide'
        ? r.kind === 'slide' && r.slideId === ref.slideId
        : r.kind === 'element' && r.slideId === ref.slideId && r.elementId === ref.elementId
    )
  }

  const toggleElementSelection = (el: PptElementModel): void => {
    if (!activeSlide) return
    const curRefs =
      selection && normPath(selection.documentPath) === normPath(filePath)
        ? selection.references
        : []
    const exists = curRefs.some(
      (r) => r.kind === 'element' && r.slideId === activeSlide.slideId && r.elementId === el.elementId
    )
    const nextRefs: PptReference[] = exists
      ? curRefs.filter(
          (r) =>
            !(r.kind === 'element' && r.slideId === activeSlide.slideId && r.elementId === el.elementId)
        )
      : [...curRefs, { kind: 'element', slideId: activeSlide.slideId, elementId: el.elementId }]

    if (nextRefs.length === 0) {
      onChangeSelection(null)
      return
    }
    const labels = nextRefs.slice(0, 5).map((r) =>
      r.kind === 'slide' ? `整页 ${r.slideId}` : `${r.slideId}/${r.elementId}`
    )
    onChangeSelection({
      documentPath: filePath,
      currentSlideId: activeSlide.slideId,
      references: nextRefs,
      referenceLabels: labels
    })
  }

  const selectWholeSlide = (): void => {
    if (!activeSlide) return
    const already = isSelectedRef({ kind: 'slide', slideId: activeSlide.slideId })
    if (already) {
      onChangeSelection(null)
      return
    }
    onChangeSelection({
      documentPath: filePath,
      currentSlideId: activeSlide.slideId,
      references: [{ kind: 'slide', slideId: activeSlide.slideId }],
      referenceLabels: [`整页 ${activeSlide.slideId}`]
    })
  }

  const pendingOpsForSlide = useMemo(() => {
    if (!pendingProposal || !activeSlide) return new Map<string, string>()
    const map = new Map<string, string>()
    for (const op of pendingProposal.operations) {
      if (op.slideId === activeSlide.slideId && op.elementId && op.text) {
        map.set(op.elementId, op.text)
      }
    }
    return map
  }, [pendingProposal, activeSlide])

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center gap-2 text-xs text-zinc-500 py-12">
        <LoaderCircle className="w-4 h-4 animate-spin text-blue-600" />
        <span>正在加载交互式 PPT 工作台画布…</span>
      </div>
    )
  }

  if (error || !deck) {
    return <div className="p-6 text-xs text-rose-600 text-center">{error || '无法解析 PPTX'}</div>
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-2">
      {/* 顶部工具与选中状态条 */}
      <div className="flex items-center justify-between gap-2 px-3 py-1.5 rounded-xl bg-zinc-100 text-xs shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-semibold text-zinc-800">
            PPT 工作台 ({deck.slides.length} 页)
          </span>
          <span className="text-[11px] text-zinc-500 truncate">
            点击画布内文本框或元素可选中作为 AI 局改范围
          </span>
        </div>
        {activeSlide && (
          <button
            type="button"
            onClick={selectWholeSlide}
            className={clsx(
              'inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium cursor-pointer transition-colors shrink-0',
              isSelectedRef({ kind: 'slide', slideId: activeSlide.slideId })
                ? 'bg-blue-600 text-white'
                : 'bg-white border border-zinc-200 text-zinc-700 hover:bg-zinc-50'
            )}
          >
            <CheckSquare className="w-3 h-3" />
            <span>选中整页 {activeSlide.index}</span>
          </button>
        )}
      </div>

      {/* 待审核修改提案横幅 */}
      {pendingProposal && pendingProposal.status === 'pending' && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 space-y-2 shrink-0">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-900">
                <Sparkles className="w-3.5 h-3.5 text-amber-600" />
                <span>AI 局改提案待确认 ({pendingProposal.operations.length} 处改动)</span>
              </div>
              <p className="text-[11px] text-amber-800 mt-0.5">{pendingProposal.summary}</p>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                disabled={resolving}
                onClick={async () => {
                  setResolving(true)
                  await onResolveProposal(filePath, true)
                  setResolving(false)
                  setReloadNonce((n) => n + 1)
                }}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-600 text-white text-[11px] font-medium hover:bg-emerald-700 cursor-pointer"
              >
                <Check className="w-3 h-3" />
                <span>接受并写回 PPTX</span>
              </button>
              <button
                type="button"
                disabled={resolving}
                onClick={() => void onResolveProposal(filePath, false)}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-white border border-zinc-300 text-zinc-700 text-[11px] hover:bg-zinc-50 cursor-pointer"
              >
                <X className="w-3 h-3" />
                <span>拒绝</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 主体：左侧缩略目录 + 中间等比画布 */}
      <div className="flex-1 min-h-0 flex gap-2">
        <div className="w-24 shrink-0 overflow-y-auto space-y-1.5 pr-1">
          {deck.slides.map((sl) => {
            const isCur = activeSlide?.slideId === sl.slideId
            const hasProposal = pendingProposal?.operations.some((op) => op.slideId === sl.slideId)
            return (
              <button
                key={sl.slideId}
                type="button"
                onClick={() => setActiveSlideId(sl.slideId)}
                className={clsx(
                  'w-full rounded-lg border p-1.5 text-left transition-all cursor-pointer',
                  isCur
                    ? 'border-blue-600 bg-blue-50/70 ring-1 ring-blue-500'
                    : 'border-zinc-200 bg-white hover:border-zinc-300'
                )}
              >
                <div className="flex items-center justify-between text-[10px] font-semibold text-zinc-700">
                  <span>第 {sl.index} 页</span>
                  {hasProposal && <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />}
                </div>
                <div className="text-[10px] text-zinc-400 truncate mt-0.5">
                  {sl.elements.find((e) => e.text)?.text.slice(0, 18) || `${sl.elements.length} 元素`}
                </div>
              </button>
            )
          })}
        </div>

        <div className="flex-1 min-w-0 overflow-auto rounded-xl border border-zinc-200 bg-zinc-200/70 p-3 flex flex-col items-center justify-start gap-3">
          {activeSlide && (
            <>
              <div
                className="relative w-full bg-white shadow-md rounded-lg overflow-hidden border border-zinc-300 shrink-0"
                style={{
                  aspectRatio: String(deck.aspectRatio || 16 / 9),
                  backgroundColor: activeSlide.backgroundHex || '#ffffff'
                }}
              >
                {activeSlide.elements.map((el) => {
                  const selected = isSelectedRef({
                    kind: 'element',
                    slideId: activeSlide.slideId,
                    elementId: el.elementId
                  })
                  const proposedText = pendingOpsForSlide.get(el.elementId)

                  return (
                    <div
                      key={el.elementId}
                      onClick={(e) => {
                        e.stopPropagation()
                        toggleElementSelection(el)
                      }}
                      title={`${el.name} (${el.elementId}) — 点击切换 AI 局改选区`}
                      style={{
                        left: `${el.xPct}%`,
                        top: `${el.yPct}%`,
                        width: `${el.wPct}%`,
                        height: `${el.hPct}%`,
                        backgroundColor: el.fillHex || undefined,
                        borderColor: el.strokeHex || undefined,
                        borderWidth: el.strokeHex ? 1 : undefined,
                        borderStyle: el.strokeHex ? 'solid' : undefined
                      }}
                      className={clsx(
                        'absolute overflow-hidden cursor-pointer transition-all p-1',
                        selected
                          ? 'ring-2 ring-blue-600 bg-blue-50/20 z-20'
                          : proposedText
                            ? 'ring-2 ring-amber-500 bg-amber-50/30 z-20'
                            : 'hover:ring-1 hover:ring-blue-400/70 z-10'
                      )}
                    >
                      {el.kind === 'image' && el.imageDataUrl ? (
                        <img
                          src={el.imageDataUrl}
                          alt={el.name}
                          className="w-full h-full object-contain pointer-events-none"
                        />
                      ) : el.kind === 'table' && el.tableRows ? (
                        <table className="w-full h-full border-collapse text-[9px] bg-white/90">
                          <tbody>
                            {el.tableRows.slice(0, 8).map((r, ri) => (
                              <tr key={ri} className={ri === 0 ? 'bg-zinc-100 font-semibold' : 'border-t border-zinc-200'}>
                                {r.slice(0, 6).map((c, ci) => (
                                  <td key={ci} className="px-1 py-0.5 border-r border-zinc-200 truncate">
                                    {c}
                                  </td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      ) : (
                        <div className="w-full h-full overflow-hidden">
                          {proposedText ? (
                            <div className="text-[10px] leading-snug text-amber-950 font-medium whitespace-pre-wrap">
                              <span className="inline-block px-1 rounded bg-amber-200 text-[9px] mr-1">
                                提案
                              </span>
                              {proposedText}
                            </div>
                          ) : (
                            el.paragraphs.map((p, pi) => (
                              <div
                                key={pi}
                                style={{ textAlign: p.align ?? 'left' }}
                                className="leading-snug break-words"
                              >
                                {p.runs.map((run, ri) => (
                                  <span
                                    key={ri}
                                    style={{
                                      fontSize: run.fontSizePt
                                        ? `${Math.max(8, Math.min(24, run.fontSizePt * 0.55))}px`
                                        : '11px',
                                      color: run.colorHex || '#18181b',
                                      fontWeight: run.bold ? 700 : 400
                                    }}
                                  >
                                    {run.text}
                                  </span>
                                ))}
                              </div>
                            ))
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>

              {activeSlide.noteText && (
                <div className="w-full rounded-lg bg-white border border-zinc-200 px-3 py-2 text-[11px] text-zinc-600">
                  <span className="font-semibold text-zinc-800">演讲者备注：</span>
                  {activeSlide.noteText}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
