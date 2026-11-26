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
  /** 任务目录 featureCode（如 B4.4）；目录提交时由 compose 写入，供生图渠道按任务路由使用 */
  featureCode?: string
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
  /** 实际出图的渠道名（多渠道降级链中命中的渠道） */
  channelName?: string
  /** 实际出图的模型名 */
  model?: string
}

export interface RegulationChunk {
  cite: string
  standardName: string
  standardNo: string
  clauseId: string
  pageNo?: number
  text: string
  explanation?: string
  validityStatus: string
  supersededBy?: string
  warningText?: string
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
  /** 由 CC Switch 导入时记录候选 uid：真实 Key 只在主进程按 uid 解析，不落到界面 */
  ccUid?: string
  model: string
  subagentModel?: string
  supportsThinking?: boolean
  enablePromptCache?: boolean
  useResponsesApi?: boolean
  contextWindowTokens?: number
  maxOutputTokens?: number
}

/**
 * 生图协议偏好：
 * - auto：按模型名猜测（gemini/nano-banana 类走 /chat/completions 优先，其余走 /images/* 优先）
 * - chat-first：强制 /chat/completions 优先
 * - images-first：强制 /images/generations|edits 优先
 */
export type ImageChannelProtocol = 'auto' | 'chat-first' | 'images-first'

/** 生图渠道擅长方向，供按任务路由排序（未声明时按配置顺序兜底） */
export type ImageChannelRole = 'generate' | 'edit'

export interface ImageGenChannel {
  id: string
  name: string
  enabled: boolean
  baseUrl: string
  apiKey: string
  /** 从 CC Switch 候选一键填入时记录 uid，真实 Key 由主进程解析 */
  ccUid?: string
  model: string
  editModel?: string
  protocol: ImageChannelProtocol
  defaultSize?: string
  roles?: ImageChannelRole[]
}

export interface ImageGenConfig {
  enabled: boolean
  baseUrl: string
  apiKey: string
  /** 从 CC Switch 候选一键填入时记录 uid，真实 Key 由主进程解析 */
  ccUid?: string
  model: string
  editModel?: string
  defaultSize?: string
  /**
   * 多渠道列表（按顺序即降级链顺序）。channels[0] 与上方平铺字段互为镜像（主渠道），
   * 旧版单槽配置在 store 加载时自动迁移为一条渠道，见 @shared/imageChannels。
   */
  channels?: ImageGenChannel[]
}

/** 生图渠道连通性测试级别：probe = 轻量探活（免费）；generate = 真实出图（消耗一次出图调用） */
export type ImageChannelTestLevel = 'probe' | 'generate'

export interface ImageChannelTestResult {
  ok: boolean
  level: ImageChannelTestLevel
  latencyMs: number
  /** 成功时的补充说明（如命中模型、返回图片大小） */
  detail?: string
  /** 硬失败原因（网络/DNS/超时/鉴权 401 等，可判定为渠道不可用） */
  error?: string
  /**
   * 软提示：探活未能完成确认，但不代表出图不可用——典型如中转未开放 /models 接口，
   * 或模型列表不完整未列出目标模型。与 error 互斥语义：有 warning 时不应直接判定渠道坏死。
   */
  warning?: string
}

export interface RegulationConfig {
  folderPath: string
}

/** 灵感/素材库配置：folderPath 指向含 inspiration-index.json 的本地目录（与 RegulationConfig 同构） */
export interface InspirationConfig {
  folderPath: string
  /**
   * 本地向量模型（Chinese-CLIP ViT-B/16 ONNX）目录：含 model_fp16.onnx 与 vocab.txt。
   * 缺省为 userData/models/chinese-clip-vit-b16（store 填充）；模型缺失时灵感检索自动退化为纯关键词。
   */
  clipModelDir?: string
}

/** 本地向量模型文件清单中的一项（状态查询用） */
export interface ClipModelFileStatus {
  name: string
  present: boolean
  sizeBytes?: number
}

