import { X } from 'lucide-react'

export interface CharterModalProps {
  draft: string
  onChange: (text: string) => void
  onClose: () => void
  onSave: () => void | Promise<void>
}

/** 项目宪章（ZNZMO.md）编辑弹窗 */
export function CharterModal({
  draft,
  onChange,
  onClose,
  onSave
}: CharterModalProps): React.JSX.Element {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-[2px] p-4">
      <div className="w-full max-w-xl rounded-2xl bg-white border border-zinc-200 shadow-2xl overflow-hidden flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-200">
          <div className="text-xs font-semibold text-zinc-900">
            项目宪章 (ZNZMO.md) · 自动注入到本工作区所有智能体对话
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-lg text-zinc-400 hover:text-zinc-700 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-4">
          <textarea
            rows={10}
            value={draft}
            onChange={(e) => onChange(e.target.value)}
            placeholder="可填写项目硬约束、品牌调性、面积指标、出图规范等（Markdown 格式）…"
            className="w-full p-3 rounded-xl border border-zinc-200 text-xs font-mono outline-none focus:border-blue-500 resize-y"
          />
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
            onClick={() => void onSave()}
            className="px-3.5 py-1.5 rounded-lg text-xs font-medium bg-zinc-900 text-white hover:bg-zinc-800 cursor-pointer"
          >
            保存 ZNZMO.md
          </button>
        </div>
      </div>
    </div>
  )
}
