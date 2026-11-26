import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  shell,
  Tray
} from 'electron'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  IPC_CHANNELS,
  type AppGeneralSettings,
  type ModelSettingsState,
  type ProjectMeta,
  type SendMessagePayload,
  type WorkspaceEntry
} from '@shared/ipc'
import type {
  AgentAttachment,
  AgentDecision,
  AskAnswer,
  ImageChannelTestLevel,
  ImageEditAnswer,
  ImageGenChannel,
  PermissionMode,
  PptProposal,
  RuntimeInbound,
  RuntimeOutbound
} from '@shared/protocol'
import { LocalAppStore } from './store'
import { AgentRuntimeHost } from './runtimeHost'
import { CadPreviewService } from './cadService'
import { ModelPreviewService } from './modelService'
import { McpConnectorManager } from './mcpManager'
import { applyPptProposalToFile } from './pptPatcher'
import { discoverCcSwitchCandidates, testModelProfileConnection } from './ccSwitchService'
import { testImageChannelConnection } from './imageChannelTestService'
import {
  downloadClipModel,
  getClipModelStatus,
  rebuildInspirationIndex
} from './inspirationModelService'
import { discoverSkills } from '../runtime/prompts'
import {
  capturePreEditSnapshot,
  listFileSnapshots,
  restoreFileSnapshot
} from '@shared/fileSnapshots'
import { isPathWithinRoot, resolvePathWithinRoot, samePath } from '@shared/workspacePaths'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false
let store: LocalAppStore
let runtimeHost: AgentRuntimeHost
const liveRuntimeThreads = new Set<string>()
let cadService: CadPreviewService
let modelService: ModelPreviewService
let mcpManager: McpConnectorManager
const pickedFiles = new Set<string>()
const pickedFolders = new Set<string>()
const pickedModelFolders = new Set<string>()

