import { create } from 'zustand'
import type {
  AppGeneralSettings,
  CcSwitchCandidate,
  McpConnectorInfo,
  ModelSettingsState,
  PersistedTurnItem,
  ProjectSummary,
  RecentFileEntry,
  SkillInfo,
  TaskSummary
} from '@shared/ipc'
import type {
  AgentAttachment,
  AgentDecision,
  AgentToolAction,
  AskAnswer,
  AskQuestion,
  AuthorizationRequestContext,
  ConversationRef,
  ImageEditAnswer,
  ModelAnnotationRef,
  ModelProviderProfile,
  PermissionMode,
  PptProposal,
  PptWorkbenchSelection,
  RuntimeOutbound,
  SceneParam,
  TodoItem,
  WriteTodosToolData
} from '@shared/protocol'
import { inheritInterruptedTodos, settleCompletedTodos } from '@shared/todoUtils'

export function ccCandidateProfileId(uid: string): string {
  return `cc_${uid.replace(/[^a-zA-Z0-9_-]/g, '_')}`
}

export function candidateToProfile(
  c: CcSwitchCandidate,
  existingId?: string
): ModelProviderProfile {
  return {
    id: existingId ?? ccCandidateProfileId(c.uid),
    label: c.name,
    protocol: c.protocol,
    baseUrl: c.baseUrl,
    apiKey: c.apiKey,
    model: c.model,
    subagentModel: '',
    supportsThinking: true,
    enablePromptCache: c.protocol === 'anthropic',
    useResponsesApi: Boolean(c.useResponsesApi),
    ...(c.authStyle ? { authStyle: c.authStyle } : {}),
    ...(c.contextWindowTokens ? { contextWindowTokens: c.contextWindowTokens } : {}),
    maxOutputTokens: 16384
  }
}

function normalizeEndpointBase(url: string): string {
  return url.trim().replace(/\/+$/, '').replace(/\/v\d+$/i, '')
}

/**
 * 只保留「本机当前正在激活且健康」或「所属中转已在软件内配置过」的候选模型，
 * 并按 (baseUrl, model) 去重，避免历史失效中转堆满界面。
 */
export function filterActiveRecognizedCandidates(
  candidates: CcSwitchCandidate[],
  profiles: ModelProviderProfile[]
): CcSwitchCandidate[] {
  const configured = profiles.filter((p) => Boolean(p.apiKey?.trim()))
  const configuredIds = new Set(configured.map((p) => p.id))
  const seenKeys = new Set(
    configured.map((p) => `${normalizeEndpointBase(p.baseUrl)}::${p.model.trim()}`)
  )
  const configuredProviderKeys = new Set(
    configured.map((p) => `${normalizeEndpointBase(p.baseUrl)}::${p.apiKey.trim()}`)
  )

  const out: CcSwitchCandidate[] = []
  for (const c of candidates) {
    if (!c.apiKey?.trim() || !c.baseUrl?.trim() || !c.model?.trim()) continue
    if (c.isHealthy === false) continue

    const isSiblingOfConfigured = configuredProviderKeys.has(
      `${normalizeEndpointBase(c.baseUrl)}::${c.apiKey.trim()}`
    )
    if (!c.isCurrent && !isSiblingOfConfigured) continue

    if (configuredIds.has(ccCandidateProfileId(c.uid))) continue
    const dedupKey = `${normalizeEndpointBase(c.baseUrl)}::${c.model.trim()}`
    if (seenKeys.has(dedupKey)) continue
    seenKeys.add(dedupKey)
    out.push(c)
  }
  return out
}

export interface PendingInterruptState {
  requestId: string
  actions: AgentToolAction[]
  authorization: AuthorizationRequestContext
  message: string
  delta?: string
}

export interface PendingAskUserState {
  requestId: string
  id?: string
  questions: AskQuestion[]
  interaction?: 'host-readiness'
}

export interface PendingImageEditState {
  requestId: string
  id: string
  hint: string
  imagePath: string
}

export interface ThreadSlice {
  turns: PersistedTurnItem[]
  running: boolean
  pendingInterrupt: PendingInterruptState | null
  pendingAskUser: PendingAskUserState | null
  pendingImageEdit: PendingImageEditState | null
  latestTodos: TodoItem[]
}

interface PreviewTarget {
  path: string
  title: string
}

