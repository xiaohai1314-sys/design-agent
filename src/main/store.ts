import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  AppGeneralSettings,
  LocalLibraryEntry,
  LocalLibrarySnapshot,
  ModelSettingsState,
  PersistedTurnItem,
  ProjectMeta,
  ProjectSummary,
  RecentFileEntry,
  RegulationStatsResult,
  TaskSummary
} from '@shared/ipc'
import type {
  AgentAttachment,
  ConversationRef,
  ImageGenConfig,
  ModelAnnotationRef,
  PermissionMode,
  RegulationConfig,
  RuntimeOutbound,
  SceneParam,
  TodoItem,
  WebSearchConfig,
  WriteTodosToolData
} from '@shared/protocol'
import type { SelectedMcpConnector } from '@shared/mcp'
import { inheritInterruptedTodos, settleCompletedTodos } from '@shared/todoUtils'

function readJsonSafe<T>(filePath: string, fallback: T): T {
  try {
    if (!existsSync(filePath)) return fallback
    return JSON.parse(readFileSync(filePath, 'utf8')) as T
  } catch {
    return fallback
  }
}

function writeJsonAtomic(filePath: string, data: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true })
  const tmp = `${filePath}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8')
  try {
    rmSync(tmp, { force: true })
  } catch {
    // ignore
  }
}

export class LocalAppStore {
  private readonly baseDir: string
  private readonly workspacesDir: string
  private readonly defaultWorkspaceRoot: string
  private readonly defaultRegulationDir: string
  private readonly regIndexerExe: string

  constructor(
    userDataDir: string,
    defaultProjectsHome: string,
    bundledResourcesDir: string
  ) {
    this.baseDir = userDataDir
    this.workspacesDir = join(userDataDir, 'workspaces')
    this.defaultWorkspaceRoot = join(defaultProjectsHome, 'DesignAgentProjects', 'default-workspace')
    const bundledReg = join(bundledResourcesDir, 'regulations')
    const userReg = join(userDataDir, 'regulations')
    this.defaultRegulationDir = existsSync(bundledReg) ? bundledReg : userReg
    this.regIndexerExe = join(bundledResourcesDir, 'runtime', 'reg-indexer.exe')
    mkdirSync(this.workspacesDir, { recursive: true })
    mkdirSync(this.defaultWorkspaceRoot, { recursive: true })
    mkdirSync(this.defaultRegulationDir, { recursive: true })
  }

  getWorkspacesDir(): string {
    return this.workspacesDir
  }

  getDefaultWorkspaceRoot(): string {
    return this.defaultWorkspaceRoot
  }

  private settingsPath(): string {
    return join(this.baseDir, 'app-settings.json')
  }

  getPermissionMode(): PermissionMode {
    const data = readJsonSafe<{ permissionMode?: PermissionMode }>(this.settingsPath(), {})
    return data.permissionMode === 'auto' ? 'auto' : 'default'
  }

  setPermissionMode(mode: PermissionMode): PermissionMode {
    const cur = readJsonSafe<Record<string, unknown>>(this.settingsPath(), {})
    writeJsonAtomic(this.settingsPath(), { ...cur, permissionMode: mode })
    return mode
  }

  getGeneralSettings(): AppGeneralSettings {
    const cur = readJsonSafe<{ general?: Partial<AppGeneralSettings> }>(this.settingsPath(), {})
    return {
      closeToTray: cur.general?.closeToTray ?? false,
      desktopNotifications: cur.general?.desktopNotifications ?? true
    }
  }

  saveGeneralSettings(next: AppGeneralSettings): AppGeneralSettings {
    const cur = readJsonSafe<Record<string, unknown>>(this.settingsPath(), {})
    const normalized: AppGeneralSettings = {
      closeToTray: Boolean(next.closeToTray),
      desktopNotifications: Boolean(next.desktopNotifications)
    }
    writeJsonAtomic(this.settingsPath(), { ...cur, general: normalized })
    return normalized
  }

  private modelSettingsPath(): string {
    return join(this.baseDir, 'model-settings.json')
  }

  getModelSettings(): ModelSettingsState {
    const defaultImageGen: ImageGenConfig = {
      enabled: false,
      baseUrl: 'https://api.siliconflow.cn/v1',
      apiKey: process.env.IMAGE_GEN_API_KEY ?? '',
      model: 'Kwai-Kolors/Kolors',
      editModel: '',
      defaultSize: '1024x1024'
    }
    const defaultRegulation: RegulationConfig = {
      folderPath: this.defaultRegulationDir
    }
    const defaultWebSearch: WebSearchConfig = {
      enabled: true,
      provider: 'duckduckgo',
      apiKey: ''
    }
    // 启动时不再预置未填写 Key 的默认模型模板，仅保留通过环境变量显式配置的内置渠道
    const builtinTemplateIds = new Set([
      'deepseek-default',
      'dashscope-qwen',
      'openai-compatible',
      'anthropic-claude'
    ])
    const envProfiles: ModelSettingsState['profiles'] = [
      {
        id: 'deepseek-default',
        label: 'DeepSeek (OpenAI 兼容)',
        protocol: 'openai' as const,
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: process.env.DEEPSEEK_API_KEY ?? '',
        model: 'deepseek-chat',
        subagentModel: 'deepseek-chat',
        supportsThinking: true,
        maxOutputTokens: 8192
      },
      {
        id: 'dashscope-qwen',
        label: '通义千问 DashScope',
        protocol: 'openai' as const,
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        apiKey: process.env.DASHSCOPE_API_KEY ?? '',
        model: 'qwen-plus',
        subagentModel: 'qwen-turbo',
        supportsThinking: true,
        maxOutputTokens: 16384
      },
      {
        id: 'openai-compatible',
        label: 'OpenAI / 自定义中转站',
        protocol: 'openai' as const,
        baseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
        apiKey: process.env.OPENAI_API_KEY ?? '',
        model: 'gpt-4o',
        subagentModel: 'gpt-4o-mini',
        supportsThinking: false,
        maxOutputTokens: 16384
      },
      {
        id: 'anthropic-claude',
        label: 'Anthropic Claude',
        protocol: 'anthropic' as const,
        baseUrl: process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com',
        apiKey: process.env.ANTHROPIC_API_KEY ?? '',
        model: 'claude-sonnet-4-20250514',
        subagentModel: 'claude-sonnet-4-20250514',
        supportsThinking: true,
        maxOutputTokens: 16384
      }
    ].filter((p) => Boolean(p.apiKey.trim()))

    const defaultProfiles: ModelSettingsState = {
      activeProfileId: envProfiles[0]?.id ?? '',
      imageGen: defaultImageGen,
      regulation: defaultRegulation,
      webSearch: defaultWebSearch,
      profiles: envProfiles
    }
    const saved = readJsonSafe<ModelSettingsState | null>(this.modelSettingsPath(), null)
    if (!saved || !Array.isArray(saved.profiles)) {
      writeJsonAtomic(this.modelSettingsPath(), defaultProfiles)
      return defaultProfiles
    }
    const cleanedProfiles = saved.profiles.filter(
      (p) => !(builtinTemplateIds.has(p.id) && !p.apiKey?.trim())
    )
    const resolvedActiveId = cleanedProfiles.some((p) => p.id === saved.activeProfileId)
      ? saved.activeProfileId
      : (cleanedProfiles[0]?.id ?? '')
    const next: ModelSettingsState = {
      ...saved,
      activeProfileId: resolvedActiveId,
      profiles: cleanedProfiles,
      imageGen: saved.imageGen ?? defaultImageGen,
      regulation: saved.regulation ?? defaultRegulation,
      webSearch: saved.webSearch ?? defaultWebSearch
    }
    if (
      cleanedProfiles.length !== saved.profiles.length ||
      resolvedActiveId !== saved.activeProfileId
    ) {
      writeJsonAtomic(this.modelSettingsPath(), next)
    }
    return next
  }

  saveModelSettings(settings: ModelSettingsState): ModelSettingsState {
    writeJsonAtomic(this.modelSettingsPath(), settings)
    return settings
  }

  getRegulationStats(): RegulationStatsResult {
    const folderPath = this.getModelSettings().regulation?.folderPath || this.defaultRegulationDir
    const sampleFiles: string[] = []
    let fileCount = 0
    let chunkCount = 0

    const walk = (dir: string): void => {
      if (!dir || !existsSync(dir)) return
      try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (entry.name.startsWith('.')) continue
          const full = join(dir, entry.name)
          if (entry.isDirectory()) {
            walk(full)
          } else if (entry.isFile()) {
            const ext = extname(entry.name).toLowerCase()
            if (['.json', '.md', '.txt', '.pdf'].includes(ext)) {
              fileCount += 1
              if (sampleFiles.length < 12) sampleFiles.push(entry.name)
              if (ext === '.json') {
                const parsed = readJsonSafe<unknown>(full, null)
                if (Array.isArray(parsed)) {
                  chunkCount += parsed.length
                } else if (parsed && typeof parsed === 'object') {
                  const obj = parsed as { citations?: unknown[]; chunks?: unknown[] }
                  if (Array.isArray(obj.citations)) chunkCount += obj.citations.length
                  else if (Array.isArray(obj.chunks)) chunkCount += obj.chunks.length
                }
              } else {
                chunkCount += 1
              }
            }
          }
        }
      } catch {
        // ignore unreadable dir
      }
    }
    walk(folderPath)

    const dbPath = join(folderPath, '.zmo-reg-index.db')
    if (existsSync(dbPath) && existsSync(this.regIndexerExe)) {
      try {
        const raw = execFileSync(this.regIndexerExe, ['stats', '--db', dbPath], {
          timeout: 2500,
          encoding: 'utf8',
          windowsHide: true
        })
        const dbStats = JSON.parse(raw) as { totalPages?: number }
        if (typeof dbStats.totalPages === 'number' && dbStats.totalPages > chunkCount) {
          chunkCount = dbStats.totalPages
        }
      } catch {
        // fallback to file-walk count
      }
    }
    return { folderPath, fileCount, chunkCount, sampleFiles }
  }

  private projectsPath(): string {
    return join(this.baseDir, 'projects.json')
  }

  listProjects(): ProjectSummary[] {
    return readJsonSafe<ProjectSummary[]>(this.projectsPath(), []).sort((a, b) => b.updatedAt - a.updatedAt)
  }

  createProject(name: string, folderPath: string): ProjectSummary {
    const list = this.listProjects()
    mkdirSync(folderPath, { recursive: true })
    const now = Date.now()
    const item: ProjectSummary = {
      id: randomUUID(),
      name: name.trim() || '未命名设计项目',
      folderPath,
      createdAt: now,
      updatedAt: now
    }
    list.unshift(item)
    writeJsonAtomic(this.projectsPath(), list)
    return item
  }

  deleteProject(projectId: string): void {
    const list = this.listProjects().filter((p) => p.id !== projectId)
    writeJsonAtomic(this.projectsPath(), list)
  }

  renameProject(projectId: string, name: string): ProjectSummary[] {
    const list = this.listProjects()
    const target = list.find((p) => p.id === projectId)
    if (target && name.trim()) {
      target.name = name.trim()
      target.updatedAt = Date.now()
      writeJsonAtomic(this.projectsPath(), list)
    }
    return this.listProjects()
  }

  readProjectMeta(projectId: string): ProjectMeta {
    return readJsonSafe<ProjectMeta>(join(this.workspacesDir, projectId, 'project-meta.json'), {})
  }

  updateProjectMeta(projectId: string, meta: ProjectMeta): ProjectMeta {
    const file = join(this.workspacesDir, projectId, 'project-meta.json')
    writeJsonAtomic(file, meta)
    // 同步项目结构化摘要到 ZNZMO.md 开头（或保持单独文件并在下方汇总）
    return meta
  }

  private recentFilesPath(): string {
    return join(this.baseDir, 'recent-files.json')
  }

  listRecentFiles(): RecentFileEntry[] {
    return readJsonSafe<RecentFileEntry[]>(this.recentFilesPath(), [])
      .filter((f) => f.path && existsSync(f.path))
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
      .slice(0, 30)
  }

  addRecentFiles(entries: Array<Omit<RecentFileEntry, 'lastUsedAt'>>): void {
    if (entries.length === 0) return
    const now = Date.now()
    const map = new Map<string, RecentFileEntry>()
    for (const cur of this.listRecentFiles()) {
      map.set(cur.path.toLowerCase(), cur)
    }
    for (const e of entries) {
      if (!e.path || !existsSync(e.path)) continue
      map.set(e.path.toLowerCase(), { ...e, lastUsedAt: now })
    }
    const sorted = [...map.values()].sort((a, b) => b.lastUsedAt - a.lastUsedAt).slice(0, 30)
    writeJsonAtomic(this.recentFilesPath(), sorted)
  }

  removeRecentFile(targetPath: string): RecentFileEntry[] {
    const next = this.listRecentFiles().filter(
      (f) => f.path.toLowerCase() !== targetPath.toLowerCase()
    )
    writeJsonAtomic(this.recentFilesPath(), next)
    return next
  }

  getLibraryFolders(): string[] {
    const cur = readJsonSafe<{ libraryFolders?: unknown }>(this.settingsPath(), {})
    if (!Array.isArray(cur.libraryFolders)) return []
    const seen = new Set<string>()
    const out: string[] = []
    for (const raw of cur.libraryFolders) {
      if (typeof raw !== 'string' || !raw.trim()) continue
      const resolved = resolve(raw.trim())
      const key = resolved.toLowerCase()
      if (!seen.has(key) && existsSync(resolved)) {
        seen.add(key)
        out.push(resolved)
      }
    }
    return out
  }

  addLibraryFolder(folderPath: string): LocalLibrarySnapshot {
    const cleaned = folderPath?.trim()
    if (cleaned && existsSync(cleaned)) {
      const resolved = resolve(cleaned)
      const cur = readJsonSafe<Record<string, unknown>>(this.settingsPath(), {})
      const existing = this.getLibraryFolders()
      if (!existing.some((d) => d.toLowerCase() === resolved.toLowerCase())) {
        writeJsonAtomic(this.settingsPath(), {
          ...cur,
          libraryFolders: [...existing, resolved]
        })
      }
    }
    return this.scanLocalLibrary()
  }

  removeLibraryFolder(folderPath: string): LocalLibrarySnapshot {
    const resolved = resolve(folderPath).toLowerCase()
    const cur = readJsonSafe<Record<string, unknown>>(this.settingsPath(), {})
    const next = this.getLibraryFolders().filter((d) => d.toLowerCase() !== resolved)
    writeJsonAtomic(this.settingsPath(), { ...cur, libraryFolders: next })
    return this.scanLocalLibrary()
  }

  scanLocalLibrary(): LocalLibrarySnapshot {
    const imageExts = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg'])
    const cad3dExts = new Set(['.dwg', '.dxf', '.skp', '.3dm', '.glb', '.gltf', '.obj', '.fbx', '.stl'])
    const docExts = new Set(['.pptx', '.potx', '.pdf', '.xlsx', '.xls', '.xlsm', '.docx', '.doc', '.md'])

    const classifyExt = (filePath: string, kindHint?: string): 'image' | 'cad3d' | 'doc' | null => {
      const ext = extname(filePath).toLowerCase()
      if (imageExts.has(ext) || kindHint === 'image') return 'image'
      if (cad3dExts.has(ext)) return 'cad3d'
      if (docExts.has(ext)) return 'doc'
      return null
    }

    const byPath = new Map<string, LocalLibraryEntry>()
    const sourceRank: Record<LocalLibraryEntry['sourceLabel'], number> = {
      'AI 交付成果': 3,
      '近期使用文件': 2,
      '工作区成果': 1
    }

    const upsert = (
      filePath: string,
      nameHint: string | undefined,
      group: 'image' | 'cad3d' | 'doc',
      sourceLabel: LocalLibraryEntry['sourceLabel'],
      sizeHint?: number,
      mtimeHint?: number
    ): void => {
      if (!filePath || !existsSync(filePath)) return
      const resolved = resolve(filePath)
      const key = resolved.toLowerCase()
      let size = sizeHint ?? 0
      let updatedAt = mtimeHint ?? 0
      if (!size || !updatedAt) {
        try {
          const st = statSync(resolved)
          if (!st.isFile()) return
          size = st.size
          updatedAt = st.mtimeMs
        } catch {
          return
        }
      }
      const existing = byPath.get(key)
      if (!existing || sourceRank[sourceLabel] > sourceRank[existing.sourceLabel]) {
        byPath.set(key, {
          path: resolved,
          name: nameHint?.trim() || basename(resolved),
          group,
          sourceLabel,
          size,
          updatedAt: Math.max(updatedAt, existing?.updatedAt ?? 0)
        })
      }
    }

    // 1) 从磁盘历史会话记录提取 AI 交付成果（即使未在内存中点开对话）
    try {
      const buckets = readdirSync(this.workspacesDir, { withFileTypes: true })
      for (const bucket of buckets) {
        if (!bucket.isDirectory()) continue
        const convDir = join(this.workspacesDir, bucket.name, 'conversations')
        if (!existsSync(convDir)) continue
        const threads = readdirSync(convDir, { withFileTypes: true })
        for (const th of threads) {
          if (!th.isDirectory()) continue
          const tPath = join(convDir, th.name, 'transcript.json')
          const turns = readJsonSafe<PersistedTurnItem[]>(tPath, [])
          for (const turn of turns) {
            if (turn.role !== 'assistant' || !Array.isArray(turn.deliverables)) continue
            for (const d of turn.deliverables) {
              if (!d?.path) continue
              const group = classifyExt(d.path, d.kind)
              if (!group) continue
              upsert(d.path, d.title || basename(d.path), group, 'AI 交付成果', d.size)
            }
          }
        }
      }
    } catch {
      // ignore transcript scan failures
    }

    // 2) 合并近期使用文件
    for (const rf of this.listRecentFiles()) {
      const group = classifyExt(rf.path, rf.kind)
      if (!group) continue
      upsert(rf.path, rf.name, group, '近期使用文件', rf.size, rf.lastUsedAt)
    }

    // 3) 扫描默认工作区根目录、已配置项目目录及用户添加的本地资料目录
    const folders = this.getLibraryFolders()
    const scanRoots = new Map<string, string>()
    const projectsRoot = dirname(this.defaultWorkspaceRoot)
    const candidateRoots = [
      existsSync(projectsRoot) ? projectsRoot : this.defaultWorkspaceRoot,
      ...this.listProjects().map((p) => p.folderPath),
      ...folders
    ]
    for (const r of candidateRoots) {
      if (!r || !existsSync(r)) continue
      const resolved = resolve(r)
      scanRoots.set(resolved.toLowerCase(), resolved)
    }

    const skipDirs = new Set(['.git', 'node_modules', '.zmo', '__pycache__', '.venv', 'dist'])
    let scannedCount = 0
    const MAX_FILES = 400

    const walk = (dir: string, depth: number): void => {
      if (depth > 4 || scannedCount >= MAX_FILES) return
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (scannedCount >= MAX_FILES) break
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (skipDirs.has(entry.name.toLowerCase())) continue
          walk(full, depth + 1)
        } else if (entry.isFile()) {
          const group = classifyExt(full)
          if (!group) continue
          scannedCount++
          upsert(full, entry.name, group, '工作区成果')
        }
      }
    }

    for (const root of scanRoots.values()) {
      walk(root, 0)
    }

    const items = [...byPath.values()].sort((a, b) => b.updatedAt - a.updatedAt)
    return {
      items,
      folders,
      defaultWorkspaceRoot: this.defaultWorkspaceRoot
    }
  }

  readProjectMemory(projectId: string): { memory: string; decisions: string } {
    const projDir = join(this.workspacesDir, projectId)
    const memPath = join(projDir, 'memory.md')
    const decPath = join(projDir, 'project_decisions.md')
    return {
      memory: existsSync(memPath) ? readFileSync(memPath, 'utf8') : '',
      decisions: existsSync(decPath) ? readFileSync(decPath, 'utf8') : ''
    }
  }

  readCharter(rootDir: string): string {
    if (!rootDir) return ''
    const file = join(rootDir, 'ZNZMO.md')
    return existsSync(file) ? readFileSync(file, 'utf8') : ''
  }

  saveCharter(rootDir: string, content: string): void {
    if (!rootDir) return
    mkdirSync(rootDir, { recursive: true })
    writeFileSync(join(rootDir, 'ZNZMO.md'), content, 'utf8')
  }

  private tasksPath(): string {
    return join(this.baseDir, 'tasks.json')
  }

  listTasks(): TaskSummary[] {
    const raw = readJsonSafe<TaskSummary[]>(this.tasksPath(), [])
    return raw
      .map((t) => ({
        ...t,
        transcriptPath: t.transcriptPath ?? this.transcriptPath(t.id, t.projectId ?? null)
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  getTask(threadId: string): TaskSummary | undefined {
    return this.listTasks().find((t) => t.id === threadId)
  }

  createTask(params: { id?: string; title?: string; projectId?: string | null; rootDir?: string }): TaskSummary {
    const list = readJsonSafe<TaskSummary[]>(this.tasksPath(), [])
    const now = Date.now()
    const id = params.id ?? randomUUID()
    const project = params.projectId ? this.listProjects().find((p) => p.id === params.projectId) : undefined
    const taskRootDir =
      params.rootDir?.trim() ||
      project?.folderPath ||
      join(this.defaultWorkspaceRoot, id.slice(0, 8))
    mkdirSync(taskRootDir, { recursive: true })

    const tPath = this.transcriptPath(id, params.projectId ?? null)
    const item: TaskSummary = {
      id,
      title: params.title?.trim() || '新建设计对话',
      projectId: params.projectId ?? null,
      rootDir: taskRootDir,
      transcriptPath: tPath,
      createdAt: now,
      updatedAt: now
    }
    const existingIdx = list.findIndex((t) => t.id === item.id)
    if (existingIdx >= 0) {
      list[existingIdx] = item
    } else {
      list.unshift(item)
    }
    writeJsonAtomic(this.tasksPath(), list)
    return item
  }

  updateTaskTitle(threadId: string, title: string): void {
    const list = readJsonSafe<TaskSummary[]>(this.tasksPath(), [])
    const target = list.find((t) => t.id === threadId)
    if (target) {
      target.title = title
      target.updatedAt = Date.now()
      writeJsonAtomic(this.tasksPath(), list)
    }
  }

  touchTask(threadId: string): void {
    const list = readJsonSafe<TaskSummary[]>(this.tasksPath(), [])
    const target = list.find((t) => t.id === threadId)
    if (target) {
      target.updatedAt = Date.now()
      writeJsonAtomic(this.tasksPath(), list)
    }
  }

  deleteTask(threadId: string): void {
    const task = this.getTask(threadId)
    const list = readJsonSafe<TaskSummary[]>(this.tasksPath(), []).filter((t) => t.id !== threadId)
    writeJsonAtomic(this.tasksPath(), list)
    const tPath = this.transcriptPath(threadId, task?.projectId ?? null)
    try {
      rmSync(dirname(tPath), { recursive: true, force: true })
    } catch {
      // ignore
    }
  }

  getTranscriptPath(threadId: string): string {
    const task = this.getTask(threadId)
    return this.transcriptPath(threadId, task?.projectId ?? null)
  }

  private transcriptPath(threadId: string, projectId: string | null): string {
    const bucket = projectId ? projectId : '_default'
    return join(this.workspacesDir, bucket, 'conversations', threadId, 'transcript.json')
  }

  readTranscript(threadId: string): PersistedTurnItem[] {
    const task = this.getTask(threadId)
    return readJsonSafe<PersistedTurnItem[]>(this.transcriptPath(threadId, task?.projectId ?? null), [])
  }

  private saveTranscript(threadId: string, items: PersistedTurnItem[]): void {
    const task = this.getTask(threadId)
    writeJsonAtomic(this.transcriptPath(threadId, task?.projectId ?? null), items)
  }

  appendUserTurn(params: {
    threadId: string
    requestId: string
    text: string
    attachments?: AgentAttachment[]
    annotations?: ModelAnnotationRef[]
    conversationRefs?: ConversationRef[]
    mcp?: SelectedMcpConnector[]
    sceneParam?: SceneParam
  }): void {
    const items = this.readTranscript(params.threadId)
    const inheritedTodos = inheritInterruptedTodos(items)
    const now = Date.now()
    items.push({
      id: `user_${params.requestId}`,
      role: 'user',
      text: params.text,
      attachments: params.attachments,
      annotations: params.annotations,
      conversationRefs: params.conversationRefs,
      mcp: params.mcp,
      sceneParam: params.sceneParam,
      createdAt: now
    })
    items.push({
      id: `asst_${params.requestId}`,
      role: 'assistant',
      requestId: params.requestId,
      reasoning: '',
      content: '',
      toolCalls: [],
      todos: inheritedTodos,
      deliverables: [],
      status: 'streaming',
      createdAt: now + 1
    })
    this.saveTranscript(params.threadId, items)
    this.touchTask(params.threadId)
  }

  applyRuntimeEventToTranscript(event: RuntimeOutbound): void {
    if (!('threadId' in event)) return
    const { threadId } = event

    if (event.type === 'newchat') {
      this.updateTaskTitle(threadId, event.title)
      return
    }

    const items = this.readTranscript(threadId)
    if (items.length === 0) return

    const findAssistant = (reqId: string): Extract<PersistedTurnItem, { role: 'assistant' }> | undefined => {
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i]
        if (it.role === 'assistant' && it.requestId === reqId) return it
      }
      const last = items[items.length - 1]
      return last?.role === 'assistant' ? last : undefined
    }

    if (!('requestId' in event)) return
    const asst = findAssistant(event.requestId)
    if (!asst) return

    switch (event.type) {
      case 'token':
        asst.content += event.delta
        break
      case 'reasoning':
        asst.reasoning += event.delta
        break
      case 'tool': {
        const id = event.id ?? `tool_${asst.toolCalls.length}`
        const existing = asst.toolCalls.find((tc) => tc.id === id)
        if (!existing) {
          asst.toolCalls.push({
            id,
            name: event.name,
            message: event.message,
            delta: event.delta,
            args: event.args,
            status: 'running',
            subagentEvents: []
          })
        }
        break
      }
      case 'tool-result': {
        const target = event.id
          ? asst.toolCalls.find((tc) => tc.id === event.id)
          : [...asst.toolCalls].reverse().find((tc) => tc.name === event.name && tc.status === 'running')
        if (target) {
          target.status = event.ok ? 'success' : 'error'
          target.toolData = event.toolData
          if (event.delta) target.delta = event.delta
        }
        if (
          event.toolData &&
          typeof event.toolData === 'object' &&
          (event.toolData as { kind?: string }).kind === 'write_todos'
        ) {
          const td = event.toolData as WriteTodosToolData
          asst.todos = td.todos as TodoItem[]
        }
        break
      }
      case 'subagent': {
        const parent = asst.toolCalls.find((tc) => tc.id === event.parentToolCallId)
        if (parent) {
          parent.subagentEvents = parent.subagentEvents ?? []
          parent.subagentEvents.push(event.event)
        }
        break
      }
      case 'interrupt':
        asst.pendingInteraction = {
          kind: 'interrupt',
          requestId: event.requestId,
          actions: event.actions,
          authorization: event.authorization,
          message: event.message,
          delta: event.delta
        }
        break
      case 'ask_user':
        asst.pendingInteraction = {
          kind: 'ask_user',
          requestId: event.requestId,
          id: event.id,
          questions: event.questions,
          interaction: event.interaction
        }
        break
      case 'ask_image_edit':
        asst.pendingInteraction = {
          kind: 'ask_image_edit',
          requestId: event.requestId,
          id: event.id,
          hint: event.hint,
          imagePath: event.imagePath
        }
        break
      case 'usage':
        asst.usage = event.usage
        break
      case 'done':
        asst.status = 'completed'
        asst.deliverables = event.deliverables
        asst.pendingInteraction = undefined
        asst.finishedAt = Date.now()
        if (event.usage) asst.usage = event.usage
        if (asst.todos.length > 0) {
          asst.todos = settleCompletedTodos(asst.todos)
        }
        break
      case 'aborted':
        asst.status = 'aborted'
        asst.deliverables = event.deliverables
        asst.pendingInteraction = undefined
        asst.finishedAt = Date.now()
        if (event.usage) asst.usage = event.usage
        break
      case 'error':
        asst.status = 'error'
        asst.errorMessage = event.userMessage || event.message
        asst.pendingInteraction = undefined
        asst.finishedAt = Date.now()
        if (event.deliverables) asst.deliverables = event.deliverables
        if (event.usage) asst.usage = event.usage
        break
      case 'suggestions':
        asst.suggestions = event.items
        break
      default:
        return
    }

    this.saveTranscript(threadId, items)
  }

  clearPendingInteraction(threadId: string): void {
    const items = this.readTranscript(threadId)
    let changed = false
    for (const it of items) {
      if (it.role === 'assistant' && it.pendingInteraction) {
        it.pendingInteraction = undefined
        changed = true
      }
    }
    if (changed) this.saveTranscript(threadId, items)
  }

  reconcileTranscriptOnRead(threadId: string, isLive: boolean): PersistedTurnItem[] {
    const items = this.readTranscript(threadId)
    if (isLive || items.length === 0) return items
    let changed = false
    for (const it of items) {
      if (it.role === 'assistant' && it.status === 'streaming' && !it.pendingInteraction) {
        it.status = 'aborted'
        for (const tc of it.toolCalls) {
          if (tc.status === 'running') tc.status = 'error'
        }
        changed = true
      }
    }
    if (changed) this.saveTranscript(threadId, items)
    return items
  }
}
