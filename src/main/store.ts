import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import * as electron from 'electron'
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
  InspirationConfig,
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
import { normalizeImageGenConfig } from '@shared/imageChannels'
import { isPathWithinRoot } from '@shared/workspacePaths'

function isSafeStorageId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value)
}

function assertSafeStorageId(value: string, label: string): string {
  if (!isSafeStorageId(value)) throw new Error(`${label}不合法`)
  return value
}

function readJsonSafe<T>(filePath: string, fallback: T): T {
  if (!existsSync(filePath)) return fallback
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as T
  } catch (err) {
    // M2：文件损坏时先留一份备份再回退默认值，避免下一次写入把仅存的数据覆盖掉
    try {
      copyFileSync(filePath, `${filePath}.corrupt-${Date.now()}`)
    } catch {
      // ignore
    }
    console.error(`[store] 读取 ${filePath} 失败，已备份损坏文件并使用默认值：`, err)
    return fallback
  }
}

function writeJsonAtomic(filePath: string, data: unknown, pretty = true): void {
  mkdirSync(dirname(filePath), { recursive: true })
  const tmp = `${filePath}.${process.pid}.tmp`
  writeFileSync(tmp, pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data), 'utf8')
  try {
    // M2：写临时文件后 rename 替换，保证正式文件要么是旧内容、要么是完整的新内容
    renameSync(tmp, filePath)
  } catch {
    // rename 偶尔会因为杀毒软件或其他进程占用失败，退回直接写入
    writeFileSync(filePath, pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data), 'utf8')
    try {
      rmSync(tmp, { force: true })
    } catch {
      // ignore
    }
  }
}

// ---------------- S1：API Key 落盘加密 ----------------
const SECRET_PREFIX = 'enc:v1:'

function getSafeStorage(): Electron.SafeStorage | null {
  try {
    const ss = (electron as unknown as { safeStorage?: Electron.SafeStorage }).safeStorage
    return ss && ss.isEncryptionAvailable() ? ss : null
  } catch {
    return null
  }
}

function encryptSecret(value: string): string {
  if (!value || value.startsWith(SECRET_PREFIX)) return value
  const ss = getSafeStorage()
  if (!ss) return value
  return SECRET_PREFIX + ss.encryptString(value).toString('base64')
}

function decryptSecret(value: string): string {
  if (!value || !value.startsWith(SECRET_PREFIX)) return value
  const ss = getSafeStorage()
  if (!ss) return ''
  try {
    return ss.decryptString(Buffer.from(value.slice(SECRET_PREFIX.length), 'base64'))
  } catch {
    return ''
  }
}

/** 深拷贝对象，对其中所有 apiKey 字段应用 fn */
function mapApiKeys<T>(value: T, fn: (key: string) => string): T {
  if (Array.isArray(value)) return value.map((v) => mapApiKeys(v, fn)) as unknown as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = k === 'apiKey' && typeof v === 'string' ? fn(v) : mapApiKeys(v, fn)
    }
    return out as T
  }
  return value
}

function hasPlaintextKeys(value: unknown): boolean {
  let found = false
  mapApiKeys(value, (k) => {
    if (k && !k.startsWith(SECRET_PREFIX)) found = true
    return k
  })
  return found
}

export class LocalAppStore {
  private readonly baseDir: string
  private readonly workspacesDir: string
  private readonly defaultWorkspaceRoot: string
  private readonly defaultRegulationDir: string
  private readonly defaultInspirationDir: string
  private readonly defaultClipModelDir: string
  private readonly regIndexerExe: string
  // M1：对话记录放在内存里维护，按节流批量落盘，不再每个 token 都整份读写磁盘
  private readonly transcriptCache = new Map<string, PersistedTurnItem[]>()
  private readonly dirtyTranscripts = new Set<string>()
  private transcriptFlushTimer: NodeJS.Timeout | null = null

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
    this.defaultInspirationDir = join(userDataDir, 'inspiration')
    this.defaultClipModelDir = join(userDataDir, 'models', 'chinese-clip-vit-b16')
    this.regIndexerExe = join(bundledResourcesDir, 'runtime', 'reg-indexer.exe')
    mkdirSync(this.workspacesDir, { recursive: true })
    mkdirSync(this.defaultWorkspaceRoot, { recursive: true })
    mkdirSync(this.defaultRegulationDir, { recursive: true })
    mkdirSync(this.defaultInspirationDir, { recursive: true })
    mkdirSync(this.defaultClipModelDir, { recursive: true })
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

