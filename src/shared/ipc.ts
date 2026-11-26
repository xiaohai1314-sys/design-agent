import type {
  AgentAttachment,
  AgentDecision,
  AnthropicAuthStyle,
  ApiProtocol,
  AskAnswer,
  ConversationRef,
  Deliverable,
  ImageEditAnswer,
  ImageChannelTestLevel,
  ImageChannelTestResult,
  ImageGenChannel,
  ImageGenConfig,
  ClipModelDownloadProgress,
  ClipModelStatus,
  InspirationConfig,
  InspirationRebuildProgress,
  InspirationRebuildResult,
  ModelAnnotationRef,
  ModelProviderProfile,
  PermissionMode,
  PersistedPendingInteraction,
  PptProposal,
  PptWorkbenchSelection,
  RegulationConfig,
  RuntimeOutbound,
  SceneParam,
  TodoItem,
  WebSearchConfig
} from './protocol'
import type { SelectedMcpConnector } from './mcp'
export type { FileSnapshotEntry } from './fileSnapshots'
import type { FileSnapshotEntry } from './fileSnapshots'

export const IPC_CHANNELS = {
  AgentSend: 'agent:send',
  AgentResume: 'agent:resume',
  AgentUserAnswer: 'agent:user-answer',
  AgentImageEditAnswer: 'agent:image-edit-answer',
  AgentAbort: 'agent:abort',
  AgentGetPermissionMode: 'agent:get-permission-mode',
  AgentSetPermissionMode: 'agent:set-permission-mode',
  AgentPickFiles: 'agent:pick-files',
  AgentPickFolder: 'agent:pick-folder',
  AgentSaveAnnotatedImage: 'agent:save-annotated-image',
  AgentWriteTempImage: 'agent:write-temp-image',
  AgentEvent: 'agent:event',

  WindowMinimize: 'window:minimize',
  WindowMaximizeToggle: 'window:maximize-toggle',
  WindowClose: 'window:close',
  WindowIsMaximized: 'window:is-maximized',
  WindowMaximizeChanged: 'window:maximize-changed',

  TasksList: 'tasks:list',
  TasksCreate: 'tasks:create',
  TasksGet: 'tasks:get',
  TasksRename: 'tasks:rename',
  TasksDelete: 'tasks:delete',
  TasksReadTranscript: 'tasks:read-transcript',
  TaskNotificationsOpenRequested: 'task-notifications:open-requested',

  ProjectsList: 'projects:list',
  ProjectsCreate: 'projects:create',
  ProjectsRename: 'projects:rename',
  ProjectsDelete: 'projects:delete',
  ProjectsReadMemory: 'projects:read-memory',
  ProjectsReadCharter: 'projects:read-charter',
  ProjectsSaveCharter: 'projects:save-charter',
  ProjectsReadMeta: 'projects:read-meta',
  ProjectsUpdateMeta: 'projects:update-meta',

  SettingsGetGeneral: 'settings:get-general',
  SettingsSaveGeneral: 'settings:save-general',
  RecentFilesList: 'recent-files:list',
  RecentFilesRemove: 'recent-files:remove',

  ModelsGetSettings: 'models:get-settings',
  ModelsSaveSettings: 'models:save-settings',
  ModelsDiscoverCcSwitch: 'models:discover-cc-switch',
  ModelsTestConnection: 'models:test-connection',
  ModelsTestImageChannel: 'models:test-image-channel',
  ModelsGetClipModelStatus: 'models:get-clip-model-status',
  ModelsDownloadClipModel: 'models:download-clip-model',
  ModelsClipModelDownloadProgress: 'models:clip-model-download-progress',
  ModelsRebuildInspirationIndex: 'models:rebuild-inspiration-index',
  ModelsInspirationRebuildProgress: 'models:inspiration-rebuild-progress',

  McpListConnectors: 'mcp:list-connectors',
  McpSetEnabled: 'mcp:set-enabled',
  McpCheckConnection: 'mcp:check-connection',
  McpInstallPlugin: 'mcp:install-plugin',

  CadPreviewPrepare: 'cad-preview:prepare',
  ModelPreviewPrepare: 'model-preview:prepare',

  FilesListWorkspace: 'files:list-workspace',
  FilesListLibrary: 'files:list-library',
  FilesAddLibraryFolder: 'files:add-library-folder',
  FilesRemoveLibraryFolder: 'files:remove-library-folder',
  FilesReadPreview: 'files:read-preview',
  FilesReadThumb: 'files:read-thumb',
  FilesReadBytes: 'files:read-bytes',
  FilesSaveText: 'files:save-text',
  FilesSaveAs: 'files:save-as',
  FilesListSnapshots: 'files:list-snapshots',
  FilesRestoreSnapshot: 'files:restore-snapshot',
  ClipboardWriteImage: 'clipboard:write-image',
  PptWorkbenchApplyProposal: 'ppt-workbench:apply-proposal',
  ShellOpenPath: 'shell:open-path',
  ShellShowItemInFolder: 'shell:show-item-in-folder',
  SkillsList: 'skills:list',
  RegulationStats: 'regulations:stats'
} as const

