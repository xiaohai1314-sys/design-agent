import React, { useMemo, useState } from 'react'
import {
  Box,
  Eye,
  FileSpreadsheet,
  FileText,
  FolderOpen,
  Image as ImageIcon,
  Layers,
  Presentation,
  Sparkles
} from 'lucide-react'
import clsx from 'clsx'
import type { RecentFileEntry } from '@shared/ipc'
import type { AgentAttachment, Deliverable } from '@shared/protocol'
import type { ThreadSlice } from '../store/useWorkspaceStore'

interface LocalLibraryViewProps {
  slices: Record<string, ThreadSlice>
  recentFiles: RecentFileEntry[]
  onPreview: (path: string, title: string) => void
  onAttachToNewTask: (attachment: AgentAttachment) => void
}

interface LibraryItem {
  path: string
  name: string
  group: 'image' | 'cad3d' | 'doc'
  sourceLabel: string
  size?: number
}

function classifyLibraryFile(filePath: string, kindHint?: string): 'image' | 'cad3d' | 'doc' {
  const lower = filePath.toLowerCase()
  if (kindHint === 'image' || /\.(png|jpe?g|webp|gif|bmp|svg)$/i.test(lower)) return 'image'
  if (/\.(dwg|dxf|skp|3dm|glb|gltf|obj|fbx|stl)$/i.test(lower)) return 'cad3d'
  return 'doc'
}

export const LocalLibraryView: React.FC<LocalLibraryViewProps> = ({
  slices,
  recentFiles,
  onPreview,
  onAttachToNewTask
}) => {
  const [filter, setFilter] = useState<'all' | 'image' | 'cad3d' | 'doc'>('all')

  const items = useMemo(() => {
    const byPath = new Map<string, LibraryItem>()

    for (const slice of Object.values(slices)) {
      for (const turn of slice.turns) {
        if (turn.role !== 'assistant') continue
        for (const d of (turn.deliverables ?? []) as Deliverable[]) {
          if (!d.path || byPath.has(d.path)) continue
          byPath.set(d.path, {
            path: d.path,
            name: d.title || d.path.split(/[\\/]/).pop() || d.path,
            group: classifyLibraryFile(d.path, d.kind),
            sourceLabel: 'AI 交付成果',
            size: d.size
          })
        }
      }
    }

    for (const rf of recentFiles) {
      if (!rf.path || byPath.has(rf.path)) continue
      byPath.set(rf.path, {
        path: rf.path,
        name: rf.name,
        group: classifyLibraryFile(rf.path, rf.kind),
        sourceLabel: '近期使用文件',
        size: rf.size
      })
    }

    return [...byPath.values()]
  }, [slices, recentFiles])

  const filtered = useMemo(
    () => (filter === 'all' ? items : items.filter((it) => it.group === filter)),
    [items, filter]
  )

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
      <div className="max-w-5xl mx-auto space-y-5">
        <div>
          <h1 className="text-lg font-semibold text-zinc-900">本地资料库</h1>
          <p className="text-xs text-zinc-500 mt-0.5">
            自动汇总本机会话中 AI 生成交付的效果图、CAD/三维模型、汇报 PPT 与规范文档，支持一键预览或引用发起新任务
          </p>
        </div>

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
                'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs border transition-colors cursor-pointer',
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

        {filtered.length === 0 ? (
          <div className="py-16 text-center text-xs text-zinc-400 border border-dashed border-zinc-200 rounded-2xl">
            当前暂无资料记录。在对话中生成效果图、PPT 或导入图纸后，会自动归集到这里。
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {filtered.map((item) => {
              const lower = item.name.toLowerCase()
              const Icon =
                item.group === 'image'
                  ? ImageIcon
                  : item.group === 'cad3d'
                    ? Box
                    : lower.endsWith('.pptx') || lower.endsWith('.potx')
                      ? Presentation
                      : lower.endsWith('.xlsx') || lower.endsWith('.xls')
                        ? FileSpreadsheet
                        : FileText
              return (
                <div
                  key={item.path}
                  className="rounded-2xl border border-zinc-200/90 bg-white p-4 flex flex-col gap-2.5 hover:border-zinc-300 transition-colors"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="w-8 h-8 rounded-xl bg-zinc-100 flex items-center justify-center shrink-0 text-zinc-600">
                      <Icon className="w-4 h-4" />
                    </div>
                    <span className="px-2 py-0.5 rounded bg-zinc-100 text-[10px] text-zinc-500">
                      {item.sourceLabel}
                    </span>
                  </div>

                  <div className="min-w-0 space-y-0.5">
                    <div className="text-xs font-semibold text-zinc-900 truncate" title={item.name}>
                      {item.name}
                    </div>
                    <div className="text-[10px] text-zinc-400 font-mono truncate" title={item.path}>
                      {item.path}
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 pt-1 border-t border-zinc-100 text-[11px]">
                    <button
                      type="button"
                      onClick={() => onPreview(item.path, item.name)}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-zinc-100 hover:bg-zinc-200 text-zinc-700 cursor-pointer"
                    >
                      <Eye className="w-3 h-3" />
                      <span>预览</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => void window.zmo.shell.showItemInFolder(item.path)}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-zinc-100 hover:bg-zinc-200 text-zinc-700 cursor-pointer"
                    >
                      <FolderOpen className="w-3 h-3" />
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
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-blue-50 hover:bg-blue-100 text-blue-700 cursor-pointer ml-auto"
                    >
                      <Sparkles className="w-3 h-3" />
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