interface WorkspaceState {
  initialized: boolean
  tasks: TaskSummary[]
  projects: ProjectSummary[]
  skills: SkillInfo[]
  mcpConnectors: McpConnectorInfo[]
  draftAnnotations: ModelAnnotationRef[]
  draftConversationRefs: ConversationRef[]
  pptSelection: PptWorkbenchSelection | null
  pendingPptProposals: Record<string, PptProposal>
  activeProjectId: string | null
  activeTaskId: string | null
  openTabIds: string[]
  activeView: 'chat' | 'toolbox'
  recentFiles: RecentFileEntry[]
  generalSettings: AppGeneralSettings | null
  slices: Record<string, ThreadSlice>
  permissionMode: PermissionMode
  thinkingEnabled: boolean
  aiSchemeMode: boolean
  modelSettings: ModelSettingsState | null
  ccSwitchCandidates: CcSwitchCandidate[]
  ccSwitchLoading: boolean
  settingsModalOpen: boolean
  workbenchOpen: boolean
  workbenchTab: 'files' | 'preview' | 'skills' | 'memory'
  previewTarget: PreviewTarget | null

  init: () => Promise<void>
  selectTask: (taskId: string | null) => Promise<void>
  createNewTask: (options?: {
    title?: string
    projectId?: string | null
    rootDir?: string
  }) => Promise<TaskSummary>
  renameTask: (taskId: string, title: string) => Promise<void>
  deleteTask: (taskId: string) => Promise<void>
  createProject: (name: string, folderPath: string) => Promise<ProjectSummary>
  renameProject: (projectId: string, name: string) => Promise<void>
  deleteProject: (projectId: string) => Promise<void>
  setActiveProjectId: (projectId: string | null) => void
  closeTab: (taskId: string) => void
  setActiveView: (view: 'chat' | 'toolbox') => void
  refreshRecentFiles: () => Promise<void>
  saveGeneralSettings: (next: AppGeneralSettings) => Promise<void>

  refreshMcpConnectors: () => Promise<void>
  toggleMcpConnector: (name: string, enabled: boolean) => Promise<void>

  attachAnnotationRef: (ref: ModelAnnotationRef) => void
  removeAnnotationRef: (path: string) => void
  clearDraftAnnotations: () => void

  attachConversationRef: (ref: ConversationRef) => void
  removeConversationRef: (path: string) => void
  clearDraftConversationRefs: () => void

  setPptSelection: (sel: PptWorkbenchSelection | null) => void
  resolvePptProposal: (pptPath: string, accept: boolean) => Promise<void>

  sendMessage: (params: {
    text: string
    attachments?: AgentAttachment[]
    annotations?: ModelAnnotationRef[]
    conversationRefs?: ConversationRef[]
    sceneParam?: SceneParam
  }) => Promise<{ ok: boolean; error?: string }>
  resolveInterrupt: (threadId: string, decision: AgentDecision) => Promise<void>
  submitUserAnswer: (threadId: string, answers: AskAnswer[]) => Promise<void>
  submitImageEditAnswer: (threadId: string, id: string, answer: ImageEditAnswer) => Promise<void>
  stopTask: (threadId: string) => Promise<void>

  setPermissionMode: (mode: PermissionMode) => Promise<void>
  setThinkingEnabled: (on: boolean) => void
  setAiSchemeMode: (on: boolean) => void
  setSettingsModalOpen: (open: boolean) => void
  saveModelSettings: (next: ModelSettingsState) => Promise<void>
  setActiveProfileId: (profileId: string) => Promise<void>
  refreshCcSwitchCandidates: () => Promise<void>
  importAndActivateCandidate: (candidate: CcSwitchCandidate) => Promise<void>

  setWorkbenchOpen: (open: boolean) => void
  setWorkbenchTab: (tab: 'files' | 'preview' | 'skills' | 'memory') => void
  openFilePreview: (path: string, title: string) => void
  handleRuntimeEvent: (event: RuntimeOutbound) => void
}

function emptySlice(): ThreadSlice {
  return {
    turns: [],
    running: false,
    pendingInterrupt: null,
    pendingAskUser: null,
    pendingImageEdit: null,
    latestTodos: []
  }
}

function extractLatestTodos(turns: PersistedTurnItem[]): TodoItem[] {
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]
    if (t.role === 'assistant') {
      if (!t.todos || t.todos.length === 0) return []
      return t.status === 'completed' ? settleCompletedTodos(t.todos) : t.todos
    }
  }
  return []
}