  private writeModelSettings(settings: ModelSettingsState): void {
    writeJsonAtomic(this.modelSettingsPath(), mapApiKeys(settings, encryptSecret))
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
    const defaultInspiration: InspirationConfig = {
      folderPath: this.defaultInspirationDir,
      clipModelDir: this.defaultClipModelDir
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
      inspiration: defaultInspiration,
      webSearch: defaultWebSearch,
      profiles: envProfiles
    }
    const savedRaw = readJsonSafe<ModelSettingsState | null>(this.modelSettingsPath(), null)
    if (!savedRaw || !Array.isArray(savedRaw.profiles)) {
      this.writeModelSettings(defaultProfiles)
      return defaultProfiles
    }
    const saved = mapApiKeys(savedRaw, decryptSecret)
    // 旧版本留下的明文 Key：加密可用时就地迁移为密文
    const needsEncryptMigration = Boolean(getSafeStorage()) && hasPlaintextKeys(savedRaw)
    const cleanedProfiles = saved.profiles.filter(
      (p) => !(builtinTemplateIds.has(p.id) && !p.apiKey?.trim())
    )
    const resolvedActiveId = cleanedProfiles.some((p) => p.id === saved.activeProfileId)
      ? saved.activeProfileId
      : (cleanedProfiles[0]?.id ?? '')
    // 生图配置迁移：旧版单槽 imageGen 自动规范化为多渠道（channels[0] 镜像平铺字段），值不丢失
    const rawImageGen = saved.imageGen ?? defaultImageGen
    const migratedImageGen = normalizeImageGenConfig(rawImageGen)
    const next: ModelSettingsState = {
      ...saved,
      activeProfileId: resolvedActiveId,
      profiles: cleanedProfiles,
      imageGen: migratedImageGen,
      regulation: saved.regulation ?? defaultRegulation,
      inspiration: {
        folderPath: saved.inspiration?.folderPath ?? defaultInspiration.folderPath,
        clipModelDir: saved.inspiration?.clipModelDir ?? defaultInspiration.clipModelDir
      },
      webSearch: saved.webSearch ?? defaultWebSearch
    }
    if (
      cleanedProfiles.length !== saved.profiles.length ||
      resolvedActiveId !== saved.activeProfileId ||
      JSON.stringify(migratedImageGen) !== JSON.stringify(rawImageGen) ||
      needsEncryptMigration
    ) {
      this.writeModelSettings(next)
    }
    return next
  }

  saveModelSettings(settings: ModelSettingsState): ModelSettingsState {
    const normalized: ModelSettingsState = {
      ...settings,
      imageGen: normalizeImageGenConfig(settings.imageGen)
    }
    this.writeModelSettings(normalized)
    return normalized
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
    const id = assertSafeStorageId(projectId, '项目标识')
    return readJsonSafe<ProjectMeta>(join(this.workspacesDir, id, 'project-meta.json'), {})
  }

