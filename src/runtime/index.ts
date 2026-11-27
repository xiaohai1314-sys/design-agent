import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages'
import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import type {
  AgentDecision,
  AskAnswer,
  AskQuestion,
  ConversationRef,
  Deliverable,
  ImageEditAnswer,
  InputFile,
  ModelAnnotationRef,
  ModelProviderProfile,
  PermissionMode,
  PptProposal,
  PptWorkbenchSelection,
  RuntimeInbound,
  RuntimeOutbound,
  SceneParam,
  TodoItem,
  TurnUsageStats
} from '@shared/protocol'
import type { SelectedMcpConnector } from '@shared/mcp'
import { createChatModel } from './modelFactory'
import { buildSupervisorSystemPrompt, discoverSkills } from './prompts'
import {
  buildModelingPresetDirective,
  discoverModelingPresets,
  matchModelingPreset,
  resolvePresetsRoot,
  type ModelingPresetInfo
} from './presets'
import { approvalDelta, splitMcpToolName, toolDelta, toolLabel } from './toolMeta'
import { createDeliverTool } from './tools/deliver'
import { createAskUserTool, formatAnswersForModel } from './tools/askUser'
import { createWorkspaceTools } from './tools/workspaceTools'
import { createImageTools, hasImageGenCapability, isVisionCapableModel, resolveVisionProfile } from './tools/imageTools'
import { createLocalRegulationTool } from './tools/regulationTool'
import { createSearchInspirationTool } from './tools/inspirationTool'
import { createWebSearchTool } from './tools/webSearchTool'
import { createPptWorkbenchTool } from './tools/pptWorkbenchTool'
import {
  createAsyncSubagentTools,
  selectToolsForSubagentRole,
  type UsageDelta
} from './tools/asyncSubagents'
import {
  checkSingleMcpServer,
  connectMcpServers,
  createDeferredMcpTools
} from './tools/mcpBridge'
import {
  buildSystemMessage,
  compactHistoryIfNeeded,
  degradeToolImageBlocks,
  loadRuntimeCheckpoint,
  offloadLargeToolOutput,
  sanitizeHistoryForResume,
  saveRuntimeCheckpoint,
  splitToolImageBlocks,
  type PendingSuspension
} from './checkpoint'
import { distillProjectMemory, generateNextSuggestions } from './distiller'
import { resolveToolCallId } from './tools/callId'
import { createProjectProfileTool } from './tools/projectProfileTool'
import { createImageReviewTool } from './tools/imageReviewTool'
import { createImageDescriber } from './tools/imageDescribe'
import { loadProjectProfile, projectProfilePath, summarizeProfile } from './projectProfile'

const parentPort = (
  process as unknown as {
    parentPort?: {
      on: (ev: string, fn: (e: { data: RuntimeInbound }) => void) => void
      postMessage: (msg: RuntimeOutbound) => void
    }
  }
).parentPort

process.on('unhandledRejection', (reason) => {
  console.error('[runtime] unhandledRejection:', reason)
})
process.on('uncaughtException', (err) => {
  console.error('[runtime] uncaughtException:', err)
})

function lastAiText(history: BaseMessage[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]
    if (m._getType() !== 'ai') continue
    const c = m.content as unknown
    const text =
      typeof c === 'string'
        ? c
        : Array.isArray(c)
          ? c
              .map((part) =>
                part && typeof part === 'object' && (part as { type?: string }).type === 'text'
                  ? String((part as { text?: unknown }).text ?? '')
                  : ''
              )
              .join('')
          : ''
    if (text.trim()) return text.trim()
  }
  return ''
}

function post(msg: RuntimeOutbound): void {
  if (parentPort) {
    parentPort.postMessage(msg)
  } else if (typeof process.send === 'function') {
    process.send(msg)
  }
}

function onInbound(handler: (msg: RuntimeInbound) => void): void {
  if (parentPort) {
    parentPort.on('message', (e) => handler(e.data))
  } else {
    process.on('message', (msg: unknown) => {
      if (msg && typeof msg === 'object' && 'type' in msg) {
        handler(msg as RuntimeInbound)
      }
    })
  }
}

interface PendingApproval {
  resolve: (decision: AgentDecision) => void
  reject: (err: Error) => void
}

interface PendingClarification {
  resolve: (answers: AskAnswer[]) => void
  reject: (err: Error) => void
}

interface PendingImageEdit {
  id: string
  resolve: (answer: ImageEditAnswer) => void
  reject: (err: Error) => void
}

interface ActiveTurnState {
  requestId: string
  threadId: string
  abortController: AbortController
  pendingApproval: PendingApproval | null
  pendingClarification: PendingClarification | null
  pendingImageEdit: PendingImageEdit | null
  deliverables: Deliverable[]
  /** 本轮权限模式：「全部允许」只提升当前这一轮，不影响其他会话 */
  permissionMode: PermissionMode
}

let globalPermissionMode: PermissionMode = 'default'
const conversationHistories = new Map<string, BaseMessage[]>()
const turnCounters = new Map<string, number>()
const activeTurns = new Map<string, ActiveTurnState>()

class PermissionRejectedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PermissionRejectedError'
  }
}

function detectExtraRuntimePaths(): string[] {
  const candidates: string[] = []
  const envRt = process.env.DESIGN_AGENT_RT_DIR
  if (envRt) {
    candidates.push(envRt, join(envRt, 'python'), join(envRt, 'python', 'Scripts'), join(envRt, 'node'))
  }
  const appData = process.env.APPDATA
  if (appData) {
    const existingRuntime = join(appData, '@design-agent', 'agent-desktop', 'agent-runtime')
    if (existsSync(existingRuntime)) {
      candidates.push(
        existingRuntime,
        join(existingRuntime, 'python'),
        join(existingRuntime, 'python', 'Scripts'),
        join(existingRuntime, 'node')
      )
    }
  }
  const cadVendor = join(process.env.DESIGN_AGENT_SKILLS_ROOT ?? '', 'cad', 'vendor', 'win64')
  if (existsSync(cadVendor)) candidates.push(cadVendor)
  return candidates.filter((p) => existsSync(p))
}

function findPythonExe(extraPaths: string[]): string {
  for (const dir of extraPaths) {
    const py = join(dir, 'python.exe')
    if (existsSync(py)) return py
  }
  return 'python'
}

function describeAnnotations(annotations?: ModelAnnotationRef[]): string {
  if (!annotations?.length) return ''
  const entries: string[] = []
  for (const item of annotations) {
    const body = item.text.replace(/</g, '＜').replace(/>/g, '＞').trim()
    if (!body) continue
    const meta = JSON.stringify({
      title: item.title.trim() || item.path,
      path: item.path,
      count: item.count
    })
      .replace(/</g, '\\u003c')
      .replace(/>/g, '\\u003e')
    entries.push(`<annotation>\n${meta}\n${body}\n</annotation>`)
  }
  return entries.length > 0 ? `<annotations>\n${entries.join('\n')}\n</annotations>` : ''
}

/** 对齐原版 describeConversationRefs 格式：注入引用的历史对话路径供模型按需 read_file */
function describeConversationRefs(refs?: ConversationRef[]): string {
  if (!refs?.length) return ''
  const entries: string[] = []
  for (const item of refs) {
    const p = (item.path ?? '').trim()
    if (!p) continue
    const title = (item.title ?? '').trim() || '未命名对话'
    const meta = JSON.stringify({ title, path: p })
      .replace(/</g, '\\u003c')
      .replace(/>/g, '\\u003e')
    entries.push(
      `<conversation>\n${meta}\n用户附上了一段之前的历史对话记录，供你了解此前的需求、讨论结论与产出，在此基础上继续。\n请按需使用 read_file 或 grep 检索，不必通读；它是只读的历史记录，不要修改。\n</conversation>`
    )
  }
  return entries.length > 0 ? `<conversations>\n${entries.join('\n')}\n</conversations>` : ''
}

