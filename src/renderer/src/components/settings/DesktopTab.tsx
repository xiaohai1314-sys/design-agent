import { useEffect, useState } from 'react'
import type { AppGeneralSettings } from '@shared/ipc'
import type { UpdateState } from '@shared/protocol'

export interface DesktopTabProps {
  genDraft: AppGeneralSettings
  setGenDraft: (draft: AppGeneralSettings) => void
}

/** 设置 → 桌面通知、托盘行为与版本更新 */
export function DesktopTab({ genDraft, setGenDraft }: DesktopTabProps): React.JSX.Element {
  const [update, setUpdate] = useState<UpdateState | null>(null)
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    let alive = true
    void window.designAgent.updates.getState().then((s) => {
      if (alive && s) setUpdate(s)
    })
    const off = window.designAgent.updates.onChanged((s) => setUpdate(s))
    return () => {
      alive = false
      off()
    }
  }, [])

  const checkNow = async (): Promise<void> => {
    setChecking(true)
    try {
      const s = await window.designAgent.updates.check()
      if (s) setUpdate(s)
    } finally {
      setChecking(false)
    }
  }

  const versionText = (): string => {
    if (!update) return '版本未知'
    if (update.status === 'disabled') return `v${update.currentVersion}（开发模式，不检查更新）`
    if (update.status === 'checking' || checking) return `v${update.currentVersion} · 正在检查…`
    if (update.status === 'up-to-date') return `v${update.currentVersion} · 已是最新版本`
    if (update.status === 'available' || update.status === 'downloading' || update.status === 'downloaded') {
      return `v${update.currentVersion} · 有新版本 v${update.version}`
    }
    if (update.status === 'error') return `v${update.currentVersion} · 检查失败`
    return `v${update.currentVersion}`
  }

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

      <div className="flex items-start gap-2.5 p-3 rounded-xl border border-zinc-200">
        <div className="flex-1">
          <div className="font-semibold text-zinc-900">版本与更新</div>
          <div className="text-zinc-500 mt-0.5">{versionText()}</div>
          {update?.status === 'error' && update.error && (
            <div className="text-rose-600 mt-1 break-all">{update.error}</div>
          )}
        </div>
        <button
          type="button"
          disabled={checking || update?.status === 'disabled' || update?.status === 'downloading'}
          onClick={() => void checkNow()}
          className="shrink-0 rounded-lg border border-zinc-300 px-3 py-1 text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
        >
          检查更新
        </button>
      </div>
    </div>
  )
}
