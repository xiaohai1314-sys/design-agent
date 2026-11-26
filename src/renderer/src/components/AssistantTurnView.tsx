import React, { useEffect, useState } from 'react'
import {
  AlertCircle,
  ArrowRight,
  BookCheck,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  FileSpreadsheet,
  FileText,
  Globe,
  Image as ImageIcon,
  Layers,
  LoaderCircle,
  MessageSquareMore,
  Presentation,
  RotateCcw,
  Sparkles,
  SplitSquareHorizontal,
  ThumbsDown,
  ThumbsUp,
  Wrench,
  XCircle
} from 'lucide-react'
import clsx from 'clsx'
import type { PersistedTurnItem, ToolCallRecord } from '@shared/ipc'
import type {
  AskImageEditToolData,
  AskUserToolData,
  Deliverable,
  GenerateImageToolData,
  InspirationToolData,
  PptWorkbenchToolData,
  RegulationToolData,
  WebSearchToolData
} from '@shared/protocol'
import { MarkdownRenderer } from './MarkdownRenderer'

function formatSize(size?: number): string {
  if (!size || size < 0) return ''
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`
  return `${(size / (1024 * 1024)).toFixed(size < 10 * 1024 * 1024 ? 1 : 0)}MB`
}

function formatDuration(ms?: number): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return ''
  const totalSec = Math.max(1, Math.floor(ms / 1000))
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  if (m <= 0) return `${s}s`
  return `${m}m ${s}s`
}

function splitFileName(name: string): { base: string; ext: string } {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return { base: name, ext: '' }
  return { base: name.slice(0, dot), ext: name.slice(dot) }
}

function extBadge(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name.trim())
  return m ? m[1].toUpperCase() : 'FILE'
}

const DeliverableIcon: React.FC<{ kind: Deliverable['kind'] }> = ({ kind }) => {
  switch (kind) {
    case 'slides':
      return <Presentation className="w-5 h-5 text-orange-500" />
    case 'spreadsheet':
      return <FileSpreadsheet className="w-5 h-5 text-emerald-600" />
    case 'image':
      return <ImageIcon className="w-5 h-5 text-zinc-400" />
    case 'pdf':
      return <FileText className="w-5 h-5 text-rose-500" />
    default:
      return <FileText className="w-5 h-5 text-blue-600" />
  }
}

const ImageThumbPreview: React.FC<{ path: string; title: string }> = ({ path, title }) => {
  const [thumbSrc, setThumbSrc] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    window.zmo.files
      .readPreview(path)
      .then((res) => {
        if (!cancelled && res.kind === 'image' && res.content) {
          setThumbSrc(res.content)
        }
      })
      .catch(() => {
        /* ignore thumbnail read failure; fallback icon renders */
      })
    return () => {
      cancelled = true
    }
  }, [path])

  if (!thumbSrc) {
    return (
      <div className="w-10 h-10 rounded-lg bg-zinc-200/70 flex items-center justify-center shrink-0">
        <ImageIcon className="w-4 h-4 text-zinc-400" />
      </div>
    )
  }

  return (
    <img
      src={thumbSrc}
      alt={title}
      className="w-10 h-10 rounded-lg object-cover shrink-0 bg-zinc-200"
    />
  )
}

type PreviewDeliverableFn = (
  path: string,
  title: string,
  options?: { compareBeforePath?: string; compareMode?: boolean }
) => void

const ToolCallItem: React.FC<{ tc: ToolCallRecord; onPreviewDeliverable?: PreviewDeliverableFn }> = ({
  tc,
  onPreviewDeliverable
}) => {
  const [expanded, setExpanded] = useState(false)

  const askData =
    tc.toolData &&
    typeof tc.toolData === 'object' &&
    (tc.toolData as { kind?: string }).kind === 'ask_user'
      ? (tc.toolData as AskUserToolData)
      : null

  if (askData) {
    return (
      <div className="my-1 rounded-xl border border-zinc-200/80 bg-zinc-50/70 px-3 py-2 text-xs">
        <div className="flex items-center gap-1.5 font-medium text-zinc-800 mb-1">
          <MessageSquareMore className="w-3.5 h-3.5 text-zinc-500" />
          <span>需求已澄清</span>
        </div>
        <div className="space-y-1 text-zinc-600">
          {askData.questions.map((q, idx) => {
            const ans = askData.answers[idx]
            const val =
              ans?.text?.trim() ||
              (ans?.selected && ans.selected.length > 0 ? ans.selected.join('、') : '已跳过')
            return (
              <div key={idx} className="flex flex-wrap gap-1">
                <span className="text-zinc-500">{q.question}：</span>
                <span className="font-medium text-zinc-900">{val}</span>
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  const regData =
    tc.toolData &&
    typeof tc.toolData === 'object' &&
    (tc.toolData as { kind?: string }).kind === 'regulation_chunks'
      ? (tc.toolData as RegulationToolData)
      : null

  const imgEditData =
    tc.toolData &&
    typeof tc.toolData === 'object' &&
    (tc.toolData as { kind?: string }).kind === 'ask_image_edit'
      ? (tc.toolData as AskImageEditToolData)
      : null

  const webSearchData =
    tc.toolData &&
    typeof tc.toolData === 'object' &&
    (tc.toolData as { kind?: string }).kind === 'web_search'
      ? (tc.toolData as WebSearchToolData)
      : null

  const inspData =
    tc.toolData &&
    typeof tc.toolData === 'object' &&
    (tc.toolData as { kind?: string }).kind === 'search_inspiration'
      ? (tc.toolData as InspirationToolData)
      : null

  const pptWbData =
    tc.toolData &&
    typeof tc.toolData === 'object' &&
    (tc.toolData as { kind?: string }).kind === 'ppt_workbench'
      ? (tc.toolData as PptWorkbenchToolData)
      : null

  const genImageData =
    tc.toolData &&
    typeof tc.toolData === 'object' &&
    (tc.toolData as { kind?: string }).kind === 'generate_image'
      ? (tc.toolData as GenerateImageToolData)
      : null

  return (
    <div className="rounded-lg border border-zinc-200/70 bg-zinc-50/60 overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-zinc-100/70 transition-colors cursor-pointer"
      >
        {tc.status === 'running' ? (
          <LoaderCircle className="w-3.5 h-3.5 text-zinc-500 animate-spin shrink-0" />
        ) : tc.status === 'error' ? (
          <XCircle className="w-3.5 h-3.5 text-rose-500 shrink-0" />
        ) : (
          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
        )}

        {tc.name === 'task' ? (
          <Layers className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
        ) : regData ? (
          <BookCheck className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
        ) : webSearchData ? (
          <Globe className="w-3.5 h-3.5 text-sky-600 shrink-0" />
        ) : inspData ? (
          <Sparkles className="w-3.5 h-3.5 text-violet-600 shrink-0" />
        ) : pptWbData ? (
          <Presentation className="w-3.5 h-3.5 text-orange-600 shrink-0" />
        ) : (
          <Wrench className="w-3 h-3 text-zinc-400 shrink-0" />
        )}

        <span className="font-medium text-zinc-700 shrink-0">{tc.message}</span>
        {regData ? (
          <span className="text-zinc-500 truncate flex-1">
            命中 {regData.total} 条规范条文
          </span>
        ) : webSearchData ? (
          <span className="text-zinc-500 truncate flex-1">
            检索「{webSearchData.query}」· {webSearchData.results.length} 条结果
          </span>
        ) : inspData ? (
          <span className="text-zinc-500 truncate flex-1">
            检索「{inspData.query}」· 本地命中 {inspData.total} 条
            {inspData.webFallbackUsed ? ' · 已联网补充' : ''}
          </span>
        ) : pptWbData ? (
          <span className="text-zinc-500 truncate flex-1">
            {pptWbData.summary || `${pptWbData.action} (${pptWbData.slideCount ?? 0} 页)`}
          </span>
        ) : imgEditData ? (
          <span className="text-zinc-500 truncate flex-1">
            {imgEditData.result === 'confirmed' ? '已完成局部圈选标注' : '已取消标注'}
          </span>
        ) : tc.delta ? (
          <span className="text-zinc-400 font-mono truncate flex-1">{tc.delta}</span>
        ) : (
          <span className="flex-1" />
        )}
        {genImageData?.referenceImagePath && onPreviewDeliverable && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation()
              const title = genImageData.imagePath.split(/[\\/]/).pop() || '局部重绘对比.png'
              onPreviewDeliverable(genImageData.imagePath, title, {
                compareBeforePath: genImageData.referenceImagePath,
                compareMode: true
              })
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                e.stopPropagation()
                const title = genImageData.imagePath.split(/[\\/]/).pop() || '局部重绘对比.png'
                onPreviewDeliverable(genImageData.imagePath, title, {
                  compareBeforePath: genImageData.referenceImagePath,
                  compareMode: true
                })
              }
            }}
            title="在工作台打开 Before / After 滑块对比"
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-50 border border-blue-200 text-blue-700 hover:bg-blue-100 text-[10px] font-medium shrink-0"
          >
            <SplitSquareHorizontal className="w-3 h-3" />
            <span>滑块对比</span>
          </span>
        )}
        <ChevronRight
          className={clsx(
            'w-3.5 h-3.5 text-zinc-400 transition-transform shrink-0',
            expanded && 'rotate-90'
          )}
        />
      </button>

      {expanded && (
        <div className="px-3 py-2 border-t border-zinc-200/60 bg-white text-[11px] space-y-2">
          {regData && regData.retrievedChunks.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-emerald-700 font-medium">检索命中的规范依据：</div>
              {regData.retrievedChunks.map((ch, idx) => (
                <div key={idx} className="p-2 rounded bg-emerald-50/50 border border-emerald-100 space-y-1">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <div className="font-semibold text-zinc-900">
                      {ch.standardNo}《{ch.standardName}》
                      {ch.clauseId ? ` 第 ${ch.clauseId} 条` : ''}
                    </div>
                    <div className="flex items-center gap-1 shrink-0 text-[10px]">
                      {typeof ch.pageNo === 'number' && ch.pageNo > 0 && (
                        <span className="px-1.5 py-0.5 rounded bg-white border border-zinc-200 text-zinc-600 font-mono">
                          P.{ch.pageNo}
                        </span>
                      )}
                      <span
                        className={clsx(
                          'px-1.5 py-0.5 rounded font-medium',
                          ch.validityStatus.includes('废止')
                            ? 'bg-rose-100 text-rose-700'
                            : ch.validityStatus.includes('替代')
                              ? 'bg-amber-100 text-amber-800'
                              : 'bg-emerald-100 text-emerald-800'
                        )}
                      >
                        {ch.validityStatus}
                      </span>
                    </div>
                  </div>
                  {(ch.supersededBy || ch.warningText) && (
                    <div className="text-[10px] text-amber-800 bg-amber-50/90 border border-amber-200/80 rounded px-1.5 py-0.5">
                      {ch.warningText || `部分强条已由 ${ch.supersededBy} 替代`}
                    </div>
                  )}
                  <div className="text-zinc-600 line-clamp-3">{ch.text}</div>
                </div>
              ))}
            </div>
          )}

          {webSearchData && webSearchData.results.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-sky-700 font-medium">联网检索参考来源：</div>
              {webSearchData.results.map((r, idx) => (
                <div key={idx} className="p-2 rounded bg-sky-50/50 border border-sky-100 space-y-0.5">
                  <div className="font-semibold text-zinc-900 truncate">{r.title}</div>
                  <div className="text-[10px] text-sky-700 font-mono truncate">{r.url}</div>
                  {r.snippet && <div className="text-zinc-600 line-clamp-2">{r.snippet}</div>}
                </div>
              ))}
            </div>
          )}

          {inspData && inspData.localHits.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-violet-700 font-medium">本地灵感 / 素材命中：</div>
              {inspData.localHits.map((h) => (
                <div
                  key={h.id}
                  className="p-2 rounded bg-violet-50/50 border border-violet-100 space-y-0.5"
                >
                  <div className="font-semibold text-zinc-900 truncate">
                    {h.kind === 'recipe' ? '参考图' : '素材'} · {h.title}
                  </div>
                  {(h.style || h.buildingType) && (
                    <div className="text-[10px] text-violet-700">
                      {[h.style, h.buildingType].filter(Boolean).join(' / ')}
                    </div>
                  )}
                  {h.filePath && (
                    <div className="text-[10px] text-zinc-500 font-mono truncate">{h.filePath}</div>
                  )}
                  {!h.filePath && h.sourceUrl && (
                    <div className="text-[10px] text-violet-700 font-mono truncate">{h.sourceUrl}</div>
                  )}
                  <div className="text-[10px] text-zinc-400">来源：{h.source}</div>
                </div>
              ))}
            </div>
          )}

          {tc.args && Object.keys(tc.args).length > 0 && (
            <div>
              <div className="text-zinc-400 mb-1">
                {tc.name === 'execute' ? '执行脚本 / 命令：' : '调用参数：'}
              </div>
              {tc.name === 'execute' && typeof tc.args.command === 'string' ? (
                <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-2.5 text-[11px] text-zinc-700 space-y-1.5">
                  {typeof tc.args.description === 'string' && tc.args.description.trim() && (
                    <div className="text-zinc-600 font-medium">{tc.args.description}</div>
                  )}
                  <pre className="font-mono text-zinc-700 whitespace-pre-wrap break-all max-h-40 overflow-y-auto leading-relaxed">
                    {tc.args.command}
                  </pre>
                </div>
              ) : (
                <pre className="p-2.5 rounded-lg border border-zinc-200 bg-zinc-50 text-zinc-700 whitespace-pre-wrap break-all max-h-40 overflow-y-auto leading-relaxed">
                  {JSON.stringify(tc.args, null, 2)}
                </pre>
              )}
            </div>
          )}

          {tc.subagentEvents && tc.subagentEvents.length > 0 && (
            <div>
              <div className="text-indigo-600 font-medium mb-1">子任务执行过程：</div>
              <div className="p-2 rounded bg-indigo-50/50 border border-indigo-100 space-y-1 max-h-44 overflow-y-auto">
                {tc.subagentEvents
                  .filter((e) => e.type === 'tool')
                  .map((e, idx) => (
                    <div key={idx} className="text-zinc-700 font-mono">
                      • {e.message || e.name}
                    </div>
                  ))}
                <div className="text-zinc-600 whitespace-pre-wrap">
                  {tc.subagentEvents
                    .filter((e) => e.type === 'token')
                    .map((e) => e.delta)
                    .join('')}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

interface DeliverableCardProps {
  item: Deliverable
  onPreview: (path: string, title: string) => void
}

const DeliverableCard: React.FC<DeliverableCardProps> = ({ item, onPreview }) => {
  const [menuOpen, setMenuOpen] = useState(false)
  const [copiedImg, setCopiedImg] = useState(false)
  const { base, ext } = splitFileName(item.title)
  const metaText = [extBadge(item.title), formatSize(item.size)].filter(Boolean).join(' · ')

  return (
    <div
      onClick={() => onPreview(item.path, item.title)}
      className="relative group flex items-center gap-2.5 rounded-xl bg-[#f5f5f5] hover:bg-[#eeeeee] p-3 transition-colors cursor-pointer min-w-0"
    >
      {item.kind === 'image' ? (
        <ImageThumbPreview path={item.path} title={item.title} />
      ) : (
        <div className="w-10 h-10 rounded-lg bg-white/80 flex items-center justify-center shrink-0">
          <DeliverableIcon kind={item.kind} />
        </div>
      )}

      <div className="min-w-0 flex-1">
        <div
          className="flex items-baseline text-[13px] font-medium text-zinc-900 leading-5"
          title={item.title}
        >
          <span className="truncate">{base}</span>
          {ext && <span className="shrink-0 font-semibold">{ext}</span>}
        </div>
        {metaText && (
          <div className="text-[11px] text-zinc-500 mt-0.5 tabular-nums">{metaText}</div>
        )}
      </div>

      <div className="relative shrink-0" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          onClick={() => setMenuOpen(!menuOpen)}
          className="inline-flex items-center gap-1.5 rounded-full border border-[#efefef] bg-white px-4 py-1.5 text-xs text-zinc-800 hover:text-black hover:bg-zinc-50 transition-colors cursor-pointer"
        >
          <span>打开</span>
          <ChevronDown className="w-3.5 h-3.5 text-zinc-500" />
        </button>

        {menuOpen && (
          <>
            <div className="fixed inset-0 z-30" onClick={() => setMenuOpen(false)} />
            <div className="absolute right-0 bottom-10 z-40 w-40 rounded-xl border border-zinc-200 bg-white shadow-lg p-1 text-xs space-y-0.5">
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false)
                  onPreview(item.path, item.title)
                }}
                className="w-full text-left px-2.5 py-1.5 rounded-lg text-zinc-700 hover:bg-zinc-100 cursor-pointer"
              >
                预览
              </button>
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false)
                  void window.zmo.shell.openPath(item.path)
                }}
                className="w-full text-left px-2.5 py-1.5 rounded-lg text-zinc-700 hover:bg-zinc-100 cursor-pointer"
              >
                默认应用打开
              </button>
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false)
                  void window.zmo.shell.showItemInFolder(item.path)
                }}
                className="w-full text-left px-2.5 py-1.5 rounded-lg text-zinc-700 hover:bg-zinc-100 cursor-pointer"
              >
                打开所在文件夹
              </button>
              {item.kind === 'image' && (
                <button
                  type="button"
                  onClick={async () => {
                    const r = await window.zmo.clipboard.writeImage(item.path)
                    if (r.ok) {
                      setCopiedImg(true)
                      setTimeout(() => setCopiedImg(false), 1500)
                    }
                    setMenuOpen(false)
                  }}
                  className="w-full text-left px-2.5 py-1.5 rounded-lg text-zinc-700 hover:bg-zinc-100 cursor-pointer"
                >
                  {copiedImg ? '已复制图片' : '复制图片'}
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false)
                  void window.zmo.files.saveAs(item.path)
                }}
                className="w-full text-left px-2.5 py-1.5 rounded-lg text-zinc-700 hover:bg-zinc-100 cursor-pointer"
              >
                另存为
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

interface AssistantTurnViewProps {
  turn: Extract<PersistedTurnItem, { role: 'assistant' }>
  isLastTurn: boolean
  onPreviewDeliverable: PreviewDeliverableFn
  onPickSuggestion: (text: string) => void
  onContinueInterrupted?: () => void
  onRetry?: () => void
}

export const AssistantTurnView: React.FC<AssistantTurnViewProps> = ({
  turn,
  isLastTurn,
  onPreviewDeliverable,
  onPickSuggestion,
  onContinueInterrupted,
  onRetry
}) => {
  const [traceOpen, setTraceOpen] = useState(false)
  const [reasoningOpen, setReasoningOpen] = useState(false)
  const [copiedAnswer, setCopiedAnswer] = useState(false)
  const [feedback, setFeedback] = useState<'up' | 'down' | null>(null)
  const [nowTs, setNowTs] = useState(() => Date.now())

  const isStreaming = turn.status === 'streaming'
  const hasReasoning = turn.reasoning.trim().length > 0
  const hasProcess = turn.toolCalls.length > 0 || hasReasoning
  const processOpen = isStreaming || traceOpen

  useEffect(() => {
    if (!isStreaming) return
    const timer = setInterval(() => setNowTs(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [isStreaming])

  useEffect(() => {
    if (isStreaming) setTraceOpen(false)
  }, [isStreaming])

  const elapsedMs = isStreaming
    ? Math.max(0, nowTs - turn.createdAt)
    : turn.finishedAt && turn.finishedAt >= turn.createdAt
      ? turn.finishedAt - turn.createdAt
      : undefined
  const elapsedLabel = formatDuration(elapsedMs)

  const statusLabel = isStreaming
    ? '处理中'
    : turn.status === 'error'
      ? '失败'
      : turn.status === 'aborted'
        ? '已停止'
        : '已处理'
  const statusMeta =
    turn.status === 'error' ? '· 已中断' : elapsedLabel

  const imageDeliverables = (turn.deliverables ?? []).filter((d) => d.kind === 'image')
  const docDeliverables = (turn.deliverables ?? []).filter((d) => d.kind !== 'image')

  const copyAnswer = async (): Promise<void> => {
    const text = turn.content.trim()
    if (!text) return
    await navigator.clipboard.writeText(text)
    setCopiedAnswer(true)
    setTimeout(() => setCopiedAnswer(false), 1500)
  }

  return (
    <div className="space-y-3 text-[15px] text-zinc-900">
      {/* 折叠式单行执行态摘要（对齐知末原版 TaskStatusRow：默认折叠为「已处理 5m 48s >」 / 「失败 · 已中断 >」） */}
      {hasProcess && (
        <div className="space-y-2.5">
          <button
            type="button"
            onClick={() => !isStreaming && setTraceOpen((v) => !v)}
            aria-expanded={processOpen}
            title={processOpen ? '收起处理过程' : '展开处理过程'}
            className={clsx(
              'inline-flex items-center gap-1.5 text-[13px] select-none transition-colors',
              !isStreaming && 'cursor-pointer hover:opacity-80'
            )}
          >
            <span className="font-semibold text-zinc-900">{statusLabel}</span>
            {statusMeta && <span className="text-zinc-500 tabular-nums">{statusMeta}</span>}
            {!isStreaming && (
              <ChevronRight
                className={clsx(
                  'w-3.5 h-3.5 text-zinc-400 transition-transform',
                  processOpen && 'rotate-90'
                )}
              />
            )}
          </button>

          {processOpen && (
            <div className="ml-1.5 pl-4 border-l border-dashed border-zinc-200 space-y-2">
              {hasReasoning && (
                <div className="space-y-1">
                  <button
                    type="button"
                    onClick={() => setReasoningOpen((v) => !v)}
                    className="inline-flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-800 cursor-pointer"
                  >
                    <span className="font-medium text-zinc-700">
                      {isStreaming && !turn.content ? '深度思考中…' : '已深度思考'}
                    </span>
                    <ChevronRight
                      className={clsx(
                        'w-3.5 h-3.5 text-zinc-400 transition-transform',
                        reasoningOpen && 'rotate-90'
                      )}
                    />
                  </button>
                  {reasoningOpen && (
                    <div className="rounded-xl border border-zinc-200/70 bg-zinc-50/70 px-3 py-2 text-xs text-zinc-600 whitespace-pre-wrap leading-relaxed max-h-64 overflow-y-auto">
                      {turn.reasoning}
                    </div>
                  )}
                </div>
              )}

              {turn.toolCalls.length > 0 && (
                <div className="space-y-1.5">
                  {turn.toolCalls.map((tc) => (
                    <ToolCallItem key={tc.id} tc={tc} onPreviewDeliverable={onPreviewDeliverable} />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* 主回答内容（直接铺在白底，无边框/黑色头像框） */}
      {turn.content ? (
        <div className="zmo-markdown text-[15px] leading-[1.7] text-zinc-900">
          <MarkdownRenderer content={turn.content} />
        </div>
      ) : isStreaming && !hasProcess ? (
        <div className="inline-flex items-center gap-2 text-[13px] text-zinc-500">
          <LoaderCircle className="w-3.5 h-3.5 animate-spin text-zinc-500" />
          <span>思考中…</span>
        </div>
      ) : null}

      {/* 交付到成果区 · N 个文件 */}
      {turn.deliverables && turn.deliverables.length > 0 && (
        <div className="pt-1 space-y-2.5">
          <div className="text-xs font-medium text-zinc-500">
            交付到成果区 · {turn.deliverables.length} 个文件
          </div>
          {docDeliverables.length > 0 && (
            <div className="space-y-2.5">
              {docDeliverables.map((item, idx) => (
                <DeliverableCard key={`doc-${idx}`} item={item} onPreview={onPreviewDeliverable} />
              ))}
            </div>
          )}
          {imageDeliverables.length > 0 && (
            <div
              className={clsx(
                'grid gap-2.5',
                imageDeliverables.length >= 3
                  ? 'grid-cols-1 sm:grid-cols-3'
                  : imageDeliverables.length === 2
                    ? 'grid-cols-1 sm:grid-cols-2'
                    : 'grid-cols-1'
              )}
            >
              {imageDeliverables.map((item, idx) => (
                <DeliverableCard key={`img-${idx}`} item={item} onPreview={onPreviewDeliverable} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* 错误横幅（对齐知末截图：红底/红字告警条 + 重试） */}
      {turn.status === 'error' && (
        <div className="space-y-2">
          <div className="flex items-start gap-2 rounded-xl border border-rose-200/80 bg-rose-50/70 px-3.5 py-2.5 text-[13px] text-rose-600">
            <AlertCircle className="w-4 h-4 text-rose-500 shrink-0 mt-0.5" />
            <span className="whitespace-pre-wrap leading-relaxed">
              {turn.errorMessage || '任务执行意外中断，请重试。'}
            </span>
          </div>
          {isLastTurn && onRetry && (
            <div className="flex items-center gap-2.5">
              <button
                type="button"
                onClick={onRetry}
                className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 py-1 text-xs text-zinc-800 hover:bg-zinc-50 cursor-pointer transition-colors"
              >
                <RotateCcw className="w-3.5 h-3.5 text-zinc-500" />
                <span>重试</span>
              </button>
              <span className="text-xs text-zinc-400">将沿用本轮输入重新发送一条消息</span>
            </div>
          )}
        </div>
      )}

      {/* 中断态 */}
      {turn.status === 'aborted' && (
        <div className="inline-flex items-center gap-2 text-xs text-zinc-400">
          <span>已停止</span>
          {isLastTurn && onContinueInterrupted && (
            <button
              type="button"
              onClick={onContinueInterrupted}
              className="inline-flex items-center gap-1 rounded-full border border-zinc-200 bg-white px-2.5 py-0.5 text-xs text-zinc-700 hover:bg-zinc-50 cursor-pointer"
            >
              继续生成
            </button>
          )}
        </div>
      )}

      {/* 底部操作图标栏（复制 / 点赞 / 点踩） */}
      {turn.status === 'completed' && (turn.content.trim() || (turn.deliverables?.length ?? 0) > 0) && (
        <div className="flex items-center gap-1 pt-0.5 text-zinc-400">
          <button
            type="button"
            onClick={() => void copyAnswer()}
            title="复制"
            aria-label="复制"
            className="p-1.5 rounded-lg hover:bg-zinc-100 hover:text-zinc-700 cursor-pointer transition-colors"
          >
            {copiedAnswer ? (
              <Check className="w-4 h-4 text-emerald-600" />
            ) : (
              <Copy className="w-4 h-4" />
            )}
          </button>
          <button
            type="button"
            onClick={() => setFeedback((f) => (f === 'up' ? null : 'up'))}
            title="有帮助"
            aria-label="点赞"
            className={clsx(
              'p-1.5 rounded-lg hover:bg-zinc-100 cursor-pointer transition-colors',
              feedback === 'up' ? 'text-zinc-900' : 'hover:text-zinc-700'
            )}
          >
            <ThumbsUp className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => setFeedback((f) => (f === 'down' ? null : 'down'))}
            title="需改进"
            aria-label="点踩"
            className={clsx(
              'p-1.5 rounded-lg hover:bg-zinc-100 cursor-pointer transition-colors',
              feedback === 'down' ? 'text-zinc-900' : 'hover:text-zinc-700'
            )}
          >
            <ThumbsDown className="w-4 h-4" />
          </button>
          {turn.usage && turn.usage.totalTokens > 0 && (() => {
            const netTokens = Math.max(0, turn.usage.totalTokens - turn.usage.cacheReadTokens)
            const fmtTok = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
            const cachePct =
              turn.usage.inputTokens > 0
                ? Math.min(100, Math.round((turn.usage.cacheReadTokens / turn.usage.inputTokens) * 100))
                : 0
            return (
              <span
                className="ml-2 text-[11px] text-zinc-400 hover:text-zinc-600 transition-colors"
                title={`本轮 ${turn.usage.modelCalls} 次模型调用 · 总输入 ${turn.usage.inputTokens.toLocaleString()}（缓存命中 ${turn.usage.cacheReadTokens.toLocaleString()}，省 ${cachePct}%）· 输出 ${turn.usage.outputTokens.toLocaleString()}`}
              >
                实耗 {fmtTok(netTokens)} tok{cachePct > 0 ? ` · 缓存 ${cachePct}%` : ''}
              </span>
            )
          })()}
        </div>
      )}

      {/* 下一步建议胶囊 */}
      {isLastTurn && turn.status === 'completed' && turn.suggestions && turn.suggestions.length > 0 && (
        <ul className="pt-1 flex flex-col items-start gap-1.5" aria-label="下一步建议">
          {turn.suggestions.map((item) => (
            <li key={item}>
              <button
                type="button"
                onClick={() => onPickSuggestion(item)}
                title="填入输入框"
                className="inline-flex items-center gap-2 px-3 py-1.5 rounded-xl border border-zinc-200 bg-white hover:border-zinc-300 hover:bg-zinc-50 text-xs text-zinc-700 transition-all cursor-pointer"
              >
                <span>{item}</span>
                <ArrowRight className="w-3.5 h-3.5 text-zinc-400" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
