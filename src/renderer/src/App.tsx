import React, { useEffect, useRef, useState } from 'react'
import {
  ChevronDown,
  Compass,
  FileSpreadsheet,
  FileText,
  FolderPlus,
  PanelRight,
  ShieldCheck,
  Sparkles,
  Wand2,
  X
} from 'lucide-react'
import clsx from 'clsx'
import type { AgentAttachment, SceneParam } from '@shared/protocol'
import type { ProjectMeta, ProjectSummary } from '@shared/ipc'
import type { FeatureSubmission } from './features/taskForm/compose'
import {
  filterActiveRecognizedCandidates,
  useWorkspaceStore,
  type ComposerMode
} from './store/useWorkspaceStore'
import { TodoBar } from './components/TodoBar'
import { ComposerCard } from './components/chat/ComposerCard'
import { WindowTitleBar } from './components/layout/WindowTitleBar'
import { UpdateBanner } from './components/UpdateBanner'
import { WorkspaceSidebar } from './components/layout/WorkspaceSidebar'
import { ProjectMetaModal } from './components/modals/ProjectMetaModal'
import { CharterModal } from './components/modals/CharterModal'
import { InterruptCard } from './components/InterruptCard'
import { ClarifyCard } from './components/ClarifyCard'
import { AssistantTurnView } from './components/AssistantTurnView'
import { RightWorkbench } from './components/RightWorkbench'
import { ModelSettingsModal } from './components/ModelSettingsModal'
import { ImageEditModal } from './components/ImageEditModal'
import { DeliveryPopover } from './components/DeliveryPopover'
import {
  ToolboxPanel,
  type SceneToolboxPreset
} from './components/SceneToolboxBar'
import {
  MODE_HEADLINE,
  MODE_TABS,
  ModeEcosystemPanel
} from './components/WorkspaceModeHome'
import { LocalLibraryView } from './components/LocalLibraryView'

const QUICK_SCENES = [
  {
    title: 'AI 空间方案策划',
    featureCode: 'B2.1',
    desc: '基于任务书、CAD 或现状资料完成功能分区、动线分析与概念方案',
    prompt:
      '请帮我根据项目任务条件做一份空间概念设计与功能动线分析方案，如果有缺失的核心设计边界请先向我确认。',
    icon: Compass
  },
  {
    title: 'CAD 图纸深度解析',
    featureCode: 'B3.1',
    desc: '调用本地 cad.py 提取图幅、图层、房间尺寸与标高，支持右侧交互框选批注',
    prompt:
      '请读取我上传的 CAD 图纸（.dwg/.dxf），先列出图幅总览与主要空间尺寸指标，并检查是否存在天正对象或缺失项。',
    icon: FileSpreadsheet
  },
  {
    title: 'SketchUp / Blender 建模联动',
    featureCode: 'B3.6',
    desc: '开启下方软件连接器后，直接驱动本机 SketchUp 或 Blender 生成三维体块',
    prompt:
      '请检查当前已启用的三维建模软件连接器状态，并帮我创建一个现代极简客厅的基础墙体与沙发岛台体块模型。',
    icon: Sparkles
  },
  {
    title: '建筑规范检索与效果图精修',
    featureCode: 'B8.2',
    desc: '支持本地建筑规范知识库条文核验与 13 类室内/建筑效果图生成改图',
    prompt:
      '请帮我检索无障碍卫生间轮椅回转空间和抓杆尺寸的国家与北京规范要求，并附上条文引用。',
    icon: Wand2
  }
]