export interface ProjectSummary {
  id: string
  name: string
  folderPath: string
  createdAt: number
  updatedAt: number
}

export interface ProjectMeta {
  domain?: string
  projectType?: string
  region?: string
  area?: string
  budget?: string
  brief?: string
}

export interface RecentFileEntry {
  path: string
  name: string
  kind: 'image' | 'file'
  size?: number
  lastUsedAt: number
}

export interface LocalLibraryEntry {
  path: string
  name: string
  group: 'image' | 'cad3d' | 'doc'
  sourceLabel: 'AI 交付成果' | '近期使用文件' | '工作区成果'
  size: number
  updatedAt: number
}

export interface LocalLibrarySnapshot {
  items: LocalLibraryEntry[]
  folders: string[]
  defaultWorkspaceRoot: string
}

export interface AppGeneralSettings {
  closeToTray: boolean
  desktopNotifications: boolean
}

export interface RegulationStatsResult {
  folderPath: string
  fileCount: number
  chunkCount: number
  sampleFiles: string[]
}

export interface TaskSummary {
  id: string
  title: string
  projectId: string | null
  rootDir: string
  transcriptPath?: string
  createdAt: number
  updatedAt: number
}

export interface ToolCallRecord {
  id: string
  name: string
  message: string
  delta?: string
  args?: Record<string, unknown>
  status: 'running' | 'success' | 'error'
  toolData?: unknown
  subagentEvents?: Array<{
    type: 'token' | 'reasoning' | 'tool' | 'tool-result'
    delta?: string
    name?: string
    message?: string
    ok?: boolean
  }>
}

export type PersistedTurnItem =
  | {
      id: string
      role: 'user'
      text: string
      attachments?: AgentAttachment[]
      annotations?: ModelAnnotationRef[]
      conversationRefs?: ConversationRef[]
      mcp?: SelectedMcpConnector[]
      sceneParam?: SceneParam
      createdAt: number
    }
  | {
      id: string
      role: 'assistant'
      requestId: string
      reasoning: string
      content: string
      toolCalls: ToolCallRecord[]
      todos: TodoItem[]
      deliverables: Deliverable[]
      status: 'streaming' | 'completed' | 'aborted' | 'error'
      errorMessage?: string
      suggestions?: string[]
      pendingInteraction?: PersistedPendingInteraction
      usage?: import('./protocol').TurnUsageStats
      createdAt: number
      finishedAt?: number
    }

export interface CcSwitchCandidate {
  uid: string
  source: 'ccswitch-db' | 'claude-live' | 'codex-live'
  appType: string
  name: string
  protocol: ApiProtocol
  baseUrl: string
  apiKey: string
  maskedKey: string
  model: string
  isCurrent: boolean
  isHealthy: boolean | null
  lastError?: string
  useResponsesApi?: boolean
  authStyle?: AnthropicAuthStyle
  contextWindowTokens?: number
}

export interface ModelSettingsState {
  activeProfileId: string
  profiles: ModelProviderProfile[]
  imageGen: ImageGenConfig
  regulation: RegulationConfig
  inspiration: InspirationConfig
  webSearch?: WebSearchConfig
}

export interface SkillInfo {
  name: string
  description: string
  path: string
}

export interface WorkspaceEntry {
  name: string
  path: string
  isDirectory: boolean
  size: number
  updatedAt: number
}

export interface CadLayerInfo {
  name: string
  color: string
  visible: boolean
  entityCount: number
}

export type CadPolylineEntity = {
  kind: 'polyline'
  layer: string
  color?: string
  closed: boolean
  dashed?: boolean
  pts: Array<[number, number]>
}