/** 本地向量模型状态（设置页「本地向量模型」区块） */
export interface ClipModelStatus {
  /** missing = 关键文件不全；downloading = 正在下载；ready = 可加载 */
  state: 'missing' | 'downloading' | 'ready'
  modelDir: string
  files: ClipModelFileStatus[]
  /** 已就绪/已下载文件的总字节数 */
  sizeBytes: number
  /** state=downloading 时的进度 */
  download?: { file: string; downloadedBytes: number; totalBytes: number }
}

/** 向量模型下载进度事件（主进程 → 渲染进程） */
export interface ClipModelDownloadProgress {
  file: string
  downloadedBytes: number
  totalBytes: number
  /** 全部文件合计进度 0~1 */
  overallRatio: number
}

/** 应用内重建灵感索引的结果（设置页「重建索引」按钮） */
export interface InspirationRebuildResult {
  ok: boolean
  folder: string
  recordCount: number
  recipeCount: number
  assetCount: number
  /** 成功算出文本/图像向量的记录数 */
  textVectorCount: number
  imageVectorCount: number
  /** 是否算了向量（模型未下载时为 false，索引仅含关键词元数据） */
  vectorsComputed: boolean
  /** 逐文件错误（已截断，完整计数见 errorCount） */
  errors: { path: string; error: string }[]
  errorCount: number
  elapsedMs: number
  error?: string
}

/** 重建索引进度事件（主进程 → 渲染进程） */
export interface InspirationRebuildProgress {
  phase: 'scan' | 'text-vectors' | 'image-vectors' | 'write'
  done: number
  total: number
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

/**
 * 灵感/素材库统一索引记录（inspiration-index.json 内 records 的元素）。
 * localPath 相对索引文件所在目录，素材文件本体不搬动、只在索引里引用。
 */
export interface InspirationIndexRecord {
  id: string
  /** recipe = 建筑参考图 + 生图配方；asset = 3D 模型 / 贴图 / HDRI 素材 */
  kind: 'recipe' | 'asset'
  title: string
  tags: string[]
  /** 配方风格：photo / render 等（仅 recipe） */
  style?: string
  /** 建筑类型：villa_house / cityscape / highrise / traditional / futuristic / commercial / public / rural / other_arch（仅 recipe） */
  buildingType?: string
  /** 生图提示词原文（仅 recipe） */
  prompt?: string
  /** 相对灵感库目录的本地文件路径（参考图或素材文件，可为目录如贴图集） */
  localPath?: string
  /** 远程来源页 / 原图 URL */
  sourceUrl?: string
  /** 来源说明（如素材出处、配方库名称） */
  source: string
  /** 文本向量（base64 Float32Array，512 维，Chinese-CLIP）；索引 v2 起可选，缺失时该条只走关键词打分 */
  textVector?: string
  /** 图像向量（base64 Float32Array，512 维）；配方参考图/贴图预览图才有 */
  imageVector?: string
}

export interface InspirationHit {
  id: string
  kind: 'recipe' | 'asset'
  title: string
  score: number
  style?: string
  buildingType?: string
  prompt?: string
  /** 解析后的本机绝对路径（文件不存在时不下发，改走 sourceUrl） */
  filePath?: string
  sourceUrl?: string
  source: string
  tags: string[]
}

export interface InspirationToolData {
  kind: 'search_inspiration'
  query: string
  /** 本地命中总数（截断前） */
  total: number
  localHits: InspirationHit[]
  /** 本次是否用上了向量（语义/以图搜图）混合打分；模型未下载或索引无向量时为 false */
  vectorUsed?: boolean
  /** 本地不足时是否走了联网兜底 */
  webFallbackUsed: boolean
  webProvider?: string
  webResults?: WebSearchResultItem[]
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

export type AgentErrorKind = 'execution-failed' | 'permission-rejected' | 'preflight' | 'runtime-crashed'

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
      inspirationFolder?: string
      clipModelDir?: string
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
      inspirationFolder?: string
      clipModelDir?: string
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