export const App: React.FC = () => {
  const {
    initialized,
    init,
    tasks,
    projects,
    skills,
    mcpConnectors,
    draftAnnotations,
    draftConversationRefs,
    pptSelection,
    pendingPptProposals,
    activeProjectId,
    activeTaskId,
    openTabIds,
    activeView,
    composerMode,
    recentFiles,
    regulationStats,
    generalSettings,
    slices,
    permissionMode,
    thinkingEnabled,
    aiSchemeMode,
    modelSettings,
    ccSwitchCandidates,
    ccSwitchLoading,
    settingsModalOpen,
    workbenchOpen,
    workbenchTab,
    previewTarget,
    selectTask,
    createNewTask,
    renameTask,
    deleteTask,
    createProject,
    renameProject,
    deleteProject,
    setActiveProjectId,
    closeTab,
    setActiveView,
    setComposerMode,
    refreshRecentFiles,
    refreshRegulationStats,
    saveGeneralSettings,
    refreshMcpConnectors,
    toggleMcpConnector,
    attachAnnotationRef,
    removeAnnotationRef,
    clearDraftAnnotations,
    attachConversationRef,
    removeConversationRef,
    clearDraftConversationRefs,
    setPptSelection,
    resolvePptProposal,
    sendMessage,
    resolveInterrupt,
    submitUserAnswer,
    submitImageEditAnswer,
    stopTask,
    setPermissionMode,
    setThinkingEnabled,
    setAiSchemeMode,
    setSettingsModalOpen,
    saveModelSettings,
    setActiveProfileId,
    refreshCcSwitchCandidates,
    importAndActivateCandidate,
    setWorkbenchOpen,
    setWorkbenchTab,
    openFilePreview
  } = useWorkspaceStore()

  const [inputText, setInputText] = useState('')
  const [attachments, setAttachments] = useState<AgentAttachment[]>([])
  const [todoOpen, setTodoOpen] = useState(false)
  const [plusMenuOpen, setPlusMenuOpen] = useState(false)
  const [plusSubmenu, setPlusSubmenu] = useState<'none' | 'recent' | 'conv' | 'mcp'>('none')
  const [permMenuOpen, setPermMenuOpen] = useState(false)
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [regScope, setRegScope] = useState<'comprehensive' | 'retrieve' | 'qa'>('comprehensive')
  const [atBottom, setAtBottom] = useState(true)
  const [projectMetaTarget, setProjectMetaTarget] = useState<ProjectSummary | null>(null)
  const [projectMetaDraft, setProjectMetaDraft] = useState<ProjectMeta>({})
  const [dragOver, setDragOver] = useState(false)
  const [charterOpen, setCharterOpen] = useState(false)
  const [charterDraft, setCharterDraft] = useState('')
  const [isMaximized, setIsMaximized] = useState(false)
  const [activeScenePreset, setActiveScenePreset] = useState<SceneToolboxPreset | null>(null)
  const [sceneParamValues, setSceneParamValues] = useState<Record<string, string>>({})
  const [initialToolboxCode, setInitialToolboxCode] = useState<string | null>(null)
  const [sendError, setSendError] = useState<string | null>(null)
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)
  const scrollBottomRef = useRef<HTMLDivElement | null>(null)
  const taskSearchInputRef = useRef<HTMLInputElement | null>(null)
  /** 任务进行中按下的消息先排队，本轮结束后按顺序发出（以前是直接丢弃，用户以为发出去了） */
  const queuedSendRef = useRef<Array<{ taskId: string | null; payload: Parameters<typeof sendMessage>[0] & { restore: () => void } }>>([])
  const [queuedCount, setQueuedCount] = useState(0)
  /** 排队消息发送失败后暂停的任务：不自动重试（多半是密钥 / 网络问题，连发只会连败），用户在输入框按回车再继续 */
  const queuePausedRef = useRef<Set<string | null>>(new Set())
  /** 队列内容变了但 running / activeTaskId 没变时，用它触发下面的出队 effect */
  const [queueVersion, setQueueVersion] = useState(0)

  useEffect(() => {
    void init()
    void window.designAgent.window.isMaximized().then(setIsMaximized)
    const offMax = window.designAgent.window.onMaximizeChanged(setIsMaximized)
    return () => offMax()
  }, [init])

  const activeTask = tasks.find((t) => t.id === activeTaskId) ?? null
  const activeSlice = activeTaskId ? slices[activeTaskId] : undefined
  const turns = activeSlice?.turns ?? []
  const running = activeSlice?.running ?? false
  const pendingInterrupt = activeSlice?.pendingInterrupt ?? null
  const pendingAskUser = activeSlice?.pendingAskUser ?? null
  const pendingImageEdit = activeSlice?.pendingImageEdit ?? null
  const latestTodos = activeSlice?.latestTodos ?? []

  useEffect(() => {
    scrollBottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [turns.length, turns[turns.length - 1], pendingInterrupt, pendingAskUser, pendingImageEdit])

  const configuredProfiles = (modelSettings?.profiles ?? []).filter((p) =>
    Boolean(p.apiKey?.trim())
  )
  const activeProfile =
    configuredProfiles.find((p) => p.id === modelSettings?.activeProfileId) ??
    configuredProfiles[0]

  const hasApiKey = Boolean(activeProfile)
  const recognizedCandidates = filterActiveRecognizedCandidates(
    ccSwitchCandidates,
    configuredProfiles
  )

  const handlePickFiles = async (role?: 'project_material' | 'ppt_template'): Promise<void> => {
    const picked = await window.designAgent.agent.pickFiles()
    if (picked.length > 0) {
      const withRole = role ? picked.map((p) => ({ ...p, role })) : picked
      setAttachments((prev) => {
        const existing = new Set(prev.map((p) => p.path))
        return [...prev, ...withRole.filter((p) => !existing.has(p.path))]
      })
      const firstPreviewable = withRole.find((p) =>
        /\.(dwg|dxf|skp|3dm|glb|gltf|obj|fbx|stl|pdf|xlsx|xls|docx|pptx)$/i.test(p.name)
      )
      if (firstPreviewable) {
        openFilePreview(firstPreviewable.path, firstPreviewable.name)
      }
    }
  }

  const handleSubmitFeature = async (sub: FeatureSubmission): Promise<void> => {
    if (!hasApiKey) {
      setSettingsModalOpen(true)
      return
    }
    setSendError(null)
    await createNewTask({ title: sub.title })
    setActiveView('chat')
    setActiveScenePreset(null)
    setSceneParamValues({})
    const res = await sendMessage({
      text: sub.text,
      attachments: sub.attachments.length > 0 ? sub.attachments : undefined,
      sceneParam: sub.sceneParam
    })
    if (!res.ok && res.error) {
      setSendError(res.error)
      setInputText(sub.text)
      setAttachments(sub.attachments)
    }
  }

  const handleFillFeature = async (sub: FeatureSubmission): Promise<void> => {
    if (!activeTaskId || turns.length > 0) {
      await createNewTask({ title: sub.title })
    }
    setActiveView('chat')
    setInputText(sub.text)
    setAttachments(sub.attachments)
    setActiveScenePreset({
      id: 'catalog-feature',
      category: '专业工作流',
      title: sub.sceneParam.toolTitle || sub.title,
      desc: '',
      prompt: sub.text,
      params: []
    })
    setSceneParamValues({})
  }

  const handleOpenFeatureCode = (code: string): void => {
    setInitialToolboxCode(code)
    setActiveView('toolbox')
  }

  const switchLeftMode = async (mode: ComposerMode): Promise<void> => {
    setActiveView('chat')
    setComposerMode(mode)
    if (turns.length > 0) {
      await createNewTask()
      setComposerMode(mode)
    }
  }

  const handleOpenProjectMeta = async (proj: ProjectSummary): Promise<void> => {
    const meta = await window.designAgent.projects.readMeta(proj.id)
    setProjectMetaDraft(meta)
    setProjectMetaTarget(proj)
  }

  const handleCreateProject = async (): Promise<void> => {
    const folder = await window.designAgent.agent.pickFolder('project')
    if (!folder) return
    const folderName = folder.split(/[\\/]/).filter(Boolean).pop() || '新建设计项目'
    await createProject(folderName, folder)
  }

  const appendAttachedFiles = (items: AgentAttachment[]): void => {
    if (items.length === 0) return
    setAttachments((prev) => {
      const existing = new Set(prev.map((p) => p.path))
      return [...prev, ...items.filter((p) => !existing.has(p.path))]
    })
    const firstPreviewable = items.find((p) =>
      /\.(dwg|dxf|skp|3dm|glb|gltf|obj|fbx|stl|pdf|xlsx|xls|docx|pptx|png|jpg|jpeg|webp)$/i.test(p.name)
    )
    if (firstPreviewable) {
      openFilePreview(firstPreviewable.path, firstPreviewable.name)
    }
  }

  const handleDropFiles = async (e: React.DragEvent): Promise<void> => {
    e.preventDefault()
    setDragOver(false)
    const files = Array.from(e.dataTransfer.files)
    if (files.length === 0) return
    const imgExts = /\.(png|jpg|jpeg|webp|gif|bmp|svg)$/i
    const mapped: AgentAttachment[] = []
    for (const file of files) {
      const filePath = (await window.designAgent.app?.getPathForFile(file)) || ''
      if (!filePath) continue
      mapped.push({
        path: filePath,
        name: file.name,
        kind: imgExts.test(file.name) ? 'image' : 'file',
        size: file.size
      })
    }
    appendAttachedFiles(mapped)
  }

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    const items = Array.from(e.clipboardData?.items ?? [])
    const imgItem = items.find((it) => it.type.startsWith('image/'))
    if (!imgItem) return
    const blob = imgItem.getAsFile()
    if (!blob) return
    e.preventDefault()
    const reader = new FileReader()
    reader.onload = async () => {
      const dataUrl = String(reader.result ?? '')
      const b64 = dataUrl.replace(/^data:image\/[a-z0-9+.-]+;base64,/i, '')
      if (!b64) return
      const att = await window.designAgent.agent.writeTempImage({
        base64: b64,
        name: `clipboard_${Date.now()}.png`,
        rootDir: activeTask?.rootDir
      })
      appendAttachedFiles([att])
    }
    reader.readAsDataURL(blob)
  }

  const handleOpenCharter = async (): Promise<void> => {
    if (!activeTask?.rootDir) return
    const text = await window.designAgent.projects.readCharter(activeTask.rootDir)
    setCharterDraft(text)
    setCharterOpen(true)
  }

  const buildSendPayload = (
    overrideText?: string
  ): (Parameters<typeof sendMessage>[0] & { restore: () => void }) | null => {
    const content = (overrideText ?? inputText).trim()
    const filesToSend = [...attachments]
    const annotationsToSend = [...draftAnnotations]
    const convRefsToSend = [...draftConversationRefs]
    if (
      !content &&
      filesToSend.length === 0 &&
      annotationsToSend.length === 0 &&
      convRefsToSend.length === 0 &&
      !pptSelection
    )
      return null
    const sceneParam: SceneParam | undefined = activeScenePreset
      ? { toolTitle: activeScenePreset.title, paramValues: sceneParamValues }
      : composerMode === 'regulation'
        ? {
            toolTitle:
              regScope === 'retrieve'
                ? '规范检索'
                : regScope === 'qa'
                  ? 'AI规范问答'
                  : '建筑规范检索与合规核查'
          }
        : undefined
    return {
      text:
        content ||
        (annotationsToSend.length > 0
          ? '请按照我附带的图纸/模型批注进行修改与分析。'
          : '请分析我附带的资料与历史上下文。'),
      attachments: filesToSend.length > 0 ? filesToSend : undefined,
      annotations: annotationsToSend.length > 0 ? annotationsToSend : undefined,
      conversationRefs: convRefsToSend.length > 0 ? convRefsToSend : undefined,
      sceneParam,
      restore: () => {
        if (overrideText) return
        setInputText(content)
        setAttachments(filesToSend)
        annotationsToSend.forEach(attachAnnotationRef)
        convRefsToSend.forEach(attachConversationRef)
      }
    }
  }

  type QueuedSend = { taskId: string | null; payload: Parameters<typeof sendMessage>[0] & { restore: () => void } }

  const queuedFor = (taskId: string | null): number => queuedSendRef.current.filter((q) => q.taskId === taskId).length

  /** fromQueue：排队消息出队发送。失败时放回队首并暂停，不把内容倒回输入框（用户可能正在打下一条） */
  const dispatchSend = async (
    payload: Parameters<typeof sendMessage>[0] & { restore: () => void },
    fromQueue?: QueuedSend
  ): Promise<void> => {
    setSendError(null)
    const { restore, ...message } = payload
    const res = await sendMessage(message)
    if (!res.ok && res.error) {
      if (fromQueue) {
        queuedSendRef.current.unshift(fromQueue)
        queuePausedRef.current.add(fromQueue.taskId)
        setQueuedCount(queuedFor(fromQueue.taskId))
        setSendError(`${res.error}（排队的消息已暂停，处理好后在输入框按回车继续，或点「清空」放弃）`)
      } else {
        setSendError(res.error)
        restore()
      }
    }
  }

  const handleSend = async (overrideText?: string): Promise<void> => {
    const payload = buildSendPayload(overrideText)
    const hasQueued = queuedFor(activeTaskId) > 0
    // 空输入也允许按回车：用来恢复暂停的排队消息
    if (!payload && !(hasQueued && !running)) return
    if (payload && !overrideText) {
      setInputText('')
      setAttachments([])
      clearDraftAnnotations()
      clearDraftConversationRefs()
    }
    // 任务进行中不能并发发送：排到队尾，本轮结束后自动发出，不再静默丢弃。
    // 本任务还有没发完的排队消息时也排到后面，保证先按先发
    if (running || hasQueued) {
      if (payload) queuedSendRef.current.push({ taskId: activeTaskId, payload })
      queuePausedRef.current.delete(activeTaskId)
      setQueuedCount(queuedFor(activeTaskId))
      setQueueVersion((v) => v + 1)
      return
    }
    if (payload) await dispatchSend(payload)
  }

  const clearQueued = (): void => {
    queuedSendRef.current = queuedSendRef.current.filter((q) => q.taskId !== activeTaskId)
    queuePausedRef.current.delete(activeTaskId)
    setQueuedCount(0)
  }

  // 每轮结束发出一条排队消息；发出后 running 会重新变 true，剩下的等下一轮结束再发。
  // 只发排给自己那个任务的：切到别的会话时不能把上一条排队的消息发过去
  // 按任务找第一条，别的会话排的消息不挡住这里
  useEffect(() => {
    setQueuedCount(queuedFor(activeTaskId))
    if (running) return
    if (queuePausedRef.current.has(activeTaskId)) return
    const index = queuedSendRef.current.findIndex((q) => q.taskId === activeTaskId)
    if (index < 0) return
    const [item] = queuedSendRef.current.splice(index, 1)
    setQueuedCount(queuedFor(activeTaskId))
    void dispatchSend(item.payload, item)
    // dispatchSend 每次渲染重建，只依赖稳定的 store 方法与 setState
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, activeTaskId, queueVersion])

  const refableTasks = tasks.filter((t) => t.id !== activeTaskId && t.transcriptPath)

  if (!initialized) {
    return (
      <div className="h-screen w-screen flex items-center justify-center text-xs text-zinc-500">
        正在启动空间设计智能体工作台…
      </div>
    )
  }

  const enabledConnectors = mcpConnectors.filter((c) => c.enabled)

  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden bg-[#f8f9fb] text-zinc-900">
      <WindowTitleBar
        toolboxActive={activeView === 'toolbox'}
        onToggleToolbox={() => setActiveView(activeView === 'toolbox' ? 'chat' : 'toolbox')}
        tabs={openTabIds.flatMap((tid) => {
          const t = tasks.find((x) => x.id === tid)
          return t
            ? [
                {
                  id: tid,
                  title: t.title,
                  running: Boolean(slices[tid]?.running),
                  active: activeView === 'chat' && activeTaskId === tid
                }
              ]
            : []
        })}
        onSelectTask={(tid) => void selectTask(tid)}
        onCloseTab={closeTab}
        onCreateTask={() => void createNewTask()}
        onFocusSearch={() => taskSearchInputRef.current?.focus()}
        onOpenSettings={() => setSettingsModalOpen(true)}
        isMaximized={isMaximized}
      />

      <UpdateBanner />

      <div className="flex-1 min-h-0 flex overflow-hidden">
      <WorkspaceSidebar
        activeView={activeView}
        composerMode={composerMode}
        onNewTask={() => {
          setComposerMode('general')
          setActiveView('chat')
          void createNewTask()
        }}
        onSwitchMode={(mode) => void switchLeftMode(mode)}
        onOpenLibrary={() => {
          void refreshRecentFiles()
          setActiveView('library')
        }}
        onOpenWorkbench={() => {
          setActiveView('chat')
          setWorkbenchOpen(true)
          setWorkbenchTab('preview')
        }}
        onOpenToolbox={() => {
          setInitialToolboxCode(null)
          setActiveView('toolbox')
        }}
        projects={projects}
        activeProjectId={activeProjectId}
        taskCount={tasks.length}
        onSelectProject={setActiveProjectId}
        onCreateProject={() => void handleCreateProject()}
        onOpenProjectMeta={(proj) => void handleOpenProjectMeta(proj)}
        onDeleteProject={(id) => void deleteProject(id)}
        onRenameProject={(id, name) => void renameProject(id, name)}
        tasks={tasks}
        activeTaskId={activeTaskId}
        isTaskRunning={(id) => Boolean(slices[id]?.running)}
        searchInputRef={taskSearchInputRef}
        onSelectTask={(id) => void selectTask(id)}
        onDeleteTask={(id) => void deleteTask(id)}
        onRenameTask={(id, title) => void renameTask(id, title)}
        permissionMode={permissionMode}
        onTogglePermission={() =>
          void setPermissionMode(permissionMode === 'auto' ? 'default' : 'auto')
        }
        hasApiKey={hasApiKey}
        activeProfileLabel={activeProfile?.label}
        onOpenSettings={() => setSettingsModalOpen(true)}
      />

      {/* 中间对话主面板 */}
      <main className="flex-1 min-w-0 flex flex-col h-full bg-white relative">
        {activeView === 'toolbox' ? (
          <ToolboxPanel
            initialFeatureCode={initialToolboxCode}
            onClearInitialFeature={() => setInitialToolboxCode(null)}
            onSubmitFeature={handleSubmitFeature}
            onFillComposer={handleFillFeature}
          />
        ) : activeView === 'library' ? (
          <LocalLibraryView
            slices={slices}
            recentFiles={recentFiles}
            onPreview={(p, t) => openFilePreview(p, t)}
            onAttachToNewTask={(att) => {
              setActiveView('chat')
              setComposerMode('image')
              appendAttachedFiles([att])
            }}
          />
        ) : (
        <>
        <header className="h-11 px-4 border-b border-zinc-100 bg-white flex items-center justify-between gap-3 shrink-0">
          <div className="min-w-0 flex items-center gap-2">
            <h2 className="text-sm font-semibold text-zinc-900 truncate">
              {activeTask?.title ?? '空间设计工作台'}
            </h2>
            {activeTask?.rootDir && (
              <button
                type="button"
                onClick={() => void window.designAgent.shell.openPath(activeTask.rootDir)}
                title={`点击打开工作目录：${activeTask.rootDir}`}
                className="hidden sm:inline-block max-w-64 truncate px-2 py-0.5 rounded-md bg-zinc-100 text-[11px] font-mono text-zinc-500 hover:text-zinc-800 cursor-pointer"
              >
                {activeTask.rootDir}
              </button>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <DeliveryPopover
              turns={turns}
              onPreviewDeliverable={(path, title) => openFilePreview(path, title)}
              onOpenFilesManager={() => {
                setWorkbenchOpen(true)
                setWorkbenchTab('files')
              }}
            />
            {activeTask?.rootDir && (
              <button
                type="button"
                onClick={() => void handleOpenCharter()}
                title="编辑工作区项目宪章 (DESIGN-AGENT.md)"
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50 cursor-pointer"
              >
                <FileText className="w-3.5 h-3.5 text-zinc-500" />
                <span>项目宪章</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => setWorkbenchOpen(!workbenchOpen)}
              title={workbenchOpen ? '收起工作台' : '打开工作台'}
              className={clsx(
                'inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs border transition-colors cursor-pointer',
                workbenchOpen
                  ? 'bg-zinc-900 text-white border-zinc-900'
                  : 'bg-white text-zinc-700 border-zinc-200 hover:bg-zinc-50'
              )}
            >
              <PanelRight className="w-3.5 h-3.5" />
              <span>{workbenchOpen ? '收起工作台' : '打开工作台'}</span>
            </button>
          </div>
        </header>

        {(() => {
          const replacesComposer = Boolean(pendingAskUser || pendingImageEdit)
          const isHomeEmpty = turns.length === 0 && !replacesComposer && !pendingInterrupt
          const showTodoBar =
            !isHomeEmpty &&
            latestTodos.length > 0 &&
            !pendingInterrupt &&
            !replacesComposer &&
            !sendError
          const templateAttachment = attachments.find((a) => a.role === 'ppt_template')
          const headline = MODE_HEADLINE[composerMode]
          const activeProj = projects.find(
            (p) => p.id === (activeTask?.projectId ?? activeProjectId)
          )

          const composerCard = !replacesComposer ? (
            <ComposerCard
              isHomeEmpty={isHomeEmpty}
              showTodoBar={showTodoBar}
              headline={headline}
              activeProj={activeProj}
              templateAttachment={templateAttachment}
              activeProfile={activeProfile}
              configuredProfiles={configuredProfiles}
              recognizedCandidates={recognizedCandidates}
              enabledConnectors={enabledConnectors}
              refableTasks={refableTasks}
              attachments={attachments}
              inputText={inputText}
              dragOver={dragOver}
              running={running}
              queuedCount={queuedCount}
              onClearQueued={clearQueued}
              hasApiKey={hasApiKey}
              pendingInterrupt={pendingInterrupt}
              activeScenePreset={activeScenePreset}
              sceneParamValues={sceneParamValues}
              regScope={regScope}
              plusMenuOpen={plusMenuOpen}
              plusSubmenu={plusSubmenu}
              permMenuOpen={permMenuOpen}
              modelMenuOpen={modelMenuOpen}
              setInputText={setInputText}
              setAttachments={setAttachments}
              setDragOver={setDragOver}
              setActiveScenePreset={setActiveScenePreset}
              setSceneParamValues={setSceneParamValues}
              setRegScope={setRegScope}
              setPlusMenuOpen={setPlusMenuOpen}
              setPlusSubmenu={setPlusSubmenu}
              setPermMenuOpen={setPermMenuOpen}
              setModelMenuOpen={setModelMenuOpen}
              appendAttachedFiles={appendAttachedFiles}
              handleDropFiles={handleDropFiles}
              handlePaste={handlePaste}
              handlePickFiles={handlePickFiles}
              handleSend={handleSend}
            />
          ) : null

          if (isHomeEmpty) {
            return (
              <div className="flex-1 min-h-0 overflow-y-auto px-4 py-8">
                <div className="max-w-[840px] mx-auto space-y-5">
                  <div className="text-center space-y-1.5 pt-2">
                    <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">
                      {headline.title}
                    </h1>
                    <p className="text-xs text-zinc-500">{headline.subtitle}</p>
                  </div>

                  {/* 顶部 5 大模式切换胶囊（通用 / 生图 / 建模 / 汇报 / 查规范） */}
                  <div className="flex items-center justify-center gap-1.5 flex-wrap">
                    {MODE_TABS.map((m) => {
                      const Icon = m.icon
                      const active = composerMode === m.id
                      return (
                        <button
                          key={m.id}
                          type="button"
                          onClick={() => setComposerMode(m.id)}
                          className={clsx(
                            'inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs border transition-all cursor-pointer',
                            active
                              ? 'bg-white border-zinc-300 text-zinc-900 font-semibold shadow-xs'
                              : 'bg-transparent border-transparent text-zinc-500 hover:text-zinc-900 hover:bg-zinc-100/80'
                          )}
                        >
                          <Icon className="w-3.5 h-3.5" />
                          <span>{m.label}</span>
                        </button>
                      )
                    })}
                  </div>

                  {!hasApiKey && (
                    <div className="rounded-xl border border-amber-200 bg-amber-50/80 p-3 flex items-center justify-between gap-3 text-xs text-amber-900">
                      <span>
                        开始对话前，请先配置模型 API Key（可在输入框右下角点击「请配置模型」直接选用已识别配置）。
                      </span>
                      <button
                        type="button"
                        onClick={() => setSettingsModalOpen(true)}
                        className="px-3 py-1.5 rounded-lg bg-zinc-900 text-white font-medium shrink-0 cursor-pointer"
                      >
                        立即配置
                      </button>
                    </div>
                  )}

                  {sendError && (
                    <div className="rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2 text-xs text-rose-700 flex items-center justify-between">
                      <span>{sendError}</span>
                      <button
                        type="button"
                        onClick={() => setSendError(null)}
                        className="text-rose-500 hover:text-rose-800 cursor-pointer"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}

                  <div className="space-y-2">
                    {composerCard}
                    <div className="flex items-center gap-4 px-2 text-xs text-zinc-500">
                      <button
                        type="button"
                        onClick={() => void handleCreateProject()}
                        className="inline-flex items-center gap-1.5 hover:text-zinc-900 cursor-pointer"
                        title="绑定或切换当前项目目录"
                      >
                        <FolderPlus className="w-3.5 h-3.5" />
                        <span>{activeProj ? `项目：${activeProj.name}` : '进入项目工作'}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          void setPermissionMode(permissionMode === 'auto' ? 'default' : 'auto')
                        }
                        className={clsx(
                          'inline-flex items-center gap-1 cursor-pointer',
                          permissionMode === 'auto'
                            ? 'text-amber-600 font-medium'
                            : 'text-zinc-600 hover:text-zinc-900'
                        )}
                      >
                        <ShieldCheck className="w-3.5 h-3.5" />
                        <span>{permissionMode === 'auto' ? '完全访问' : '默认权限'}</span>
                      </button>
                    </div>
                  </div>

                  <div className="pt-2">
                    <ModeEcosystemPanel
                      mode={composerMode}
                      quickScenes={QUICK_SCENES}
                      recentFiles={recentFiles}
                      regulationStats={regulationStats}
                      onOpenCatalogFeature={handleOpenFeatureCode}
                      onOpenAllToolbox={() => {
                        setInitialToolboxCode(null)
                        setActiveView('toolbox')
                      }}
                      onQuickPrompt={(p, toolTitle, _autoSend, presetScene) => {
                        setInputText(p)
                        if (toolTitle) {
                          setActiveScenePreset({
                            id: presetScene?.id || 'mode-quick',
                            category: '场景工具',
                            title: toolTitle,
                            desc: '',
                            prompt: p,
                            params: presetScene?.params ?? []
                          })
                          setSceneParamValues(presetScene?.values ?? {})
                        }
                        if (presetScene?.targetHost) {
                          const targetConn = mcpConnectors.find((c) => c.name === presetScene.targetHost)
                          if (targetConn && !targetConn.enabled) {
                            void toggleMcpConnector(targetConn.name, true)
                          }
                        }
                      }}
                      onPickTemplate={() => void handlePickFiles('ppt_template')}
                      onSelectLocalTemplate={(rf) =>
                        appendAttachedFiles([
                          {
                            path: rf.path,
                            name: rf.name,
                            kind: 'file',
                            size: rf.size,
                            role: 'ppt_template'
                          }
                        ])
                      }
                      onOpenRegulationSettings={() => setSettingsModalOpen(true)}
                      onRefreshRegulationStats={() => void refreshRegulationStats()}
                    />
                  </div>
                </div>
              </div>
            )
          }

          return (
            <div className="flex-1 min-h-0 relative flex flex-col">
              <div className="flex-1 min-h-0 relative flex flex-col">
                <div
                  ref={scrollContainerRef}
                  onScroll={(e) => {
                    const el = e.currentTarget
                    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 64)
                  }}
                  className="flex-1 min-h-0 overflow-y-auto px-4 py-6"
                >
                  <div className="max-w-[780px] mx-auto space-y-6">
                    {turns.map((item, idx) =>
                      item.role === 'user' ? (
                        <div key={item.id} className="flex flex-col items-end gap-2">
                          {((item.attachments && item.attachments.length > 0) ||
                            (item.annotations && item.annotations.length > 0) ||
                            (item.conversationRefs && item.conversationRefs.length > 0) ||
                            (item.mcp && item.mcp.length > 0)) && (
                            <div className="flex flex-wrap justify-end gap-1.5 max-w-[78%]">
                              {item.mcp?.map((m, i) => (
                                <span
                                  key={`m_${i}`}
                                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-50 border border-emerald-200 text-[11px] text-emerald-800"
                                >
                                  🔌 {m.label}
                                </span>
                              ))}
                              {item.conversationRefs?.map((c, i) => (
                                <span
                                  key={`c_${i}`}
                                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-indigo-50 border border-indigo-200 text-[11px] text-indigo-800"
                                >
                                  💬 引用：{c.title}
                                </span>
                              ))}
                              {item.annotations?.map((ann, i) => (
                                <span
                                  key={`ann_${i}`}
                                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-blue-50 border border-blue-200 text-[11px] text-blue-800"
                                >
                                  📍 {ann.title} · {ann.count} 条批注
                                </span>
                              ))}
                              {item.attachments?.map((att, i) => (
                                <button
                                  key={`att_${i}`}
                                  type="button"
                                  onClick={() => openFilePreview(att.path, att.name)}
                                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[#f4f4f5] border border-zinc-200/80 text-[11px] text-zinc-700 hover:bg-zinc-200/70 cursor-pointer"
                                >
                                  📎 {att.name}
                                </button>
                              ))}
                            </div>
                          )}
                          {item.text && (
                            <div className="max-w-[78%] rounded-2xl bg-[#f4f4f5] text-zinc-900 px-4 py-3 text-[14px] leading-relaxed">
                              <div className="whitespace-pre-wrap break-words">{item.text}</div>
                            </div>
                          )}
                        </div>
                      ) : (
                        <AssistantTurnView
                          key={item.id}
                          turn={item}
                          isLastTurn={idx === turns.length - 1}
                          onPreviewDeliverable={(path, title, opts) => openFilePreview(path, title, opts)}
                          onPickSuggestion={(sugText) => setInputText(sugText)}
                          onContinueInterrupted={() =>
                            void handleSend('请从上次中断的步骤继续执行剩余任务。')
                          }
                          onRetry={() => {
                            const prevUser = [...turns.slice(0, idx)]
                              .reverse()
                              .find((t) => t.role === 'user')
                            if (prevUser && prevUser.role === 'user') {
                              void sendMessage({
                                text: prevUser.text,
                                attachments: prevUser.attachments,
                                annotations: prevUser.annotations,
                                conversationRefs: prevUser.conversationRefs,
                                sceneParam: prevUser.sceneParam
                              })
                            }
                          }}
                        />
                      )
                    )}
                    <div ref={scrollBottomRef} />
                  </div>
                </div>

                {!atBottom && turns.length > 0 && (
                  <button
                    type="button"
                    onClick={() => scrollBottomRef.current?.scrollIntoView({ behavior: 'smooth' })}
                    aria-label="回到底部"
                    className="absolute left-1/2 -translate-x-1/2 bottom-3 z-20 w-8 h-8 rounded-full border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50 shadow-sm flex items-center justify-center cursor-pointer transition-colors"
                  >
                    <ChevronDown className="w-4 h-4" />
                  </button>
                )}
              </div>

              <div className="max-w-[780px] w-full mx-auto">
                {sendError && (
                  <div className="px-4 pb-2">
                    <div className="rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2 text-xs text-rose-700 flex items-center justify-between">
                      <span>{sendError}</span>
                      <button
                        type="button"
                        onClick={() => setSendError(null)}
                        className="text-rose-500 hover:text-rose-800 cursor-pointer"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                )}

                {showTodoBar && (
                  <TodoBar
                    todos={latestTodos}
                    running={running}
                    attached={!replacesComposer}
                    open={todoOpen}
                    onOpenChange={setTodoOpen}
                  />
                )}

                {pendingInterrupt && activeTaskId && (
                  <InterruptCard
                    message={pendingInterrupt.message}
                    delta={pendingInterrupt.delta}
                    actions={pendingInterrupt.actions}
                    onDecide={(decision) => void resolveInterrupt(activeTaskId, decision)}
                  />
                )}

                {pendingAskUser && activeTaskId && (
                  <ClarifyCard
                    questions={pendingAskUser.questions}
                    interaction={pendingAskUser.interaction}
                    onSubmit={(answers) => void submitUserAnswer(activeTaskId, answers)}
                  />
                )}

                {composerCard}
              </div>
            </div>
          )
        })()}
        </>
        )}
      </main>

      {workbenchOpen && (
        <RightWorkbench
          rootDir={activeTask?.rootDir}
          projectId={activeTask?.projectId ?? activeProjectId}
          skills={skills}
          activeTab={workbenchTab}
          previewTarget={previewTarget}
          pptSelection={pptSelection}
          pendingPptProposals={pendingPptProposals}
          onTabChange={setWorkbenchTab}
          onSelectPreview={openFilePreview}
          onAttachAnnotations={attachAnnotationRef}
          onAttachFileToChat={(att) => appendAttachedFiles([att])}
          onChangePptSelection={setPptSelection}
          onResolvePptProposal={resolvePptProposal}
          onClose={() => setWorkbenchOpen(false)}
        />
      )}

      </div>

      {projectMetaTarget && (
        <ProjectMetaModal
          target={projectMetaTarget}
          draft={projectMetaDraft}
          onChange={setProjectMetaDraft}
          onClose={() => setProjectMetaTarget(null)}
          onSave={async (id, draft) => {
            await window.designAgent.projects.updateMeta(id, draft)
            setProjectMetaTarget(null)
          }}
        />
      )}

      {charterOpen && activeTask?.rootDir && (
        <CharterModal
          draft={charterDraft}
          onChange={setCharterDraft}
          onClose={() => setCharterOpen(false)}
          onSave={async () => {
            await window.designAgent.projects.saveCharter(activeTask.rootDir, charterDraft)
            setCharterOpen(false)
          }}
        />
      )}

      {pendingImageEdit && activeTaskId && (
        <ImageEditModal
          hint={pendingImageEdit.hint}
          imagePath={pendingImageEdit.imagePath}
          rootDir={activeTask?.rootDir}
          onConfirm={(annotatedPath) =>
            submitImageEditAnswer(activeTaskId, pendingImageEdit.id, {
              action: 'confirm',
              imagePath: annotatedPath
            })
          }
          onCancel={() =>
            submitImageEditAnswer(activeTaskId, pendingImageEdit.id, { action: 'cancel' })
          }
        />
      )}

      <ModelSettingsModal
        open={settingsModalOpen}
        settings={modelSettings}
        generalSettings={generalSettings}
        onClose={() => setSettingsModalOpen(false)}
        onSave={saveModelSettings}
        onSaveGeneral={saveGeneralSettings}
      />
    </div>
  )
}
