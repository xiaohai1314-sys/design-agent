import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Box,
  Eye,
  FileSpreadsheet,
  FileText,
  FolderOpen,
  FolderPlus,
  Image as ImageIcon,
  Layers,
  Presentation,
  RefreshCw,
  Search,
  Sparkles,
  X
} from 'lucide-react'
import clsx from 'clsx'
import type { LocalLibraryEntry, LocalLibrarySnapshot, RecentFileEntry } from '@shared/ipc'
import type { AgentAttachment, Deliverable } from '@shared/protocol'
import type { ThreadSlice } from '../store/useWorkspaceStore'

interface LocalLibraryViewProps {
  slices: Record<string, ThreadSlice>
  recentFiles: RecentFileEntry[]
  onPreview: (path: string, title: string) => void
  onAttachToNewTask: (attachment: AgentAttachment) => void
}

function classifyLibraryFile(filePath: string, kindHint?: string): 'image' | 'cad3d' | 'doc' {
  const lower = filePath.toLowerCase()
  if (kindHint === 'image' || /\.(png|jpe?g|webp|gif|bmp|svg)$/i.test(lower)) return 'image'
  if (/\.(dwg|dxf|skp|3dm|glb|gltf|obj|fbx|stl)$/i.test(lower)) return 'cad3d'
  return 'doc'
}

function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDateLabel(ts?: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const min = String(d.getMinutes()).padStart(2, '0')
  return `${mm}-${dd} ${hh}:${min}`
}

