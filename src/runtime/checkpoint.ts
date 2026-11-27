import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  AIMessage,
  BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type ToolCall
} from '@langchain/core/messages'
import type { PersistedTurnItem } from '@shared/ipc'
import type { ModelProviderProfile } from '@shared/protocol'
import { createChatModel } from './modelFactory'
import { SYSTEM_PROMPT_CACHE_BREAK } from './prompts'

interface SerializedMsg {
  kind: 'human' | 'ai' | 'system' | 'tool'
  /** 字符串，或原样保存的内容块数组（保留 Anthropic thinking 等非文本块，续跑时接口才不会报错） */
  content: string | unknown[]
  name?: string
  tool_call_id?: string
  tool_calls?: ToolCall[]
  status?: 'success' | 'error'
}

export interface PendingSuspension {
  kind: 'interrupt' | 'ask_user' | 'ask_image_edit'
  toolCallId: string
  toolName: string
  args: Record<string, unknown>
  requestId: string
  turnNum: number
}

interface CheckpointFile {
  threadId: string
  turnCount: number
  updatedAt: number
  messages: SerializedMsg[]
  pendingSuspension?: PendingSuspension
}

function checkpointFilePath(transcriptPath: string): string {
  return join(dirname(transcriptPath), 'runtime-history.json')
}

/** 断点里保留完整内容块；只把图片的 base64 换成占位文字，避免断点文件膨胀 */
function serializeContentBlocks(content: unknown): string | unknown[] {
  if (!Array.isArray(content)) return serializeContent(content)
  return content.map((part) => {
    if (part && typeof part === 'object') {
      const p = part as { type?: string }
      if (p.type === 'image_url' || p.type === 'image') {
        return { type: 'text', text: '[图片内容未保存到断点，如需查看请重新读取原文件]' }
      }
    }
    return part
  })
}

function serializeContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part === 'object' && 'text' in part) {
          return String((part as { text?: unknown }).text ?? '')
        }
        return ''
      })
      .join('')
  }
  return String(content ?? '')
}

