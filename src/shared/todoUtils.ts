import type { PersistedTurnItem } from './ipc'
import type { TodoItem } from './protocol'

/**
 * 当任务自然完成（done）而模型未补调最后一次 write_todos 时，
 * 将仍停留在 pending/in_progress 的计划项收口为 completed，避免界面误报「已停止」。
 */
export function settleCompletedTodos(todos: TodoItem[]): TodoItem[] {
  return todos.map((item) =>
    item.status === 'completed' ? item : { ...item, status: 'completed' }
  )
}

/**
 * 仅当上一轮因中断/报错结束且仍有未完成步骤时（如 80 步自动中断后点「从中断处继续」），
 * 继承该未完成计划进度；若上一轮已自然完成，则返回空数组以免跨轮残留旧计划。
 */
export function inheritInterruptedTodos(turns: PersistedTurnItem[]): TodoItem[] {
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]
    if (t.role === 'assistant') {
      if (
        (t.status === 'aborted' || t.status === 'error') &&
        t.todos.some((td) => td.status !== 'completed')
      ) {
        return t.todos.map((td) => ({ ...td }))
      }
      return []
    }
  }
  return []
}
