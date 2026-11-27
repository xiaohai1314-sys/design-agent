import React, { useEffect, useState } from 'react'
import { Download, RefreshCw, X } from 'lucide-react'
import type { UpdateState } from '@shared/protocol'

function mb(bytes?: number): string {
  if (!bytes) return ''
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function speed(bytesPerSecond?: number): string {
  if (!bytesPerSecond) return ''
  return `${(bytesPerSecond / 1024 / 1024).toFixed(1)} MB/s`
}

/**
 * 顶部更新提示条：有新版本 → 用户点下载 → 进度 → 重启安装。
 * 不做后台静默下载，安装包几百 MB，得让用户知道。
 */
export function UpdateBanner(): React.JSX.Element | null {
  const [state, setState] = useState<UpdateState | null>(null)
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    void window.designAgent.updates.getState().then((s) => {
      if (alive && s) setState(s)
    })
    const off = window.designAgent.updates.onChanged((s) => setState(s))
    return () => {
      alive = false
      off()
    }
  }, [])

  if (!state) return null
  const { status, version } = state
  const shown =
    status === 'available' || status === 'downloading' || status === 'downloaded' || status === 'error'
  if (!shown) return null
  if (status === 'available' && version && dismissedVersion === version) return null

  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try {
      await fn()
    } finally {
      setBusy(false)
    }
  }

  const close = (): void => {
    if (status === 'available' && version) setDismissedVersion(version)
    else setState({ ...state, status: 'idle' })
  }

  if (status === 'available') {
    return (
      <div className="flex items-center gap-3 border-b border-blue-200 bg-blue-50 px-4 py-2 text-xs text-blue-900">
        <Download className="w-3.5 h-3.5 shrink-0" />
        <span className="flex-1">
          有新版本 <span className="font-semibold">v{version}</span>，下载完成后重启即可生效。
        </span>
        <button
          type="button"
          disabled={busy}
          onClick={() => void run(() => window.designAgent.updates.download())}
          className="cursor-pointer rounded-lg bg-zinc-900 px-3 py-1 text-white disabled:opacity-50"
        >
          下载
        </button>
        <button
          type="button"
          onClick={close}
          className="cursor-pointer text-blue-500 hover:text-blue-800"
          title="忽略这个版本"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    )
  }

  if (status === 'downloading') {
    const percent = Math.max(0, Math.min(100, state.percent ?? 0))
    return (
      <div className="flex items-center gap-3 border-b border-blue-200 bg-blue-50 px-4 py-2 text-xs text-blue-900">
        <Download className="w-3.5 h-3.5 shrink-0" />
        <span className="shrink-0">
          正在下载 v{version} {percent.toFixed(0)}%
        </span>
        <div className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-blue-100">
          <div className="h-full bg-blue-500 transition-[width]" style={{ width: `${percent}%` }} />
        </div>
        <span className="shrink-0 tabular-nums text-blue-700">
          {mb(state.transferred)}
          {state.total ? ` / ${mb(state.total)}` : ''} {speed(state.bytesPerSecond)}
        </span>
      </div>
    )
  }

  if (status === 'downloaded') {
    return (
      <div className="flex items-center gap-3 border-b border-emerald-200 bg-emerald-50 px-4 py-2 text-xs text-emerald-900">
        <RefreshCw className="w-3.5 h-3.5 shrink-0" />
        <span className="flex-1">
          新版本 <span className="font-semibold">v{version}</span> 已下载，重启后生效。
        </span>
        <button
          type="button"
          onClick={() => void run(() => window.designAgent.updates.install())}
          className="cursor-pointer rounded-lg bg-zinc-900 px-3 py-1 text-white"
        >
          立即重启
        </button>
        <button
          type="button"
          onClick={close}
          className="cursor-pointer text-emerald-600 hover:text-emerald-900"
          title="下次退出时自动安装"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-3 border-b border-rose-200 bg-rose-50 px-4 py-2 text-xs text-rose-700">
      <span className="flex-1">检查更新失败：{state.error ?? '未知错误'}</span>
      <button
        type="button"
        disabled={busy}
        onClick={() => void run(() => window.designAgent.updates.check())}
        className="cursor-pointer rounded-lg border border-rose-300 px-3 py-1 hover:bg-rose-100 disabled:opacity-50"
      >
        重试
      </button>
      <button
        type="button"
        onClick={close}
        className="cursor-pointer text-rose-500 hover:text-rose-800"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  )
}
