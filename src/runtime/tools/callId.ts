/**
 * 统一获取当前工具调用的 ID。
 * runAgentLoop 以 `invoke(args, { configurable: { toolCallId } })` 调用工具，
 * LangChain 会把这份 config 作为 func 的第三个参数传入；以 ToolCall 方式调用时则在 `config.toolCall.id`。
 * 取不到时返回空字符串，由调用方回退到当前活动调用。
 */
export function resolveToolCallId(runManager?: unknown, config?: unknown): string {
  const cfg = config as
    | { configurable?: { toolCallId?: unknown }; toolCall?: { id?: unknown } }
    | undefined
  const fromConfig = cfg?.configurable?.toolCallId ?? cfg?.toolCall?.id
  if (typeof fromConfig === 'string' && fromConfig) return fromConfig
  const rm = runManager as
    | { toolCallId?: unknown; configurable?: { toolCallId?: unknown } }
    | undefined
  const fromRunManager = rm?.toolCallId ?? rm?.configurable?.toolCallId
  return typeof fromRunManager === 'string' ? fromRunManager : ''
}