/** P9：插进标签属性的值转义尖括号、引号与 & */
function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 插进标签正文的用户文本：与 annotations 一致，用全角尖括号替换，避免伪造标签 */
function escapeTagBody(value: string): string {
  return value.replace(/</g, '＜').replace(/>/g, '＞')
}

function formatUserMessageWithContext(params: {
  text: string
  filelist?: InputFile[]
  annotations?: ModelAnnotationRef[]
  conversationRefs?: ConversationRef[]
  pptSelection?: PptWorkbenchSelection
  sceneParam?: SceneParam
  mcp?: SelectedMcpConnector[]
  mcpStatusBlocks?: string[]
  presetDirective?: string
}): string {
  const blocks: string[] = [params.text.trim()]

  if (params.sceneParam?.toolTitle || params.sceneParam?.paramValues) {
    const kv = Object.entries(params.sceneParam.paramValues ?? {})
      .filter(([, v]) => v && v.trim())
      .map(([k, v]) => `  ${escapeTagBody(k)}: ${escapeTagBody(v)}`)
      .join('\n')
    const toolName = escapeAttr(params.sceneParam.toolTitle ?? '')
    blocks.push(kv ? `<scene tool="${toolName}">\n${kv}\n</scene>` : `<scene tool="${toolName}" />`)
  }

  if (params.presetDirective) {
    blocks.push(params.presetDirective)
  }

  if (params.mcp && params.mcp.length > 0) {
    blocks.push(`<mcp>${escapeTagBody(params.mcp.map((m) => m.name).join(', '))}</mcp>`)
  }

  if (params.mcpStatusBlocks && params.mcpStatusBlocks.length > 0) {
    blocks.push(...params.mcpStatusBlocks)
  }

  const convBlock = describeConversationRefs(params.conversationRefs)
  if (convBlock) blocks.push(convBlock)

  const annBlock = describeAnnotations(params.annotations)
  if (annBlock) blocks.push(annBlock)

  if (params.pptSelection?.documentPath) {
    const selMeta = JSON.stringify({
      documentPath: params.pptSelection.documentPath.replace(/\\/g, '/'),
      currentSlideId: params.pptSelection.currentSlideId,
      references: params.pptSelection.references,
      referenceLabels: params.pptSelection.referenceLabels
    })
      .replace(/</g, '\\u003c')
      .replace(/>/g, '\\u003e')
    blocks.push(
      `<ppt-workbench>\n${selMeta}\n用户当前在右侧 PPT 交互工作台选中了以上页面/元素范围。请优先调用 ppt_workbench(action="read") 查看结构并调用 ppt_workbench(action="suggest") 提交修改建议；禁止直接用 write_file 覆盖该 .pptx。\n</ppt-workbench>`
    )
  }

  if (params.filelist && params.filelist.length > 0) {
    const fileLines = params.filelist
      .filter((f) => f.path)
      .map((f) => {
        const roleTag =
          f.role === 'ppt_template'
            ? ' [role=ppt_template 仅参考版式与视觉语言，切勿照抄模板中示例数据]'
            : ''
        return `- ${escapeTagBody(f.name ?? 'file')} (${f.type ?? 'file'}, ${f.size ?? 0} bytes)${roleTag}: ${f.path!.replace(/\\/g, '/')}`
      })
    if (fileLines.length > 0) {
      blocks.push(`<files>\n用户随本条消息提供的本机文件绝对路径：\n${fileLines.join('\n')}\n</files>`)
    }
  }

  return blocks.filter(Boolean).join('\n\n')
}

function extractStreamDeltas(chunk: AIMessage): { textDelta: string; reasoningDelta: string } {
  let textDelta = ''
  let reasoningDelta = ''

  const addKw = (chunk as unknown as { additional_kwargs?: Record<string, unknown> }).additional_kwargs
  if (addKw) {
    if (typeof addKw.reasoning_content === 'string') {
      reasoningDelta += addKw.reasoning_content
    } else if (typeof addKw.reasoning === 'string') {
      reasoningDelta += addKw.reasoning
    }
  }

  if (typeof chunk.content === 'string') {
    textDelta += chunk.content
  } else if (Array.isArray(chunk.content)) {
    for (const part of chunk.content) {
      if (!part || typeof part !== 'object') continue
      const p = part as Record<string, unknown>
      if (p.type === 'text' && typeof p.text === 'string') {
        textDelta += p.text
      } else if (p.type === 'thinking' && typeof p.thinking === 'string') {
        reasoningDelta += p.thinking
      } else if (p.type === 'reasoning' && typeof p.summary === 'string') {
        reasoningDelta += p.summary
      }
    }
  }

  return { textDelta, reasoningDelta }
}

/** 主模型能看图、但接口不允许工具结果带图片（OpenAI Chat Completions）时，每步最多补发几张图 */
const MAX_FORWARDED_IMAGES_PER_STEP = 4

