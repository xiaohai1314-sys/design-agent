import React from 'react'
import { ShieldAlert } from 'lucide-react'
import type { AgentDecision, AgentToolAction } from '@shared/protocol'

interface InterruptCardProps {
  message: string
  delta?: string
  actions: AgentToolAction[]
  onDecide: (decision: AgentDecision) => void
}

/** 100% 对齐原版 TaskDetail/InterruptCard/index.tsx：拒绝 / 允许 / 始终允许 */
export const InterruptCard: React.FC<InterruptCardProps> = ({
  message,
  delta,
  actions,
  onDecide
}) => {
  const label = message || actions[0]?.name || '该操作'

  return (
    <div className="px-4 pb-2.5">
      <div className="rounded-xl border border-amber-200 bg-amber-50/70 shadow-sm px-4 py-3">
        <div className="flex items-center gap-2 mb-2">
          <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" aria-hidden="true" />
          <ShieldAlert className="w-4 h-4 text-amber-600" />
          <span className="text-xs font-semibold text-zinc-900">允许智能体执行？</span>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div
            className="min-w-0 flex-1 flex items-center gap-2 text-xs bg-white/90 border border-amber-200/80 rounded-lg px-3 py-2"
            title={delta ? `${label} ${delta}` : label}
          >
            <span className="font-semibold text-zinc-800 shrink-0">{label}</span>
            {delta && (
              <span className="font-mono text-zinc-600 truncate">{delta}</span>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => onDecide({ type: 'reject', message: '用户拒绝了该操作' })}
              className="px-3 py-1.5 rounded-lg text-xs font-medium border border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-100 cursor-pointer transition-colors"
            >
              拒绝
            </button>
            <button
              type="button"
              onClick={() => onDecide({ type: 'approve', scope: 'once' })}
              className="px-3.5 py-1.5 rounded-lg text-xs font-medium bg-zinc-900 text-white hover:bg-zinc-800 cursor-pointer transition-colors"
            >
              允许
            </button>
            <button
              type="button"
              onClick={() => onDecide({ type: 'approve', scope: 'all' })}
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-blue-600 text-white hover:bg-blue-700 cursor-pointer transition-colors"
              title="批准本次操作并将全局权限切换为自动允许"
            >
              始终允许
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
