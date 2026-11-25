import type { SelectedMcpConnector } from './mcp'
import type { FileCategory } from './fileCategory'

export interface AgentToolAction {
  name: string
  args: Record<string, unknown>
  description?: string
  toolCallId?: string
}

export interface AuthorizationRequestContext {
  authRequestId: string
  toolCallId?: string
  messageId: string
  turnNum: number
}

export type AgentDecision =
  | { type: 'approve'; scope?: 'once' | 'all' }
  | { type: 'reject'; message?: string }

export type PermissionMode = 'default' | 'auto'

export type AttachmentRole = 'project_material' | 'ppt_template'

export interface AgentAttachment {
  role?: AttachmentRole
  path: string
  name: string
  kind: 'image' | 'file'
  size?: number
}

export interface InputFile {
  role?: AttachmentRole
  path?: string
  type?: string
  name?: string
  size?: number
}

export interface SceneParam {
  toolTitle?: string
  paramValues?: Record<string, string>
}

export interface ModelAnnotationRef {
  title: string
  path: string
  count: number
  text: string
}

/** 对齐原版 conversationRef.ts：用户消息引用的历史对话胶囊 */
export interface ConversationRef {
  title: string
  path: string
}

export type DeliverableKind = FileCategory

export interface Deliverable {
  path: string
  title: string
  kind: DeliverableKind
  size?: number
}

export interface AskQuestion {
  question: string
  type: 'single_select' | 'multi_select'
  options: string[]
}

export interface AskAnswer {
  question: string
  selected: string[]
  text?: string
}

export interface AskUserToolData {
  kind: 'ask_user'
  questions: AskQuestion[]
  answers: AskAnswer[]
}

export interface AskImageEditToolData {
  kind: 'ask_image_edit'
  hint: string
  sourcePath: string
  editedPath?: string
  result: 'confirmed' | 'cancelled'
}

export interface GenerateImageToolData {
  kind: 'generate_image'
  prompt: string
  imagePath: string
  referenceImagePath?: string
}

export interface RegulationChunk {
  cite: string
  standardName: string
  standardNo: string
  clauseId: string
  text: string
  explanation?: string
  validityStatus: string
  isMandatory?: boolean
  sourceFile?: string
}

export interface RegulationToolData {
  kind: 'regulation_chunks'
  queriesUsed: string[]
  total: number
  retrievedChunks: RegulationChunk[]
}

export interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

export interface WriteTodosToolData {
  kind: 'write_todos'
  todos: TodoItem[]
}

export type ImageEditAnswer = { action: 'confirm'; imagePath: string } | { action: 'cancel' }

export type ApiProtocol = 'openai' | 'anthropic'
export type AnthropicAuthStyle = 'auto' | 'bearer' | 'x-api-key'

export interface ModelProviderProfile {
  id: string
  label: string
  protocol: ApiProtocol
  authStyle?: AnthropicAuthStyle
  baseUrl: string
  apiKey: string
  model: string
  subagentModel?: string
  supportsThinking?: boolean
  enablePromptCache?: boolean
  useResponsesApi?: boolean
  contextWindowTokens?: number
  maxOutputTokens?: number
}

export interface ImageGenConfig {
  enabled: boolean
  baseUrl: string
  apiKey: string
  model: string
  editModel?: string
  defaultSize?: string
}

export interface RegulationConfig {
  folderPath: string
}

export interface WebSearchConfig {
  enabled: boolean
  provider: 'duckduckgo' | 'tavily' | 'bocha'
  apiKey?: string
}

export interface WebSearchResultItem {
  title: string
  url: string
  snippet: string
}

export interface WebSearchToolData {
  kind: 'web_search'
  query: string
  provider: string
  results: WebSearchResultItem[]
}

export type PptReference =
  | { kind: 'slide'; slideId: string }
  | { kind: 'element'; slideId: string; elementId: string }

export interface PptWorkbenchSelection {
  documentPath: string
  currentSlideId: string
  references: PptReference[]
  referenceLabels?: string[]
}

export interface PptOperation {
  op: 'update_text' | 'update_style' | 'add_note'
  slideId: string
  elementId?: string
  text?: string
  colorHex?: string
  fontSizePt?: number
  bold?: boolean
  note?: string
}

export interface PptProposal {
  proposalId: string
  pptPath: string
  summary: string
  operations: PptOperation[]
  status: 'pending' | 'accepted' | 'rejected'
  createdAt: number
}

export interface PptWorkbenchToolData {
  kind: 'ppt_workbench'
  action: 'read' | 'suggest' | 'snapshot'
  summary?: string
  slideCount?: number
  operationCount?: number
}

export interface McpHostState {
  state: 'ready' | 'plugin-missing' | 'host-not-running' | 'handshake-failed'
  hostRunning?: boolean
  pluginInstalled?: boolean
  reason?: string
}

export interface RuntimeMcpServerSpec {
  name: string
  label: string
  description: string
  command: string
  args: string[]
  env?: Record<string, string>
  hostState?: McpHostState
}

export interface SelectedModel {
  provider: string
  model: string
  label: string
}

export type SubagentStreamEvent =
  | { type: 'token'; delta: string }
  | { type: 'reasoning'; delta: string }
  | {
      type: 'tool'
      id?: string
      name: string
      args?: Record<string, unknown>
      message: string
      delta?: string
    }
  | {
      type: 'tool-result'
      id?: string
      name: string
      ok: boolean
      toolData: unknown
      delta?: string
    }