export async function runAgentLoop(params: {
  model: ReturnType<typeof createChatModel>
  systemPrompt: string
  history: BaseMessage[]
  tools: DynamicStructuredTool[]
  signal: AbortSignal
  maxIterations?: number
  offloadRootDir?: string
  enableAnthropicCache?: boolean
  /** 用于判断该接口能否接收工具结果里的图片块 */
  profile?: ModelProviderProfile
  compactContext?: {
    rootDir: string
    profile: ModelProviderProfile
    onCompacted?: (summary: string) => void
  }
  onUsage?: (delta: UsageDelta) => void
  onToken: (delta: string) => void
  onReasoning: (delta: string) => void
  onToolStart: (id: string, name: string, args: Record<string, unknown>) => void
  onToolEnd: (id: string, name: string, ok: boolean, toolData: unknown) => void
  takeRecordedToolData: (id: string) => unknown
}): Promise<{ completedNaturally: boolean }> {
  const { model, systemPrompt, history, tools, signal, maxIterations = 80, compactContext } = params
  const toolImagesSupported = params.profile
    ? params.profile.protocol === 'anthropic' || Boolean(params.profile.useResponsesApi)
    : true
  // 接口不收工具结果里的图片时，能看图的主模型改走“用户消息补发图片”
  const forwardToolImages =
    !toolImagesSupported && Boolean(params.profile && isVisionCapableModel(params.profile.model))
  const toolMap = new Map(tools.map((t) => [t.name, t]))
  let lastBoundCount = -1
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let boundModel: any = model
  let completedNaturally = false

  for (let step = 0; step < maxIterations; step++) {
    signal.throwIfAborted()

    // 若 tool_search 动态加载了新 MCP 工具，即时重绑工具集
    if (tools.length !== lastBoundCount) {
      for (const t of tools) toolMap.set(t.name, t)
      boundModel = model.bindTools ? model.bindTools(tools) : model
      lastBoundCount = tools.length
    }

    if (compactContext) {
      const res = await compactHistoryIfNeeded({
        rootDir: compactContext.rootDir,
        systemPrompt,
        history,
        profile: compactContext.profile
      })
      if (res.compacted) {
        compactContext.onCompacted?.(res.archivePath ?? '')
      }
    }

    const streamOnce = async (): Promise<AIMessage | null> => {
      // 压缩摘要等 SystemMessage 合并进系统提示词，保证发送给模型的消息里只有开头一条 system
      const extraSystem = history
        .filter((m) => m._getType() === 'system')
        .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
        .join('\n\n')
      const sysMsg = buildSystemMessage(
        extraSystem ? `${systemPrompt}\n\n${extraSystem}` : systemPrompt,
        Boolean(params.enableAnthropicCache)
      )
      const messages: BaseMessage[] = [sysMsg, ...history.filter((m) => m._getType() !== 'system')]
      const stream = await boundModel.stream(messages, { signal })
      let agg: AIMessage | null = null
      for await (const chunk of stream) {
        signal.throwIfAborted()
        const aiChunk = chunk as AIMessage
        const { textDelta, reasoningDelta } = extractStreamDeltas(aiChunk)
        if (reasoningDelta) params.onReasoning(reasoningDelta)
        if (textDelta) params.onToken(textDelta)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        agg = agg ? (agg as any).concat(aiChunk) : aiChunk
      }
      return agg
    }

    let aggregated: AIMessage | null = null
    try {
      aggregated = await streamOnce()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (
        compactContext &&
        !signal.aborted &&
        /(context.*length|maximum context|too many tokens|token limit)/i.test(msg)
      ) {
        const res = await compactHistoryIfNeeded({
          rootDir: compactContext.rootDir,
          systemPrompt,
          history,
          profile: compactContext.profile,
          force: true
        })
        if (res.compacted) {
          compactContext.onCompacted?.(res.archivePath ?? '')
          aggregated = await streamOnce()
        } else {
          throw err
        }
      } else {
        throw err
      }
    }

    if (!aggregated) {
      completedNaturally = true
      break
    }
    history.push(aggregated)

    const um = (aggregated as unknown as {
      usage_metadata?: {
        input_tokens?: number
        output_tokens?: number
        total_tokens?: number
        input_token_details?: { cache_read?: number; cache_creation?: number }
      }
    }).usage_metadata
    if (um && params.onUsage) {
      const inp = Number(um.input_tokens ?? 0)
      const outp = Number(um.output_tokens ?? 0)
      const cacheRead = Number(um.input_token_details?.cache_read ?? 0)
      const cacheCreate = Number(um.input_token_details?.cache_creation ?? 0)
      const total = Number(um.total_tokens ?? inp + outp)
      if (inp > 0 || outp > 0 || total > 0) {
        params.onUsage({
          inputTokens: inp,
          outputTokens: outp,
          cacheReadTokens: cacheRead,
          cacheCreationTokens: cacheCreate,
          totalTokens: total
        })
      }
    }

    const toolCalls = aggregated.tool_calls ?? []
    const invalidCalls =
      (aggregated as unknown as {
        invalid_tool_calls?: Array<{ id?: string; name?: string; args?: string; error?: string }>
      }).invalid_tool_calls ?? []

    if (toolCalls.length === 0 && invalidCalls.length === 0) {
      completedNaturally = true
      break
    }

    for (const inv of invalidCalls) {
      const callId = inv.id || `invalid_${randomUUID().slice(0, 8)}`
      const callName = inv.name || 'unknown_tool'
      params.onToolStart(callId, callName, { raw: inv.args ?? '' })
      params.onToolEnd(callId, callName, false, null)
      history.push(
        new ToolMessage({
          tool_call_id: callId,
          name: callName,
          content: `工具 "${callName}" 参数 JSON 解析失败（${inv.error ?? '语法不合法'}），请修正为合法 JSON 参数后重试。`,
          status: 'error'
        })
      )
    }

    const forwardedImages: Array<{ name: string; image: unknown }> = []
    for (const tc of toolCalls) {
      signal.throwIfAborted()
      const callId = tc.id || `call_${randomUUID().slice(0, 8)}`
      const callName = tc.name
      const callArgs = (tc.args ?? {}) as Record<string, unknown>

      params.onToolStart(callId, callName, callArgs)

      const targetTool = toolMap.get(callName)
      if (!targetTool) {
        const errMsg = `未找到工具 "${callName}"，请从已注册工具中选择。`
        params.onToolEnd(callId, callName, false, null)
        history.push(
          new ToolMessage({
            tool_call_id: callId,
            name: callName,
            content: errMsg,
            status: 'error'
          })
        )
        continue
      }

      try {
        const rawOutput = await targetTool.invoke(callArgs, {
          signal,
          configurable: { toolCallId: callId }
        } as Record<string, unknown>)
        const safeOutput = params.offloadRootDir
          ? offloadLargeToolOutput({
              rootDir: params.offloadRootDir,
              toolCallId: callId,
              toolName: callName,
              output: rawOutput
            })
          : rawOutput
        const recorded = params.takeRecordedToolData(callId)
        params.onToolEnd(callId, callName, true, recorded ?? null)
        let toolContent: unknown = safeOutput
        if (forwardToolImages) {
          const split = splitToolImageBlocks(safeOutput)
          toolContent = split.content
          for (const image of split.images) forwardedImages.push({ name: callName, image })
        } else {
          toolContent = degradeToolImageBlocks(safeOutput, toolImagesSupported)
        }
        history.push(
          new ToolMessage({
            tool_call_id: callId,
            name: callName,
            content: toolContent as never
          })
        )
      } catch (err) {
        if (signal.aborted || err instanceof PermissionRejectedError) {
          params.onToolEnd(callId, callName, false, null)
          throw err
        }
        const msg = err instanceof Error ? err.message : String(err)
        params.onToolEnd(callId, callName, false, null)
        history.push(
          new ToolMessage({
            tool_call_id: callId,
            name: callName,
            content: `工具执行出错：${msg}`,
            status: 'error'
          })
        )
      }
    }
    // 所有工具结果都写完之后才能插入用户消息（OpenAI 要求 tool 消息紧跟在带 tool_calls 的助手消息后）
    if (forwardedImages.length > 0) {
      const kept = forwardedImages.slice(-MAX_FORWARDED_IMAGES_PER_STEP)
      const dropped = forwardedImages.length - kept.length
      history.push(
        new HumanMessage({
          content: [
            {
              type: 'text',
              text: `[系统转交] 以下是上一步工具（${[...new Set(kept.map((x) => x.name))].join('、')}）读取到的图片，共 ${kept.length} 张${
                dropped > 0 ? `（另有 ${dropped} 张较早的图片未转交，需要时请重新读取）` : ''
              }。这不是用户的新指令，请结合图片继续当前任务。`
            },
            ...kept.map((x) => x.image)
          ] as never
        })
      )
    }
  }
  return { completedNaturally }
}

function isDirectImageGenerationIntent(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  // P2：去掉过宽的“来”“出”，避免“接下来分析这张图片”“读出这张照片上的尺寸”被误判为生图
  const asksImage =
    /(生成|画|渲染|制作|做|改成|改为|换成|出一?[张版套幅个]|来一?[张版套幅个])\S{0,10}(效果图|夜景图|日景图|黄昏图|鸟瞰图|彩平图|透视图|人视图|意向图|概念图|实景图|方案图|图片|照片)|改图|出图|生图|文生图|图生图|垫图出图/i.test(
      t
    )
  if (!asksImage) return false
  // 若用户明确还要纯 CAD 尺寸分析、规范核查、文档生成或三维软件建模，不直接拦截
  const asksOtherDeliverable =
    /(三维建模|建模型|白模|sketchup|blender|rhino|3ds\s*max|ppt|pptx|word|docx|excel|xlsx|pdf|规范|条文|核查|面积表|尺寸表|分析|识别|读取|读出|看看|看一下|标注|尺寸|测量|说明|解释|描述|重命名|文件名)/i.test(
      t
    )
  return !asksOtherDeliverable
}