  updateProjectMeta(projectId: string, meta: ProjectMeta): ProjectMeta {
    const id = assertSafeStorageId(projectId, '项目标识')
    const file = join(this.workspacesDir, id, 'project-meta.json')
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
    const folders = this.getLibraryFolders()
    const projects = this.listProjects()
    const tasks = this.listTasks()
    const authorizedRoots = [
      this.defaultWorkspaceRoot,
      ...projects.map((project) => project.folderPath),
      ...tasks.map((task) => task.rootDir),
      ...folders
    ].filter(Boolean)
    const isAuthorizedLibraryPath = (filePath: string): boolean =>
      authorizedRoots.some((root) => isPathWithinRoot(root, filePath))
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

    // 1) 从已登记任务的历史会话中提取工作区内的 AI 交付成果
    for (const task of tasks) {
      const tPath = this.transcriptPath(task.id, task.projectId ?? null)
      const turns = readJsonSafe<PersistedTurnItem[]>(tPath, [])
      for (const turn of turns) {
        if (turn.role !== 'assistant' || !Array.isArray(turn.deliverables)) continue
        for (const d of turn.deliverables) {
          if (!d?.path || !isAuthorizedLibraryPath(d.path)) continue
          const group = classifyExt(d.path, d.kind)
          if (!group) continue
          upsert(d.path, d.title || basename(d.path), group, 'AI 交付成果', d.size)
        }
      }
    }

    // 2) 合并近期使用文件
    for (const rf of this.listRecentFiles()) {
      const group = classifyExt(rf.path, rf.kind)
      if (!group) continue
      upsert(rf.path, rf.name, group, '近期使用文件', rf.size, rf.lastUsedAt)
    }

    // 3) 仅扫描默认/已登记任务和项目工作区，以及用户明确添加的资料目录
    const scanRoots = new Map<string, string>()
    for (const r of authorizedRoots) {
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
    const projDir = join(this.workspacesDir, assertSafeStorageId(projectId, '项目标识'))
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
      .filter((t) => isSafeStorageId(t.id) && (t.projectId == null || isSafeStorageId(t.projectId)))
      .map((t) => ({
        ...t,
        transcriptPath: this.transcriptPath(t.id, t.projectId ?? null)
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
    this.transcriptCache.delete(threadId)
    this.dirtyTranscripts.delete(threadId)
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
    const bucket = projectId ? assertSafeStorageId(projectId, '项目标识') : '_default'
    const taskId = assertSafeStorageId(threadId, '任务标识')
    return join(this.workspacesDir, bucket, 'conversations', taskId, 'transcript.json')
  }

  readTranscript(threadId: string): PersistedTurnItem[] {
    const cached = this.transcriptCache.get(threadId)
    if (cached) return cached
    const task = this.getTask(threadId)
    const items = readJsonSafe<PersistedTurnItem[]>(this.transcriptPath(threadId, task?.projectId ?? null), [])
    this.transcriptCache.set(threadId, items)
    return items
  }

  /**
   * immediate=false 时只更新内存并在 400ms 后批量落盘（用于 token 等高频事件）；
   * 关键事件（工具结果、审批、完成、出错）立即落盘，保证崩溃时丢失的最多是几百毫秒的流式文字。
   */
  private saveTranscript(threadId: string, items: PersistedTurnItem[], immediate = true): void {
    this.transcriptCache.set(threadId, items)
    if (immediate) {
      this.dirtyTranscripts.delete(threadId)
      this.writeTranscriptNow(threadId, items)
      return
    }
    this.dirtyTranscripts.add(threadId)
    if (!this.transcriptFlushTimer) {
      this.transcriptFlushTimer = setTimeout(() => {
        this.transcriptFlushTimer = null
        this.flushTranscripts()
      }, 400)
    }
  }

  private writeTranscriptNow(threadId: string, items: PersistedTurnItem[]): void {
    try {
      const task = this.getTask(threadId)
      writeJsonAtomic(this.transcriptPath(threadId, task?.projectId ?? null), items, false)
    } catch (err) {
      console.error(`[store] 保存对话记录失败（${threadId}）：`, err)
    }
  }

  /** 把所有尚未落盘的对话记录写入磁盘（退出前、触发记忆提炼前调用） */
  flushTranscripts(): void {
    if (this.transcriptFlushTimer) {
      clearTimeout(this.transcriptFlushTimer)
      this.transcriptFlushTimer = null
    }
    for (const threadId of [...this.dirtyTranscripts]) {
      this.dirtyTranscripts.delete(threadId)
      const items = this.transcriptCache.get(threadId)
      if (items) this.writeTranscriptNow(threadId, items)
    }
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

    const highFrequency =
      event.type === 'token' ||
      event.type === 'reasoning' ||
      event.type === 'usage' ||
      (event.type === 'subagent' && (event.event.type === 'token' || event.event.type === 'reasoning'))
    this.saveTranscript(threadId, items, !highFrequency)
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
