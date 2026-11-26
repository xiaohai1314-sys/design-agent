import type { AppGeneralSettings } from '@shared/ipc'

export interface DesktopTabProps {
  genDraft: AppGeneralSettings
  setGenDraft: (draft: AppGeneralSettings) => void
}

/** 设置 → 桌面通知与托盘行为 */
export function DesktopTab({ genDraft, setGenDraft }: DesktopTabProps): React.JSX.Element {
  return (
    <div className="flex-1 p-6 space-y-4 overflow-y-auto text-xs">
      <div className="p-3.5 rounded-xl bg-zinc-100 border border-zinc-200 text-zinc-700 leading-relaxed">
        配置后台长任务完成后是否弹出 Windows 系统通知，以及点击右上角关闭按钮时是最小化到系统托盘还是直接退出程序。
      </div>

      <label className="flex items-start gap-2.5 cursor-pointer p-3 rounded-xl border border-zinc-200 hover:bg-zinc-50">
        <input
          type="checkbox"
          checked={genDraft.desktopNotifications}
          onChange={(e) => setGenDraft({ ...genDraft, desktopNotifications: e.target.checked })}
          className="w-4 h-4 mt-0.5 rounded accent-blue-600"
        />
        <div>
          <div className="font-semibold text-zinc-900">启用后台任务桌面系统通知</div>
          <div className="text-zinc-500 mt-0.5">
            窗口处于最小化或未聚焦状态时，当智能体完成任务或等待您审批/回答提问，弹出 Windows 通知提醒。
          </div>
        </div>
      </label>

      <label className="flex items-start gap-2.5 cursor-pointer p-3 rounded-xl border border-zinc-200 hover:bg-zinc-50">
        <input
          type="checkbox"
          checked={genDraft.closeToTray}
          onChange={(e) => setGenDraft({ ...genDraft, closeToTray: e.target.checked })}
          className="w-4 h-4 mt-0.5 rounded accent-blue-600"
        />
        <div>
          <div className="font-semibold text-zinc-900">关闭主窗口时隐藏到系统托盘</div>
          <div className="text-zinc-500 mt-0.5">
            点击右上角「×」不中断正在运行的任务，可在右下角托盘图标右键菜单彻底退出。
          </div>
        </div>
      </label>
    </div>
  )
}