function buildProjectContext(
  rootDir: string,
  projectId: string | null,
  skillsRoot: string,
  profile: 'ai-scheme-v1' | 'default' | undefined,
  imageGenCapability?: { enabled: boolean; modelName: string },
  presets?: ModelingPresetInfo[],
  visionReview?: boolean
): { projectMemoryFile: string; projectProfileFile: string; systemPrompt: string } {
  const skills = discoverSkills(skillsRoot)
  const resolvedPresets = presets ?? discoverModelingPresets(undefined, skillsRoot)
  const workspacesBase = process.env.DESIGN_AGENT_WORKSPACES_DIR || join(rootDir, '.design-agent-workspaces')
  const projectMemoryFile = projectId
    ? join(workspacesBase, projectId, 'memory.md')
    : join(rootDir, '.design-agent', 'memory.md')
  const projectDecisionsFile = projectId
    ? join(workspacesBase, projectId, 'project_decisions.md')
    : join(rootDir, '.design-agent', 'project_decisions.md')
  const projectMetaFile = projectId ? join(workspacesBase, projectId, 'project-meta.json') : ''
  const charterFile = join(rootDir, 'DESIGN-AGENT.md')

  const charterParts: string[] = []
  if (projectMetaFile && existsSync(projectMetaFile)) {
    try {
      const meta = JSON.parse(readFileSync(projectMetaFile, 'utf8')) as Record<string, string>
      const lines = Object.entries(meta)
        .filter(([, v]) => v && String(v).trim())
        .map(([k, v]) => `- ${k}: ${v}`)
      if (lines.length > 0) charterParts.push(`## 项目基本档案\n${lines.join('\n')}`)
    } catch {
      // ignore
    }
  }
  if (existsSync(charterFile)) charterParts.push(readFileSync(charterFile, 'utf8'))
  const projectCharter = charterParts.length > 0 ? charterParts.join('\n\n') : undefined

  const memChunks: string[] = []
  if (existsSync(projectMemoryFile)) memChunks.push(readFileSync(projectMemoryFile, 'utf8'))
  if (existsSync(projectDecisionsFile)) memChunks.push(readFileSync(projectDecisionsFile, 'utf8'))
  const projectMemory = memChunks.length > 0 ? memChunks.join('\n\n') : undefined
  const projectProfileFile = projectProfilePath(projectMemoryFile)
  const profileData = loadProjectProfile(projectProfileFile)
  const projectProfile = profileData ? summarizeProfile(profileData) : undefined

  return {
    projectMemoryFile,
    projectProfileFile,
    systemPrompt: buildSupervisorSystemPrompt({
      rootDir,
      skillsRoot,
      skills,
      presets: resolvedPresets,
      profile,
      projectMemory,
      projectCharter,
      projectProfile,
      imageGenCapability,
      visionReview
    })
  }
}

async function applySuspendedResolution(params: {
  requestId: string
  threadId: string
  rootDir: string
  history: BaseMessage[]
  pendingSuspension: PendingSuspension | undefined
  resolution: Extract<RuntimeInbound, { type: 'resume_suspended_turn' }>['resolution']
  allTools: DynamicStructuredTool[]
  mcpTools: DynamicStructuredTool[] | undefined
  signal: AbortSignal
  setCurrentActiveToolCallId: (id: string) => void
  setApprovedSuspendedCallId: (id: string | null) => void
  takeRecordedToolData: (id: string) => unknown
}): Promise<void> {
  const {
    requestId,
    threadId,
    rootDir,
    history,
    pendingSuspension,
    resolution,
    allTools,
    mcpTools,
    signal,
    setCurrentActiveToolCallId,
    setApprovedSuspendedCallId,
    takeRecordedToolData
  } = params

  if (!pendingSuspension) return

  if (resolution.kind === 'interrupt') {
    const decision = resolution.decision
    if (decision.type === 'reject') {
      const reason = decision.message || '用户拒绝了该操作'
      post({
        type: 'tool-result',
        requestId,
        threadId,
        id: pendingSuspension.toolCallId,
        name: pendingSuspension.toolName,
        ok: false,
        toolData: null
      })
      history.push(
        new ToolMessage({
          tool_call_id: pendingSuspension.toolCallId,
          name: pendingSuspension.toolName,
          content: reason,
          status: 'error'
        })
      )
      throw new PermissionRejectedError(reason)
    }

    let targetTool = allTools.find((t) => t.name === pendingSuspension.toolName)
    if (!targetTool && mcpTools) {
      const deferredMatch = mcpTools.find((t) => t.name === pendingSuspension.toolName)
      if (deferredMatch) {
        allTools.push(deferredMatch)
        targetTool = deferredMatch
      }
    }

    if (!targetTool) {
      post({
        type: 'tool-result',
        requestId,
        threadId,
        id: pendingSuspension.toolCallId,
        name: pendingSuspension.toolName,
        ok: false,
        toolData: null
      })
      history.push(
        new ToolMessage({
          tool_call_id: pendingSuspension.toolCallId,
          name: pendingSuspension.toolName,
          content: `恢复执行失败：未找到工具 "${pendingSuspension.toolName}"。`,
          status: 'error'
        })
      )
      return
    }

    setApprovedSuspendedCallId(pendingSuspension.toolCallId)
    setCurrentActiveToolCallId(pendingSuspension.toolCallId)
    try {
      const rawOutput = await targetTool.invoke(pendingSuspension.args, {
        signal,
        configurable: { toolCallId: pendingSuspension.toolCallId }
      } as Record<string, unknown>)
      const safeOutput = offloadLargeToolOutput({
        rootDir,
        toolCallId: pendingSuspension.toolCallId,
        toolName: pendingSuspension.toolName,
        output: rawOutput
      })
      const recorded = takeRecordedToolData(pendingSuspension.toolCallId)
      post({
        type: 'tool-result',
        requestId,
        threadId,
        id: pendingSuspension.toolCallId,
        name: pendingSuspension.toolName,
        ok: true,
        toolData: recorded ?? null
      })
      history.push(
        new ToolMessage({
          tool_call_id: pendingSuspension.toolCallId,
          name: pendingSuspension.toolName,
          content: typeof safeOutput === 'string' ? safeOutput : (safeOutput as never)
        })
      )
    } catch (err) {
      if (signal.aborted || err instanceof PermissionRejectedError) {
        post({
          type: 'tool-result',
          requestId,
          threadId,
          id: pendingSuspension.toolCallId,
          name: pendingSuspension.toolName,
          ok: false,
          toolData: null
        })
        throw err
      }
      const errMsg = err instanceof Error ? err.message : String(err)
      post({
        type: 'tool-result',
        requestId,
        threadId,
        id: pendingSuspension.toolCallId,
        name: pendingSuspension.toolName,
        ok: false,
        toolData: null
      })
      history.push(
        new ToolMessage({
          tool_call_id: pendingSuspension.toolCallId,
          name: pendingSuspension.toolName,
          content: `工具执行出错：${errMsg}`,
          status: 'error'
        })
      )
    } finally {
      setCurrentActiveToolCallId('')
      setApprovedSuspendedCallId(null)
    }
    return
  }

  if (resolution.kind === 'ask_user') {
    if (pendingSuspension.toolName === '__host_readiness__') return
    const questions = Array.isArray(pendingSuspension.args?.questions)
      ? (pendingSuspension.args.questions as AskQuestion[])
      : []
    post({
      type: 'tool-result',
      requestId,
      threadId,
      id: pendingSuspension.toolCallId,
      name: pendingSuspension.toolName,
      ok: true,
      toolData: {
        kind: 'ask_user',
        questions,
        answers: resolution.answers
      }
    })
    history.push(
      new ToolMessage({
        tool_call_id: pendingSuspension.toolCallId,
        name: pendingSuspension.toolName,
        content: formatAnswersForModel(resolution.answers)
      })
    )
    return
  }

  if (resolution.kind === 'ask_image_edit') {
    const hint = typeof pendingSuspension.args?.hint === 'string' ? pendingSuspension.args.hint : ''
    const rawPath =
      typeof pendingSuspension.args?.image_path === 'string' ? pendingSuspension.args.image_path : ''
    const ans = resolution.answer
    const confirmed = ans.action !== 'cancel' && Boolean(ans.imagePath)
    post({
      type: 'tool-result',
      requestId,
      threadId,
      id: pendingSuspension.toolCallId,
      name: pendingSuspension.toolName,
      ok: true,
      toolData: confirmed
        ? {
            kind: 'ask_image_edit',
            hint,
            sourcePath: rawPath,
            editedPath: ans.imagePath,
            result: 'confirmed'
          }
        : {
            kind: 'ask_image_edit',
            hint,
            sourcePath: rawPath,
            result: 'cancelled'
          }
    })
    history.push(
      new ToolMessage({
        tool_call_id: pendingSuspension.toolCallId,
        name: pendingSuspension.toolName,
        content: confirmed
          ? `用户已完成图片局部标注，标注后的图片保存在：${ans.imagePath.replace(/\\/g, '/')}（可用 read_file 查看标注位置，再结合 edit_image_with_ref 进行图生图改图）。`
          : '用户取消了本次图片标注操作，请询问用户是否改为文字描述或终止修改。'
      })
    )
  }
}