export type CadCircleEntity = {
  kind: 'circle'
  layer: string
  color?: string
  cx: number
  cy: number
  r: number
}

export type CadArcEntity = {
  kind: 'arc'
  layer: string
  color?: string
  cx: number
  cy: number
  r: number
  startAngle: number
  endAngle: number
}

export type CadTextEntity = {
  kind: 'text'
  layer: string
  color?: string
  x: number
  y: number
  height: number
  rotation: number
  text: string
}

export type CadEntity = CadPolylineEntity | CadCircleEntity | CadArcEntity | CadTextEntity

export interface CadSnapPoint {
  x: number
  y: number
  kind: 'endpoint' | 'midpoint' | 'center'
  layer: string
}

export interface CadPreviewResult {
  ok: boolean
  error?: string
  layers?: CadLayerInfo[]
  entities?: CadEntity[]
  snapPoints?: CadSnapPoint[]
  bbox?: { minX: number; minY: number; maxX: number; maxY: number }
  unitLabel?: string
  entityTotal?: number
}

export interface ModelPreviewResult {
  ok: boolean
  error?: string
  glbBase64?: string
  detail?: string
}

export interface McpConnectorInfo {
  name: string
  label: string
  requirement: string
  description: string
  enabled: boolean
  available: boolean
  hostRunning: boolean
  canInstallPlugin: boolean
  pluginInstalled?: boolean
  statusText: string
}

export interface SendMessagePayload {
  threadId: string
  text: string
  rootDir?: string
  projectId?: string | null
  attachments?: AgentAttachment[]
  annotations?: ModelAnnotationRef[]
  conversationRefs?: ConversationRef[]
  pptSelection?: PptWorkbenchSelection
  sceneParam?: SceneParam
  mcp?: SelectedMcpConnector[]
  thinking?: boolean
  profileId?: string
  profile?: 'ai-scheme-v1' | 'default'
}

