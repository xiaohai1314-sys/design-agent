import { X } from 'lucide-react'
import type { ProjectMeta } from '@shared/ipc'

export interface ProjectMetaModalProps {
  target: { id: string; name: string }
  draft: ProjectMeta
  onChange: (draft: ProjectMeta) => void
  onClose: () => void
  onSave: (id: string, draft: ProjectMeta) => void | Promise<void>
}

/** 项目档案编辑弹窗（内容自动注入该项目的所有对话） */
export function ProjectMetaModal({
  target,
  draft,
  onChange,
  onClose,
  onSave
}: ProjectMetaModalProps): React.JSX.Element {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-[2px] p-4">
      <div className="w-full max-w-lg rounded-2xl bg-white border border-zinc-200 shadow-2xl overflow-hidden flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-200">
          <div className="text-xs font-semibold text-zinc-900">
            项目档案：{target.name}（自动注入本项目所有对话）
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-lg text-zinc-400 hover:text-zinc-700 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-4 space-y-3 text-xs">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block font-medium text-zinc-700 mb-1">所属领域</label>
              <input
                type="text"
                value={draft.domain ?? ''}
                onChange={(e) => onChange({ ...draft, domain: e.target.value })}
                placeholder="如 室内工装 / 住宅家装 / 建筑 / 景观"
                className="w-full px-2.5 py-1.5 rounded-lg border border-zinc-200 outline-none focus:border-blue-500"
              />
            </div>
            <div>
              <label className="block font-medium text-zinc-700 mb-1">项目类型</label>
              <input
                type="text"
                value={draft.projectType ?? ''}
                onChange={(e) => onChange({ ...draft, projectType: e.target.value })}
                placeholder="如 新中式茶室 / 商业展厅"
                className="w-full px-2.5 py-1.5 rounded-lg border border-zinc-200 outline-none focus:border-blue-500"
              />
            </div>
            <div>
              <label className="block font-medium text-zinc-700 mb-1">项目地区</label>
              <input
                type="text"
                value={draft.region ?? ''}
                onChange={(e) => onChange({ ...draft, region: e.target.value })}
                placeholder="如 北京（影响地方规范适配）"
                className="w-full px-2.5 py-1.5 rounded-lg border border-zinc-200 outline-none focus:border-blue-500"
              />
            </div>
            <div>
              <label className="block font-medium text-zinc-700 mb-1">面积与预算</label>
              <input
                type="text"
                value={draft.area ?? ''}
                onChange={(e) => onChange({ ...draft, area: e.target.value })}
                placeholder="如 280㎡ · 预算 60 万元"
                className="w-full px-2.5 py-1.5 rounded-lg border border-zinc-200 outline-none focus:border-blue-500"
              />
            </div>
          </div>
          <div>
            <label className="block font-medium text-zinc-700 mb-1">任务书 / 客户核心要求</label>
            <textarea
              rows={4}
              value={draft.brief ?? ''}
              onChange={(e) => onChange({ ...draft, brief: e.target.value })}
              placeholder="填写客户明确的设计诉求、忌讳项或保留空间结构…"
              className="w-full px-2.5 py-1.5 rounded-lg border border-zinc-200 outline-none focus:border-blue-500 resize-y"
            />
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-zinc-200 bg-zinc-50">
          <button
            type="button"
            onClick={onClose}
            className="px-3.5 py-1.5 rounded-lg text-xs border border-zinc-300 bg-white text-zinc-700 cursor-pointer"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => void onSave(target.id, draft)}
            className="px-3.5 py-1.5 rounded-lg text-xs font-medium bg-zinc-900 text-white hover:bg-zinc-800 cursor-pointer"
          >
            保存项目档案
          </button>
        </div>
      </div>
    </div>
  )
}