async function executeTurn(
  msg:
    | Extract<RuntimeInbound, { type: 'chat' }>
    | Extract<RuntimeInbound, { type: 'resume_suspended_turn' }>
): Promise<void> {
  const isResumeTurn = msg.type === 'resume_suspended_turn'
  const {
    requestId,
    threadId,
    rootDir,
    projectId,
    transcriptPath,
    mcpServers,
    thinking,
    modelProfile,
    imageGenConfig,
    visionConfig,
    regulationFolder,
    inspirationFolder,
    clipModelDir,
    webSearchConfig,
    profile
  } = msg

  if (activeTurns.has(threadId)) {
    post({
      type: 'error',
      requestId,
      threadId,
      kind: 'preflight',
      message: 'Turn already in flight',
      userMessage: '当前会话已有任务正在执行，请等待完成或先点击停止。'
    })
    return
  }

  if (msg.permissionMode) {
    globalPermissionMode = msg.permissionMode
  }
  let initialPermissionMode: PermissionMode = msg.permissionMode ?? globalPermissionMode
  // 任务上下文仅 chat 消息携带（恢复轮次无此字段）：提升到此处供生图渠道按任务路由使用
  const turnSceneParam: SceneParam | undefined =
    msg.type === 'chat' ? msg.sceneParam : undefined
  if (
    isResumeTurn &&
    msg.resolution.kind === 'interrupt' &&
    msg.resolution.decision.type === 'approve' &&
    msg.resolution.decision.scope === 'all'
  ) {
    initialPermissionMode = 'auto'
  }

  const abortController = new AbortController()
  const turnState: ActiveTurnState = {
    requestId,
    threadId,
    abortController,
    pendingApproval: null,
    pendingClarification: null,
    pendingImageEdit: null,
    deliverables: [],
    permissionMode: initialPermissionMode
  }

  // 跨软件重启恢复同一 threadId 的完整 LLM 上下文（Checkpoint）
  let pendingSuspension: PendingSuspension | undefined
  if (!conversationHistories.has(threadId) && transcriptPath) {
    const restored = loadRuntimeCheckpoint(transcriptPath)
    pendingSuspension = restored.pendingSuspension
    if (restored.history.length > 0) {
      const initialHistory = isResumeTurn
        ? restored.history
        : sanitizeHistoryForResume(restored.history)
      conversationHistories.set(threadId, initialHistory)
      turnCounters.set(threadId, restored.turnCount)
    }
  }

  const prevTurns = turnCounters.get(threadId) ?? 0
  const turnNum = isResumeTurn
    ? (pendingSuspension?.turnNum ?? Math.max(1, prevTurns))
    : prevTurns + 1
  turnCounters.set(threadId, turnNum)
  const turnId = `${threadId}:turn:${turnNum}`

  const isFirstTurn = !conversationHistories.has(threadId)
  const history = conversationHistories.get(threadId) ?? []
  if (isFirstTurn) {
    conversationHistories.set(threadId, history)
    if (!isResumeTurn) {
      const rawTitle = msg.text.replace(/\s+/g, ' ').trim().slice(0, 28) || '新建设计任务'
      post({ type: 'newchat', requestId, threadId, title: rawTitle })
    }
  }

  const toolDataStore = new Map<string, unknown>()
  let currentActiveToolCallId = ''
  let approvedSuspendedCallId: string | null = null

  const recordToolData = (_id: string, data: unknown): void => {
    const key = _id || currentActiveToolCallId
    toolDataStore.set(key, data)
  }
  // 主循环发起的工具调用 ID（只有这些调用的挂起状态可以跨重启恢复；子智能体内部的调用不写入断点）
  const mainLoopCallIds = new Set<string>()
  // R1：同一轮内的人工交互（审批 / 追问 / 图片标注）串行排队，避免并发子任务互相覆盖挂起位
  let interactionChain: Promise<void> = Promise.resolve()
  const runExclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = interactionChain.then(fn, fn)
    interactionChain = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }
  const takeRecordedToolData = (id: string): unknown => {
    const val = toolDataStore.get(id)
    toolDataStore.delete(id)
    return val ?? null
  }

  const gatedToolNames = new Set([
    'write_file',
    'edit_file',
    'execute',
    'generate_image',
    'edit_image_with_ref'
    // 自用：remember（写项目记忆）不再弹审批。如需恢复，把 'remember' 加回这里即可
  ])

  const requireApproval = async (
    toolName: string,
    args: Record<string, unknown>,
    _id: string
  ): Promise<void> => {
    const callId = _id || currentActiveToolCallId
    if (approvedSuspendedCallId && callId === approvedSuspendedCallId) {
      approvedSuspendedCallId = null
      return
    }
    const isMcpTool = Boolean(splitMcpToolName(toolName))
    if (!gatedToolNames.has(toolName) && !isMcpTool) return
    return runExclusive(async () => {
      abortController.signal.throwIfAborted()
      if (turnState.permissionMode === 'auto') return
      const resumable = mainLoopCallIds.has(callId)
      const authRequestId = randomUUID()
      if (resumable) {
        saveRuntimeCheckpoint(transcriptPath, threadId, turnNum, history, {
          kind: 'interrupt',
          toolCallId: callId,
          toolName,
          args,
          requestId,
          turnNum
        })
      }
      post({
        type: 'interrupt',
        requestId,
        threadId,
        actions: [{ name: toolName, args, toolCallId: callId }],
        authorization: {
          authRequestId,
          toolCallId: callId,
          messageId: turnId,
          turnNum
        },
        message: toolLabel(toolName),
        delta: approvalDelta(toolName, args)
      })

      const decision = await new Promise<AgentDecision>((resolveDecision, rejectDecision) => {
        turnState.pendingApproval = { resolve: resolveDecision, reject: rejectDecision }
      })
      turnState.pendingApproval = null
      if (resumable) saveRuntimeCheckpoint(transcriptPath, threadId, turnNum, history)

      if (decision.type === 'approve') {
        if (decision.scope === 'all') {
          turnState.permissionMode = 'auto'
        }
        return
      }
      throw new PermissionRejectedError(decision.message || '用户拒绝了该操作')
    })
  }

  const waitForUserAnswer = async (
    _id: string,
    questions: AskQuestion[],
    interaction?: 'host-readiness',
    fallbackPrompt?: string
  ): Promise<AskAnswer[]> => runExclusive(async () => {
    abortController.signal.throwIfAborted()
    const callId = _id || currentActiveToolCallId
    saveRuntimeCheckpoint(transcriptPath, threadId, turnNum, history, {
      kind: 'ask_user',
      toolCallId: callId,
      toolName: interaction === 'host-readiness' ? '__host_readiness__' : 'ask_user',
      args: {
        questions,
        ...(interaction ? { interaction } : {}),
        ...(fallbackPrompt ? { fallbackPrompt } : {})
      },
      requestId,
      turnNum
    })
    post({
      type: 'ask_user',
      requestId,
      threadId,
      id: callId,
      questions,
      ...(interaction ? { interaction } : {})
    })
    const answers = await new Promise<AskAnswer[]>((resolveAns, rejectAns) => {
      turnState.pendingClarification = { resolve: resolveAns, reject: rejectAns }
    })
    turnState.pendingClarification = null
    saveRuntimeCheckpoint(transcriptPath, threadId, turnNum, history)
    return answers
  })

  const waitForImageEdit = async (
    _id: string,
    imagePath: string,
    hint: string
  ): Promise<ImageEditAnswer> => runExclusive(async () => {
    abortController.signal.throwIfAborted()
    const callId = _id || currentActiveToolCallId
    saveRuntimeCheckpoint(transcriptPath, threadId, turnNum, history, {
      kind: 'ask_image_edit',
      toolCallId: callId,
      toolName: 'ask_image_edit',
      args: { image_path: imagePath, hint },
      requestId,
      turnNum
    })
    post({
      type: 'ask_image_edit',
      requestId,
      threadId,
      id: callId,
      hint,
      imagePath
    })
    const answer = await new Promise<ImageEditAnswer>((resolveEdit, rejectEdit) => {
      turnState.pendingImageEdit = { id: callId, resolve: resolveEdit, reject: rejectEdit }
    })
    turnState.pendingImageEdit = null
    saveRuntimeCheckpoint(transcriptPath, threadId, turnNum, history)
    return answer
  })

  const skillsRoot = process.env.DESIGN_AGENT_SKILLS_ROOT || ''
  const availablePresets = discoverModelingPresets(undefined, skillsRoot)
  let mcpBundle: Awaited<ReturnType<typeof connectMcpServers>> | null = null
  let extraMcpBundle: Awaited<ReturnType<typeof connectMcpServers>> | null = null
  let cancelAsyncJobs: (() => void) | null = null
  const turnUsage: TurnUsageStats = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
    modelCalls: 0,
    model: modelProfile.model
  }
  const addUsage = (delta: UsageDelta): void => {
    turnUsage.inputTokens += delta.inputTokens
    turnUsage.outputTokens += delta.outputTokens
    turnUsage.cacheReadTokens += delta.cacheReadTokens
    turnUsage.cacheCreationTokens += delta.cacheCreationTokens
    turnUsage.totalTokens += delta.totalTokens
    turnUsage.modelCalls += 1
    post({ type: 'usage', requestId, threadId, usage: { ...turnUsage } })
  }

  const mcpImageDir = join(rootDir, '.design-agent', 'mcp-images')
  activeTurns.set(threadId, turnState)
  try {
    mcpBundle =
      mcpServers && mcpServers.length > 0
        ? await connectMcpServers(mcpServers, requireApproval, { imageDir: mcpImageDir })
        : null

    if (isResumeTurn) {
      if (
        pendingSuspension?.toolName === '__host_readiness__' &&
        msg.resolution.kind === 'ask_user'
      ) {
        const choice = msg.resolution.answers[0]?.selected?.[0] || msg.resolution.answers[0]?.text || ''
        if (choice.includes('重试') && mcpBundle && mcpBundle.failedServers.length > 0) {
          extraMcpBundle = await connectMcpServers(mcpBundle.failedServers, requireApproval, { imageDir: mcpImageDir })
          mcpBundle.tools.push(...extraMcpBundle.tools)
          mcpBundle.serverPrompts = extraMcpBundle.serverPrompts
        }
        const fallbackPrompt =
          typeof pendingSuspension.args?.fallbackPrompt === 'string'
            ? pendingSuspension.args.fallbackPrompt
            : ''
        if (fallbackPrompt) {
          const promptWithMcp = mcpBundle?.serverPrompts
            ? `${fallbackPrompt}\n\n${mcpBundle.serverPrompts}`
            : fallbackPrompt
          history.push(new HumanMessage(promptWithMcp))
        }
      }
    } else {
      const { text, filelist, annotations, conversationRefs, pptSelection, sceneParam, mcp } = msg
      const matchedPreset = matchModelingPreset(availablePresets, {
        text,
        sceneParam,
        mcp,
        hasAttachments: (filelist?.length ?? 0) > 0
      })
      const presetDirective = matchedPreset
        ? buildModelingPresetDirective(matchedPreset, { text, sceneParam, skillsRoot })
        : undefined
      const baseUserText = formatUserMessageWithContext({
        text,
        filelist,
        annotations,
        conversationRefs,
        pptSelection,
        sceneParam,
        mcp,
        presetDirective
      })

      // 对齐原版 host-readiness 引导：若已选的连接器尚未打开/握手失败，弹窗引导打开后一键重连
      if (mcpBundle && mcpBundle.failedServers.length > 0) {
        const namesList = mcpBundle.failedServers
          .map((s) => s.hostState?.reason || s.label)
          .join('、')
        const answers = await waitForUserAnswer(
          `host_${Date.now()}`,
          [
            {
              question: `以下设计软件连接器尚未就绪（${namesList}），请处理后重试连接或跳过：`,
              type: 'single_select',
              options: ['已打开，重试连接', '跳过连接器，先直接对话']
            }
          ],
          'host-readiness',
          baseUserText
        )
        const choice = answers[0]?.selected?.[0] || answers[0]?.text || ''
        if (choice.includes('重试')) {
          extraMcpBundle = await connectMcpServers(mcpBundle.failedServers, requireApproval, { imageDir: mcpImageDir })
          mcpBundle.tools.push(...extraMcpBundle.tools)
          mcpBundle.serverPrompts = extraMcpBundle.serverPrompts
        }
      }

      const formattedUserText = formatUserMessageWithContext({
        text,
        filelist,
        annotations,
        conversationRefs,
        pptSelection,
        sceneParam,
        mcp,
        mcpStatusBlocks: mcpBundle?.serverPrompts,
        presetDirective
      })
      const cleanBeforePush = sanitizeHistoryForResume(history)
      if (cleanBeforePush.length !== history.length) {
        history.splice(0, history.length, ...cleanBeforePush)
      }
      history.push(new HumanMessage(formattedUserText))
      post({ type: 'user-persisted', requestId, threadId })
    }

    const imageCapable = hasImageGenCapability({ modelProfile, imageGenConfig })
    // 审图用的是「能不能看图」，与上面的「能不能生图」无关
    const visionProfile = resolveVisionProfile({ modelProfile, visionConfig })
    // 主模型是纯文本时，read_file 读到的图片先由独立视觉模型转述成文字
    const mainSeesImages = isVisionCapableModel(modelProfile.model)
    const imageDescriber =
      !mainSeesImages && visionProfile
        ? createImageDescriber({ modelProfile: visionProfile, signal: abortController.signal })
        : undefined
    if (!isResumeTurn && !imageCapable && isDirectImageGenerationIntent(msg.text)) {
      const fastNotice = [
        `当前所选对话模型（\`${modelProfile.model}\`）本身不具备生图能力，且你尚未配置或开启独立的「效果图 / 图生图 API」，因此无法直接生成图片（已为你跳过耗时的图纸解析与预处理，避免浪费 Token）。`,
        '',
        '你可以按以下任意方式继续：',
        '1. **配置独立生图 API（推荐）**：点击左下角「设置」→ 切换到 **「效果图 / 图生图 API」**，开启并填写支持出图的模型与 API Key（如 FLUX / Kolors / GPT-Image / Gemini 生图），保存后重发即可；这样主对话可以继续用 DeepSeek！',
        '2. **切换支持生图的模型**：在输入框右下角模型菜单切换为支持出图的多模态生图模型后再试。',
        '3. 如果你只是想先让我分析图纸尺寸、房间构成或写汇报方案，告诉我具体分析要求即可。'
      ].join('\n')
      post({ type: 'token', requestId, threadId, delta: fastNotice })
      history.push(new AIMessage(fastNotice))
      post({
        type: 'done',
        requestId,
        threadId,
        turnId,
        deliverables: []
      })
      return
    }

    const { projectMemoryFile, projectProfileFile, systemPrompt } = buildProjectContext(
      rootDir,
      projectId,
      skillsRoot,
      profile,
      { enabled: imageCapable, modelName: modelProfile.model },
      availablePresets,
      Boolean(visionProfile)
    )

    const extraEnvPaths = detectExtraRuntimePaths()
    const pythonExe = findPythonExe(extraEnvPaths)
    const mainModel = createChatModel(modelProfile, { thinking })

    const pptSelection = isResumeTurn ? undefined : msg.pptSelection
    const protectedPptPaths = pptSelection?.documentPath ? [pptSelection.documentPath] : []
    const allowedReadPaths = [
      ...('filelist' in msg
        ? (msg.filelist ?? []).flatMap((file) => (file.path ? [file.path] : []))
        : []),
      ...('conversationRefs' in msg
        ? (msg.conversationRefs ?? []).flatMap((reference) =>
            reference.path ? [reference.path] : []
          )
        : [])
    ]

    const readOnlyRoots = [skillsRoot, resolvePresetsRoot(undefined, skillsRoot)].filter(Boolean)
    const baseTools = createWorkspaceTools({
      rootDir,
      readOnlyRoots,
      projectMemoryPath: projectMemoryFile,
      extraEnvPaths,
      protectedPptPaths,
      allowedReadPaths,
      signal: abortController.signal,
      requireApproval,
      recordToolData,
      modelSeesImages: mainSeesImages,
      describeImage: imageDescriber,
      onTodosChange: (_todos: TodoItem[]) => {}
    })

    const askUserTool = createAskUserTool({
      waitForUserAnswer,
      recordToolData
    })

    const imageTools = createImageTools({
      rootDir,
      modelProfile,
      imageGenConfig,
      sceneParam: turnSceneParam,
      signal: abortController.signal,
      requireApproval,
      waitForImageEdit,
      recordToolData
    })

    const regulationTool = createLocalRegulationTool({
      regulationFolder,
      pythonExe,
      recordToolData
    })

    const webSearchTool = createWebSearchTool({
      config: webSearchConfig,
      signal: abortController.signal,
      recordToolData
    })

    const inspirationTool = createSearchInspirationTool({
      inspirationFolder,
      clipModelDir,
      webSearchConfig,
      signal: abortController.signal,
      recordToolData
    })

    const pptWorkbenchTool = createPptWorkbenchTool({
      rootDir,
      pptSelection,
      recordToolData,
      onEmitProposal: (proposal: PptProposal) => {
        post({ type: 'ppt_proposal', requestId, threadId, proposal })
      }
    })

    const projectProfileTool = createProjectProfileTool({ profilePath: projectProfileFile, rootDir })
    const imageReviewTool = visionProfile
      ? createImageReviewTool({
          rootDir,
          modelProfile: visionProfile,
          profilePath: projectProfileFile,
          signal: abortController.signal
        })
      : null

    const deliverTool = createDeliverTool({
      rootDir,
      onDeliver: (items) => {
        for (const item of items) {
          const idx = turnState.deliverables.findIndex((d) => d.path === item.path)
          if (idx >= 0) turnState.deliverables[idx] = item
          else turnState.deliverables.push(item)
        }
      }
    })

    const subWorkspaceTools = createWorkspaceTools({
      rootDir,
      readOnlyRoots,
      projectMemoryPath: projectMemoryFile,
      extraEnvPaths,
      protectedPptPaths,
      allowedReadPaths,
      signal: abortController.signal,
      requireApproval,
      recordToolData: () => {},
      modelSeesImages: mainSeesImages,
      describeImage: imageDescriber,
      onTodosChange: () => {}
    })

    // 子智能体能力对齐原版 SubagentMcpScope + SubagentSkills：透传 MCP 工具、规范检索与联网检索
    const subagentAllTools: DynamicStructuredTool[] = [
      ...subWorkspaceTools,
      regulationTool,
      inspirationTool,
      ...(webSearchTool ? [webSearchTool] : []),
      ...(mcpBundle?.tools ?? [])
    ]

    const asyncSub = createAsyncSubagentTools({
      rootDir,
      skillsRoot,
      modelProfile,
      parentSignal: abortController.signal,
      subTools: subagentAllTools,
      runLoop: runAgentLoop,
      onUsage: addUsage
    })
    cancelAsyncJobs = asyncSub.cancelAll

    const taskSubagentTool = new DynamicStructuredTool({
      name: 'task',
      description:
        '委派一个独立子智能体执行专项子任务（例如：深度扫描大型图纸/文档、驱动已连接的 MCP 三维软件工具、或独立查规范并编写生成脚本），返回精炼结果摘要以节省主上下文。',
      schema: z.object({
        description: z.string().min(1).describe('子任务简短标题（5~15字，展示在胶囊卡片上）'),
        prompt: z.string().min(1).describe('给子智能体的完整、自包含任务指令与文件路径'),
        role: z
          .enum(['general', 'research', 'cad-analyzer', 'modeler'])
          .optional()
          .describe('子智能体角色（用于裁剪可用工具子集）：research=只读调研/查规范；cad-analyzer=图纸与文档解析；modeler=三维MCP建模；general=全工具')
      }),
      func: async ({ prompt: subPrompt, role }, runManager, config) => {
        const parentToolCallId = resolveToolCallId(runManager, config) || currentActiveToolCallId
        const { tools: scopedSubTools, roleInstruction } = selectToolsForSubagentRole(
          role,
          subagentAllTools
        )
        const subModel = createChatModel(modelProfile, { thinking: false, isSubagent: true })
        const subHistory: BaseMessage[] = [new HumanMessage(subPrompt)]
        let subFinalText = ''

        await runAgentLoop({
          model: subModel,
          systemPrompt: `你是专注执行专项子任务的空间设计子智能体。工作目录：${rootDir.replace(/\\/g, '/')}。技能目录：${skillsRoot.replace(/\\/g, '/')}。${roleInstruction} 请返回有据可查的结论。`,
          history: subHistory,
          tools: scopedSubTools,
          signal: abortController.signal,
          maxIterations: 15,
          offloadRootDir: rootDir,
          enableAnthropicCache:
            modelProfile.protocol === 'anthropic' && modelProfile.enablePromptCache !== false,
          profile: {
            ...modelProfile,
            model: modelProfile.subagentModel?.trim() || modelProfile.model
          },
          onUsage: addUsage,
          onToken: (delta) => {
            subFinalText += delta
            post({
              type: 'subagent',
              requestId,
              threadId,
              parentToolCallId,
              event: { type: 'token', delta }
            })
          },
          onReasoning: (delta) => {
            post({
              type: 'subagent',
              requestId,
              threadId,
              parentToolCallId,
              event: { type: 'reasoning', delta }
            })
          },
          onToolStart: (id, name, args) => {
            post({
              type: 'subagent',
              requestId,
              threadId,
              parentToolCallId,
              event: { type: 'tool', id, name, args, message: toolLabel(name), delta: toolDelta(name, args) }
            })
          },
          onToolEnd: (id, name, ok, toolData) => {
            post({
              type: 'subagent',
              requestId,
              threadId,
              parentToolCallId,
              event: { type: 'tool-result', id, name, ok, toolData }
            })
          },
          takeRecordedToolData: () => null
        })

        // 只把子智能体的最终结论交回主上下文，中间过程不再整段回灌
        const finalText = lastAiText(subHistory) || subFinalText.trim().slice(-4000)
        return finalText || '子任务已执行完毕。'
      }
    })

    const allTools: DynamicStructuredTool[] = [
      ...baseTools,
      askUserTool,
      ...imageTools,
      regulationTool,
      inspirationTool,
      ...(webSearchTool ? [webSearchTool] : []),
      ...(pptWorkbenchTool ? [pptWorkbenchTool] : []),
      deliverTool,
      projectProfileTool,
      ...(imageReviewTool ? [imageReviewTool] : []),
      taskSubagentTool,
      ...asyncSub.tools
    ]
    const deferredMcp = createDeferredMcpTools(mcpBundle?.tools ?? [], allTools)
    allTools.push(...deferredMcp.initialTools)
    const finalSystemPrompt = deferredMcp.summaryHint
      ? `${systemPrompt}\n${deferredMcp.summaryHint}`
      : systemPrompt

    if (isResumeTurn) {
      await applySuspendedResolution({
        requestId,
        threadId,
        rootDir,
        history,
        pendingSuspension,
        resolution: msg.resolution,
        allTools,
        mcpTools: mcpBundle?.tools,
        signal: abortController.signal,
        setCurrentActiveToolCallId: (id) => {
          currentActiveToolCallId = id
        },
        setApprovedSuspendedCallId: (id) => {
          approvedSuspendedCallId = id
        },
        takeRecordedToolData
      })
      const cleanAfterResume = sanitizeHistoryForResume(history)
      history.splice(0, history.length, ...cleanAfterResume)
      saveRuntimeCheckpoint(transcriptPath, threadId, turnNum, history)
    }

    const loopRes = await runAgentLoop({
      model: mainModel,
      systemPrompt: finalSystemPrompt,
      history,
      tools: allTools,
      signal: abortController.signal,
      offloadRootDir: rootDir,
      enableAnthropicCache:
        modelProfile.protocol === 'anthropic' && modelProfile.enablePromptCache !== false,
      profile: modelProfile,
      onUsage: addUsage,
      compactContext: {
        rootDir,
        profile: modelProfile,
        onCompacted: () => {
          post({
            type: 'reasoning',
            requestId,
            threadId,
            delta: '\n[系统：早期长对话上下文已自动压缩并归档至 .design-agent/history-archive/]\n'
          })
        }
      },
      onToken: (delta) => {
        post({ type: 'token', requestId, threadId, delta })
      },
      onReasoning: (delta) => {
        post({ type: 'reasoning', requestId, threadId, delta })
      },
      onToolStart: (id, name, args) => {
        currentActiveToolCallId = id
        mainLoopCallIds.add(id)
        post({
          type: 'tool',
          requestId,
          threadId,
          id,
          name,
          args,
          message: toolLabel(name),
          delta: toolDelta(name, args)
        })
      },
      onToolEnd: (id, name, ok, toolData) => {
        currentActiveToolCallId = ''
        post({
          type: 'tool-result',
          requestId,
          threadId,
          id,
          name,
          ok,
          toolData
        })
      },
      takeRecordedToolData
    })

    const finalUsage = turnUsage.modelCalls > 0 ? { ...turnUsage } : undefined
    if (!loopRes.completedNaturally) {
      post({
        type: 'token',
        requestId,
        threadId,
        delta:
          '\n\n---\n⚠️ 本轮工具调用已达单轮步数上限（80 步）而自动暂停，当前生成的脚本、图片与对话上下文均已保留。请点击下方「从中断处继续」接着完成剩余步骤并交付成品。'
      })
      post({
        type: 'aborted',
        requestId,
        threadId,
        turnId,
        deliverables: turnState.deliverables,
        ...(finalUsage ? { usage: finalUsage } : {})
      })
      return
    }

    post({
      type: 'done',
      requestId,
      threadId,
      turnId,
      deliverables: turnState.deliverables,
      ...(finalUsage ? { usage: finalUsage } : {})
    })

    // 异步旁路生成「下一步建议」（不阻塞 done，对齐原版 YKs scheduleNextSuggestions）
    if (process.env.DESIGN_AGENT_NEXT_SUGGESTIONS !== '0') {
      void generateNextSuggestions({
        profile: modelProfile,
        history,
        deliverables: turnState.deliverables.map((d) => d.title)
      }).then((items) => {
        if (items.length > 0) {
          post({
            type: 'suggestions',
            requestId,
            threadId,
            turnId,
            items
          })
        }
      })
    }
  } catch (err) {
    const partialUsage = turnUsage.modelCalls > 0 ? { ...turnUsage } : undefined
    if (abortController.signal.aborted) {
      post({
        type: 'aborted',
        requestId,
        threadId,
        turnId,
        deliverables: turnState.deliverables,
        ...(partialUsage ? { usage: partialUsage } : {})
      })
    } else if (err instanceof PermissionRejectedError) {
      post({
        type: 'error',
        requestId,
        threadId,
        turnId,
        kind: 'permission-rejected',
        message: err.message,
        userMessage: err.message,
        ...(partialUsage ? { usage: partialUsage } : {})
      })
    } else {
      const errMsg = err instanceof Error ? err.message : String(err)
      post({
        type: 'error',
        requestId,
        threadId,
        turnId,
        kind: 'execution-failed',
        message: errMsg,
        userMessage: `执行出错：${errMsg}`,
        deliverables: turnState.deliverables,
        ...(partialUsage ? { usage: partialUsage } : {})
      })
    }
  } finally {
    try {
      const cleanHist = sanitizeHistoryForResume(history)
      history.splice(0, history.length, ...cleanHist)
      saveRuntimeCheckpoint(transcriptPath, threadId, turnNum, history)
      cancelAsyncJobs?.()
      await mcpBundle?.closeAll()
      await extraMcpBundle?.closeAll()
    } catch (cleanupErr) {
      console.error('[runtime] turn cleanup failed:', cleanupErr)
    } finally {
      activeTurns.delete(threadId)
    }
  }
}

