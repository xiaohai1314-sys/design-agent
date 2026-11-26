import React, { useState } from 'react'
import {
  Activity,
  CheckCircle2,
  Download,
  LoaderCircle,
  Plug,
  RefreshCw,
  XCircle
} from 'lucide-react'
import clsx from 'clsx'
import type { McpConnectorInfo } from '@shared/ipc'

interface McpConnectorPopoverProps {
  connectors: McpConnectorInfo[]
  onToggle: (name: string, enabled: boolean) => Promise<void>
  onRefresh: () => Promise<void>
}

export const McpConnectorPopover: React.FC<McpConnectorPopoverProps> = ({
  connectors,
  onToggle,
  onRefresh
}) => {
  const [open, setOpen] = useState(false)
  const [checkingName, setCheckingName] = useState<string | null>(null)
  const [installingName, setInstallingName] = useState<string | null>(null)
  const [actionMsg, setActionMsg] = useState<Record<string, { ok: boolean; text: string }>>({})

  const enabledCount = connectors.filter((c) => c.enabled).length

  const handleCheck = async (name: string): Promise<void> => {
    setCheckingName(name)
    try {
      const res = await window.designAgent.mcp.checkConnection(name)
      setActionMsg((prev) => ({
        ...prev,
        [name]: res.ok
          ? { ok: true, text: `握手成功 (${res.toolCount ?? 0} 个工具)` }
          : { ok: false, text: res.reason || '连接失败' }
      }))
    } finally {
      setCheckingName(null)
    }
  }

  const handleInstall = async (name: string): Promise<void> => {
    setInstallingName(name)
    try {
      const res = await window.designAgent.mcp.installPlugin(name)
      setActionMsg((prev) => ({
        ...prev,
        [name]: { ok: res.ok, text: res.message }
      }))
      await onRefresh()
    } finally {
      setInstallingName(null)
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => {
          const next = !open
          setOpen(next)
          if (next) void onRefresh()
        }}
        className={clsx(
          'inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs border transition-colors cursor-pointer',
          enabledCount > 0
            ? 'border-emerald-300 bg-emerald-50 text-emerald-800 font-medium'
            : 'border-zinc-200 text-zinc-600 hover:bg-zinc-100'
        )}
      >
        <Plug className="w-3.5 h-3.5" />
        <span>软件连接器{enabledCount > 0 ? ` (${enabledCount})` : ''}</span>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute left-0 bottom-9 z-40 w-[420px] rounded-2xl border border-zinc-200 bg-white shadow-xl p-3 space-y-2">
            <div className="flex items-center justify-between pb-2 border-b border-zinc-100">
              <div>
                <div className="text-xs font-semibold text-zinc-900">本机设计软件 MCP 连接器</div>
                <div className="text-[11px] text-zinc-400">
                  支持一键铺设宿主插件，启用后智能体可直接控制对应软件
                </div>
              </div>
              <button
                type="button"
                onClick={() => void onRefresh()}
                title="刷新宿主软件运行状态"
                className="p-1.5 rounded-lg text-zinc-500 hover:bg-zinc-100 cursor-pointer"
              >
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className="max-h-80 overflow-y-auto divide-y divide-zinc-100">
              {connectors.map((c) => {
                const msg = actionMsg[c.name]
                return (
                  <div key={c.name} className="py-2.5 flex items-start justify-between gap-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs font-semibold text-zinc-900">{c.label}</span>
                        <span className="text-[10px] text-zinc-400">{c.requirement}</span>
                      </div>
                      <div className="text-[11px] text-zinc-500 mt-0.5 flex items-center gap-1.5">
                        <span
                          className={clsx(
                            'w-1.5 h-1.5 rounded-full shrink-0',
                            c.hostRunning
                              ? 'bg-emerald-500'
                              : c.available
                                ? 'bg-amber-400'
                                : 'bg-zinc-300'
                          )}
                        />
                        <span className="truncate">{c.statusText}</span>
                      </div>
                      {msg && (
                        <div
                          className={clsx(
                            'mt-1 flex items-start gap-1 text-[10px] leading-snug',
                            msg.ok ? 'text-emerald-600' : 'text-rose-600'
                          )}
                        >
                          {msg.ok ? (
                            <CheckCircle2 className="w-3 h-3 shrink-0 mt-0.5" />
                          ) : (
                            <XCircle className="w-3 h-3 shrink-0 mt-0.5" />
                          )}
                          <span>{msg.text}</span>
                        </div>
                      )}
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0 pt-0.5">
                      {c.canInstallPlugin && (
                        <button
                          type="button"
                          disabled={installingName === c.name}
                          onClick={() => void handleInstall(c.name)}
                          className={clsx(
                            'inline-flex items-center gap-1 px-2 py-1 rounded-md border text-[11px] cursor-pointer',
                            c.pluginInstalled
                              ? 'border-zinc-200 text-zinc-600 hover:bg-zinc-50'
                              : 'border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100'
                          )}
                          title={c.pluginInstalled ? '重新安装或更新宿主插件' : '一键安装插件到本机设计软件'}
                        >
                          {installingName === c.name ? (
                            <LoaderCircle className="w-3 h-3 animate-spin" />
                          ) : (
                            <Download className="w-3 h-3" />
                          )}
                          <span>{c.pluginInstalled ? '重装插件' : '安装插件'}</span>
                        </button>
                      )}

                      {c.available && (
                        <button
                          type="button"
                          disabled={checkingName === c.name}
                          onClick={() => void handleCheck(c.name)}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-zinc-200 text-[11px] text-zinc-600 hover:bg-zinc-50 cursor-pointer"
                        >
                          {checkingName === c.name ? (
                            <LoaderCircle className="w-3 h-3 animate-spin" />
                          ) : (
                            <Activity className="w-3 h-3" />
                          )}
                          <span>检测</span>
                        </button>
                      )}

                      <input
                        type="checkbox"
                        disabled={!c.available}
                        checked={c.enabled}
                        onChange={(e) => void onToggle(c.name, e.target.checked)}
                        className="w-4 h-4 rounded accent-blue-600 cursor-pointer disabled:opacity-35"
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