function buildAppIcon(): Electron.NativeImage {
  // 16x16 / 32x32 清晰 SVG 矢量标志转为 NativeImage（无外部资源依赖）
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#18181b"/><path d="M9 10h14l-14 12h14" stroke="#ffffff" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>`
  return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`)
}

function showAndFocusWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function maybeNotifyBackground(title: string, body: string, threadId: string): void {
  try {
    const gen = store.getGeneralSettings()
    if (!gen.desktopNotifications) return
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && mainWindow.isFocused()) {
      return
    }
    if (!Notification.isSupported()) return
    const n = new Notification({ title, body })
    n.on('click', () => {
      showAndFocusWindow()
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC_CHANNELS.TaskNotificationsOpenRequested, threadId)
      }
    })
    n.show()
  } catch {
    // ignore OS notification error
  }
}

function resolveResourcesDir(): string {
  if (app.isPackaged) {
    return process.resourcesPath
  }
  return resolve(app.getAppPath(), 'resources')
}

function workspaceRoots(): string[] {
  return [
    store.getDefaultWorkspaceRoot(),
    ...store.listProjects().map((project) => project.folderPath),
    ...store.listTasks().map((task) => task.rootDir)
  ].filter(Boolean)
}

function isApprovedPickedFolder(folderPath: string): boolean {
  return [...pickedFolders].some((picked) => samePath(picked, folderPath))
}

function assertWorkspaceRoot(rootDir: string | undefined): string {
  if (!rootDir?.trim()) throw new Error('缺少工作区根目录')
  const candidate = resolve(rootDir)
  if (!workspaceRoots().some((root) => isPathWithinRoot(root, candidate))) {
    throw new Error(`工作区未获用户选择或登记：${candidate}`)
  }
  return candidate
}

function assertKnownProjectId(projectId: string | null | undefined): string | null | undefined {
  if (projectId !== null && projectId !== undefined) {
    if (!projectId.trim() || !store.listProjects().some((project) => project.id === projectId)) {
      throw new Error(`项目未登记：${projectId}`)
    }
  }
  return projectId
}

function requireKnownProjectId(projectId: string): string {
  if (!projectId?.trim() || !store.listProjects().some((project) => project.id === projectId)) {
    throw new Error(`项目未登记：${projectId}`)
  }
  return projectId
}

function requireKnownTask(threadId: string) {
  if (!threadId?.trim()) throw new Error('缺少任务标识')
  const task = store.getTask(threadId)
  if (!task) throw new Error(`任务未登记：${threadId}`)
  return task
}

function assertWorkspacePath(targetPath: string, rootDir: string | undefined): string {
  return resolvePathWithinRoot(assertWorkspaceRoot(rootDir), targetPath)
}

function assertWritableWorkspacePath(targetPath: string): string {
  const candidate = resolve(targetPath)
  for (const root of workspaceRoots()) {
    if (isPathWithinRoot(root, candidate)) return resolvePathWithinRoot(root, candidate)
  }
  throw new Error(`写入目标不在已登记工作区内：${candidate}`)
}

function isApprovedModelFolder(folderPath: string): boolean {
  if (!folderPath?.trim()) return false
  const candidate = resolve(folderPath)
  return (
    [...pickedModelFolders].some((picked) => isPathWithinRoot(picked, candidate)) ||
    workspaceRoots().some((root) => isPathWithinRoot(root, candidate))
  )
}

function assertAuthorizedModelFolder(
  folderPath: string | undefined,
  configuredPath?: string
): string {
  if (!folderPath?.trim()) throw new Error('缺少模型或素材库目录')
  const candidate = resolve(folderPath)
  if (
    !(configuredPath?.trim() && samePath(configuredPath, candidate)) &&
    !isApprovedModelFolder(candidate)
  ) {
    throw new Error(`模型或素材库目录必须是已配置、已选择或位于工作区内的目录：${candidate}`)
  }
  return candidate
}

function assertAuthorizedReadPath(targetPath: string): string {
  if (!targetPath?.trim()) throw new Error('缺少文件路径')
  const candidate = resolve(targetPath)
  const readRoots = [...workspaceRoots(), ...store.getLibraryFolders()]
  for (const root of readRoots) {
    if (isPathWithinRoot(root, candidate)) return candidate
  }

  const explicitlySelected = [
    ...pickedFiles,
    ...store.listRecentFiles().map((file) => file.path)
  ]
  if (explicitlySelected.some((allowed) => samePath(allowed, candidate)) && existsSync(candidate)) {
    return candidate
  }
  throw new Error(`文件未获授权访问：${candidate}`)
}

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1420,
    height: 880,
    minWidth: 1060,
    minHeight: 680,
    frame: false,
    title: '空间设计智能体工作台',
    icon: buildAppIcon(),
    backgroundColor: '#f8f9fb',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('maximize', () => {
    mainWindow?.webContents.send(IPC_CHANNELS.WindowMaximizeChanged, true)
  })
  mainWindow.on('unmaximize', () => {
    mainWindow?.webContents.send(IPC_CHANNELS.WindowMaximizeChanged, false)
  })
  mainWindow.on('close', (e) => {
    if (!isQuitting && store.getGeneralSettings().closeToTray) {
      e.preventDefault()
      mainWindow?.hide()
    }
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function registerIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.ModelsGetSettings, () => store.getModelSettings())
  ipcMain.handle(IPC_CHANNELS.ModelsSaveSettings, (_e, settings: ModelSettingsState) => {
    const current = store.getModelSettings()
    const requestedFolders: Array<[string | undefined, string | undefined]> = [
      [settings.regulation?.folderPath, current.regulation?.folderPath],
      [settings.inspiration?.folderPath, current.inspiration?.folderPath],
      [settings.inspiration?.clipModelDir, current.inspiration?.clipModelDir]
    ]
    for (const [folder, configuredPath] of requestedFolders) {
      if (!folder?.trim()) continue
      if (
        !configuredPath?.trim() ||
        (!samePath(configuredPath, folder) && !isApprovedModelFolder(folder))
      ) {
        throw new Error(`模型设置目录必须通过系统文件夹选择器选中：${folder}`)
      }
    }
    return store.saveModelSettings(settings)
  })
  ipcMain.handle(IPC_CHANNELS.ModelsDiscoverCcSwitch, () => {
    const py = join(resolveResourcesDir(), 'runtime', 'python', 'python.exe')
    return discoverCcSwitchCandidates(existsSync(py) ? py : 'python')
  })
  ipcMain.handle(
    IPC_CHANNELS.ModelsTestConnection,
    (_e, profile: ModelSettingsState['profiles'][number]) => testModelProfileConnection(profile)
  )
  ipcMain.handle(
    IPC_CHANNELS.ModelsTestImageChannel,
    (_e, channel: ImageGenChannel, level: ImageChannelTestLevel) =>
      testImageChannelConnection(channel, level)
  )
  ipcMain.handle(IPC_CHANNELS.ModelsGetClipModelStatus, (_e, modelDir: string) =>
    getClipModelStatus(
      assertAuthorizedModelFolder(modelDir, store.getModelSettings().inspiration?.clipModelDir)
    )
  )
  ipcMain.handle(IPC_CHANNELS.ModelsDownloadClipModel, (e, modelDir: string) =>
    downloadClipModel(
      assertAuthorizedModelFolder(modelDir, store.getModelSettings().inspiration?.clipModelDir),
      (p) => {
        if (!e.sender.isDestroyed()) {
          e.sender.send(IPC_CHANNELS.ModelsClipModelDownloadProgress, p)
        }
      }
    )
  )
  ipcMain.handle(
    IPC_CHANNELS.ModelsRebuildInspirationIndex,
    (e, payload: { folder: string; clipModelDir?: string }) =>
      rebuildInspirationIndex({
        folder: assertAuthorizedModelFolder(
          payload.folder,
          store.getModelSettings().inspiration?.folderPath
        ),
        clipModelDir: payload.clipModelDir
          ? assertAuthorizedModelFolder(
              payload.clipModelDir,
              store.getModelSettings().inspiration?.clipModelDir
            )
          : undefined,
        onProgress: (p) => {
          if (!e.sender.isDestroyed()) {
            e.sender.send(IPC_CHANNELS.ModelsInspirationRebuildProgress, p)
          }
        }
      })
  )

  ipcMain.handle(IPC_CHANNELS.AgentGetPermissionMode, () => store.getPermissionMode())
  ipcMain.handle(IPC_CHANNELS.AgentSetPermissionMode, (_e, mode: PermissionMode) => {
    const saved = store.setPermissionMode(mode)
    runtimeHost.send({ type: 'set_permission_mode', permissionMode: saved })
    return saved
  })

  ipcMain.handle(IPC_CHANNELS.ProjectsList, () => store.listProjects())
  ipcMain.handle(IPC_CHANNELS.ProjectsCreate, (_e, payload: { name: string; folderPath: string }) => {
    const picked = isApprovedPickedFolder(payload.folderPath)
    const registered = workspaceRoots().some((root) => isPathWithinRoot(root, payload.folderPath))
    if (!picked && !registered) throw new Error('项目文件夹必须由系统文件夹选择器选中')
    return store.createProject(payload.name, resolve(payload.folderPath))
  })
  ipcMain.handle(IPC_CHANNELS.ProjectsDelete, (_e, projectId: string) => {
    store.deleteProject(requireKnownProjectId(projectId))
  })
  ipcMain.handle(IPC_CHANNELS.ProjectsReadMemory, (_e, projectId: string) =>
    store.readProjectMemory(requireKnownProjectId(projectId))
  )
  ipcMain.handle(IPC_CHANNELS.ProjectsReadCharter, (_e, rootDir: string) => {
    const root = assertWorkspaceRoot(rootDir)
    assertWorkspacePath(join(root, 'ZNZMO.md'), root)
    return store.readCharter(root)
  })
  ipcMain.handle(IPC_CHANNELS.ProjectsSaveCharter, (_e, payload: { rootDir: string; content: string }) => {
    const root = assertWorkspaceRoot(payload.rootDir)
    assertWorkspacePath(join(root, 'ZNZMO.md'), root)
    store.saveCharter(root, payload.content)
  })
  ipcMain.handle(IPC_CHANNELS.ProjectsRename, (_e, payload: { projectId: string; name: string }) =>
    store.renameProject(requireKnownProjectId(payload.projectId), payload.name)
  )
  ipcMain.handle(IPC_CHANNELS.ProjectsReadMeta, (_e, projectId: string) =>
    store.readProjectMeta(requireKnownProjectId(projectId))
  )
  ipcMain.handle(
    IPC_CHANNELS.ProjectsUpdateMeta,
    (_e, payload: { projectId: string; meta: ProjectMeta }) =>
      store.updateProjectMeta(requireKnownProjectId(payload.projectId), payload.meta)
  )
  ipcMain.handle(IPC_CHANNELS.SettingsGetGeneral, () => store.getGeneralSettings())
  ipcMain.handle(IPC_CHANNELS.SettingsSaveGeneral, (_e, next: AppGeneralSettings) =>
    store.saveGeneralSettings(next)
  )
  ipcMain.handle(IPC_CHANNELS.RecentFilesList, () => store.listRecentFiles())
  ipcMain.handle(IPC_CHANNELS.RecentFilesRemove, (_e, targetPath: string) =>
    store.removeRecentFile(targetPath)
  )
  ipcMain.on(IPC_CHANNELS.WindowMinimize, () => mainWindow?.minimize())
  ipcMain.on(IPC_CHANNELS.WindowMaximizeToggle, () => {
    if (!mainWindow) return
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
  })
  ipcMain.on(IPC_CHANNELS.WindowClose, () => mainWindow?.close())
  ipcMain.handle(IPC_CHANNELS.WindowIsMaximized, () => mainWindow?.isMaximized() ?? false)
  ipcMain.handle(IPC_CHANNELS.TasksRename, (_e, payload: { threadId: string; title: string }) => {
    store.updateTaskTitle(requireKnownTask(payload.threadId).id, payload.title)
    return store.listTasks()
  })

  ipcMain.handle(IPC_CHANNELS.TasksList, () => store.listTasks())
  ipcMain.handle(
    IPC_CHANNELS.TasksCreate,
    (_e, payload: { title?: string; projectId?: string | null; rootDir?: string }) => {
      if (payload.rootDir) assertWorkspaceRoot(payload.rootDir)
      return store.createTask({ ...payload, projectId: assertKnownProjectId(payload.projectId) })
    }
  )
  ipcMain.handle(IPC_CHANNELS.TasksDelete, (_e, threadId: string) => {
    store.deleteTask(requireKnownTask(threadId).id)
  })
  ipcMain.handle(IPC_CHANNELS.TasksReadTranscript, (_e, threadId: string) => {
    const task = requireKnownTask(threadId)
    return store.reconcileTranscriptOnRead(task.id, liveRuntimeThreads.has(task.id))
  })

  ipcMain.handle(IPC_CHANNELS.SkillsList, () => discoverSkills(join(resolveResourcesDir(), 'skills')))
  ipcMain.handle(IPC_CHANNELS.RegulationStats, () => store.getRegulationStats())

  ipcMain.handle(IPC_CHANNELS.McpListConnectors, () => mcpManager.listConnectors())
  ipcMain.handle(
    IPC_CHANNELS.McpSetEnabled,
    (_e, payload: { name: string; enabled: boolean }) =>
      mcpManager.setEnabled(payload.name, payload.enabled)
  )
  ipcMain.handle(IPC_CHANNELS.McpCheckConnection, async (_e, name: string) => {
    const spec = mcpManager.resolveServerSpec(name)
    if (!spec) return { ok: false, reason: '本地未找到该连接器服务包或宿主插件未安装' }
    return runtimeHost.checkMcpServer(spec)
  })
  ipcMain.handle(IPC_CHANNELS.McpInstallPlugin, (_e, name: string) =>
    mcpManager.installPlugin(name)
  )

  ipcMain.handle(IPC_CHANNELS.CadPreviewPrepare, (_e, filePath: string) =>
    cadService.prepare(assertAuthorizedReadPath(filePath))
  )
  ipcMain.handle(IPC_CHANNELS.ModelPreviewPrepare, (_e, filePath: string) =>
    modelService.prepare(assertAuthorizedReadPath(filePath))
  )

  ipcMain.handle(
    IPC_CHANNELS.AgentSaveAnnotatedImage,
    (_e, payload: { sourcePath: string; dataUrl: string; rootDir?: string }) => {
      payload.sourcePath = assertAuthorizedReadPath(payload.sourcePath)
      const m = /^data:image\/[a-zA-Z0-9+.-]+;base64,(.+)$/.exec(payload.dataUrl)
      if (!m) throw new Error('无效的图片 DataURL')
      const root = assertWorkspaceRoot(payload.rootDir || store.getDefaultWorkspaceRoot())
      const dir = resolvePathWithinRoot(root, join(root, 'annotations'))
      mkdirSync(dir, { recursive: true })
      const base = basename(payload.sourcePath, extname(payload.sourcePath))
      const outPath = resolvePathWithinRoot(root, join(dir, `${base}_annotated_${Date.now()}.png`))
      writeFileSync(outPath, Buffer.from(m[1], 'base64'))
      return outPath
    }
  )

  ipcMain.handle(IPC_CHANNELS.AgentPickFiles, async () => {
    if (!mainWindow) return []
    const res = await dialog.showOpenDialog(mainWindow, {
      title: '选择项目参考资料或图纸附件',
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: '设计资料与办公文件',
          extensions: [
            'dwg',
            'dxf',
            'skp',
            '3dm',
            'obj',
            'fbx',
            'glb',
            'gltf',
            'stl',
            'blend',
            'max',
            'png',
            'jpg',
            'jpeg',
            'webp',
            'pdf',
            'pptx',
            'docx',
            'xlsx',
            'xls',
            'csv',
            'html',
            'md',
            'txt',
            'json'
          ]
        },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    if (res.canceled) return []
    const imgExts = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg'])
    const out: AgentAttachment[] = []
    for (const p of res.filePaths) {
      try {
        const st = statSync(p)
        if (!st.isFile()) continue
        pickedFiles.add(resolve(p))
        const ext = extname(p).toLowerCase()
        out.push({
          path: p,
          name: basename(p),
          kind: imgExts.has(ext) ? 'image' : 'file',
          size: st.size
        })
      } catch {
        // ignore unreadable
      }
    }
    return out
  })

  ipcMain.handle(
    IPC_CHANNELS.AgentPickFolder,
    async (_e, purpose?: 'project' | 'library' | 'model-settings') => {
      if (!mainWindow) return null
      const res = await dialog.showOpenDialog(mainWindow, {
        title: '选择本地文件夹',
        properties: ['openDirectory', 'createDirectory']
      })
      if (res.canceled || res.filePaths.length === 0) return null
      const selected = resolve(res.filePaths[0])
      if (purpose === 'project' || purpose === 'library') pickedFolders.add(selected)
      if (purpose === 'model-settings') pickedModelFolders.add(selected)
      return selected
    }
  )

  ipcMain.handle(IPC_CHANNELS.AgentAuthorizeDroppedFile, (_e, filePath: string) => {
    const candidate = resolve(filePath)
    if (!existsSync(candidate) || !statSync(candidate).isFile()) {
      throw new Error('拖放文件不存在或不是普通文件')
    }
    pickedFiles.add(candidate)
    return candidate
  })

  ipcMain.handle(
    IPC_CHANNELS.FilesListWorkspace,
    (_e, payload: { dirPath: string; rootDir: string }): WorkspaceEntry[] => {
      const root = assertWorkspaceRoot(payload?.rootDir)
      const dirPath = resolvePathWithinRoot(root, payload?.dirPath)
      if (!existsSync(dirPath)) return []
      try {
        const entries = readdirSync(dirPath, { withFileTypes: true })
        return entries
          .filter((item) => !item.isSymbolicLink() && item.name !== 'node_modules' && item.name !== '.git')
          .map((item) => {
            const full = join(dirPath, item.name)
            let size = 0
            let updatedAt = 0
            try {
              const st = statSync(full)
              size = st.size
              updatedAt = st.mtimeMs
            } catch {
              // ignore
            }
            return {
              name: item.name,
              path: full,
              isDirectory: item.isDirectory(),
              size,
              updatedAt
            }
          })
          .sort((a, b) => {
            if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
            return a.name.localeCompare(b.name, 'zh-CN')
          })
      } catch {
        return []
      }
    }
  )

  ipcMain.handle(IPC_CHANNELS.FilesListLibrary, () => store.scanLocalLibrary())

  ipcMain.handle(IPC_CHANNELS.FilesAddLibraryFolder, (_e, folderPath: string) => {
    const alreadyAdded = store.getLibraryFolders().some((folder) => samePath(folder, folderPath))
    if (!isApprovedPickedFolder(folderPath) && !alreadyAdded) {
      throw new Error('文件库目录必须由系统文件夹选择器选中')
    }
    return store.addLibraryFolder(resolve(folderPath))
  })

  ipcMain.handle(IPC_CHANNELS.FilesRemoveLibraryFolder, (_e, folderPath: string) => {
    if (!store.getLibraryFolders().some((folder) => samePath(folder, folderPath))) {
      throw new Error('只能移除已添加到文件库的文件夹')
    }
    return store.removeLibraryFolder(folderPath)
  })

  ipcMain.handle(IPC_CHANNELS.FilesReadThumb, (_e, filePath: string) => {
    try {
      filePath = assertAuthorizedReadPath(filePath)
      if (!filePath || !existsSync(filePath)) return { ok: false, error: '文件不存在' }
      const st = statSync(filePath)
      const ext = extname(filePath).toLowerCase()
      if (ext === '.svg' && st.size <= 2 * 1024 * 1024) {
        const b64 = readFileSync(filePath).toString('base64')
        return { ok: true, dataUrl: `data:image/svg+xml;base64,${b64}` }
      }
      const img = nativeImage.createFromPath(filePath)
      if (!img.isEmpty()) {
        const { width } = img.getSize()
        const resized = width > 480 ? img.resize({ width: 480, quality: 'good' }) : img
        if (ext === '.png' || ext === '.webp' || ext === '.gif') {
          return { ok: true, dataUrl: `data:image/png;base64,${resized.toPNG().toString('base64')}` }
        }
        return { ok: true, dataUrl: `data:image/jpeg;base64,${resized.toJPEG(82).toString('base64')}` }
      }
      const fallbackMimes: Record<string, string> = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.webp': 'image/webp',
        '.gif': 'image/gif',
        '.bmp': 'image/bmp'
      }
      if (fallbackMimes[ext] && st.size <= 20 * 1024 * 1024) {
        return {
          ok: true,
          dataUrl: `data:${fallbackMimes[ext]};base64,${readFileSync(filePath).toString('base64')}`
        }
      }
      return { ok: false, error: '不支持缩略图解码' }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.FilesReadPreview, (_e, filePath: string) => {
    filePath = assertAuthorizedReadPath(filePath)
    if (!existsSync(filePath)) throw new Error('文件不存在')
    const st = statSync(filePath)
    const ext = extname(filePath).toLowerCase()
    const imgMimes: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.gif': 'image/gif',
      '.svg': 'image/svg+xml',
      '.bmp': 'image/bmp'
    }
    if (imgMimes[ext] && st.size <= 20 * 1024 * 1024) {
      const base64 = readFileSync(filePath).toString('base64')
      return {
        kind: 'image' as const,
        mime: imgMimes[ext],
        content: `data:${imgMimes[ext]};base64,${base64}`,
        size: st.size
      }
    }
    const textExts = new Set([
      '.md',
      '.txt',
      '.json',
      '.py',
      '.rb',
      '.ms',
      '.js',
      '.ts',
      '.tsx',
      '.css',
      '.html',
      '.htm',
      '.csv',
      '.tsv',
      '.yaml',
      '.yml',
      '.xml'
    ])
    if (textExts.has(ext) && st.size <= 2 * 1024 * 1024) {
      return {
        kind: 'text' as const,
        content: readFileSync(filePath, 'utf8'),
        size: st.size
      }
    }
    return { kind: 'binary' as const, size: st.size }
  })

  ipcMain.handle(IPC_CHANNELS.FilesReadBytes, (_e, filePath: string) => {
    try {
      filePath = assertAuthorizedReadPath(filePath)
      if (!existsSync(filePath)) return { ok: false, error: '文件不存在' }
      const st = statSync(filePath)
      if (st.size > 40 * 1024 * 1024) {
        return { ok: false, error: `文件较大 (${Math.round(st.size / 1024 / 1024)}MB)，超出面板内预览上限 40MB` }
      }
      const bytes = readFileSync(filePath)
      return { ok: true, base64: bytes.toString('base64'), size: st.size }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.ShellOpenPath, (_e, targetPath: string) =>
    shell.openPath(assertAuthorizedReadPath(targetPath))
  )
  ipcMain.handle(IPC_CHANNELS.ShellShowItemInFolder, (_e, targetPath: string) => {
    shell.showItemInFolder(assertAuthorizedReadPath(targetPath))
  })

  ipcMain.handle(
    IPC_CHANNELS.AgentWriteTempImage,
    (_e, payload: { base64: string; name?: string; rootDir?: string }): AgentAttachment => {
      const root = assertWorkspaceRoot(payload.rootDir || store.getDefaultWorkspaceRoot())
      const dir = resolvePathWithinRoot(root, join(root, 'uploads'))
      mkdirSync(dir, { recursive: true })
      const safeName = (payload.name || `paste_${Date.now()}.png`).replace(/[<>:"/\\|?*]/g, '_')
      const target = resolvePathWithinRoot(root, join(dir, safeName))
      const buf = Buffer.from(payload.base64, 'base64')
      writeFileSync(target, buf)
      return { path: target, name: safeName, kind: 'image', size: buf.byteLength }
    }
  )

  ipcMain.handle(IPC_CHANNELS.FilesSaveAs, async (_e, filePath: string) => {
    try {
      filePath = assertAuthorizedReadPath(filePath)
      if (!existsSync(filePath)) return { ok: false, error: '源文件不存在' }
      if (!mainWindow) return { ok: false, error: '窗口不可用' }
      const res = await dialog.showSaveDialog(mainWindow, {
        title: '文件另存为',
        defaultPath: basename(filePath)
      })
      if (res.canceled || !res.filePath) return { ok: false, canceled: true }
      copyFileSync(filePath, res.filePath)
      pickedFiles.add(resolve(res.filePath))
      return { ok: true, savedPath: res.filePath }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.ClipboardWriteImage, (_e, filePath: string) => {
    try {
      filePath = assertAuthorizedReadPath(filePath)
      if (!existsSync(filePath)) return { ok: false, error: '图片不存在' }
      const img = nativeImage.createFromPath(filePath)
      if (img.isEmpty()) return { ok: false, error: '无法解析图片格式' }
      clipboard.writeImage(img)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.PptWorkbenchApplyProposal, (_e, proposal: PptProposal) => {
    proposal.pptPath = assertWritableWorkspacePath(proposal.pptPath)
    return applyPptProposalToFile(proposal)
  })

  ipcMain.handle(
    IPC_CHANNELS.FilesSaveText,
    (_e, payload: { filePath: string; content: string; rootDir?: string }) => {
      try {
        const filePath = assertWorkspacePath(payload.filePath, payload.rootDir)
        capturePreEditSnapshot({
          targetPath: filePath,
          rootDir: payload.rootDir,
          sourceTool: 'manual_edit',
          summary: '工作台编辑器手动保存'
        })
        writeFileSync(filePath, payload.content, 'utf8')
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.FilesListSnapshots,
    (_e, payload: { filePath: string; rootDir?: string }) => {
      const filePath = assertWorkspacePath(payload.filePath, payload.rootDir)
      return listFileSnapshots({ filePath, rootDir: payload.rootDir })
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.FilesRestoreSnapshot,
    (_e, payload: { filePath: string; snapshotId: string; rootDir?: string }) => {
      const filePath = assertWorkspacePath(payload.filePath, payload.rootDir)
      return restoreFileSnapshot({
        filePath,
        snapshotId: payload.snapshotId,
        rootDir: payload.rootDir
      })
    }
  )

  ipcMain.handle(IPC_CHANNELS.AgentSend, async (_e, payload: SendMessagePayload) => {
    const modelSettings = store.getModelSettings()
    const targetProfileId = payload.profileId || modelSettings.activeProfileId
    const modelProfile =
      modelSettings.profiles.find((p) => p.id === targetProfileId) ?? modelSettings.profiles[0]

    if (!modelProfile || !modelProfile.apiKey.trim()) {
      return {
        ok: false,
        error: '尚未配置模型 API Key，请在右下角「请配置模型」中选择已识别的配置，或打开设置填入 API Key。'
      }
    }

    let task = store.getTask(payload.threadId)
    if (!task) {
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(payload.threadId)) {
        return { ok: false, error: '任务标识不合法，无法创建本地对话文件' }
      }
      const rootDir = payload.rootDir ? assertWorkspaceRoot(payload.rootDir) : undefined
      task = store.createTask({
        id: payload.threadId,
        title: payload.text.slice(0, 28),
        projectId: assertKnownProjectId(payload.projectId) ?? null,
        rootDir
      })
    }
    assertWorkspaceRoot(task.rootDir)

    let attachments: AgentAttachment[] | undefined
    let conversationRefs = payload.conversationRefs
    try {
      attachments = payload.attachments?.map((attachment) => {
        const path = assertAuthorizedReadPath(attachment.path)
        if (!existsSync(path) || !statSync(path).isFile()) {
          throw new Error(`附件不存在或不是普通文件：${path}`)
        }
        return { ...attachment, path }
      })
      conversationRefs = payload.conversationRefs?.map((reference) => {
        const candidate = resolve(reference.path)
        const transcriptPath = store
          .listTasks()
          .map((knownTask) => store.getTranscriptPath(knownTask.id))
          .find((knownPath) => samePath(knownPath, candidate))
        if (
          !transcriptPath ||
          !isPathWithinRoot(store.getWorkspacesDir(), transcriptPath) ||
          !existsSync(transcriptPath) ||
          !statSync(transcriptPath).isFile()
        ) {
          throw new Error(`历史对话引用未通过授权校验：${candidate}`)
        }
        return { ...reference, path: transcriptPath }
      })
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : '附件路径未通过访问校验'
      }
    }

    const enabledMcpSpecs = await mcpManager.getEnabledSpecsWithHostState()
    if (attachments && attachments.length > 0) {
      store.addRecentFiles(
        attachments.map((a) => ({
          path: a.path,
          name: a.name,
          kind: a.kind,
          size: a.size
        }))
      )
    }
    const selectedMcpList =
      payload.mcp && payload.mcp.length > 0
        ? payload.mcp
        : enabledMcpSpecs.map((s) => ({ name: s.name, label: s.label }))

    const requestId = randomUUID()
    store.appendUserTurn({
      threadId: task.id,
      requestId,
      text: payload.text,
      attachments,
      annotations: payload.annotations,
      conversationRefs,
      mcp: selectedMcpList,
      sceneParam: payload.sceneParam
    })

    liveRuntimeThreads.add(task.id)
    runtimeHost.send({
      type: 'chat',
      requestId,
      threadId: task.id,
      text: payload.text,
      rootDir: task.rootDir,
      projectId: task.projectId,
      filelist: attachments?.map((a) => ({
        path: a.path,
        name: a.name,
        type: a.kind,
        size: a.size,
      role: a.role
      })),
      annotations: payload.annotations,
      conversationRefs,
      pptSelection: payload.pptSelection,
      transcriptPath: store.getTranscriptPath(task.id),
      sceneParam: payload.sceneParam,
      mcp: selectedMcpList,
      mcpServers: enabledMcpSpecs,
      thinking: payload.thinking,
      permissionMode: store.getPermissionMode(),
      modelProfile,
      imageGenConfig: modelSettings.imageGen,
      regulationFolder: modelSettings.regulation?.folderPath,
      inspirationFolder: modelSettings.inspiration?.folderPath,
      clipModelDir: modelSettings.inspiration?.clipModelDir,
      webSearchConfig: modelSettings.webSearch,
      profile: payload.profile ?? 'ai-scheme-v1'
    })

    return { ok: true, requestId }
  })

  const dispatchSuspendedResume = async (
    threadId: string,
    resolution: Extract<RuntimeInbound, { type: 'resume_suspended_turn' }>['resolution']
  ): Promise<void> => {
    const task = store.getTask(threadId)
    if (!task) return
    const transcript = store.readTranscript(threadId)
    const lastAssistant = [...transcript].reverse().find((t) => t.role === 'assistant')
    const requestId = lastAssistant?.requestId || randomUUID()

    const modelSettings = store.getModelSettings()
    const modelProfile =
      modelSettings.profiles.find((p) => p.id === modelSettings.activeProfileId) ??
      modelSettings.profiles[0]

    if (!modelProfile || !modelProfile.apiKey.trim()) {
      const errEvent: RuntimeOutbound = {
        type: 'error',
        requestId,
        threadId,
        kind: 'preflight',
        message: 'Missing API Key on resume',
        userMessage: '尚未配置大模型 API Key，请先点击左下角「设置」填入 Key 后重试。'
      }
      store.applyRuntimeEventToTranscript(errEvent)
      mainWindow?.webContents.send(IPC_CHANNELS.AgentEvent, errEvent)
      return
    }

    const enabledMcpSpecs = await mcpManager.getEnabledSpecsWithHostState()
    store.clearPendingInteraction(threadId)
    liveRuntimeThreads.add(threadId)
    runtimeHost.send({
      type: 'resume_suspended_turn',
      requestId,
      threadId: task.id,
      rootDir: task.rootDir,
      projectId: task.projectId,
      transcriptPath: store.getTranscriptPath(task.id),
      mcpServers: enabledMcpSpecs,
      thinking: true,
      permissionMode: store.getPermissionMode(),
      modelProfile,
      imageGenConfig: modelSettings.imageGen,
      regulationFolder: modelSettings.regulation?.folderPath,
      inspirationFolder: modelSettings.inspiration?.folderPath,
      clipModelDir: modelSettings.inspiration?.clipModelDir,
      webSearchConfig: modelSettings.webSearch,
      profile: 'ai-scheme-v1',
      resolution
    })
  }

  ipcMain.handle(
    IPC_CHANNELS.AgentResume,
    (_e, payload: { threadId: string; decision: AgentDecision }) => {
      const task = requireKnownTask(payload.threadId)
      assertWorkspaceRoot(task.rootDir)
      if (payload.decision.type === 'approve' && payload.decision.scope === 'all') {
        store.setPermissionMode('auto')
      }
      if (!liveRuntimeThreads.has(payload.threadId)) {
        void dispatchSuspendedResume(payload.threadId, { kind: 'interrupt', decision: payload.decision })
        return
      }
      store.clearPendingInteraction(payload.threadId)
      runtimeHost.send({
        type: 'resume',
        requestId: randomUUID(),
        threadId: payload.threadId,
        decision: payload.decision
      })
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.AgentUserAnswer,
    (_e, payload: { threadId: string; answers: AskAnswer[] }) => {
      const task = requireKnownTask(payload.threadId)
      assertWorkspaceRoot(task.rootDir)
      if (!liveRuntimeThreads.has(payload.threadId)) {
        void dispatchSuspendedResume(payload.threadId, { kind: 'ask_user', answers: payload.answers })
        return
      }
      store.clearPendingInteraction(payload.threadId)
      runtimeHost.send({
        type: 'user_answer',
        requestId: randomUUID(),
        threadId: payload.threadId,
        answers: payload.answers
      })
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.AgentImageEditAnswer,
    (_e, payload: { threadId: string; id: string; answer: ImageEditAnswer }) => {
      const task = requireKnownTask(payload.threadId)
      assertWorkspaceRoot(task.rootDir)
      const answer: ImageEditAnswer = payload.answer.action === 'confirm'
        ? { ...payload.answer, imagePath: assertWorkspacePath(payload.answer.imagePath, task.rootDir) }
        : payload.answer
      if (!liveRuntimeThreads.has(payload.threadId)) {
        void dispatchSuspendedResume(payload.threadId, {
          kind: 'ask_image_edit',
          id: payload.id,
          answer
        })
        return
      }
      store.clearPendingInteraction(payload.threadId)
      runtimeHost.send({
        type: 'image_edit_answer',
        requestId: randomUUID(),
        threadId: payload.threadId,
        id: payload.id,
        answer
      })
    }
  )

  ipcMain.handle(IPC_CHANNELS.AgentAbort, (_e, threadId: string) => {
    const task = requireKnownTask(threadId)
    assertWorkspaceRoot(task.rootDir)
    store.clearPendingInteraction(threadId)
    if (!liveRuntimeThreads.has(threadId)) {
      store.reconcileTranscriptOnRead(threadId, false)
      const transcript = store.readTranscript(threadId)
      const lastAssistant = [...transcript].reverse().find((t) => t.role === 'assistant')
      if (lastAssistant) {
        mainWindow?.webContents.send(IPC_CHANNELS.AgentEvent, {
          type: 'aborted',
          requestId: lastAssistant.requestId,
          threadId,
          deliverables: (lastAssistant.role === 'assistant' ? lastAssistant.deliverables : undefined) ?? []
        } satisfies RuntimeOutbound)
      }
      return
    }
    runtimeHost.send({
      type: 'abort',
      requestId: randomUUID(),
      threadId
    })
  })
}

const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => showAndFocusWindow())
}

if (gotSingleInstanceLock) app.whenReady().then(() => {
  const userData = app.getPath('userData')
  const resourcesDir = resolveResourcesDir()
  const skillsRoot = join(resourcesDir, 'skills')
  const presetsRoot = join(resourcesDir, 'presets')
  const runtimeDir = join(resourcesDir, 'runtime')

  store = new LocalAppStore(userData, app.getPath('documents'), resourcesDir)
  cadService = new CadPreviewService(join(userData, 'cache', 'cad'), skillsRoot)
  modelService = new ModelPreviewService(join(userData, 'cache', 'models'))
  mcpManager = new McpConnectorManager(userData, resourcesDir)

  runtimeHost = new AgentRuntimeHost({
    skillsRoot,
    presetsRoot,
    workspacesDir: store.getWorkspacesDir(),
    runtimeDir
  })

  runtimeHost.on('outbound', (event: RuntimeOutbound) => {
    store.applyRuntimeEventToTranscript(event)

    if (event.type === 'done' || event.type === 'aborted' || event.type === 'error') {
      liveRuntimeThreads.delete(event.threadId)
    }

    // 当隶属于某个「项目空间」的会话本轮完成时，自动触发后台记忆蒸馏（Distiller）
    if (event.type === 'done') {
      const task = store.getTask(event.threadId)
      maybeNotifyBackground('设计任务已完成', task?.title || '点击查看交付结果', event.threadId)
      if (event.deliverables.length > 0) {
        const taskRoot = task?.rootDir
        const authorizedDeliverables = taskRoot
          ? event.deliverables.filter((deliverable) => isPathWithinRoot(taskRoot, deliverable.path))
          : []
        store.addRecentFiles(
          authorizedDeliverables.map((d) => ({
            path: d.path,
            name: d.title,
            kind: d.kind === 'image' ? 'image' : 'file',
            size: d.size
          }))
        )
      }
      if (task?.projectId) {
        const modelSettings = store.getModelSettings()
        const modelProfile =
          modelSettings.profiles.find((p) => p.id === modelSettings.activeProfileId) ??
          modelSettings.profiles[0]
        if (modelProfile?.apiKey.trim()) {
          runtimeHost.send({
            type: 'distill_project',
            requestId: randomUUID(),
            projectId: task.projectId,
            conversationId: task.id,
            transcriptPath: store.getTranscriptPath(task.id),
            modelProfile
          })
        }
      }
    }

    if (event.type === 'interrupt') {
      maybeNotifyBackground('需要您的确认批准', event.message, event.threadId)
    } else if (event.type === 'ask_user') {
      maybeNotifyBackground('智能体向您发起提问', event.questions[0]?.question || '点击回复', event.threadId)
    } else if (event.type === 'ask_image_edit') {
      maybeNotifyBackground('等待局部涂抹标注', event.hint, event.threadId)
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.AgentEvent, event)
    }
  })

  runtimeHost.ensureStarted()
  registerIpcHandlers()
  createMainWindow()

  tray = new Tray(buildAppIcon())
  tray.setToolTip('空间设计智能体工作台')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示主窗口', click: () => showAndFocusWindow() },
      { type: 'separator' },
      {
        label: '退出程序',
        click: () => {
          isQuitting = true
          app.quit()
        }
      }
    ])
  )
  tray.on('click', () => showAndFocusWindow())

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
    else showAndFocusWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !store.getGeneralSettings().closeToTray) {
    app.quit()
  }
})

app.on('before-quit', () => {
  isQuitting = true
  runtimeHost?.dispose()
})
