import React, { useMemo, useState } from 'react'
import { BookCheck, Eye, FolderOpen, PackageCheck } from 'lucide-react'
import type { PersistedTurnItem } from '@shared/ipc'
import type { Deliverable, RegulationChunk, RegulationToolData } from '@shared/protocol'

interface DeliveryPopoverProps {
  turns: PersistedTurnItem[]
  onPreviewDeliverable: (path: string, title: string) => void
  onOpenFilesManager: () => void
}

export const DeliveryPopover: React.FC<DeliveryPopoverProps> = ({
  turns,
  onPreviewDeliverable,
  onOpenFilesManager
}) => {
  const [open, setOpen] = useState(false)

  const { files, citations } = useMemo(() => {
    const fileMap = new Map<string, Deliverable>()
    const regList: RegulationChunk[] = []
    for (let i = turns.length - 1; i >= 0; i--) {
      const t = turns[i]
      if (t.role !== 'assistant') continue
      for (const d of t.deliverables ?? []) {
        if (!fileMap.has(d.path)) fileMap.set(d.path, d)
      }
      for (const tc of t.toolCalls ?? []) {
        if (
          tc.toolData &&
          typeof tc.toolData === 'object' &&
          (tc.toolData as { kind?: string }).kind === 'regulation_chunks'
        ) {
          const rd = tc.toolData as RegulationToolData
          regList.push(...rd.retrievedChunks)
        }
      }
    }
    return { files: [...fileMap.values()], citations: regList.slice(0, 6) }
  }, [turns])

  const totalCount = files.length + citations.length

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50 cursor-pointer"
        title="查看本会话全部交付物汇总与规范依据"
      >
        <PackageCheck className="w-3.5 h-3.5 text-emerald-600" />
        <span>交付物</span>
        {totalCount > 0 && (
          <span className="px-1.5 py-0.2 rounded-full bg-emerald-100 text-emerald-800 text-[10px] font-semibold">
            {totalCount}
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-10 z-40 w-80 rounded-2xl border border-zinc-200 bg-white shadow-2xl overflow-hidden flex flex-col max-h-[70vh]">
            <div className="px-3.5 py-2.5 border-b border-zinc-100 flex items-center justify-between text-xs font-semibold text-zinc-900">
              <span>本会话交付物汇总</span>
              <span className="text-[11px] font-normal text-zinc-400">按时间倒序</span>
            </div>

            <div className="flex-1 overflow-y-auto p-2.5 space-y-2">
              {files.length === 0 && citations.length === 0 ? (
                <div className="py-10 text-center text-xs text-zinc-400">暂无交付物</div>
              ) : (
                <>
                  {files.map((item) => (
                    <div
                      key={item.path}
                      className="flex items-center justify-between gap-2 px-2.5 py-2 rounded-xl border border-zinc-100 bg-zinc-50/70 hover:bg-zinc-100/70 text-xs"
                    >
                      <button
                        type="button"
                        onClick={() => {
                          onPreviewDeliverable(item.path, item.title)
                          setOpen(false)
                        }}
                        className="min-w-0 flex-1 text-left cursor-pointer"
                      >
                        <div className="font-medium text-zinc-900 truncate">{item.title}</div>
                        <div className="text-[10px] text-zinc-400 font-mono truncate">{item.path}</div>
                      </button>
                      <div className="flex items-center gap-0.5 shrink-0">
                        <button
                          type="button"
                          onClick={() => {
                            onPreviewDeliverable(item.path, item.title)
                            setOpen(false)
                          }}
                          title="预览"
                          className="p-1 rounded text-zinc-500 hover:text-blue-600 cursor-pointer"
                        >
                          <Eye className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => void window.zmo.shell.showItemInFolder(item.path)}
                          title="定位文件夹"
                          className="p-1 rounded text-zinc-500 hover:text-zinc-900 cursor-pointer"
                        >
                          <FolderOpen className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}

                  {citations.length > 0 && (
                    <div className="pt-1 border-t border-zinc-100 space-y-1">
                      <div className="px-1 text-[10px] font-semibold text-emerald-700 flex items-center gap-1">
                        <BookCheck className="w-3 h-3" />
                        <span>本会话参考规范条文 ({citations.length})</span>
                      </div>
                      {citations.map((c, idx) => (
                        <div
                          key={idx}
                          className="px-2.5 py-1.5 rounded-lg bg-emerald-50/50 border border-emerald-100 text-[11px]"
                        >
                          <div className="font-medium text-zinc-900">
                            {c.standardNo} 第 {c.clauseId} 条
                          </div>
                          <div className="text-zinc-600 line-clamp-2">{c.text}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="px-3 py-2 border-t border-zinc-100 bg-zinc-50">
              <button
                type="button"
                onClick={() => {
                  setOpen(false)
                  onOpenFilesManager()
                }}
                className="w-full py-1.5 rounded-lg bg-white border border-zinc-200 text-xs font-medium text-zinc-700 hover:bg-zinc-100 cursor-pointer"
              >
                打开工作区文件管理 →
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