export interface ZmoBridgeApi {
  app?: {
    getPathForFile: (file: File) => string
  }
  window: {
    minimize: () => void
    toggleMaximize: () => void
    close: () => void
    isMaximized: () => Promise<boolean>
    onMaximizeChanged: (listener: (maximized: boolean) => void) => () => void
  }
  taskNotifications: {
    onOpenRequested: (listener: (threadId: string) => void) => () => void
  }
  settings: {
    getGeneral: () => Promise<AppGeneralSettings>
    saveGeneral: (next: AppGeneralSettings) => Promise<AppGeneralSettings>
  }
  recentFiles: {
    list: () => Promise<RecentFileEntry[]>
    remove: (path: string) => Promise<RecentFileEntry[]>
  }
  agent: {
    send: (payload: SendMessagePayload) => Promise<{ ok: boolean; requestId?: string; error?: string }>
    resume: (payload: { threadId: string; decision: AgentDecision }) => Promise<void>
    userAnswer: (payload: { threadId: string; answers: AskAnswer[] }) => Promise<void>
    imageEditAnswer: (payload: { threadId: string; id: string; answer: ImageEditAnswer }) => Promise<void>
    saveAnnotatedImage: (payload: { sourcePath: string; dataUrl: string }) => Promise<string>
    writeTempImage: (payload: { base64: string; name?: string; rootDir?: string }) => Promise<AgentAttachment>
    stop: (threadId: string) => Promise<void>
    getPermissionMode: () => Promise<PermissionMode>
    setPermissionMode: (mode: PermissionMode) => Promise<PermissionMode>
    pickFiles: () => Promise<AgentAttachment[]>
    pickFolder: () => Promise<string | null>
    onEvent: (listener: (event: RuntimeOutbound) => void) => () => void
  }
  tasks: {
    list: () => Promise<TaskSummary[]>
    create: (payload: { title?: string; projectId?: string | null; rootDir?: string }) => Promise<TaskSummary>
    rename: (threadId: string, title: string) => Promise<TaskSummary[]>
    delete: (threadId: string) => Promise<void>
    readTranscript: (threadId: string) => Promise<PersistedTurnItem[]>
  }
  projects: {
    list: () => Promise<ProjectSummary[]>
    create: (payload: { name: string; folderPath: string }) => Promise<ProjectSummary>
    rename: (projectId: string, name: string) => Promise<ProjectSummary[]>
    delete: (projectId: string) => Promise<void>
    readMemory: (projectId: string) => Promise<{ memory: string; decisions: string }>
    readCharter: (rootDir: string) => Promise<string>
    saveCharter: (rootDir: string, content: string) => Promise<void>
    readMeta: (projectId: string) => Promise<ProjectMeta>
    updateMeta: (projectId: string, meta: ProjectMeta) => Promise<ProjectMeta>
  }
  models: {
    getSettings: () => Promise<ModelSettingsState>
    saveSettings: (settings: ModelSettingsState) => Promise<ModelSettingsState>
    discoverCcSwitch: () => Promise<{ candidates: CcSwitchCandidate[]; error?: string }>
    testConnection: (
      profile: ModelProviderProfile
    ) => Promise<{
      ok: boolean
      latencyMs: number
      detail?: string
      error?: string
      resolvedBaseUrl?: string
      resolvedUseResponsesApi?: boolean
      resolvedAuthStyle?: AnthropicAuthStyle
    }>
    testImageChannel: (
      channel: ImageGenChannel,
      level: ImageChannelTestLevel
    ) => Promise<ImageChannelTestResult>
    /** 查询本地向量模型（Chinese-CLIP）状态：缺失/下载中/就绪 */
    getClipModelStatus: (modelDir: string) => Promise<ClipModelStatus>
    /** 下载向量模型到指定目录（首次使用时）；进度经 onClipModelDownloadProgress 推送 */
    downloadClipModel: (modelDir: string) => Promise<ClipModelStatus>
    onClipModelDownloadProgress: (cb: (p: ClipModelDownloadProgress) => void) => () => void
    /** 扫描灵感库目录并重建 inspiration-index.json（端口径与种子生成器一致） */
    rebuildInspirationIndex: (payload: {
      folder: string
      clipModelDir?: string
    }) => Promise<InspirationRebuildResult>
    onInspirationRebuildProgress: (cb: (p: InspirationRebuildProgress) => void) => () => void
  }
  mcp: {
    listConnectors: () => Promise<McpConnectorInfo[]>
    setEnabled: (payload: { name: string; enabled: boolean }) => Promise<McpConnectorInfo[]>
    checkConnection: (name: string) => Promise<{ ok: boolean; toolCount?: number; reason?: string }>
    installPlugin: (name: string) => Promise<{ ok: boolean; message: string }>
  }
  cadPreview: {
    prepare: (filePath: string) => Promise<CadPreviewResult>
  }
  modelPreview: {
    prepare: (filePath: string) => Promise<ModelPreviewResult>
  }
  files: {
    listWorkspace: (dirPath: string) => Promise<WorkspaceEntry[]>
    listLibrary: () => Promise<LocalLibrarySnapshot>
    addLibraryFolder: (folderPath: string) => Promise<LocalLibrarySnapshot>
    removeLibraryFolder: (folderPath: string) => Promise<LocalLibrarySnapshot>
    readPreview: (filePath: string) => Promise<{
      kind: 'text' | 'image' | 'binary'
      content?: string
      mime?: string
      size: number
    }>
    readThumb: (filePath: string) => Promise<{ ok: boolean; dataUrl?: string; error?: string }>
    readBytes: (filePath: string) => Promise<{ ok: boolean; base64?: string; size?: number; error?: string }>
    saveText: (filePath: string, content: string, rootDir?: string) => Promise<{ ok: boolean; error?: string }>
    saveAs: (filePath: string) => Promise<{ ok: boolean; savedPath?: string; canceled?: boolean; error?: string }>
    listSnapshots: (filePath: string, rootDir?: string) => Promise<FileSnapshotEntry[]>
    restoreSnapshot: (
      filePath: string,
      snapshotId: string,
      rootDir?: string
    ) => Promise<{ ok: boolean; error?: string; restoredFrom?: FileSnapshotEntry }>
  }
  clipboard: {
    writeImage: (filePath: string) => Promise<{ ok: boolean; error?: string }>
  }
  pptWorkbench: {
    applyProposal: (proposal: PptProposal) => Promise<{ ok: boolean; appliedCount: number; error?: string }>
  }
  skills: {
    list: () => Promise<SkillInfo[]>
  }
  regulations: {
    stats: () => Promise<RegulationStatsResult>
  }
  shell: {
    openPath: (targetPath: string) => Promise<string>
    showItemInFolder: (targetPath: string) => Promise<void>
  }
}