onInbound((msg) => {
  switch (msg.type) {
    case 'chat':
    case 'resume_suspended_turn':
      executeTurn(msg).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        console.error('[runtime] executeTurn failed before start:', err)
        post({
          type: 'error',
          requestId: msg.requestId,
          threadId: msg.threadId,
          kind: 'execution-failed',
          message,
          userMessage: `任务启动失败：${message}`
        })
      })
      break
    case 'resume': {
      const turn = activeTurns.get(msg.threadId)
      if (turn?.pendingApproval) {
        turn.pendingApproval.resolve(msg.decision)
      }
      break
    }
    case 'user_answer': {
      const turn = activeTurns.get(msg.threadId)
      if (turn?.pendingClarification) {
        turn.pendingClarification.resolve(msg.answers)
      }
      break
    }
    case 'image_edit_answer': {
      const turn = activeTurns.get(msg.threadId)
      if (turn?.pendingImageEdit) {
        turn.pendingImageEdit.resolve(msg.answer)
      }
      break
    }
    case 'set_permission_mode':
      globalPermissionMode = msg.permissionMode
      for (const turn of activeTurns.values()) turn.permissionMode = msg.permissionMode
      break
    case 'abort': {
      const turn = activeTurns.get(msg.threadId)
      if (turn) {
        turn.abortController.abort()
        turn.pendingApproval?.reject(new Error('Aborted'))
        turn.pendingClarification?.reject(new Error('Aborted'))
        turn.pendingImageEdit?.reject(new Error('Aborted'))
      }
      break
    }
    case 'flush_pending':
      post({ type: 'flush_pending_done', requestId: msg.requestId })
      break
    case 'mcp_check':
      void checkSingleMcpServer(msg.server)
        .then((res) => post({ type: 'mcp_check_done', requestId: msg.requestId, ...res }))
        .catch((err: unknown) =>
          post({
            type: 'mcp_check_done',
            requestId: msg.requestId,
            ok: false,
            reason: err instanceof Error ? err.message : String(err)
          })
        )
      break
    case 'distill_project':
      void distillProjectMemory({
        workspacesBase: process.env.DESIGN_AGENT_WORKSPACES_DIR || join(process.cwd(), '.design-agent-workspaces'),
        projectId: msg.projectId,
        conversationId: msg.conversationId,
        transcriptPath: msg.transcriptPath,
        modelProfile: msg.modelProfile
      })
        .then((updated) =>
          post({
            type: 'distill_done',
            requestId: msg.requestId,
            projectId: msg.projectId,
            ok: true,
            updated
          })
        )
        .catch((err: unknown) => {
          console.error('[runtime] distill failed:', err)
          post({
            type: 'distill_done',
            requestId: msg.requestId,
            projectId: msg.projectId,
            ok: false,
            updated: false
          })
        })
      break
  }
})

post({ type: 'ready' })
