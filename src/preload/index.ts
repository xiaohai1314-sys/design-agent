import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC_CHANNELS, type ZmoBridgeApi } from '@shared/ipc'
import type { RuntimeOutbound } from '@shared/protocol'

const api: ZmoBridgeApi = {
  app: {
    getPathForFile: (file) => webUtils.getPathForFile(file)
  },
  window: {
    minimize: () => ipcRenderer.send(IPC_CHANNELS.WindowMinimize),
    toggleMaximize: () => ipcRenderer.send(IPC_CHANNELS.WindowMaximizeToggle),
    close: () => ipcRenderer.send(IPC_CHANNELS.WindowClose),
    isMaximized: () => ipcRenderer.invoke(IPC_CHANNELS.WindowIsMaximized),
    onMaximizeChanged: (listener) => {
      const wrapped = (_e: Electron.IpcRendererEvent, maximized: boolean): void => listener(maximized)
      ipcRenderer.on(IPC_CHANNELS.WindowMaximizeChanged, wrapped)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.WindowMaximizeChanged, wrapped)
    }
  },
  taskNotifications: {
    onOpenRequested: (listener) => {
      const wrapped = (_e: Electron.IpcRendererEvent, threadId: string): void => listener(threadId)
      ipcRenderer.on(IPC_CHANNELS.TaskNotificationsOpenRequested, wrapped)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.TaskNotificationsOpenRequested, wrapped)
    }
  },
  settings: {
    getGeneral: () => ipcRenderer.invoke(IPC_CHANNELS.SettingsGetGeneral),
    saveGeneral: (next) => ipcRenderer.invoke(IPC_CHANNELS.SettingsSaveGeneral, next)
  },
  recentFiles: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.RecentFilesList),
    remove: (path) => ipcRenderer.invoke(IPC_CHANNELS.RecentFilesRemove, path)
  },
  agent: {
    send: (payload) => ipcRenderer.invoke(IPC_CHANNELS.AgentSend, payload),
    resume: (payload) => ipcRenderer.invoke(IPC_CHANNELS.AgentResume, payload),
    userAnswer: (payload) => ipcRenderer.invoke(IPC_CHANNELS.AgentUserAnswer, payload),
    imageEditAnswer: (payload) => ipcRenderer.invoke(IPC_CHANNELS.AgentImageEditAnswer, payload),
    saveAnnotatedImage: (payload) => ipcRenderer.invoke(IPC_CHANNELS.AgentSaveAnnotatedImage, payload),
    writeTempImage: (payload) => ipcRenderer.invoke(IPC_CHANNELS.AgentWriteTempImage, payload),
    stop: (threadId) => ipcRenderer.invoke(IPC_CHANNELS.AgentAbort, threadId),
    getPermissionMode: () => ipcRenderer.invoke(IPC_CHANNELS.AgentGetPermissionMode),
    setPermissionMode: (mode) => ipcRenderer.invoke(IPC_CHANNELS.AgentSetPermissionMode, mode),
    pickFiles: () => ipcRenderer.invoke(IPC_CHANNELS.AgentPickFiles),
    pickFolder: () => ipcRenderer.invoke(IPC_CHANNELS.AgentPickFolder),
    onEvent: (listener) => {
      const wrapped = (_event: Electron.IpcRendererEvent, data: RuntimeOutbound): void => {
        listener(data)
      }
      ipcRenderer.on(IPC_CHANNELS.AgentEvent, wrapped)
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.AgentEvent, wrapped)
      }
    }
  },
  tasks: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.TasksList),
    create: (payload) => ipcRenderer.invoke(IPC_CHANNELS.TasksCreate, payload),
    rename: (threadId, title) => ipcRenderer.invoke(IPC_CHANNELS.TasksRename, { threadId, title }),
    delete: (threadId) => ipcRenderer.invoke(IPC_CHANNELS.TasksDelete, threadId),
    readTranscript: (threadId) => ipcRenderer.invoke(IPC_CHANNELS.TasksReadTranscript, threadId)
  },
  projects: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.ProjectsList),
    create: (payload) => ipcRenderer.invoke(IPC_CHANNELS.ProjectsCreate, payload),
    rename: (projectId, name) => ipcRenderer.invoke(IPC_CHANNELS.ProjectsRename, { projectId, name }),
    delete: (projectId) => ipcRenderer.invoke(IPC_CHANNELS.ProjectsDelete, projectId),
    readMemory: (projectId) => ipcRenderer.invoke(IPC_CHANNELS.ProjectsReadMemory, projectId),
    readCharter: (rootDir) => ipcRenderer.invoke(IPC_CHANNELS.ProjectsReadCharter, rootDir),
    saveCharter: (rootDir, content) =>
      ipcRenderer.invoke(IPC_CHANNELS.ProjectsSaveCharter, { rootDir, content }),
    readMeta: (projectId) => ipcRenderer.invoke(IPC_CHANNELS.ProjectsReadMeta, projectId),
    updateMeta: (projectId, meta) =>
      ipcRenderer.invoke(IPC_CHANNELS.ProjectsUpdateMeta, { projectId, meta })
  },
  models: {
    getSettings: () => ipcRenderer.invoke(IPC_CHANNELS.ModelsGetSettings),
    saveSettings: (settings) => ipcRenderer.invoke(IPC_CHANNELS.ModelsSaveSettings, settings),
    discoverCcSwitch: () => ipcRenderer.invoke(IPC_CHANNELS.ModelsDiscoverCcSwitch),
    testConnection: (profile) => ipcRenderer.invoke(IPC_CHANNELS.ModelsTestConnection, profile)
  },
  mcp: {
    listConnectors: () => ipcRenderer.invoke(IPC_CHANNELS.McpListConnectors),
    setEnabled: (payload) => ipcRenderer.invoke(IPC_CHANNELS.McpSetEnabled, payload),
    checkConnection: (name) => ipcRenderer.invoke(IPC_CHANNELS.McpCheckConnection, name),
    installPlugin: (name) => ipcRenderer.invoke(IPC_CHANNELS.McpInstallPlugin, name)
  },
  cadPreview: {
    prepare: (filePath) => ipcRenderer.invoke(IPC_CHANNELS.CadPreviewPrepare, filePath)
  },
  modelPreview: {
    prepare: (filePath) => ipcRenderer.invoke(IPC_CHANNELS.ModelPreviewPrepare, filePath)
  },
  files: {
    listWorkspace: (dirPath) => ipcRenderer.invoke(IPC_CHANNELS.FilesListWorkspace, dirPath),
    readPreview: (filePath) => ipcRenderer.invoke(IPC_CHANNELS.FilesReadPreview, filePath),
    readBytes: (filePath) => ipcRenderer.invoke(IPC_CHANNELS.FilesReadBytes, filePath),
    saveText: (filePath, content, rootDir) =>
      ipcRenderer.invoke(IPC_CHANNELS.FilesSaveText, { filePath, content, rootDir }),
    saveAs: (filePath) => ipcRenderer.invoke(IPC_CHANNELS.FilesSaveAs, filePath),
    listSnapshots: (filePath, rootDir) =>
      ipcRenderer.invoke(IPC_CHANNELS.FilesListSnapshots, { filePath, rootDir }),
    restoreSnapshot: (filePath, snapshotId, rootDir) =>
      ipcRenderer.invoke(IPC_CHANNELS.FilesRestoreSnapshot, { filePath, snapshotId, rootDir })
  },
  clipboard: {
    writeImage: (filePath) => ipcRenderer.invoke(IPC_CHANNELS.ClipboardWriteImage, filePath)
  },
  pptWorkbench: {
    applyProposal: (proposal) => ipcRenderer.invoke(IPC_CHANNELS.PptWorkbenchApplyProposal, proposal)
  },
  skills: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.SkillsList)
  },
  regulations: {
    stats: () => ipcRenderer.invoke(IPC_CHANNELS.RegulationStats)
  },
  shell: {
    openPath: (targetPath) => ipcRenderer.invoke(IPC_CHANNELS.ShellOpenPath, targetPath),
    showItemInFolder: (targetPath) => ipcRenderer.invoke(IPC_CHANNELS.ShellShowItemInFolder, targetPath)
  }
}

contextBridge.exposeInMainWorld('zmo', api)
