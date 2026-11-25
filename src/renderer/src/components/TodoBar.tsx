import React from 'react'
import { Check, ChevronDown, Circle, LoaderCircle, Pause } from 'lucide-react'
import clsx from 'clsx'
import type { TodoItem } from '@shared/protocol'

interface TodoBarProps {
  todos: TodoItem[]
  running?: boolean
  attached?: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** 100% 对齐原版 TaskDetail/TodoBar/index.tsx 视觉与状态计算（含零缝贴合态） */
export const TodoBar: React.FC<TodoBarProps> = ({
  todos,
  running = false,
  attached = true,
  open,
  onOpenChange
}) => {
  if (todos.length === 0) return null

  const done = todos.filter((t) => t.status === 'completed').length
  const total = todos.length
  const allDone = done === total
  const inProgressRunning = running ? todos.filter((t) => t.status === 'in_progress').length : 0
  const pct = total ? Math.round(((done + inProgressRunning * 0.5) / total) * 100) : 0

  return (
    <div className={clsx('px-4', attached ? 'pb-0' : 'pb-2.5')}>
      <div
        className={clsx(
          'border border-zinc-200/90 bg-white overflow-hidden transition-colors',
          attached ? 'rounded-t-[20px] rounded-b-none border-b-0' : 'rounded-[20px] shadow-xs'
        )}
      >
        <button
          type="button"
          onClick={() => onOpenChange(!open)}
          aria-expanded={open}
          className="w-full flex items-center gap-2.5 px-4 py-2.5 text-left hover:bg-zinc-50/70 transition-colors cursor-pointer"
        >
          {allDone ? (
            <Check className="w-4 h-4 text-emerald-600 shrink-0" />
          ) : running ? (
            <LoaderCircle className="w-4 h-4 text-blue-600 animate-spin shrink-0" />
          ) : (
            <Pause className="w-4 h-4 text-zinc-400 shrink-0" />
          )}

          <span className="text-[13px] font-medium text-zinc-800">
            {allDone ? '制定计划已完成' : running ? '制定计划进行中' : '制定计划已停止'}
          </span>

          <span className="flex-1" />

          <span className="text-xs tabular-nums text-zinc-400 font-medium">
            {done}/{total}
          </span>

          <ChevronDown
            className={clsx(
              'w-4 h-4 text-zinc-400 transition-transform duration-200',
              open && 'rotate-180'
            )}
          />
        </button>

        {!open && (
          <div className="h-[2px] w-full bg-zinc-100 overflow-hidden">
            <div
              className={clsx(
                'h-full transition-all duration-300',
                allDone ? 'bg-emerald-500' : running ? 'bg-blue-600' : 'bg-zinc-300'
              )}
              style={{ width: `${pct}%` }}
            />
          </div>
        )}

        {open && (
          <div className="border-t border-zinc-100 px-4 py-2.5 space-y-1.5 max-h-52 overflow-y-auto bg-zinc-50/40">
            {todos.map((item, idx) => (
              <div key={idx} className="flex items-start gap-2 text-xs">
                {item.status === 'completed' ? (
                  <Check className="w-3.5 h-3.5 text-emerald-600 mt-0.5 shrink-0" />
                ) : item.status === 'in_progress' && running ? (
                  <LoaderCircle className="w-3.5 h-3.5 text-blue-600 mt-0.5 shrink-0 animate-spin" />
                ) : (
                  <Circle className="w-3.5 h-3.5 text-zinc-300 mt-0.5 shrink-0" />
                )}
                <span
                  className={clsx(
                    item.status === 'completed'
                      ? 'text-zinc-400 line-through'
                      : item.status === 'in_progress'
                        ? 'text-zinc-900 font-medium'
                        : 'text-zinc-600'
                  )}
                >
                  {item.content}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