export function saveRuntimeCheckpoint(
  transcriptPath: string | undefined,
  threadId: string,
  turnCount: number,
  history: BaseMessage[],
  pendingSuspension?: PendingSuspension
): void {
  if (!transcriptPath) return
  try {
    const filePath = checkpointFilePath(transcriptPath)
    mkdirSync(dirname(filePath), { recursive: true })
    const messages: SerializedMsg[] = []
    for (const msg of history) {
      const kind = msg._getType()
      if (kind === 'human') {
        messages.push({ kind: 'human', content: serializeContentBlocks(msg.content) })
      } else if (kind === 'system') {
        messages.push({ kind: 'system', content: serializeContent(msg.content) })
      } else if (kind === 'ai') {
        const ai = msg as AIMessage
        messages.push({
          kind: 'ai',
          content: serializeContentBlocks(ai.content),
          ...(ai.tool_calls && ai.tool_calls.length > 0 ? { tool_calls: ai.tool_calls } : {})
        })
      } else if (kind === 'tool') {
        const tm = msg as ToolMessage
        messages.push({
          kind: 'tool',
          name: tm.name,
          tool_call_id: tm.tool_call_id,
          content: serializeContentBlocks(tm.content),
          status: tm.status === 'error' ? 'error' : 'success'
        })
      }
    }
    const payload: CheckpointFile = {
      threadId,
      turnCount,
      updatedAt: Date.now(),
      messages,
      ...(pendingSuspension ? { pendingSuspension } : {})
    }
    // 先写临时文件再 rename，避免写到一半崩溃留下半截 JSON
    const tmp = `${filePath}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(payload), 'utf8')
    try {
      renameSync(tmp, filePath)
    } catch {
      writeFileSync(filePath, JSON.stringify(payload), 'utf8')
    }
  } catch (err) {
    console.error('[runtime] 保存断点失败，重启后可能无法从中断处继续：', err)
  }
}

/** 补齐所有被意外中断/未返回 ToolMessage 的孤儿 tool_calls，防止后续续跑报 API 400 错误 */
export function sanitizeHistoryForResume(history: BaseMessage[]): BaseMessage[] {
  const out: BaseMessage[] = []
  for (let i = 0; i < history.length; i++) {
    const msg = history[i]
    out.push(msg)
    if (msg._getType() !== 'ai') continue
    const tcs = (msg as AIMessage).tool_calls ?? []
    if (tcs.length === 0) continue

    const responded = new Set<string>()
    let j = i + 1
    while (j < history.length && history[j]._getType() === 'tool') {
      const tm = history[j] as ToolMessage
      if (tm.tool_call_id) responded.add(tm.tool_call_id)
      j++
    }
    for (const tc of tcs) {
      if (tc.id && !responded.has(tc.id)) {
        out.push(
          new ToolMessage({
            tool_call_id: tc.id,
            name: tc.name,
            content: '本步骤因上次会话中断而暂停；请根据用户指示继续衔接执行。',
            status: 'error'
          })
        )
      }
    }
  }
  return out
}

/**
 * 跨进程重启恢复会话上下文：
 * 1) 优先恢复精细的 runtime-history.json（含完整 tool_calls 与挂起状态）；
 * 2) 若只有旧版 transcript.json，则退化重建人类/助手多轮文本记忆。
 */
export function loadRuntimeCheckpoint(
  transcriptPath: string | undefined
): { history: BaseMessage[]; turnCount: number; pendingSuspension?: PendingSuspension } {
  if (!transcriptPath) return { history: [], turnCount: 0 }

  const cpPath = checkpointFilePath(transcriptPath)
  if (existsSync(cpPath)) {
    try {
      const raw = JSON.parse(readFileSync(cpPath, 'utf8')) as CheckpointFile
      if (Array.isArray(raw.messages)) {
        const out: BaseMessage[] = []
        for (const m of raw.messages) {
          if (m.kind === 'human') out.push(new HumanMessage({ content: m.content as never }))
          else if (m.kind === 'system') out.push(new SystemMessage(serializeContent(m.content)))
          else if (m.kind === 'ai') {
            out.push(
              new AIMessage({
                content: m.content as never,
                ...(m.tool_calls?.length ? { tool_calls: m.tool_calls } : {})
              })
            )
          } else if (m.kind === 'tool') {
            out.push(
              new ToolMessage({
                tool_call_id: m.tool_call_id ?? 'restored',
                name: m.name ?? 'tool',
                content: m.content as never,
                status: m.status === 'error' ? 'error' : undefined
              })
            )
          }
        }
        return {
          history: out,
          turnCount: raw.turnCount || 0,
          pendingSuspension: raw.pendingSuspension
        }
      }
    } catch {
      // fallback to transcript
    }
  }

  if (existsSync(transcriptPath)) {
    try {
      const items = JSON.parse(readFileSync(transcriptPath, 'utf8')) as PersistedTurnItem[]
      const out: BaseMessage[] = []
      let turns = 0
      for (const it of items) {
        if (it.role === 'user' && it.text.trim()) {
          out.push(new HumanMessage(it.text))
          turns++
        } else if (it.role === 'assistant' && it.content.trim()) {
          const delivNote =
            it.deliverables?.length > 0
              ? `\n[本轮交付成品：${it.deliverables.map((d) => d.title).join('、')}]`
              : ''
          out.push(new AIMessage(`${it.content}${delivNote}`))
        }
      }
      return { history: out, turnCount: turns }
    } catch {
      // ignore
    }
  }

  return { history: [], turnCount: 0 }
}

export const LARGE_TOOL_OUTPUT_CHARS = 7500

/**
 * 大工具结果自动外置到 `<rootDir>/.design-agent/tool-results/`，仅向模型返回预览与路径，避免长输出撑爆上下文。
 */
export function offloadLargeToolOutput(params: {
  rootDir: string
  toolCallId: string
  toolName: string
  output: unknown
}): unknown {
  if (typeof params.output !== 'string') return params.output
  const raw = params.output
  if (raw.length <= LARGE_TOOL_OUTPUT_CHARS) return raw
  if (params.toolName === 'read_file' && raw.includes('.design-agent/tool-results/')) {
    return raw
  }

  const dir = join(params.rootDir, '.design-agent', 'tool-results')
  mkdirSync(dir, { recursive: true })
  const safeName = params.toolName.replace(/[^a-zA-Z0-9_-]/g, '_') || 'tool'
  const safeId = params.toolCallId.replace(/[^a-zA-Z0-9_-]/g, '_') || `${Date.now()}`
  const filePath = join(dir, `${safeName}_${safeId}.txt`)
  writeFileSync(filePath, raw, 'utf8')

  const totalLines = raw.split(/\r?\n/).length
  const head = raw.slice(0, 1400)
  const tail = raw.slice(-700)
  const normPath = filePath.replace(/\\/g, '/')

  return [
    `[系统提示：工具 "${params.toolName}" 返回结果过长（共 ${raw.length} 字符 / ${totalLines} 行），已自动外置保存至：${normPath}]`,
    '如需查看完整或指定行区间内容，请用 `read_file` 传入该路径与 `start_line` / `end_line` 读取，或用 `grep` 检索。',
    '',
    '--- 头部预览 (前 1400 字符) ---',
    head,
    '',
    '--- 尾部预览 (后 700 字符) ---',
    tail
  ].join('\n')
}

/**
 * OpenAI Chat Completions 的 tool 消息只接受文本块，带 image 块会被网关 400。
 * Anthropic 与 Responses API 支持原生图片，保持原样。
 */
export function degradeToolImageBlocks(content: unknown, keepImages: boolean): unknown {
  if (keepImages || !Array.isArray(content)) return content
  let degraded = false
  const parts = content.map((part) => {
    const type = (part as { type?: string } | null)?.type
    if (type === 'image_url' || type === 'image') {
      degraded = true
      return { type: 'text', text: '[图片内容已读取，但当前模型接口不支持在工具结果中返回图片]' }
    }
    return part
  })
  return degraded ? parts : content
}

/** 从工具结果里摘出图片块，留一个文字占位，等所有工具结果写完后作为用户消息补发 */
export function splitToolImageBlocks(content: unknown): { content: unknown; images: unknown[] } {
  if (!Array.isArray(content)) return { content, images: [] }
  const images: unknown[] = []
  const parts = content.map((part) => {
    const type = (part as { type?: string } | null)?.type
    if (type === 'image_url' || type === 'image') {
      images.push(part)
      return { type: 'text', text: '[图片见紧随其后的消息]' }
    }
    return part
  })
  return images.length ? { content: parts, images } : { content, images: [] }
}

export function buildSystemMessage(systemPrompt: string, enableAnthropicCache: boolean): SystemMessage {
  const breakIdx = systemPrompt.indexOf(SYSTEM_PROMPT_CACHE_BREAK)
  const staticPart = (breakIdx >= 0 ? systemPrompt.slice(0, breakIdx) : systemPrompt).trim()
  const dynamicPart = breakIdx >= 0 ? systemPrompt.slice(breakIdx + SYSTEM_PROMPT_CACHE_BREAK.length).trim() : ''
  if (!enableAnthropicCache) {
    return new SystemMessage(dynamicPart ? `${staticPart}\n\n${dynamicPart}` : staticPart)
  }
  // 只给固定部分打缓存断点；每轮变化的部分放在断点之后，不会让整段缓存失效
  const blocks: Array<Record<string, unknown>> = [
    { type: 'text', text: staticPart, cache_control: { type: 'ephemeral' } }
  ]
  if (dynamicPart) blocks.push({ type: 'text', text: dynamicPart })
  return new SystemMessage({ content: blocks as unknown as string })
}

function estimateContentWeightChars(content: unknown): number {
  if (typeof content === 'string') return content.length
  if (Array.isArray(content)) {
    let total = 0
    for (const part of content) {
      if (typeof part === 'string') total += part.length
      else if (part && typeof part === 'object') {
        const p = part as { type?: string; text?: unknown }
        if (p.type === 'image_url') {
          // 单张视觉图片按约 1500~2000 tokens (~4000 chars) 计入上下文压力预算
          total += 4000
        } else if ('text' in p) {
          total += String(p.text ?? '').length
        }
      }
    }
    return total
  }
  return String(content ?? '').length
}

export function estimateMessagesTokens(systemPrompt: string, history: BaseMessage[]): number {
  let chars = systemPrompt.length
  for (const m of history) {
    chars += estimateContentWeightChars(m.content) + 40
    if (m._getType() === 'ai') {
      const tc = (m as AIMessage).tool_calls
      if (tc?.length) chars += JSON.stringify(tc).length
    }
  }
  // 中文与混合 JSON 偏保守估算 ~2.2 chars/token
  return Math.ceil(chars / 2.2)
}

/**
 * 选择压缩切分点：尽量保留最近 keepHumanTurns 轮完整对话（从倒数第 N 条用户消息开始保留），
 * 切分点总落在用户消息上，保证保留段不会以 AI / 工具消息开头，也不会拆散工具调用与其结果。
 */
function findSafeSplitIndex(history: BaseMessage[], keepHumanTurns: number, maxKeepTokens: number): number {
  const humanIdx: number[] = []
  for (let i = 0; i < history.length; i++) {
    if (history[i]._getType() !== 'human') continue
    // 工具图片转交消息不是用户的一轮对话，不算进“保留最近几轮”，也不能作为切分点
    const c = history[i].content as unknown
    const first = Array.isArray(c) ? (c[0] as { text?: unknown } | undefined)?.text : c
    if (typeof first === 'string' && first.startsWith('[系统转交]')) continue
    humanIdx.push(i)
  }
  if (humanIdx.length === 0) return 0
  for (let k = Math.min(keepHumanTurns, humanIdx.length); k >= 1; k--) {
    const idx = humanIdx[humanIdx.length - k]
    if (k === 1 || estimateMessagesTokens('', history.slice(idx)) <= maxKeepTokens) return idx
  }
  return humanIdx[humanIdx.length - 1]
}

/**
 * 长对话上下文自动压缩（对齐原版 SummarizationMiddleware）：
 * 将早期消息归档到 `.design-agent/history-archive/` 并用大模型（失败则启发式）浓缩为摘要 SystemMessage。
 * 只按 Token 触发（上下文窗口的 65%），至少保留最近 3 轮完整对话；上一次的摘要会完整带入新摘要，避免层层截断丢失约束。
 */
export async function compactHistoryIfNeeded(params: {
  rootDir: string
  systemPrompt: string
  history: BaseMessage[]
  profile: ModelProviderProfile
  force?: boolean
}): Promise<{ compacted: boolean; archivePath?: string; summaryText?: string }> {
  const ctxLimit = params.profile.contextWindowTokens ?? 64000
  const triggerTokens = Math.floor(ctxLimit * 0.65)
  const est = estimateMessagesTokens(params.systemPrompt, params.history)

  if (!params.force && est < triggerTokens) {
    return { compacted: false }
  }
  if (params.history.length <= 6) {
    return { compacted: false }
  }

  const splitIdx = findSafeSplitIndex(params.history, 3, Math.floor(ctxLimit * 0.35))
  if (splitIdx <= 1) return { compacted: false }

  const older = params.history.slice(0, splitIdx)
  const kept = params.history.slice(splitIdx)

  // 1. 完整归档早期消息到工作区，模型如有需要仍可通过 read_file 找回
  const archiveDir = join(params.rootDir, '.design-agent', 'history-archive')
  mkdirSync(archiveDir, { recursive: true })
  const archivePath = join(archiveDir, `compact_${Date.now()}.md`)
  const archiveBody = older
    .map((m, idx) => `## [${idx + 1}] ${m._getType().toUpperCase()}\n${serializeContent(m.content)}`)
    .join('\n\n---\n\n')
  writeFileSync(archivePath, archiveBody, 'utf8')

  // 2. 压缩生成摘要
  // 上一次的摘要（SystemMessage）完整带入，其余消息截取要点
  const previousSummaries = older
    .filter((m) => m._getType() === 'system')
    .map((m) => serializeContent(m.content))
    .join('\n\n')
  const digestBody = older
    .filter((m) => m._getType() !== 'system')
    .map((m) => `${m._getType()}: ${serializeContent(m.content).slice(0, 1200)}`)
    .join('\n')
  const digestInput = [
    previousSummaries ? `【此前的压缩摘要，须完整保留其中的约束与决策】\n${previousSummaries.slice(0, 8000)}` : '',
    `【新增的历史消息】\n${digestBody.slice(-24000)}`
  ]
    .filter(Boolean)
    .join('\n\n')

  let summary = ''
  try {
    const model = createChatModel(params.profile, { thinking: false, isSubagent: true })
    const res = await Promise.race([
      model.invoke([
        new SystemMessage(
          '你是上下文压缩器。请将以下历史对话精炼为结构化摘要（300~600字），保留所有已确认的尺寸/标高/风格/规范约束、已生成或交付的文件路径、以及尚未完成的待办事项。'
        ),
        new HumanMessage(digestInput)
      ]),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('compact-timeout')), 15000))
    ])
    summary = serializeContent(res.content).trim()
  } catch {
    summary = older
      .filter((m) => m._getType() === 'human' || m._getType() === 'ai')
      .slice(-8)
      .map((m) => `- [${m._getType()}] ${serializeContent(m.content).slice(0, 180)}`)
      .join('\n')
  }

  const summaryMsg = new SystemMessage(
    `<context-summary archive="${archivePath.replace(/\\/g, '/')}">\n前序 ${older.length} 条历史消息已自动压缩归档。核心摘要如下（如需完整原文可用 read_file 查看归档文件）：\n${summary}\n</context-summary>`
  )

  params.history.splice(0, params.history.length, summaryMsg, ...kept)
  return { compacted: true, archivePath, summaryText: summary }
}