const LibraryImageThumb: React.FC<{
  path: string
  name: string
  onClick: () => void
}> = ({ path, name, onClick }) => {
  const [src, setSrc] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    setSrc(null)
    setFailed(false)
    window.designAgent.files
      .readThumb(path)
      .then((res) => {
        if (cancelled) return
        if (res.ok && res.dataUrl) {
          setSrc(res.dataUrl)
        } else {
          setFailed(true)
        }
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [path])

  return (
    <button
      type="button"
      onClick={onClick}
      title={`点击预览：${name}`}
      className="relative w-full h-36 rounded-xl overflow-hidden bg-zinc-100 border border-zinc-200/70 flex items-center justify-center group cursor-pointer"
    >
      {src ? (
        <>
          <img
            src={src}
            alt={name}
            loading="lazy"
            className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
          />
          <span className="absolute inset-0 bg-black/0 group-hover:bg-black/15 transition-colors flex items-center justify-center opacity-0 group-hover:opacity-100">
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-white/95 text-zinc-900 text-[11px] font-medium shadow-sm">
              <Eye className="w-3 h-3" />
              <span>查看大图</span>
            </span>
          </span>
        </>
      ) : (
        <div className="flex flex-col items-center gap-1.5 text-zinc-400">
          <ImageIcon className="w-6 h-6" />
          <span className="text-[11px]">{failed ? '无法生成缩略图' : '正在加载效果图…'}</span>
        </div>
      )}
    </button>
  )
}

export const LocalLibraryView: React.FC<LocalLibraryViewProps> = ({
  slices,
  recentFiles,
  onPreview,
  onAttachToNewTask
}) => {
  const [filter, setFilter] = useState<'all' | 'image' | 'cad3d' | 'doc'>('all')
  const [query, setQuery] = useState('')
  const [snapshot, setSnapshot] = useState<LocalLibrarySnapshot | null>(null)
  const [loading, setLoading] = useState(false)

  const refreshLibrary = useCallback(async () => {
    setLoading(true)
    try {
      const next = await window.designAgent.files.listLibrary()
      setSnapshot(next)
    } catch {
      // ignore fallback to props
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refreshLibrary()
  }, [refreshLibrary, recentFiles])

  const handleAddFolder = async (): Promise<void> => {
    const picked = await window.designAgent.agent.pickFolder('library')
    if (!picked) return
    setLoading(true)
    try {
      const next = await window.designAgent.files.addLibraryFolder(picked)
      setSnapshot(next)
    } finally {
      setLoading(false)
    }
  }

  const handleRemoveFolder = async (folderPath: string): Promise<void> => {
    setLoading(true)
    try {
      const next = await window.designAgent.files.removeLibraryFolder(folderPath)
      setSnapshot(next)
    } finally {
      setLoading(false)
    }
  }

  const items = useMemo(() => {
    const byPath = new Map<string, LocalLibraryEntry>()
    const rank: Record<LocalLibraryEntry['sourceLabel'], number> = {
      'AI 交付成果': 3,
      '近期使用文件': 2,
      '工作区成果': 1
    }

    const mergeItem = (entry: LocalLibraryEntry): void => {
      if (!entry.path) return
      const key = entry.path.replace(/\//g, '\\').toLowerCase()
      const prev = byPath.get(key)
      if (!prev || rank[entry.sourceLabel] > rank[prev.sourceLabel]) {
        byPath.set(key, {
          ...entry,
          updatedAt: Math.max(entry.updatedAt || 0, prev?.updatedAt || 0)
        })
      }
    }

    for (const it of snapshot?.items ?? []) {
      mergeItem(it)
    }

    for (const slice of Object.values(slices)) {
      for (const turn of slice.turns) {
        if (turn.role !== 'assistant') continue
        for (const d of (turn.deliverables ?? []) as Deliverable[]) {
          if (!d.path) continue
          mergeItem({
            path: d.path,
            name: d.title || d.path.split(/[\\/]/).pop() || d.path,
            group: classifyLibraryFile(d.path, d.kind),
            sourceLabel: 'AI 交付成果',
            size: d.size ?? 0,
            updatedAt: turn.createdAt ?? 0
          })
        }
      }
    }

    for (const rf of recentFiles) {
      if (!rf.path) continue
      mergeItem({
        path: rf.path,
        name: rf.name,
        group: classifyLibraryFile(rf.path, rf.kind),
        sourceLabel: '近期使用文件',
        size: rf.size ?? 0,
        updatedAt: rf.lastUsedAt ?? 0
      })
    }

    return [...byPath.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  }, [snapshot, slices, recentFiles])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return items.filter((it) => {
      if (filter !== 'all' && it.group !== filter) return false
      if (!q) return true
      return it.name.toLowerCase().includes(q) || it.path.toLowerCase().includes(q)
    })
  }, [items, filter, query])

  const counts = useMemo(
    () => ({
      all: items.length,
      image: items.filter((i) => i.group === 'image').length,
      cad3d: items.filter((i) => i.group === 'cad3d').length,
      doc: items.filter((i) => i.group === 'doc').length
    }),
    [items]
  )

  return (
    <div className="flex-1 overflow-y-auto px-6 py-6 bg-white">
      <div className="max-w-6xl mx-auto space-y-4">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-lg font-semibold text-zinc-900">本地资料库</h1>
            <p className="text-xs text-zinc-500 mt-0.5">
              自动汇总本机工作区与会话中生成的效果图、CAD/三维模型、汇报 PPT 与规范文档，支持直接看图与一键引用
            </p>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => void handleAddFolder()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-zinc-200 bg-white hover:border-zinc-300 hover:bg-zinc-50 text-xs font-medium text-zinc-700 whitespace-nowrap cursor-pointer"
            >
              <FolderPlus className="w-3.5 h-3.5 text-blue-600" />
              <span>添加本地目录</span>
            </button>
            <button
              type="button"
              onClick={() => void refreshLibrary()}
              disabled={loading}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-zinc-200 bg-white hover:border-zinc-300 hover:bg-zinc-50 text-xs text-zinc-600 whitespace-nowrap cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={clsx('w-3.5 h-3.5', loading && 'animate-spin')} />
              <span>刷新</span>
            </button>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-1.5 flex-wrap">
            {(
              [
                { id: 'all', label: '全部资料' },
                { id: 'image', label: '渲染效果图' },
                { id: 'cad3d', label: 'CAD 与三维模型' },
                { id: 'doc', label: 'PPT 与设计文档' }
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setFilter(tab.id)}
                className={clsx(
                  'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs border transition-colors cursor-pointer whitespace-nowrap',
                  filter === tab.id
                    ? 'bg-zinc-900 text-white border-zinc-900 font-medium'
                    : 'bg-white text-zinc-600 border-zinc-200 hover:border-zinc-300'
                )}
              >
                <span>{tab.label}</span>
                <span
                  className={clsx(
                    'text-[10px] tabular-nums',
                    filter === tab.id ? 'text-zinc-300' : 'text-zinc-400'
                  )}
                >
                  {counts[tab.id]}
                </span>
              </button>
            ))}
          </div>

          <div className="relative w-56">
            <Search className="w-3.5 h-3.5 text-zinc-400 absolute left-3 top-2" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索文件名或路径…"
              className="w-full pl-8 pr-3 py-1.5 rounded-full border border-zinc-200 bg-white text-xs text-zinc-800 outline-none focus:border-blue-500"
            />
          </div>
        </div>

        {(snapshot?.folders.length ?? 0) > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap text-[11px] text-zinc-500">
            <span>已挂载目录：</span>
            {snapshot!.folders.map((folder) => (
              <span
                key={folder}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-zinc-100 text-zinc-700 font-mono"
                title={folder}
              >
                <span className="max-w-[240px] truncate">{folder}</span>
                <button
                  type="button"
                  onClick={() => void handleRemoveFolder(folder)}
                  title="移除目录"
                  className="text-zinc-400 hover:text-rose-600 cursor-pointer"
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            ))}
          </div>
        )}

        {filtered.length === 0 ? (
          <div className="py-16 text-center text-xs text-zinc-400 border border-dashed border-zinc-200 rounded-2xl">
            {items.length === 0
              ? '当前暂无资料记录。在对话中生成效果图、PPT 或导入图纸，或点击右上角“添加本地目录”即可在这里浏览。'
              : '未找到匹配的本地资料或效果图。'}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3.5">
            {filtered.map((item) => {
              const lower = item.name.toLowerCase()
              const ext = (item.name.split('.').pop() || '').toUpperCase()
              const Icon =
                item.group === 'image'
                  ? ImageIcon
                  : item.group === 'cad3d'
                    ? Box
                    : lower.endsWith('.pptx') || lower.endsWith('.potx')
                      ? Presentation
                      : lower.endsWith('.xlsx') || lower.endsWith('.xls') || lower.endsWith('.xlsm')
                        ? FileSpreadsheet
                        : FileText
              const sizeStr = formatBytes(item.size)
              const timeStr = formatDateLabel(item.updatedAt)

              return (
                <div
                  key={item.path}
                  className="rounded-2xl border border-zinc-200/90 bg-white p-3.5 flex flex-col gap-2.5 hover:border-zinc-300 hover:shadow-xs transition-all min-w-0"
                >
                  {item.group === 'image' ? (
                    <LibraryImageThumb
                      path={item.path}
                      name={item.name}
                      onClick={() => onPreview(item.path, item.name)}
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => onPreview(item.path, item.name)}
                      className="w-full h-24 rounded-xl bg-gradient-to-br from-zinc-50 to-zinc-100/80 border border-zinc-200/70 px-3 flex items-center justify-between gap-2 hover:from-zinc-100 hover:to-zinc-100 transition-colors cursor-pointer"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <div className="w-10 h-10 rounded-xl bg-white border border-zinc-200/80 flex items-center justify-center shrink-0 text-zinc-700 shadow-2xs">
                          <Icon className="w-5 h-5" />
                        </div>
                        <div className="text-left min-w-0">
                          <div className="text-[11px] font-semibold text-zinc-700">
                            {ext || 'FILE'}
                          </div>
                          <div className="text-[10px] text-zinc-400">
                            {[sizeStr, timeStr].filter(Boolean).join(' · ') || '点击预览'}
                          </div>
                        </div>
                      </div>
                      <span className="px-2 py-0.5 rounded bg-white border border-zinc-200/80 text-[10px] text-zinc-500 whitespace-nowrap shrink-0">
                        {item.sourceLabel}
                      </span>
                    </button>
                  )}

                  <div className="min-w-0 space-y-0.5">
                    <div className="flex items-center justify-between gap-2">
                      <div
                        className="text-xs font-semibold text-zinc-900 truncate"
                        title={item.name}
                      >
                        {item.name}
                      </div>
                      {item.group === 'image' && (
                        <span className="px-1.5 py-0.5 rounded bg-zinc-100 text-[10px] text-zinc-500 whitespace-nowrap shrink-0">
                          {item.sourceLabel}
                        </span>
                      )}
                    </div>
                    <div className="text-[10px] text-zinc-400 font-mono truncate" title={item.path}>
                      {item.path}
                    </div>
                    {item.group === 'image' && (sizeStr || timeStr) && (
                      <div className="text-[10px] text-zinc-400">
                        {[ext, sizeStr, timeStr].filter(Boolean).join(' · ')}
                      </div>
                    )}
                  </div>

                  <div className="flex items-center gap-1.5 pt-2 mt-auto border-t border-zinc-100 text-[11px] flex-wrap">
                    <button
                      type="button"
                      onClick={() => onPreview(item.path, item.name)}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-zinc-100 hover:bg-zinc-200 text-zinc-700 whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      <Eye className="w-3 h-3 shrink-0" />
                      <span>预览</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => void window.designAgent.shell.showItemInFolder(item.path)}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-zinc-100 hover:bg-zinc-200 text-zinc-700 whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      <FolderOpen className="w-3 h-3 shrink-0" />
                      <span>位置</span>
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        onAttachToNewTask({
                          path: item.path,
                          name: item.name,
                          kind: item.group === 'image' ? 'image' : 'file',
                          size: item.size
                        })
                      }
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-blue-50 hover:bg-blue-100 text-blue-700 whitespace-nowrap shrink-0 cursor-pointer ml-auto"
                    >
                      <Sparkles className="w-3 h-3 shrink-0" />
                      <span>引用</span>
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

export { Layers }
