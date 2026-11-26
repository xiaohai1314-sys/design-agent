import React, { useEffect, useRef, useState } from 'react'
import {
  ArrowUp,
  AtSign,
  BookOpenCheck,
  Box,
  Brain,
  ChevronDown,
  ChevronRight,
  Compass,
  Eye,
  FileSpreadsheet,
  FileText,
  FolderPlus,
  History,
  Image as ImageIcon,
  KeyRound,
  LayoutGrid,
  Library,
  MapPin,
  Maximize2,
  MessageSquare,
  MessageSquarePlus,
  Minimize2,
  PanelRight,
  Pencil,
  Plug,
  Plus,
  Presentation,
  Search,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Square,
  Trash2,
  Upload,
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
import { InterruptCard } from './components/InterruptCard'
import { ClarifyCard } from './components/ClarifyCard'
import { AssistantTurnView } from './components/AssistantTurnView'
import { RightWorkbench } from './components/RightWorkbench'
import { ModelSettingsModal } from './components/ModelSettingsModal'
import { ImageEditModal } from './components/ImageEditModal'
import { DeliveryPopover } from './components/DeliveryPopover'
import {
  FunctionToolChips,
  ToolboxPanel,
  type SceneToolboxPreset
} from './components/SceneToolboxBar'
import {
  MODE_HEADLINE,
  MODE_PLACEHOLDER,
  MODE_TABS,
  ModeEcosystemPanel,
  ModelingMcpStrip,
  RegulationScopeStrip,
  ReportTemplateSlot
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
  const [moreMenuOpen, setMoreMenuOpen] = useState(false)
  const [regScope, setRegScope] = useState<'comprehensive' | 'retrieve' | 'qa'>('comprehensive')
  const [atBottom, setAtBottom] = useState(true)
  const [taskSearch, setTaskSearch] = useState('')
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  const [editingProjId, setEditingProjId] = useState<string | null>(null)
  const [editingProjName, setEditingProjName] = useState('')
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

  useEffect(() => {
    void init()
    void window.zmo.window.isMaximized().then(setIsMaximized)
    const offMax = window.zmo.window.onMaximizeChanged(setIsMaximized)
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
    const picked = await window.zmo.agent.pickFiles()
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
    setMoreMenuOpen(false)
    setActiveView('chat')
    setComposerMode(mode)
    if (turns.length > 0) {
      await createNewTask()
      setComposerMode(mode)
    }
  }

  const handleOpenProjectMeta = async (proj: ProjectSummary): Promise<void> => {
    const meta = await window.zmo.projects.readMeta(proj.id)
    setProjectMetaDraft(meta)
    setProjectMetaTarget(proj)
  }

  const handleCreateProject = async (): Promise<void> => {
    const folder = await window.zmo.agent.pickFolder('project')
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
      const filePath = (await window.zmo.app?.getPathForFile(file)) || ''
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
      const att = await window.zmo.agent.writeTempImage({
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
    const text = await window.zmo.projects.readCharter(activeTask.rootDir)
    setCharterDraft(text)
    setCharterOpen(true)
  }

  const handleSend = async (overrideText?: string): Promise<void> => {
    const content = (overrideText ?? inputText).trim()
    if (
      (!content &&
        attachments.length === 0 &&
        draftAnnotations.length === 0 &&
        draftConversationRefs.length === 0 &&
        !pptSelection) ||
      running
    )
      return
    setSendError(null)
    const filesToSend = [...attachments]
    const annotationsToSend = [...draftAnnotations]
    const convRefsToSend = [...draftConversationRefs]
    if (!overrideText) {
      setInputText('')
      setAttachments([])
      clearDraftAnnotations()
      clearDraftConversationRefs()
    }
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
    const res = await sendMessage({
      text:
        content ||
        (annotationsToSend.length > 0
          ? '请按照我附带的图纸/模型批注进行修改与分析。'
          : '请分析我附带的资料与历史上下文。'),
      attachments: filesToSend.length > 0 ? filesToSend : undefined,
      annotations: annotationsToSend.length > 0 ? annotationsToSend : undefined,
      conversationRefs: convRefsToSend.length > 0 ? convRefsToSend : undefined,
      sceneParam
    })
    if (!res.ok && res.error) {
      setSendError(res.error)
      if (!overrideText) {
        setInputText(content)
        setAttachments(filesToSend)
        annotationsToSend.forEach(attachAnnotationRef)
        convRefsToSend.forEach(attachConversationRef)
      }
    }
  }

  const filteredTasks = tasks
    .filter((t) => (activeProjectId ? t.projectId === activeProjectId : true))
    .filter((t) =>
      taskSearch.trim() ? t.title.toLowerCase().includes(taskSearch.trim().toLowerCase()) : true
    )

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
      {/* 顶部无边框自定义窗口栏 + 多标签页条（留出 flex-1 纯空白拖拽热区，修复 Windows 无边框无法拖动） */}
      <div className="h-9 shrink-0 bg-[#eceef2] border-b border-zinc-200/90 flex items-center px-2 select-none app-drag-region">
        <div className="flex items-center gap-1 min-w-0 max-w-[calc(100%-250px)] overflow-x-auto">
          <div className="w-6 h-6 rounded-md bg-zinc-900 text-white flex items-center justify-center text-[11px] font-bold shrink-0 mr-1">
            Z
          </div>

          <button
            type="button"
            onClick={() => setActiveView(activeView === 'toolbox' ? 'chat' : 'toolbox')}
            className={clsx(
              'app-no-drag inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium shrink-0 cursor-pointer transition-colors',
              activeView === 'toolbox'
                ? 'bg-white text-blue-700 shadow-2xs'
                : 'text-zinc-600 hover:bg-zinc-200/70'
            )}
          >
            <LayoutGrid className="w-3 h-3" />
            <span>工具箱</span>
          </button>

          <div className="h-3.5 w-[1px] bg-zinc-300 mx-0.5 shrink-0" />

          {openTabIds.map((tid) => {
            const t = tasks.find((x) => x.id === tid)
            if (!t) return null
            const isTabActive = activeView === 'chat' && activeTaskId === tid
            const isTabRunning = slices[tid]?.running
            return (
              <div
                key={tid}
                onClick={() => void selectTask(tid)}
                className={clsx(
                  'app-no-drag group flex items-center gap-1.5 pl-2.5 pr-1.5 py-1 rounded-md text-[11px] max-w-44 cursor-pointer transition-colors shrink-0',
                  isTabActive
                    ? 'bg-white text-zinc-900 font-medium shadow-2xs'
                    : 'text-zinc-600 hover:bg-zinc-200/60'
                )}
              >
                {isTabRunning && (
                  <span className="w-1.5 h-1.5 rounded-full bg-blue-600 animate-ping shrink-0" />
                )}
                <span className="truncate">{t.title}</span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    closeTab(tid)
                  }}
                  title="关闭标签页"
                  className="p-0.5 rounded text-zinc-400 hover:text-zinc-900 hover:bg-zinc-100 cursor-pointer opacity-70 group-hover:opacity-100"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            )
          })}

          <button
            type="button"
            onClick={() => void createNewTask()}
            title="新建任务标签页"
            className="app-no-drag p-1 rounded-md text-zinc-500 hover:text-zinc-900 hover:bg-zinc-200/70 cursor-pointer shrink-0"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* 显式居中弹性拖拽区域（至少保留 64px 可拖动空白区，双击亦可最大化/还原） */}
        <div
          onDoubleClick={() => window.zmo.window.toggleMaximize()}
          title="按住拖动窗口位置（双击最大化/还原）"
          className="flex-1 h-full min-w-[64px] app-drag-region"
        />

        <div className="app-no-drag flex items-center gap-1 shrink-0 ml-2">
          <button
            type="button"
            onClick={() => taskSearchInputRef.current?.focus()}
            title="搜索任务"
            className="p-1.5 rounded-md text-zinc-600 hover:bg-zinc-200/70 cursor-pointer"
          >
            <Search className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setSettingsModalOpen(true)}
            title="API 与桌面设置"
            className="p-1.5 rounded-md text-zinc-600 hover:bg-zinc-200/70 cursor-pointer"
          >
            <Settings className="w-3.5 h-3.5" />
          </button>
          <div className="h-3.5 w-[1px] bg-zinc-300 mx-0.5" />
          <button
            type="button"
            onClick={() => window.zmo.window.minimize()}
            aria-label="最小化"
            className="p-1.5 rounded-md text-zinc-600 hover:bg-zinc-200/70 cursor-pointer"
          >
            <Minimize2 className="w-3 h-3" />
          </button>
          <button
            type="button"
            onClick={() => window.zmo.window.toggleMaximize()}
            aria-label={isMaximized ? '还原' : '最大化'}
            className="p-1.5 rounded-md text-zinc-600 hover:bg-zinc-200/70 cursor-pointer"
          >
            <Maximize2 className="w-3 h-3" />
          </button>
          <button
            type="button"
            onClick={() => window.zmo.window.close()}
            aria-label="关闭"
            className="p-1.5 rounded-md text-zinc-600 hover:bg-rose-500 hover:text-white cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 flex overflow-hidden">
      {/* 左侧导航栏（对齐 znzmo 场景导航 + 我的项目 + 任务记录） */}
      <aside className="w-[224px] shrink-0 border-r border-zinc-200/90 bg-[#f5f6f8] flex flex-col select-none">
        {/* 顶部功能导航区 */}
        <div className="p-2.5 space-y-0.5 border-b border-zinc-200/70 relative">
          <button
            type="button"
            onClick={() => {
              setComposerMode('general')
              setActiveView('chat')
              void createNewTask()
            }}
            className="w-full flex items-center gap-2 px-2.5 py-2 rounded-xl text-xs font-medium text-zinc-800 hover:bg-white hover:shadow-2xs transition-all cursor-pointer"
          >
            <MessageSquarePlus className="w-4 h-4 text-zinc-600 shrink-0" />
            <span>新建任务</span>
          </button>

          {(
            [
              { mode: 'image' as const, label: 'AI 生图', icon: ImageIcon },
              { mode: 'modeling' as const, label: 'AI 建模', icon: Box },
              { mode: 'report' as const, label: 'AI 汇报', icon: Presentation, tag: 'PPT' },
              { mode: 'regulation' as const, label: 'AI 查规范', icon: BookOpenCheck }
            ] as const
          ).map((nav) => {
            const Icon = nav.icon
            const isNavActive = activeView === 'chat' && composerMode === nav.mode
            return (
              <button
                key={nav.mode}
                type="button"
                onClick={() => void switchLeftMode(nav.mode)}
                className={clsx(
                  'w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-xl text-xs transition-all cursor-pointer',
                  isNavActive
                    ? 'bg-zinc-200/80 text-zinc-900 font-semibold'
                    : 'text-zinc-700 hover:bg-white/80'
                )}
              >
                <span className="flex items-center gap-2 min-w-0">
                  <Icon className="w-4 h-4 text-zinc-600 shrink-0" />
                  <span className="truncate">{nav.label}</span>
                </span>
                {'tag' in nav && nav.tag && (
                  <span className="px-1.5 py-0.5 rounded bg-orange-50 text-orange-600 text-[9px] font-semibold shrink-0">
                    {nav.tag}
                  </span>
                )}
              </button>
            )
          })}

          <button
            type="button"
            onClick={() => {
              setMoreMenuOpen(false)
              void refreshRecentFiles()
              setActiveView('library')
            }}
            className={clsx(
              'w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-xl text-xs transition-all cursor-pointer',
              activeView === 'library'
                ? 'bg-zinc-200/80 text-zinc-900 font-semibold'
                : 'text-zinc-700 hover:bg-white/80'
            )}
          >
            <span className="flex items-center gap-2 min-w-0">
              <Library className="w-4 h-4 text-zinc-600 shrink-0" />
              <span>资料库</span>
            </span>
            <span className="text-[10px] text-zinc-400">本地成果</span>
          </button>

          <button
            type="button"
            onClick={() => setMoreMenuOpen((v) => !v)}
            className={clsx(
              'w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-xl text-xs transition-all cursor-pointer',
              activeView === 'toolbox' || moreMenuOpen
                ? 'bg-zinc-200/80 text-zinc-900 font-semibold'
                : 'text-zinc-700 hover:bg-white/80'
            )}
          >
            <span className="flex items-center gap-2">
              <LayoutGrid className="w-4 h-4 text-zinc-600 shrink-0" />
              <span>更多</span>
            </span>
            <ChevronRight className="w-3.5 h-3.5 text-zinc-400" />
          </button>

          {moreMenuOpen && (
            <>
              <div className="fixed inset-0 z-30" onClick={() => setMoreMenuOpen(false)} />
              <div className="absolute left-[216px] top-44 z-40 w-44 rounded-2xl border border-zinc-200 bg-white shadow-xl p-1.5 space-y-0.5 text-xs">
                <button
                  type="button"
                  onClick={() => {
                    setMoreMenuOpen(false)
                    setActiveView('chat')
                    setWorkbenchOpen(true)
                    setWorkbenchTab('preview')
                  }}
                  className="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-zinc-800 hover:bg-zinc-100 cursor-pointer"
                >
                  <Sparkles className="w-3.5 h-3.5 text-blue-600" />
                  <span>AI 工作台画布</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMoreMenuOpen(false)
                    setInitialToolboxCode(null)
                    setActiveView('toolbox')
                  }}
                  className="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-zinc-800 hover:bg-zinc-100 cursor-pointer"
                >
                  <LayoutGrid className="w-3.5 h-3.5 text-zinc-600" />
                  <span>43 项工具箱</span>
                </button>
              </div>
            </>
          )}
        </div>

        <div className="px-2.5 pt-2.5 pb-1.5">
          <div className="flex items-center justify-between px-1.5 mb-1">
            <span className="text-[11px] font-medium text-zinc-400">项目空间</span>
            <button
              type="button"
              onClick={() => void handleCreateProject()}
              title="绑定本地项目文件夹"
              className="p-0.5 rounded text-zinc-400 hover:text-zinc-800 cursor-pointer"
            >
              <FolderPlus className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="space-y-0.5 max-h-28 overflow-y-auto">
            <button
              type="button"
              onClick={() => setActiveProjectId(null)}
              className={clsx(
                'w-full px-2.5 py-1.5 rounded-lg text-left text-xs truncate cursor-pointer transition-colors',
                activeProjectId === null
                  ? 'bg-white text-zinc-900 font-medium shadow-2xs'
                  : 'text-zinc-600 hover:bg-zinc-200/50'
              )}
            >
              全部对话 ({tasks.length})
            </button>
            {projects.map((proj) => {
              const isProjEditing = editingProjId === proj.id
              return (
                <div
                  key={proj.id}
                  className={clsx(
                    'group flex items-center gap-0.5 rounded-lg pr-1 transition-colors',
                    activeProjectId === proj.id
                      ? 'bg-white text-zinc-900 font-medium shadow-2xs'
                      : 'text-zinc-600 hover:bg-zinc-200/50'
                  )}
                >
                  {isProjEditing ? (
                    <input
                      autoFocus
                      value={editingProjName}
                      onChange={(e) => setEditingProjName(e.target.value)}
                      onBlur={() => {
                        void renameProject(proj.id, editingProjName)
                        setEditingProjId(null)
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          void renameProject(proj.id, editingProjName)
                          setEditingProjId(null)
                        } else if (e.key === 'Escape') {
                          setEditingProjId(null)
                        }
                      }}
                      className="flex-1 min-w-0 mx-1 my-1 px-1.5 py-0.5 rounded bg-zinc-50 border border-blue-400 text-xs outline-none"
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => setActiveProjectId(proj.id)}
                      title={proj.folderPath}
                      className="flex-1 min-w-0 px-2.5 py-1.5 text-left text-xs truncate cursor-pointer"
                    >
                      📁 {proj.name}
                    </button>
                  )}
                  {!isProjEditing && (
                    <>
                      <button
                        type="button"
                        title="编辑项目档案与指标"
                        onClick={(e) => {
                          e.stopPropagation()
                          void handleOpenProjectMeta(proj)
                        }}
                        className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-zinc-400 hover:text-blue-600 cursor-pointer"
                      >
                        <SlidersHorizontal className="w-3 h-3" />
                      </button>
                      <button
                        type="button"
                        title="重命名项目"
                        onClick={(e) => {
                          e.stopPropagation()
                          setEditingProjId(proj.id)
                          setEditingProjName(proj.name)
                        }}
                        className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-zinc-400 hover:text-zinc-800 cursor-pointer"
                      >
                        <Pencil className="w-3 h-3" />
                      </button>
                      <button
                        type="button"
                        title="移除项目空间（不删除本机文件）"
                        onClick={(e) => {
                          e.stopPropagation()
                          void deleteProject(proj.id)
                        }}
                        className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-zinc-400 hover:text-rose-600 cursor-pointer"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </>
                  )}
                </div>
              )
            })}
          </div>
        </div>

        <div className="px-2.5 pt-2 pb-1 flex-1 min-h-0 flex flex-col">
          <div className="px-1.5 mb-1.5 flex items-center justify-between gap-1">
            <span className="text-[11px] font-medium text-zinc-400">任务记录</span>
          </div>
          <div className="relative mb-1.5">
            <Search className="w-3 h-3 text-zinc-400 absolute left-2 top-1/2 -translate-y-1/2" />
            <input
              ref={taskSearchInputRef}
              type="text"
              value={taskSearch}
              onChange={(e) => setTaskSearch(e.target.value)}
              placeholder="搜索历史任务…"
              className="w-full pl-6 pr-2 py-1 rounded-lg bg-white/80 border border-zinc-200/80 text-[11px] text-zinc-700 placeholder:text-zinc-400 outline-none focus:border-zinc-400"
            />
          </div>
          <div className="flex-1 overflow-y-auto space-y-0.5 pr-0.5">
            {filteredTasks.map((t) => {
              const isSelected = t.id === activeTaskId
              const isTaskRunning = slices[t.id]?.running
              const isEditing = editingTaskId === t.id
              return (
                <div
                  key={t.id}
                  onClick={() => !isEditing && void selectTask(t.id)}
                  className={clsx(
                    'group flex items-center gap-1.5 px-2.5 py-2 rounded-xl text-xs cursor-pointer transition-colors',
                    isSelected
                      ? 'bg-white text-zinc-900 font-medium shadow-xs border border-zinc-200/60'
                      : 'text-zinc-600 hover:bg-zinc-200/50'
                  )}
                >
                  {isTaskRunning && (
                    <span className="w-1.5 h-1.5 rounded-full bg-blue-600 animate-ping shrink-0" />
                  )}
                  {isEditing ? (
                    <input
                      autoFocus
                      value={editingTitle}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setEditingTitle(e.target.value)}
                      onBlur={() => {
                        void renameTask(t.id, editingTitle)
                        setEditingTaskId(null)
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          void renameTask(t.id, editingTitle)
                          setEditingTaskId(null)
                        } else if (e.key === 'Escape') {
                          setEditingTaskId(null)
                        }
                      }}
                      className="flex-1 min-w-0 px-1.5 py-0.5 rounded bg-zinc-50 border border-blue-400 text-xs outline-none"
                    />
                  ) : (
                    <span className="truncate flex-1">{t.title}</span>
                  )}
                  {!isEditing && (
                    <button
                      type="button"
                      title="重命名任务"
                      onClick={(e) => {
                        e.stopPropagation()
                        setEditingTaskId(t.id)
                        setEditingTitle(t.title)
                      }}
                      className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-zinc-400 hover:text-zinc-800 cursor-pointer"
                    >
                      <Pencil className="w-3 h-3" />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      void deleteTask(t.id)
                    }}
                    className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-zinc-400 hover:text-rose-600 cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              )
            })}
          </div>
        </div>

        <div className="p-2.5 border-t border-zinc-200/80 space-y-1.5 bg-zinc-100/60">
          <button
            type="button"
            onClick={() =>
              void setPermissionMode(permissionMode === 'auto' ? 'default' : 'auto')
            }
            className="w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-[11px] text-zinc-700 hover:bg-white transition-colors cursor-pointer"
          >
            <span className="flex items-center gap-1.5">
              <ShieldCheck
                className={clsx(
                  'w-3.5 h-3.5',
                  permissionMode === 'auto' ? 'text-amber-600' : 'text-zinc-500'
                )}
              />
              <span>权限模式</span>
            </span>
            <span
              className={clsx(
                'px-1.5 py-0.5 rounded font-medium',
                permissionMode === 'auto'
                  ? 'bg-amber-50 text-amber-700'
                  : 'bg-zinc-100 text-zinc-600'
              )}
            >
              {permissionMode === 'auto' ? '完全访问' : '默认权限'}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setSettingsModalOpen(true)}
            className={clsx(
              'w-full flex items-center justify-between gap-2 px-2.5 py-2 rounded-xl text-xs font-medium border transition-all cursor-pointer',
              hasApiKey
                ? 'bg-white border-zinc-200 text-zinc-800 hover:border-zinc-300'
                : 'bg-amber-50 border-amber-300 text-amber-900 hover:bg-amber-100'
            )}
          >
            <span className="flex items-center gap-1.5 truncate">
              <KeyRound className="w-3.5 h-3.5 text-blue-600 shrink-0" />
              <span className="truncate">
                {hasApiKey ? activeProfile?.label : '请配置模型'}
              </span>
            </span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-100 text-zinc-500 shrink-0">
              设置
            </span>
          </button>
        </div>
      </aside>

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
                onClick={() => void window.zmo.shell.openPath(activeTask.rootDir)}
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
                title="编辑工作区项目宪章 (ZNZMO.md)"
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
            <div
              className={clsx(isHomeEmpty ? '' : 'px-4 pb-4')}
              onDragOver={(e) => {
                e.preventDefault()
                setDragOver(true)
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDropFiles}
            >
              <div
                className={clsx(
                  'border bg-white transition-colors px-4 pt-3 pb-2.5',
                  showTodoBar
                    ? 'rounded-t-none rounded-b-[20px] shadow-[0_2px_10px_rgba(0,0,0,0.04)]'
                    : 'rounded-[20px] shadow-[0_2px_14px_rgba(0,0,0,0.05)]',
                  dragOver
                    ? 'border-blue-500 ring-2 ring-blue-200 bg-blue-50/20'
                    : 'border-zinc-200/90 focus-within:border-zinc-300'
                )}
              >
                {composerMode === 'report' && isHomeEmpty && (
                  <ReportTemplateSlot
                    templateAtt={templateAttachment}
                    onPickTemplate={() => void handlePickFiles('ppt_template')}
                    onClearTemplate={() =>
                      setAttachments((prev) => prev.filter((a) => a.role !== 'ppt_template'))
                    }
                    onHelperPrompt={() =>
                      setInputText(
                        '请结合附件资料为我策划并制作一套 12-16 页（16:9）可编辑设计汇报 PPT：包含项目定位、场地/现状分析、平面功能分区、核心空间效果图及关键做法对比。'
                      )
                    }
                  />
                )}
                {(attachments.length > 0 ||
                      draftAnnotations.length > 0 ||
                      draftConversationRefs.length > 0 ||
                      pptSelection ||
                      enabledConnectors.length > 0 ||
                      thinkingEnabled) && (
                      <div className="flex flex-wrap gap-1.5 mb-2 pb-2 border-b border-zinc-100">
                        {thinkingEnabled && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-purple-50 border border-purple-200 text-[11px] text-purple-800 font-medium">
                            <Brain className="w-3 h-3" />
                            <span>深度思考</span>
                            <button
                              type="button"
                              onClick={() => setThinkingEnabled(false)}
                              className="text-purple-400 hover:text-purple-800 cursor-pointer"
                            >
                              <X className="w-3 h-3" />
                            </button>
                          </span>
                        )}
                        {enabledConnectors.map((conn) => (
                          <span
                            key={conn.name}
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-emerald-50 border border-emerald-200 text-[11px] text-emerald-900 font-medium"
                          >
                            <span>🔌 {conn.label}</span>
                            <button
                              type="button"
                              onClick={() => void toggleMcpConnector(conn.name, false)}
                              title={`断开 ${conn.label}`}
                              className="text-emerald-500 hover:text-emerald-900 cursor-pointer"
                            >
                              <X className="w-3 h-3" />
                            </button>
                          </span>
                        ))}
                        {pptSelection && (
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-orange-50 border border-orange-200 text-xs text-orange-900 font-medium">
                            <Presentation className="w-3 h-3 text-orange-600" />
                            <span className="truncate max-w-52">
                              PPT 选区：{pptSelection.referenceLabels?.join('、') || pptSelection.currentSlideId}
                            </span>
                            <button
                              type="button"
                              onClick={() => setPptSelection(null)}
                              className="text-orange-400 hover:text-orange-800 cursor-pointer"
                            >
                              <X className="w-3 h-3" />
                            </button>
                          </span>
                        )}
                        {draftConversationRefs.map((ref) => (
                          <span
                            key={ref.path}
                            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-indigo-50 border border-indigo-200 text-xs text-indigo-900 font-medium"
                          >
                            <MessageSquare className="w-3 h-3 text-indigo-600" />
                            <span className="truncate max-w-48">引用：{ref.title}</span>
                            <button
                              type="button"
                              onClick={() => removeConversationRef(ref.path)}
                              className="text-indigo-400 hover:text-indigo-800 cursor-pointer"
                            >
                              <X className="w-3 h-3" />
                            </button>
                          </span>
                        ))}
                        {draftAnnotations.map((ann) => (
                          <span
                            key={ann.path}
                            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-blue-50 border border-blue-200 text-xs text-blue-900 font-medium"
                          >
                            <MapPin className="w-3 h-3 text-blue-600" />
                            <span className="truncate max-w-52">
                              {ann.title} · {ann.count} 条批注
                            </span>
                            <button
                              type="button"
                              onClick={() => removeAnnotationRef(ann.path)}
                              className="text-blue-400 hover:text-blue-800 cursor-pointer"
                            >
                              <X className="w-3 h-3" />
                            </button>
                          </span>
                        ))}
                        {attachments.map((att, idx) => (
                          <span
                            key={idx}
                            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-zinc-100 text-xs text-zinc-800"
                          >
                            <span className="truncate max-w-44">{att.name}</span>
                            <button
                              type="button"
                              onClick={() => openFilePreview(att.path, att.name)}
                              title="在右侧工作台预览"
                              className="text-zinc-400 hover:text-blue-600 cursor-pointer"
                            >
                              <Eye className="w-3 h-3" />
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                setAttachments((prev) => prev.filter((_, i) => i !== idx))
                              }
                              className="text-zinc-400 hover:text-zinc-800 cursor-pointer"
                            >
                              <X className="w-3 h-3" />
                            </button>
                          </span>
                        ))}
                      </div>
                    )}

                    <textarea
                      rows={isHomeEmpty ? 3 : 2}
                      value={inputText}
                      disabled={Boolean(pendingInterrupt)}
                      onChange={(e) => setInputText(e.target.value)}
                      onPaste={handlePaste}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault()
                          void handleSend()
                        }
                      }}
                      placeholder={
                        pendingInterrupt
                          ? '请先在上方卡片完成操作授权…'
                          : running
                            ? '当前有任务进行中…'
                            : MODE_PLACEHOLDER[composerMode]
                      }
                      className="w-full resize-none bg-transparent text-[14px] text-zinc-900 placeholder:text-zinc-400 outline-none max-h-40 leading-relaxed"
                    />

                    {activeScenePreset && (
                      <FunctionToolChips
                        preset={activeScenePreset}
                        paramValues={sceneParamValues}
                        onChangeParam={(name, val) =>
                          setSceneParamValues((prev) => ({ ...prev, [name]: val }))
                        }
                        onClear={() => {
                          setActiveScenePreset(null)
                          setSceneParamValues({})
                        }}
                      />
                    )}

                    <div className="flex items-center justify-between gap-2 pt-2 mt-1">
                      {/* 左侧：+ 菜单与权限档位（完全访问 / 默认权限） */}
                      <div className="flex items-center gap-1">
                        <div className="relative">
                          <button
                            type="button"
                            onClick={() => {
                              void refreshRecentFiles()
                              void refreshMcpConnectors()
                              setPlusSubmenu('none')
                              setPlusMenuOpen((v) => !v)
                            }}
                            title="上传文件、引用对话、软件连接器或高级模式"
                            aria-label="添加附件或工具"
                            className="w-8 h-8 rounded-full flex items-center justify-center text-zinc-600 hover:bg-zinc-100 cursor-pointer transition-colors"
                          >
                            <Plus className="w-4 h-4" />
                          </button>

                          {plusMenuOpen && (
                            <>
                              <div
                                className="fixed inset-0 z-30"
                                onClick={() => {
                                  setPlusMenuOpen(false)
                                  setPlusSubmenu('none')
                                }}
                              />
                              <div className="absolute left-0 bottom-10 z-40 w-64 rounded-2xl border border-zinc-200 bg-white shadow-xl p-1.5 space-y-0.5 text-xs">
                                <button
                                  type="button"
                                  onClick={() => {
                                    setPlusMenuOpen(false)
                                    void handlePickFiles('project_material')
                                  }}
                                  className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-zinc-800 hover:bg-zinc-100 cursor-pointer"
                                >
                                  <Upload className="w-3.5 h-3.5 text-zinc-500" />
                                  <span>上传文件 / 图纸 / 图片</span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setPlusMenuOpen(false)
                                    void handlePickFiles('ppt_template')
                                  }}
                                  className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-zinc-800 hover:bg-zinc-100 cursor-pointer"
                                >
                                  <Presentation className="w-3.5 h-3.5 text-orange-500" />
                                  <span>上传 PPT 版式模板</span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() =>
                                    setPlusSubmenu((s) => (s === 'recent' ? 'none' : 'recent'))
                                  }
                                  className="w-full flex items-center justify-between px-3 py-2 rounded-xl text-zinc-800 hover:bg-zinc-100 cursor-pointer"
                                >
                                  <span className="flex items-center gap-2.5">
                                    <History className="w-3.5 h-3.5 text-zinc-500" />
                                    <span>最近使用的文件</span>
                                  </span>
                                  <ChevronDown
                                    className={clsx(
                                      'w-3.5 h-3.5 text-zinc-400 transition-transform',
                                      plusSubmenu === 'recent' && 'rotate-180'
                                    )}
                                  />
                                </button>
                                {plusSubmenu === 'recent' && (
                                  <div className="mx-1.5 my-1 p-1 rounded-xl bg-zinc-50 border border-zinc-100 max-h-36 overflow-y-auto space-y-0.5">
                                    {recentFiles.length === 0 ? (
                                      <div className="px-2 py-1.5 text-[11px] text-zinc-400">
                                        暂无近期文件记录
                                      </div>
                                    ) : (
                                      recentFiles.slice(0, 8).map((rf) => (
                                        <button
                                          key={rf.path}
                                          type="button"
                                          onClick={() => {
                                            appendAttachedFiles([
                                              {
                                                path: rf.path,
                                                name: rf.name,
                                                kind: rf.kind,
                                                size: rf.size
                                              }
                                            ])
                                            setPlusMenuOpen(false)
                                          }}
                                          title={rf.path}
                                          className="w-full px-2 py-1 rounded-lg text-left text-[11px] text-zinc-700 hover:bg-zinc-200/60 truncate cursor-pointer"
                                        >
                                          📎 {rf.name}
                                        </button>
                                      ))
                                    )}
                                  </div>
                                )}

                                <button
                                  type="button"
                                  onClick={() =>
                                    setPlusSubmenu((s) => (s === 'conv' ? 'none' : 'conv'))
                                  }
                                  className="w-full flex items-center justify-between px-3 py-2 rounded-xl text-zinc-800 hover:bg-zinc-100 cursor-pointer"
                                >
                                  <span className="flex items-center gap-2.5">
                                    <AtSign className="w-3.5 h-3.5 text-zinc-500" />
                                    <span>引用历史对话</span>
                                  </span>
                                  <ChevronDown
                                    className={clsx(
                                      'w-3.5 h-3.5 text-zinc-400 transition-transform',
                                      plusSubmenu === 'conv' && 'rotate-180'
                                    )}
                                  />
                                </button>
                                {plusSubmenu === 'conv' && (
                                  <div className="mx-1.5 my-1 p-1 rounded-xl bg-zinc-50 border border-zinc-100 max-h-36 overflow-y-auto space-y-0.5">
                                    {refableTasks.length === 0 ? (
                                      <div className="px-2 py-1.5 text-[11px] text-zinc-400">
                                        暂无其他历史对话
                                      </div>
                                    ) : (
                                      refableTasks.map((t) => (
                                        <button
                                          key={t.id}
                                          type="button"
                                          onClick={() => {
                                            if (t.transcriptPath) {
                                              attachConversationRef({
                                                title: t.title,
                                                path: t.transcriptPath
                                              })
                                            }
                                            setPlusMenuOpen(false)
                                          }}
                                          className="w-full px-2 py-1 rounded-lg text-left text-[11px] text-zinc-700 hover:bg-zinc-200/60 truncate cursor-pointer"
                                        >
                                          💬 {t.title}
                                        </button>
                                      ))
                                    )}
                                  </div>
                                )}

                                <button
                                  type="button"
                                  onClick={() =>
                                    setPlusSubmenu((s) => (s === 'mcp' ? 'none' : 'mcp'))
                                  }
                                  className="w-full flex items-center justify-between px-3 py-2 rounded-xl text-zinc-800 hover:bg-zinc-100 cursor-pointer"
                                >
                                  <span className="flex items-center gap-2.5">
                                    <Plug className="w-3.5 h-3.5 text-emerald-600" />
                                    <span>
                                      软件连接器{enabledConnectors.length > 0 ? ` (${enabledConnectors.length})` : ''}
                                    </span>
                                  </span>
                                  <ChevronDown
                                    className={clsx(
                                      'w-3.5 h-3.5 text-zinc-400 transition-transform',
                                      plusSubmenu === 'mcp' && 'rotate-180'
                                    )}
                                  />
                                </button>
                                {plusSubmenu === 'mcp' && (
                                  <div className="mx-1.5 my-1 p-1.5 rounded-xl bg-zinc-50 border border-zinc-100 max-h-44 overflow-y-auto space-y-1">
                                    {mcpConnectors.map((c) => (
                                      <div
                                        key={c.name}
                                        className="flex items-center justify-between gap-2 px-1.5 py-1 rounded-lg hover:bg-white"
                                      >
                                        <span className="text-[11px] text-zinc-800 truncate">
                                          {c.label}
                                        </span>
                                        <button
                                          type="button"
                                          onClick={() => void toggleMcpConnector(c.name, !c.enabled)}
                                          className={clsx(
                                            'px-2 py-0.5 rounded-full text-[10px] font-medium cursor-pointer shrink-0',
                                            c.enabled
                                              ? 'bg-emerald-600 text-white'
                                              : 'bg-zinc-200 text-zinc-700 hover:bg-zinc-300'
                                          )}
                                        >
                                          {c.enabled ? '已开启' : '启用'}
                                        </button>
                                      </div>
                                    ))}
                                  </div>
                                )}

                                <div className="my-1 border-t border-zinc-100" />
                                <button
                                  type="button"
                                  onClick={() => setThinkingEnabled(!thinkingEnabled)}
                                  className="w-full flex items-center justify-between px-3 py-2 rounded-xl text-zinc-800 hover:bg-zinc-100 cursor-pointer"
                                >
                                  <span className="flex items-center gap-2.5">
                                    <Brain className="w-3.5 h-3.5 text-purple-600" />
                                    <span>深度思考</span>
                                  </span>
                                  <span
                                    className={clsx(
                                      'text-[11px] font-medium',
                                      thinkingEnabled ? 'text-purple-600' : 'text-zinc-400'
                                    )}
                                  >
                                    {thinkingEnabled ? '开' : '关'}
                                  </span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setAiSchemeMode(!aiSchemeMode)}
                                  className="w-full flex items-center justify-between px-3 py-2 rounded-xl text-zinc-800 hover:bg-zinc-100 cursor-pointer"
                                >
                                  <span className="flex items-center gap-2.5">
                                    <Compass className="w-3.5 h-3.5 text-blue-600" />
                                    <span>AI 方案策略</span>
                                  </span>
                                  <span
                                    className={clsx(
                                      'text-[11px] font-medium',
                                      aiSchemeMode ? 'text-blue-600' : 'text-zinc-400'
                                    )}
                                  >
                                    {aiSchemeMode ? '开' : '关'}
                                  </span>
                                </button>
                              </div>
                            </>
                          )}
                        </div>

                        {isHomeEmpty && composerMode === 'modeling' ? (
                          <ModelingMcpStrip
                            connectors={mcpConnectors}
                            onToggle={(name, en) => void toggleMcpConnector(name, en)}
                          />
                        ) : isHomeEmpty && composerMode === 'regulation' ? (
                          <RegulationScopeStrip scope={regScope} onChange={setRegScope} />
                        ) : (
                        <div className="relative">
                          <button
                            type="button"
                            onClick={() => setPermMenuOpen((v) => !v)}
                            className={clsx(
                              'inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[13px] font-medium cursor-pointer transition-colors',
                              permissionMode === 'auto'
                                ? 'text-amber-600 hover:bg-amber-50/70'
                                : 'text-zinc-600 hover:bg-zinc-100'
                            )}
                          >
                            <ShieldCheck className="w-4 h-4 shrink-0" />
                            <span>{permissionMode === 'auto' ? '完全访问' : '默认权限'}</span>
                            <ChevronDown className="w-3.5 h-3.5 opacity-70" />
                          </button>

                          {permMenuOpen && (
                            <>
                              <div
                                className="fixed inset-0 z-30"
                                onClick={() => setPermMenuOpen(false)}
                              />
                              <div className="absolute left-0 bottom-10 z-40 w-64 rounded-2xl border border-zinc-200 bg-white shadow-xl p-1.5 space-y-1 text-xs">
                                <div className="px-2.5 py-1.5 text-[11px] font-medium text-zinc-400">
                                  应如何批准智能体操作？
                                </div>
                                <button
                                  type="button"
                                  onClick={() => {
                                    void setPermissionMode('default')
                                    setPermMenuOpen(false)
                                  }}
                                  className={clsx(
                                    'w-full text-left px-2.5 py-2 rounded-xl transition-colors cursor-pointer',
                                    permissionMode === 'default' ? 'bg-zinc-100' : 'hover:bg-zinc-50'
                                  )}
                                >
                                  <div className="font-medium text-zinc-900">默认权限</div>
                                  <div className="text-[11px] text-zinc-500 mt-0.5">
                                    编辑外部文件或执行系统命令时询问确认
                                  </div>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    void setPermissionMode('auto')
                                    setPermMenuOpen(false)
                                  }}
                                  className={clsx(
                                    'w-full text-left px-2.5 py-2 rounded-xl transition-colors cursor-pointer',
                                    permissionMode === 'auto' ? 'bg-amber-50' : 'hover:bg-zinc-50'
                                  )}
                                >
                                  <div className="font-medium text-amber-700">完全访问</div>
                                  <div className="text-[11px] text-zinc-500 mt-0.5">
                                    可不受限制地读写工作区文件与执行命令
                                  </div>
                                </button>
                              </div>
                            </>
                          )}
                        </div>
                        )}
                      </div>

                      {/* 右侧：模型选择菜单 + 圆形发送/停止钮 */}
                      <div className="flex items-center gap-2">
                        {modelSettings && (
                          <div className="relative">
                            <button
                              type="button"
                              onClick={() => {
                                const nextOpen = !modelMenuOpen
                                setModelMenuOpen(nextOpen)
                                if (nextOpen) void refreshCcSwitchCandidates()
                              }}
                              className={clsx(
                                'inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[13px] font-medium cursor-pointer transition-colors max-w-48',
                                hasApiKey
                                  ? 'text-zinc-700 hover:bg-zinc-100'
                                  : 'text-amber-700 bg-amber-50 hover:bg-amber-100'
                              )}
                            >
                              <span className="truncate">
                                {activeProfile?.model || activeProfile?.label || '请配置模型'}
                              </span>
                              <ChevronDown className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
                            </button>

                            {modelMenuOpen && (
                              <>
                                <div
                                  className="fixed inset-0 z-30"
                                  onClick={() => setModelMenuOpen(false)}
                                />
                                <div className="absolute right-0 bottom-10 z-40 w-72 rounded-2xl border border-zinc-200 bg-white shadow-xl p-1.5 space-y-0.5 text-xs">
                                  <div className="max-h-64 overflow-y-auto space-y-0.5">
                                    {configuredProfiles.length > 0 && (
                                      <>
                                        <div className="px-2.5 py-1 text-[11px] font-medium text-zinc-400">
                                          已配置模型渠道
                                        </div>
                                        {configuredProfiles.map((p) => {
                                          const active = p.id === activeProfile?.id
                                          return (
                                            <button
                                              key={p.id}
                                              type="button"
                                              onClick={() => {
                                                void setActiveProfileId(p.id)
                                                setModelMenuOpen(false)
                                              }}
                                              className={clsx(
                                                'w-full text-left px-2.5 py-2 rounded-xl flex flex-col cursor-pointer transition-colors',
                                                active
                                                  ? 'bg-zinc-100 text-zinc-900 font-medium'
                                                  : 'text-zinc-700 hover:bg-zinc-50'
                                              )}
                                            >
                                              <span className="truncate">{p.model}</span>
                                              <span className="text-[10px] text-zinc-400 truncate">
                                                {p.label}
                                              </span>
                                            </button>
                                          )
                                        })}
                                      </>
                                    )}

                                    {(recognizedCandidates.length > 0 || ccSwitchLoading) && (
                                      <div
                                        className={clsx(
                                          configuredProfiles.length > 0 &&
                                            'border-t border-zinc-100 pt-1 mt-1'
                                        )}
                                      >
                                        <div className="px-2.5 py-1 text-[11px] font-medium text-zinc-400 flex items-center justify-between">
                                          <span>当前激活的本机模型</span>
                                          {ccSwitchLoading && (
                                            <span className="text-[10px] text-blue-600">扫描中…</span>
                                          )}
                                        </div>
                                        {recognizedCandidates.map((c) => (
                                          <button
                                            key={c.uid}
                                            type="button"
                                            onClick={() => {
                                              void importAndActivateCandidate(c)
                                              setModelMenuOpen(false)
                                            }}
                                            className="w-full text-left px-2.5 py-2 rounded-xl flex flex-col cursor-pointer transition-colors text-zinc-700 hover:bg-blue-50/70"
                                          >
                                            <div className="flex items-center justify-between gap-1.5">
                                              <span className="truncate font-medium">{c.model}</span>
                                              {c.isCurrent && (
                                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 shrink-0">
                                                  当前激活
                                                </span>
                                              )}
                                            </div>
                                            <span className="text-[10px] text-zinc-400 truncate">
                                              {c.name} · {c.appType}
                                            </span>
                                          </button>
                                        ))}
                                      </div>
                                    )}

                                    {configuredProfiles.length === 0 &&
                                      recognizedCandidates.length === 0 &&
                                      !ccSwitchLoading && (
                                        <div className="px-2.5 py-2.5 text-[11px] text-zinc-400">
                                          暂无可用模型，请点击下方手动配置或从 CC Switch 导入。
                                        </div>
                                      )}
                                  </div>

                                  <div className="border-t border-zinc-100 pt-1">
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setModelMenuOpen(false)
                                        setSettingsModalOpen(true)
                                      }}
                                      className="w-full text-left px-2.5 py-1.5 rounded-xl text-blue-600 hover:bg-blue-50 cursor-pointer"
                                    >
                                      配置 API 渠道 / 管理模型…
                                    </button>
                                  </div>
                                </div>
                              </>
                            )}
                          </div>
                        )}

                        {running && activeTaskId ? (
                          <button
                            type="button"
                            onClick={() => void stopTask(activeTaskId)}
                            aria-label="停止生成"
                            title="停止生成"
                            className="w-8 h-8 rounded-full bg-zinc-900 text-white hover:bg-zinc-700 flex items-center justify-center cursor-pointer transition-colors shrink-0"
                          >
                            <Square className="w-3.5 h-3.5 fill-current" />
                          </button>
                        ) : (
                          <button
                            type="button"
                            disabled={
                              !inputText.trim() &&
                              attachments.length === 0 &&
                              draftAnnotations.length === 0 &&
                              draftConversationRefs.length === 0 &&
                              !pptSelection
                            }
                            onClick={() => void handleSend()}
                            aria-label="发送"
                            title="发送"
                            className="w-8 h-8 rounded-full bg-zinc-900 text-white hover:bg-zinc-800 disabled:bg-zinc-200 disabled:text-white flex items-center justify-center cursor-pointer disabled:cursor-not-allowed transition-colors shrink-0"
                          >
                            <ArrowUp className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-[2px] p-4">
          <div className="w-full max-w-lg rounded-2xl bg-white border border-zinc-200 shadow-2xl overflow-hidden flex flex-col">
            <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-200">
              <div className="text-xs font-semibold text-zinc-900">
                项目档案：{projectMetaTarget.name}（自动注入本项目所有对话）
              </div>
              <button
                type="button"
                onClick={() => setProjectMetaTarget(null)}
                className="p-1 rounded-lg text-zinc-400 hover:text-zinc-700 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-4 space-y-3 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-medium text-zinc-700 mb-1">所属领域</label>
                  <input
                    type="text"
                    value={projectMetaDraft.domain ?? ''}
                    onChange={(e) => setProjectMetaDraft({ ...projectMetaDraft, domain: e.target.value })}
                    placeholder="如 室内工装 / 住宅家装 / 建筑 / 景观"
                    className="w-full px-2.5 py-1.5 rounded-lg border border-zinc-200 outline-none focus:border-blue-500"
                  />
                </div>
                <div>
                  <label className="block font-medium text-zinc-700 mb-1">项目类型</label>
                  <input
                    type="text"
                    value={projectMetaDraft.projectType ?? ''}
                    onChange={(e) =>
                      setProjectMetaDraft({ ...projectMetaDraft, projectType: e.target.value })
                    }
                    placeholder="如 新中式茶室 / 商业展厅"
                    className="w-full px-2.5 py-1.5 rounded-lg border border-zinc-200 outline-none focus:border-blue-500"
                  />
                </div>
                <div>
                  <label className="block font-medium text-zinc-700 mb-1">项目地区</label>
                  <input
                    type="text"
                    value={projectMetaDraft.region ?? ''}
                    onChange={(e) => setProjectMetaDraft({ ...projectMetaDraft, region: e.target.value })}
                    placeholder="如 北京（影响地方规范适配）"
                    className="w-full px-2.5 py-1.5 rounded-lg border border-zinc-200 outline-none focus:border-blue-500"
                  />
                </div>
                <div>
                  <label className="block font-medium text-zinc-700 mb-1">面积与预算</label>
                  <input
                    type="text"
                    value={projectMetaDraft.area ?? ''}
                    onChange={(e) => setProjectMetaDraft({ ...projectMetaDraft, area: e.target.value })}
                    placeholder="如 280㎡ · 预算 60 万元"
                    className="w-full px-2.5 py-1.5 rounded-lg border border-zinc-200 outline-none focus:border-blue-500"
                  />
                </div>
              </div>
              <div>
                <label className="block font-medium text-zinc-700 mb-1">任务书 / 客户核心要求</label>
                <textarea
                  rows={4}
                  value={projectMetaDraft.brief ?? ''}
                  onChange={(e) => setProjectMetaDraft({ ...projectMetaDraft, brief: e.target.value })}
                  placeholder="填写客户明确的设计诉求、忌讳项或保留空间结构…"
                  className="w-full px-2.5 py-1.5 rounded-lg border border-zinc-200 outline-none focus:border-blue-500 resize-y"
                />
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-zinc-200 bg-zinc-50">
              <button
                type="button"
                onClick={() => setProjectMetaTarget(null)}
                className="px-3.5 py-1.5 rounded-lg text-xs border border-zinc-300 bg-white text-zinc-700 cursor-pointer"
              >
                取消
              </button>
              <button
                type="button"
                onClick={async () => {
                  await window.zmo.projects.updateMeta(projectMetaTarget.id, projectMetaDraft)
                  setProjectMetaTarget(null)
                }}
                className="px-3.5 py-1.5 rounded-lg text-xs font-medium bg-zinc-900 text-white hover:bg-zinc-800 cursor-pointer"
              >
                保存项目档案
              </button>
            </div>
          </div>
        </div>
      )}

      {charterOpen && activeTask?.rootDir && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-[2px] p-4">
          <div className="w-full max-w-xl rounded-2xl bg-white border border-zinc-200 shadow-2xl overflow-hidden flex flex-col">
            <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-200">
              <div className="text-xs font-semibold text-zinc-900">
                项目宪章 (ZNZMO.md) · 自动注入到本工作区所有智能体对话
              </div>
              <button
                type="button"
                onClick={() => setCharterOpen(false)}
                className="p-1 rounded-lg text-zinc-400 hover:text-zinc-700 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-4">
              <textarea
                rows={10}
                value={charterDraft}
                onChange={(e) => setCharterDraft(e.target.value)}
                placeholder="可填写项目硬约束、品牌调性、面积指标、出图规范等（Markdown 格式）…"
                className="w-full p-3 rounded-xl border border-zinc-200 text-xs font-mono outline-none focus:border-blue-500 resize-y"
              />
            </div>
            <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-zinc-200 bg-zinc-50">
              <button
                type="button"
                onClick={() => setCharterOpen(false)}
                className="px-3.5 py-1.5 rounded-lg text-xs border border-zinc-300 bg-white text-zinc-700 cursor-pointer"
              >
                取消
              </button>
              <button
                type="button"
                onClick={async () => {
                  await window.zmo.projects.saveCharter(activeTask.rootDir, charterDraft)
                  setCharterOpen(false)
                }}
                className="px-3.5 py-1.5 rounded-lg text-xs font-medium bg-zinc-900 text-white hover:bg-zinc-800 cursor-pointer"
              >
                保存 ZNZMO.md
              </button>
            </div>
          </div>
        </div>
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
