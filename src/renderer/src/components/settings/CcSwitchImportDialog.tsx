import { Activity, LoaderCircle, Search, X } from 'lucide-react'
import clsx from 'clsx'
import type { CcSwitchCandidate } from '@shared/ipc'
import type { ModelProviderProfile } from '@shared/protocol'
import type { ProbeResultState } from './types'

export interface CcSwitchImportDialogProps {
  candidates: CcSwitchCandidate[]
  checked: Record<string, boolean>
  setChecked: React.Dispatch<React.SetStateAction<Record<string, boolean>>>
  search: string
  onSearchChange: (value: string) => void
  error: string | null
  loading: boolean
  probes: Record<string, ProbeResultState>
  profiles: ModelProviderProfile[]
  onClose: () => void
  onProbeCandidate: (candidate: CcSwitchCandidate) => void
  onProbeChecked: () => void
  onConfirm: () => void
}

/** 从 CC Switch / Claude Code / Codex 本机配置中选择导入的浮层 */
export function CcSwitchImportDialog({
  candidates,
  checked,
  setChecked,
  search,
  onSearchChange,
  error,
  loading,
  probes,
  profiles,
  onClose,
  onProbeCandidate,
  onProbeChecked,
  onConfirm
}: CcSwitchImportDialogProps): React.JSX.Element {
  const checkedCount = Object.values(checked).filter(Boolean).length

  return (
    <div className="absolute inset-0 z-10 bg-black/45 flex items-center justify-center p-4">
      <div className="w-full max-w-2xl max-h-[82vh] rounded-2xl bg-white border border-zinc-200 shadow-2xl flex flex-col overflow-hidden text-xs">
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-200 bg-zinc-50">
          <div>
            <h3 className="text-sm font-semibold text-zinc-900">
              从 CC Switch / Claude / Codex 选择导入节点
            </h3>
            <p className="text-[11px] text-zinc-500 mt-0.5">
              仅读取本机配置（绝不修改原库）；可先「测活」筛掉失效中转，再勾选需要的节点导入。
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-700 hover:bg-zinc-200/60 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-4 py-2.5 border-b border-zinc-200 flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-44">
            <Search className="w-3.5 h-3.5 text-zinc-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder="搜索节点名、地址、模型（如 gemini / wb / custom）"
              className="w-full pl-8 pr-3 py-1.5 rounded-lg border border-zinc-200 outline-none focus:border-blue-500"
            />
          </div>
          <button
            type="button"
            onClick={() => {
              const next: Record<string, boolean> = {}
              for (const c of candidates) {
                if (c.isCurrent) next[c.uid] = true
              }
              setChecked(next)
            }}
            className="px-2.5 py-1.5 rounded-lg border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50 cursor-pointer"
          >
            仅选当前激活
          </button>
          <button
            type="button"
            onClick={() => setChecked({})}
            className="px-2.5 py-1.5 rounded-lg border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50 cursor-pointer"
          >
            清空选择
          </button>
          <button
            type="button"
            disabled={checkedCount === 0}
            onClick={onProbeChecked}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 disabled:opacity-40 cursor-pointer"
          >
            <Activity className="w-3.5 h-3.5" />
            <span>测活已勾选项</span>
          </button>
        </div>

        {error && (
          <div className="mx-4 mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
            {error}
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {loading ? (
            <div className="py-12 flex items-center justify-center gap-2 text-zinc-500">
              <LoaderCircle className="w-4 h-4 animate-spin text-blue-600" />
              <span>正在扫描本机 CC Switch / Claude / Codex 节点…</span>
            </div>
          ) : candidates.length === 0 ? (
            <div className="py-12 text-center text-zinc-500">
              未在当前用户目录下检测到 CC Switch、Claude Code 或 Codex 配置。
            </div>
          ) : (
            candidates
              .filter((c) => {
                const q = search.trim().toLowerCase()
                if (!q) return true
                return (
                  c.name.toLowerCase().includes(q) ||
                  c.baseUrl.toLowerCase().includes(q) ||
                  c.model.toLowerCase().includes(q) ||
                  c.appType.toLowerCase().includes(q)
                )
              })
              .map((c) => {
                const isChecked = Boolean(checked[c.uid])
                const probe = probes[c.uid]
                const alreadyAdded = profiles.some(
                  (p) =>
                    p.id === `cc_${c.uid.replace(/[^a-zA-Z0-9_-]/g, '_')}` ||
                    (p.label === c.name &&
                      p.baseUrl.replace(/\/+$/, '') === c.baseUrl.replace(/\/+$/, ''))
                )
                return (
                  <div
                    key={c.uid}
                    className={clsx(
                      'rounded-xl border p-3 transition-colors flex items-start gap-3',
                      isChecked
                        ? 'border-blue-400 bg-blue-50/40'
                        : 'border-zinc-200 bg-white hover:border-zinc-300'
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onChange={(e) =>
                        setChecked((prev) => ({ ...prev, [c.uid]: e.target.checked }))
                      }
                      className="mt-1 w-4 h-4 rounded accent-blue-600 cursor-pointer shrink-0"
                    />
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-semibold text-zinc-900">{c.name}</span>
                        <span className="px-1.5 py-0.5 rounded bg-zinc-100 text-[10px] text-zinc-600 font-mono">
                          {c.appType}
                        </span>
                        <span className="px-1.5 py-0.5 rounded bg-slate-100 text-[10px] text-slate-700">
                          {c.protocol === 'anthropic' ? 'Anthropic' : 'OpenAI 兼容'}
                        </span>
                        {c.isCurrent && (
                          <span className="px-1.5 py-0.5 rounded bg-emerald-100 text-[10px] font-medium text-emerald-700">
                            当前正在用
                          </span>
                        )}
                        {c.isHealthy === false && (
                          <span
                            className="px-1.5 py-0.5 rounded bg-rose-100 text-[10px] text-rose-700"
                            title={c.lastError || 'CC Switch 记录近期存在失败'}
                          >
                            历史失败
                          </span>
                        )}
                        {alreadyAdded && (
                          <span className="px-1.5 py-0.5 rounded bg-amber-100 text-[10px] text-amber-800">
                            列表已有
                          </span>
                        )}
                      </div>
                      <div
                        className="text-[11px] font-mono text-zinc-500 truncate"
                        title={c.baseUrl}
                      >
                        {c.baseUrl} · {c.model} · Key: {c.maskedKey}
                      </div>
                      {probe && probe.status !== 'testing' && (
                        <div
                          className={clsx(
                            'text-[11px]',
                            probe.status === 'ok' ? 'text-emerald-700' : 'text-rose-600'
                          )}
                        >
                          {probe.status === 'ok'
                            ? `✅ 可用 (${probe.latencyMs}ms)${probe.message ? ` · ${probe.message}` : ''}`
                            : `❌ 不可用 (${probe.latencyMs}ms)：${probe.message || '连接失败'}`}
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      disabled={probe?.status === 'testing'}
                      onClick={() => onProbeCandidate(c)}
                      className="shrink-0 px-2.5 py-1 rounded-lg border border-zinc-200 bg-white text-[11px] text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 cursor-pointer"
                    >
                      {probe?.status === 'testing' ? '测活中…' : '测活'}
                    </button>
                  </div>
                )
              })
          )}
        </div>

        <div className="px-4 py-3 border-t border-zinc-200 bg-zinc-50 flex items-center justify-between">
          <span className="text-zinc-500">
            共扫描到 {candidates.length} 个配置，已勾选{' '}
            <strong className="text-zinc-900">{checkedCount}</strong> 个
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3.5 py-1.5 rounded-lg border border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-100 cursor-pointer"
            >
              取消
            </button>
            <button
              type="button"
              disabled={checkedCount === 0}
              onClick={onConfirm}
              className="px-4 py-1.5 rounded-lg bg-zinc-900 text-white font-medium hover:bg-zinc-800 disabled:opacity-40 cursor-pointer"
            >
              确认导入所选 ({checkedCount})
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