export type AgentErrorKind = 'execution-failed' | 'permission-rejected' | 'preflight'

export type PersistedPendingInteraction =
  | {
      kind: 'interrupt'
      requestId: string
      actions: AgentToolAction[]
      authorization: AuthorizationRequestContext
      message: string
      delta?: string
    }
  | {
      kind: 'ask_user'
      requestId: string
      id?: string
      questions: AskQuestion[]
      interaction?: 'host-readiness'
    }
  | {
      kind: 'ask_image_edit'
      requestId: string
      id: string
      hint: string
      imagePath: string
    }

export type RuntimeInbound =
  | {
      type: 'chat'
      requestId: string
      threadId: string
      text: string
      rootDir: string
      projectId: string | null
      filelist?: InputFile[]
      sceneParam?: SceneParam
      mcp?: SelectedMcpConnector[]
      mcpServers?: RuntimeMcpServerSpec[]
      annotations?: ModelAnnotationRef[]
      conversationRefs?: ConversationRef[]
      pptSelection?: PptWorkbenchSelection
      transcriptPath?: string
      thinking?: boolean
      permissionMode?: PermissionMode
      modelProfile: ModelProviderProfile
      imageGenConfig?: ImageGenConfig
      regulationFolder?: string
      webSearchConfig?: WebSearchConfig
      profile?: 'ai-scheme-v1' | 'default'
    }
  | {
      type: 'resume_suspended_turn'
      requestId: string
      threadId: string
      rootDir: string
      projectId: string | null
      transcriptPath: string
      mcpServers?: RuntimeMcpServerSpec[]
      thinking?: boolean
      permissionMode?: PermissionMode
      modelProfile: ModelProviderProfile
      imageGenConfig?: ImageGenConfig
      regulationFolder?: string
      webSearchConfig?: WebSearchConfig
      profile?: 'ai-scheme-v1' | 'default'
      resolution:
        | { kind: 'interrupt'; decision: AgentDecision }
        | { kind: 'ask_user'; answers: AskAnswer[] }
        | { kind: 'ask_image_edit'; id: string; answer: ImageEditAnswer }
    }
  | { type: 'resume'; requestId: string; threadId: string; decision: AgentDecision }
  | { type: 'set_permission_mode'; permissionMode: PermissionMode }
  | { type: 'user_answer'; requestId: string; threadId: string; answers: AskAnswer[] }
  | {
      type: 'image_edit_answer'
      requestId: string
      threadId: string
      id: string
      answer: ImageEditAnswer
    }
  | { type: 'abort'; requestId: string; threadId: string }
  | { type: 'flush_pending'; requestId: string }
  | { type: 'mcp_check'; requestId: string; server: RuntimeMcpServerSpec }
  | {
      type: 'distill_project'
      requestId: string
      projectId: string
      conversationId: string
      transcriptPath: string
      modelProfile: ModelProviderProfile
    }

export type RuntimeOutbound =
  | { type: 'ready' }
  | { type: 'flush_pending_done'; requestId: string }
  | { type: 'mcp_check_done'; requestId: string; ok: boolean; toolCount?: number; reason?: string }
  | { type: 'distill_done'; requestId: string; projectId: string; ok: boolean; updated: boolean }
  | { type: 'newchat'; requestId: string; threadId: string; title: string }
  | { type: 'user-persisted'; requestId: string; threadId: string }
  | { type: 'token'; requestId: string; threadId: string; delta: string }
  | { type: 'reasoning'; requestId: string; threadId: string; delta: string }
  | {
      type: 'tool'
      requestId: string
      threadId: string
      id?: string
      name: string
      args?: Record<string, unknown>
      message: string
      delta?: string
    }
  | {
      type: 'tool-result'
      requestId: string
      threadId: string
      id?: string
      name: string
      ok: boolean
      toolData: unknown
      delta?: string
    }
  | {
      type: 'subagent'
      requestId: string
      threadId: string
      parentToolCallId: string
      event: SubagentStreamEvent
    }
  | {
      type: 'interrupt'
      requestId: string
      threadId: string
      actions: AgentToolAction[]
      authorization: AuthorizationRequestContext
      message: string
      delta?: string
    }
  | {
      type: 'ask_image_edit'
      requestId: string
      threadId: string
      id: string
      hint: string
      imagePath: string
    }
  | {
      type: 'ask_user'
      requestId: string
      threadId: string
      id?: string
      questions: AskQuestion[]
      interaction?: 'host-readiness'
    }
  | { type: 'ppt_proposal'; requestId: string; threadId: string; proposal: PptProposal }
  | { type: 'usage'; requestId: string; threadId: string; usage: TurnUsageStats }
  | {
      type: 'done'
      requestId: string
      threadId: string
      turnId?: string
      deliverables: Deliverable[]
      usage?: TurnUsageStats
    }
  | { type: 'suggestions'; requestId: string; threadId: string; turnId: string; items: string[] }
  | {
      type: 'aborted'
      requestId: string
      threadId: string
      turnId?: string
      deliverables: Deliverable[]
      usage?: TurnUsageStats
    }
  | {
      type: 'error'
      requestId: string
      threadId: string
      turnId?: string
      kind: AgentErrorKind
      message: string
      userMessage?: string
      deliverables?: Deliverable[]
      usage?: TurnUsageStats
    }

export interface TurnUsageStats {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  totalTokens: number
  modelCalls: number
  model?: string
}