function extractPendingFromTurns(
  turns: PersistedTurnItem[]
): Pick<ThreadSlice, 'pendingInterrupt' | 'pendingAskUser' | 'pendingImageEdit'> {
  const lastAssistant = [...turns].reverse().find((t) => t.role === 'assistant')
  if (!lastAssistant || lastAssistant.role !== 'assistant' || !lastAssistant.pendingInteraction) {
    return { pendingInterrupt: null, pendingAskUser: null, pendingImageEdit: null }
  }
  const pending = lastAssistant.pendingInteraction
  if (pending.kind === 'interrupt') {
    return {
      pendingInterrupt: {
        requestId: pending.requestId,
        actions: pending.actions,
        authorization: pending.authorization,
        message: pending.message,
        delta: pending.delta
      },
      pendingAskUser: null,
      pendingImageEdit: null
    }
  }
  if (pending.kind === 'ask_user') {
    return {
      pendingInterrupt: null,
      pendingAskUser: {
        requestId: pending.requestId,
        id: pending.id,
        questions: pending.questions,
        interaction: pending.interaction
      },
      pendingImageEdit: null
    }
  }
  return {
    pendingInterrupt: null,
    pendingAskUser: null,
    pendingImageEdit: {
      requestId: pending.requestId,
      id: pending.id,
      hint: pending.hint,
      imagePath: pending.imagePath
    }
  }
}

