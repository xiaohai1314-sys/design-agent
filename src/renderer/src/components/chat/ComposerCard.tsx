import {
  ArrowUp,
  AtSign,
  Brain,
  ChevronDown,
  Compass,
  Eye,
  History,
  MapPin,
  MessageSquare,
  Plug,
  Plus,
  Presentation,
  ShieldCheck,
  Square,
  Upload,
  X
} from 'lucide-react'
import clsx from 'clsx'
import type {
  CcSwitchCandidate,
  McpConnectorInfo,
  ProjectSummary,
  TaskSummary
} from '@shared/ipc'
import type { AgentAttachment, ModelProviderProfile } from '@shared/protocol'
import { FunctionToolChips, type SceneToolboxPreset } from '../SceneToolboxBar'
import {
  MODE_PLACEHOLDER,
  ModelingMcpStrip,
  RegulationScopeStrip,
  ReportTemplateSlot
} from '../WorkspaceModeHome'
import { useWorkspaceStore } from '../../store/useWorkspaceStore'

export type RegulationScope = 'comprehensive' | 'retrieve' | 'qa'

export interface ComposerCardProps {
  isHomeEmpty: boolean
  showTodoBar: boolean
  headline: { title: string; subtitle: string }
  activeProj: ProjectSummary | undefined
  templateAttachment: AgentAttachment | undefined
  activeProfile: ModelProviderProfile | undefined
  configuredProfiles: ModelProviderProfile[]
  recognizedCandidates: CcSwitchCandidate[]
  enabledConnectors: McpConnectorInfo[]
  refableTasks: TaskSummary[]
  attachments: AgentAttachment[]
  inputText: string
  dragOver: boolean
  running: boolean
  hasApiKey: boolean
  pendingInterrupt: unknown
  activeScenePreset: SceneToolboxPreset | null
  sceneParamValues: Record<string, string>
  regScope: RegulationScope
  plusMenuOpen: boolean
  plusSubmenu: 'none' | 'recent' | 'conv' | 'mcp'
  permMenuOpen: boolean
  modelMenuOpen: boolean
  setInputText: React.Dispatch<React.SetStateAction<string>>
  setAttachments: React.Dispatch<React.SetStateAction<AgentAttachment[]>>
  setDragOver: React.Dispatch<React.SetStateAction<boolean>>
  setActiveScenePreset: React.Dispatch<React.SetStateAction<SceneToolboxPreset | null>>
  setSceneParamValues: React.Dispatch<React.SetStateAction<Record<string, string>>>
  setRegScope: React.Dispatch<React.SetStateAction<RegulationScope>>
  setPlusMenuOpen: React.Dispatch<React.SetStateAction<boolean>>
  setPlusSubmenu: React.Dispatch<React.SetStateAction<'none' | 'recent' | 'conv' | 'mcp'>>
  setPermMenuOpen: React.Dispatch<React.SetStateAction<boolean>>
  setModelMenuOpen: React.Dispatch<React.SetStateAction<boolean>>
  appendAttachedFiles: (items: AgentAttachment[]) => void
  handleDropFiles: (e: React.DragEvent) => Promise<void>
  handlePaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void
  handlePickFiles: (role?: 'project_material' | 'ppt_template') => Promise<void>
  handleSend: () => void | Promise<void>
}

/** 对话输入卡：附件 chips、模式菜单、权限/模型菜单、发送按钮 */
export function ComposerCard(props: ComposerCardProps): React.JSX.Element {
  // 这些状态由 store 直接提供，避免在 App 里层层透传
  const {
    activeTaskId,
    aiSchemeMode,
    attachConversationRef,
    ccSwitchLoading,
    composerMode,
    draftAnnotations,
    draftConversationRefs,
    importAndActivateCandidate,
    mcpConnectors,
    modelSettings,
    openFilePreview,
    permissionMode,
    pptSelection,
    recentFiles,
    refreshCcSwitchCandidates,
    refreshMcpConnectors,
    refreshRecentFiles,
    removeAnnotationRef,
    removeConversationRef,
    setActiveProfileId,
    setAiSchemeMode,
    setPermissionMode,
    setPptSelection,
    setSettingsModalOpen,
    setThinkingEnabled,
    stopTask,
    thinkingEnabled,
    toggleMcpConnector
  } = useWorkspaceStore()

  const {
    isHomeEmpty,
    showTodoBar,
    headline,
    activeProj,
    templateAttachment,
    activeProfile,
    configuredProfiles,
    recognizedCandidates,
    enabledConnectors,
    refableTasks,
    attachments,
    inputText,
    dragOver,
    running,
    hasApiKey,
    pendingInterrupt,
    activeScenePreset,
    sceneParamValues,
    regScope,
    plusMenuOpen,
    plusSubmenu,
    permMenuOpen,
    modelMenuOpen,
    setInputText,
    setAttachments,
    setDragOver,
    setActiveScenePreset,
    setSceneParamValues,
    setRegScope,
    setPlusMenuOpen,
    setPlusSubmenu,
    setPermMenuOpen,
    setModelMenuOpen,
    appendAttachedFiles,
    handleDropFiles,
    handlePaste,
    handlePickFiles,
    handleSend
  } = props

  return (
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
  )
}