let initInFlight: Promise<void> | null = null
let offAgentEvents: (() => void) | null = null
let offNotificationOpen: (() => void) | null = null

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  initialized: false,
  tasks: [],
  projects: [],
  skills: [],
  mcpConnectors: [],
  draftAnnotations: [],
  draftConversationRefs: [],
  pptSelection: null,
  pendingPptProposals: {},
  activeProjectId: null,
  activeTaskId: null,
  openTabIds: [],
  activeView: 'chat',
  recentFiles: [],
  generalSettings: null,
  slices: {},
  permissionMode: 'default',
  thinkingEnabled: false,
  aiSchemeMode: true,
  modelSettings: null,
  ccSwitchCandidates: [],
  ccSwitchLoading: false,
  settingsModalOpen: false,
  workbenchOpen: true,
  workbenchTab: 'files',
  previewTarget: null,

  init: async () => {
    if (get().initialized) return
    if (initInFlight) return initInFlight

    initInFlight = (async () => {
      const [tasks, projects, modelSettings, permissionMode, skills, mcpConnectors, recentFiles, generalSettings] =
        await Promise.all([
          window.zmo.tasks.list(),
          window.zmo.projects.list(),
          window.zmo.models.getSettings(),
          window.zmo.agent.getPermissionMode(),
          window.zmo.skills.list(),
          window.zmo.mcp.listConnectors(),
          window.zmo.recentFiles.list(),
          window.zmo.settings.getGeneral()
        ])

      offAgentEvents?.()
      offAgentEvents = window.zmo.agent.onEvent((ev) => {
        get().handleRuntimeEvent(ev)
      })
      offNotificationOpen?.()
      offNotificationOpen = window.zmo.taskNotifications.onOpenRequested((tid) => {
        void get().selectTask(tid)
      })

      set({
        initialized: true,
        tasks,
        projects,
        modelSettings,
        permissionMode,
        skills,
        mcpConnectors,
        recentFiles,
        generalSettings
      })

      void get().refreshCcSwitchCandidates()

      if (tasks.length > 0) {
        await get().selectTask(tasks[0].id)
      }
    })().finally(() => {
      initInFlight = null
    })

    return initInFlight
  },

  selectTask: async (taskId) => {
    if (!taskId) {
      set({ activeTaskId: null })
      return
    }
    const transcript = await window.zmo.tasks.readTranscript(taskId)
    set((state) => {
      const prev = state.slices[taskId] ?? emptySlice()
      const restoredPending = prev.running ? null : extractPendingFromTurns(transcript)
      const hasRestoredPending = Boolean(
        restoredPending &&
          (restoredPending.pendingInterrupt ||
            restoredPending.pendingAskUser ||
            restoredPending.pendingImageEdit)
      )
      const openTabIds = state.openTabIds.includes(taskId)
        ? state.openTabIds
        : [...state.openTabIds, taskId]
      return {
        activeTaskId: taskId,
        activeView: 'chat',
        openTabIds,
        slices: {
          ...state.slices,
          [taskId]: {
            ...prev,
            turns: transcript,
            running: prev.running || hasRestoredPending,
            ...(restoredPending ?? {}),
            latestTodos:
              prev.running && prev.latestTodos.length > 0
                ? prev.latestTodos
                : extractLatestTodos(transcript)
          }
        }
      }
    })
  },

  createNewTask: async (options) => {
    const projectId = options?.projectId !== undefined ? options.projectId : get().activeProjectId
    const created = await window.zmo.tasks.create({
      title: options?.title?.trim() || '新建设计对话',
      projectId,
      rootDir: options?.rootDir
    })
    const tasks = await window.zmo.tasks.list()
    set((state) => ({
      tasks,
      activeTaskId: created.id,
      activeView: 'chat',
      openTabIds: state.openTabIds.includes(created.id)
        ? state.openTabIds
        : [...state.openTabIds, created.id],
      slices: {
        ...state.slices,
        [created.id]: emptySlice()
      }
    }))
    return created
  },

  renameTask: async (taskId, title) => {
    const cleaned = title.trim()
    if (!cleaned) return
    const tasks = await window.zmo.tasks.rename(taskId, cleaned)
    set({ tasks })
  },

  deleteTask: async (taskId) => {
    await window.zmo.tasks.delete(taskId)
    const tasks = await window.zmo.tasks.list()
    const currentActive = get().activeTaskId
    set((state) => {
      const nextSlices = { ...state.slices }
      delete nextSlices[taskId]
      const nextTabs = state.openTabIds.filter((id) => id !== taskId)
      return {
        tasks,
        openTabIds: nextTabs,
        slices: nextSlices,
        activeTaskId:
          currentActive === taskId ? (nextTabs[0] ?? tasks[0]?.id ?? null) : currentActive
      }
    })
    const nextActive = get().activeTaskId
    if (nextActive) {
      await get().selectTask(nextActive)
    }
  },

  createProject: async (name, folderPath) => {
    const created = await window.zmo.projects.create({ name, folderPath })
    const projects = await window.zmo.projects.list()
    set({ projects, activeProjectId: created.id })
    await get().createNewTask({ projectId: created.id, rootDir: created.folderPath })
    return created
  },

  renameProject: async (projectId, name) => {
    const cleaned = name.trim()
    if (!cleaned) return
    const projects = await window.zmo.projects.rename(projectId, cleaned)
    set({ projects })
  },

  deleteProject: async (projectId) => {
    await window.zmo.projects.delete(projectId)
    const projects = await window.zmo.projects.list()
    set((state) => ({
      projects,
      activeProjectId: state.activeProjectId === projectId ? null : state.activeProjectId
    }))
  },

  setActiveProjectId: (projectId) => set({ activeProjectId: projectId }),

  closeTab: (taskId) => {
    set((state) => {
      const nextTabs = state.openTabIds.filter((id) => id !== taskId)
      const nextActive =
        state.activeTaskId === taskId ? (nextTabs[nextTabs.length - 1] ?? null) : state.activeTaskId
      return { openTabIds: nextTabs, activeTaskId: nextActive }
    })
  },

  setActiveView: (view) => set({ activeView: view }),

  refreshRecentFiles: async () => {
    const recentFiles = await window.zmo.recentFiles.list()
    set({ recentFiles })
  },

  saveGeneralSettings: async (next) => {
    const saved = await window.zmo.settings.saveGeneral(next)
    set({ generalSettings: saved })
  },

  refreshMcpConnectors: async () => {
    const mcpConnectors = await window.zmo.mcp.listConnectors()
    set({ mcpConnectors })
  },

  toggleMcpConnector: async (name, enabled) => {
    const mcpConnectors = await window.zmo.mcp.setEnabled({ name, enabled })
    set({ mcpConnectors })
  },

  attachAnnotationRef: (ref) => {
    set((state) => {
      const rest = state.draftAnnotations.filter((a) => a.path !== ref.path)
      return { draftAnnotations: [...rest, ref] }
    })
  },

  removeAnnotationRef: (path) => {
    set((state) => ({
      draftAnnotations: state.draftAnnotations.filter((a) => a.path !== path)
    }))
  },

  clearDraftAnnotations: () => set({ draftAnnotations: [] }),

  attachConversationRef: (ref) => {
    set((state) => {
      if (state.draftConversationRefs.some((c) => c.path === ref.path)) return state
      return { draftConversationRefs: [...state.draftConversationRefs, ref] }
    })
  },

  removeConversationRef: (path) => {
    set((state) => ({
      draftConversationRefs: state.draftConversationRefs.filter((c) => c.path !== path)
    }))
  },

  clearDraftConversationRefs: () => set({ draftConversationRefs: [] }),

  setPptSelection: (sel) => set({ pptSelection: sel }),

  resolvePptProposal: async (pptPath, accept) => {
    const key = pptPath.replace(/\\/g, '/').toLowerCase()
    const prop = get().pendingPptProposals[key]
    if (!prop) return
    if (accept) {
      const res = await window.zmo.pptWorkbench.applyProposal(prop)
      if (!res.ok) {
        console.error('Failed to apply PPT proposal:', res.error)
        return
      }
    }
    set((state) => {
      const next = { ...state.pendingPptProposals }
      delete next[key]
      return { pendingPptProposals: next }
    })
  },

  sendMessage: async ({ text, attachments, annotations, conversationRefs, sceneParam }) => {
    let taskId = get().activeTaskId
    if (!taskId) {
      const created = await get().createNewTask()
      taskId = created.id
    }

    const activeTask = get().tasks.find((t) => t.id === taskId)
    const enabledMcp = get()
      .mcpConnectors.filter((c) => c.enabled)
      .map((c) => ({ name: c.name, label: c.label }))

    const res = await window.zmo.agent.send({
      threadId: taskId,
      text,
      rootDir: activeTask?.rootDir,
      projectId: activeTask?.projectId ?? get().activeProjectId,
      attachments,
      annotations,
      conversationRefs,
      pptSelection: get().pptSelection ?? undefined,
      mcp: enabledMcp.length > 0 ? enabledMcp : undefined,
      sceneParam,
      thinking: get().thinkingEnabled,
      profileId: get().modelSettings?.activeProfileId,
      profile: get().aiSchemeMode ? 'ai-scheme-v1' : 'default'
    })

    if (!res.ok) {
      if (res.error?.includes('API Key')) {
        set({ settingsModalOpen: true })
      }
      return { ok: false, error: res.error }
    }

    const requestId = res.requestId!
    const now = Date.now()

    set((state) => {
      const slice = state.slices[taskId!] ?? emptySlice()
      const inheritedTodos = inheritInterruptedTodos(slice.turns)
      const nextTurns: PersistedTurnItem[] = [
        ...slice.turns,
        {
          id: `user_${requestId}`,
          role: 'user',
          text,
          attachments,
          annotations,
          conversationRefs,
          mcp: enabledMcp.length > 0 ? enabledMcp : undefined,
          sceneParam,
          createdAt: now
        },
        {
          id: `asst_${requestId}`,
          role: 'assistant',
          requestId,
          reasoning: '',
          content: '',
          toolCalls: [],
          todos: inheritedTodos,
          deliverables: [],
          status: 'streaming',
          createdAt: now + 1
        }
      ]
      return {
        slices: {
          ...state.slices,
          [taskId!]: {
            ...slice,
            turns: nextTurns,
            running: true,
            pendingInterrupt: null,
            pendingAskUser: null,
            pendingImageEdit: null,
            latestTodos: inheritedTodos
          }
        }
      }
    })

    return { ok: true }
  },

  resolveInterrupt: async (threadId, decision) => {
    if (decision.type === 'approve' && decision.scope === 'all') {
      set({ permissionMode: 'auto' })
    }
    set((state) => {
      const slice = state.slices[threadId]
      if (!slice) return state
      return {
        slices: {
          ...state.slices,
          [threadId]: { ...slice, running: true, pendingInterrupt: null }
        }
      }
    })
    await window.zmo.agent.resume({ threadId, decision })
  },

  submitUserAnswer: async (threadId, answers) => {
    set((state) => {
      const slice = state.slices[threadId]
      if (!slice) return state
      return {
        slices: {
          ...state.slices,
          [threadId]: { ...slice, running: true, pendingAskUser: null }
        }
      }
    })
    await window.zmo.agent.userAnswer({ threadId, answers })
  },

  submitImageEditAnswer: async (threadId, id, answer) => {
    set((state) => {
      const slice = state.slices[threadId]
      if (!slice) return state
      return {
        slices: {
          ...state.slices,
          [threadId]: { ...slice, running: true, pendingImageEdit: null }
        }
      }
    })
    await window.zmo.agent.imageEditAnswer({ threadId, id, answer })
  },

  stopTask: async (threadId) => {
    await window.zmo.agent.stop(threadId)
  },

  setPermissionMode: async (mode) => {
    const saved = await window.zmo.agent.setPermissionMode(mode)
    set({ permissionMode: saved })
  },

  setThinkingEnabled: (on) => set({ thinkingEnabled: on }),
  setAiSchemeMode: (on) => set({ aiSchemeMode: on }),
  setSettingsModalOpen: (open) => set({ settingsModalOpen: open }),

  saveModelSettings: async (next) => {
    const saved = await window.zmo.models.saveSettings(next)
    set({ modelSettings: saved })
  },

  setActiveProfileId: async (profileId) => {
    const cur = get().modelSettings
    if (!cur) return
    const next: ModelSettingsState = { ...cur, activeProfileId: profileId }
    const saved = await window.zmo.models.saveSettings(next)
    set({ modelSettings: saved })
  },

  refreshCcSwitchCandidates: async () => {
    if (get().ccSwitchLoading) return
    set({ ccSwitchLoading: true })
    try {
      const res = await window.zmo.models.discoverCcSwitch()
      const valid = (res.candidates ?? []).filter(
        (c) => Boolean(c.apiKey?.trim()) && Boolean(c.baseUrl?.trim()) && Boolean(c.model?.trim())
      )
      set({ ccSwitchCandidates: valid })
    } catch {
      // 本机无 CC Switch / Claude / Codex 配置时保持空列表
    } finally {
      set({ ccSwitchLoading: false })
    }
  },

  importAndActivateCandidate: async (c) => {
    const cur = get().modelSettings
    if (!cur) return
    const generatedId = ccCandidateProfileId(c.uid)
    const normalizedBase = c.baseUrl.replace(/\/+$/, '')
    const matchIdx = cur.profiles.findIndex(
      (p) =>
        p.id === generatedId ||
        (p.label === c.name &&
          p.baseUrl.replace(/\/+$/, '') === normalizedBase &&
          p.model === c.model)
    )
    const nextProfiles = [...cur.profiles]
    let targetId: string
    if (matchIdx >= 0) {
      targetId = nextProfiles[matchIdx].id
      nextProfiles[matchIdx] = {
        ...nextProfiles[matchIdx],
        ...candidateToProfile(c, targetId)
      }
    } else {
      const created = candidateToProfile(c)
      targetId = created.id
      nextProfiles.push(created)
    }
    const saved = await window.zmo.models.saveSettings({
      ...cur,
      activeProfileId: targetId,
      profiles: nextProfiles
    })
    set({ modelSettings: saved })
  },

  setWorkbenchOpen: (open) => set({ workbenchOpen: open }),
  setWorkbenchTab: (tab) => set({ workbenchTab: tab }),
  openFilePreview: (path, title) => {
    set({
      workbenchOpen: true,
      workbenchTab: 'preview',
      previewTarget: { path, title }
    })
  },

  handleRuntimeEvent: (event) => {
    if (!('threadId' in event)) return
    const { threadId } = event

    if (event.type === 'newchat') {
      void window.zmo.tasks.list().then((tasks) => set({ tasks }))
      return
    }

    if (event.type === 'ppt_proposal') {
      const key = event.proposal.pptPath.replace(/\\/g, '/').toLowerCase()
      const name = event.proposal.pptPath.split(/[\\/]/).pop() || '演示文稿.pptx'
      set((state) => ({
        pendingPptProposals: { ...state.pendingPptProposals, [key]: event.proposal },
        workbenchOpen: true,
        workbenchTab: 'preview',
        previewTarget: { path: event.proposal.pptPath, title: name }
      }))
      return
    }

    set((state) => {
      const slice = state.slices[threadId] ?? emptySlice()
      const turns = [...slice.turns]
      const findLastAssistantIdx = (): number => {
        for (let i = turns.length - 1; i >= 0; i--) {
          const item = turns[i]
          if (
            item.role === 'assistant' &&
            ('requestId' in event ? item.requestId === event.requestId : true)
          ) {
            return i
          }
        }
        return -1
      }

      const idx = findLastAssistantIdx()
      const asst =
        idx >= 0 ? { ...(turns[idx] as Extract<PersistedTurnItem, { role: 'assistant' }>) } : null
      if (asst && idx >= 0) {
        asst.toolCalls = [...asst.toolCalls]
        turns[idx] = asst
      }

      let nextRunning = slice.running
      let nextInterrupt = slice.pendingInterrupt
      let nextAskUser = slice.pendingAskUser
      let nextImageEdit = slice.pendingImageEdit
      let nextTodos = slice.latestTodos

      switch (event.type) {
        case 'token':
          if (asst) asst.content += event.delta
          break
        case 'reasoning':
          if (asst) asst.reasoning += event.delta
          break
        case 'tool':
          if (asst) {
            const id = event.id ?? `tc_${asst.toolCalls.length}`
            if (!asst.toolCalls.some((t) => t.id === id)) {
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
          }
          break
        case 'tool-result':
          if (asst) {
            const tcIdx = event.id
              ? asst.toolCalls.findIndex((t) => t.id === event.id)
              : asst.toolCalls.findIndex((t) => t.name === event.name && t.status === 'running')
            if (tcIdx >= 0) {
              asst.toolCalls[tcIdx] = {
                ...asst.toolCalls[tcIdx],
                status: event.ok ? 'success' : 'error',
                toolData: event.toolData,
                ...(event.delta ? { delta: event.delta } : {})
              }
            }
            if (
              event.toolData &&
              typeof event.toolData === 'object' &&
              (event.toolData as { kind?: string }).kind === 'write_todos'
            ) {
              const td = event.toolData as WriteTodosToolData
              asst.todos = td.todos
              nextTodos = td.todos
            }
          }
          break
        case 'subagent':
          if (asst) {
            const pIdx = asst.toolCalls.findIndex((t) => t.id === event.parentToolCallId)
            if (pIdx >= 0) {
              const prevSub = asst.toolCalls[pIdx].subagentEvents ?? []
              asst.toolCalls[pIdx] = {
                ...asst.toolCalls[pIdx],
                subagentEvents: [...prevSub, event.event]
              }
            }
          }
          break
        case 'interrupt':
          nextInterrupt = {
            requestId: event.requestId,
            actions: event.actions,
            authorization: event.authorization,
            message: event.message,
            delta: event.delta
          }
          break
        case 'ask_user':
          nextAskUser = {
            requestId: event.requestId,
            id: event.id,
            questions: event.questions,
            interaction: event.interaction
          }
          break
        case 'ask_image_edit':
          nextImageEdit = {
            requestId: event.requestId,
            id: event.id,
            hint: event.hint,
            imagePath: event.imagePath
          }
          break
        case 'suggestions':
          if (asst) {
            asst.suggestions = event.items
          }
          break
        case 'usage':
          if (asst) {
            asst.usage = event.usage
          }
          break
        case 'done':
          if (asst) {
            asst.status = 'completed'
            asst.deliverables = event.deliverables
            asst.finishedAt = Date.now()
            if (event.usage) asst.usage = event.usage
            if (asst.todos.length > 0) {
              asst.todos = settleCompletedTodos(asst.todos)
              nextTodos = asst.todos
            } else if (nextTodos.length > 0) {
              nextTodos = settleCompletedTodos(nextTodos)
            }
          }
          void window.zmo.recentFiles.list().then((rf) => set({ recentFiles: rf }))
          nextRunning = false
          nextInterrupt = null
          nextAskUser = null
          nextImageEdit = null
          break
        case 'aborted':
          if (asst) {
            asst.status = 'aborted'
            asst.deliverables = event.deliverables
            asst.finishedAt = Date.now()
            if (event.usage) asst.usage = event.usage
          }
          nextRunning = false
          nextInterrupt = null
          nextAskUser = null
          nextImageEdit = null
          break
        case 'error':
          if (asst) {
            asst.status = 'error'
            asst.errorMessage = event.userMessage || event.message
            asst.finishedAt = Date.now()
            if (event.deliverables) asst.deliverables = event.deliverables
            if (event.usage) asst.usage = event.usage
          }
          nextRunning = false
          nextInterrupt = null
          nextAskUser = null
          nextImageEdit = null
          break
      }

      return {
        slices: {
          ...state.slices,
          [threadId]: {
            turns,
            running: nextRunning,
            pendingInterrupt: nextInterrupt,
            pendingAskUser: nextAskUser,
            pendingImageEdit: nextImageEdit,
            latestTodos: nextTodos
          }
        }
      }
    })
  }
}))
