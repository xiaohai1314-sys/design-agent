import React, { useEffect, useState } from 'react'
import {
  ArrowUp,
  BookOpen,
  BrainCircuit,
  Check,
  ExternalLink,
  Eye,
  File,
  Folder,
  FolderOpen,
  MessageSquarePlus,
  Pencil,
  RefreshCw,
  Save,
  Sparkles,
  X
} from 'lucide-react'
import clsx from 'clsx'
import type { SkillInfo, WorkspaceEntry } from '@shared/ipc'
import type { AgentAttachment, ModelAnnotationRef, PptProposal, PptWorkbenchSelection } from '@shared/protocol'
import { CadViewerPanel } from './CadViewerPanel'
import { ModelViewerPanel } from './ModelViewerPanel'
import { PptWorkbenchPanel } from './PptWorkbenchPanel'
import { MarkdownRenderer } from './MarkdownRenderer'
import {
  DocxPreviewPanel,
  PdfPreviewPanel,
  SheetPreviewPanel
} from './OfficePreviewPanels'

const CAD_EXTS = new Set(['dwg', 'dxf'])
const MODEL_3D_EXTS = new Set([
  'skp',
  '3dm',
  'glb',
  'gltf',
  'fbx',
  'obj',
  'dae',
  '3ds',
  'stl',
  'ply',
  'blend'
])

function extOf(p: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(p.trim())
  return m ? m[1].toLowerCase() : ''
}

function parseCsvRows(text: string, sep: string): string[][] {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .slice(0, 200)
    .map((line) => line.split(sep).map((cell) => cell.replace(/^"|"$/g, '').trim()))
}

interface RightWorkbenchProps {
  rootDir?: string
  projectId?: string | null
  skills: SkillInfo[]
  activeTab: 'files' | 'preview' | 'skills' | 'memory'
  previewTarget: { path: string; title: string } | null
  pptSelection: PptWorkbenchSelection | null
  pendingPptProposals: Record<string, PptProposal>
  onTabChange: (tab: 'files' | 'preview' | 'skills' | 'memory') => void
  onSelectPreview: (path: string, title: string) => void
  onAttachAnnotations: (ref: ModelAnnotationRef) => void
  onAttachFileToChat?: (att: AgentAttachment) => void
  onChangePptSelection: (sel: PptWorkbenchSelection | null) => void
  onResolvePptProposal: (pptPath: string, accept: boolean) => Promise<void>
  onClose: () => void
}

export const RightWorkbench: React.FC<RightWorkbenchProps> = ({
  rootDir,
  projectId,
  skills,
  activeTab,
  previewTarget,
  pptSelection,
  pendingPptProposals,
  onTabChange,
  onSelectPreview,
  onAttachAnnotations,
  onAttachFileToChat,
  onChangePptSelection,
  onResolvePptProposal,
  onClose
}) => {
  const [currentDir, setCurrentDir] = useState<string>(rootDir ?? '')
  const [entries, setEntries] = useState<WorkspaceEntry[]>([])
  const [memoryState, setMemoryState] = useState<{ memory: string; decisions: string }>({
    memory: '',
    decisions: ''
  })
  const [editingTextMode, setEditingTextMode] = useState(false)
  const [editedTextDraft, setEditedTextDraft] = useState('')
  const [textSavedFlag, setTextSavedFlag] = useState(false)
  const [reloadTextTick, setReloadTextTick] = useState(0)
  const [previewState, setPreviewState] = useState<{
    loading: boolean
    kind?: 'text' | 'image' | 'binary'
    content?: string
    size?: number
    error?: string
  }>({ loading: false })

  useEffect(() => {
    if (rootDir) setCurrentDir(rootDir)
  }, [rootDir])

  const refreshFiles = async (dir: string): Promise<void> => {
    if (!dir) {
      setEntries([])
      return
    }
    const list = await window.zmo.files.listWorkspace(dir)
    setEntries(list)
  }

  useEffect(() => {
    if (activeTab === 'files' && currentDir) {
      void refreshFiles(currentDir)
    }
  }, [activeTab, currentDir])

  useEffect(() => {
    if (activeTab === 'memory' && projectId) {
      void window.zmo.projects.readMemory(projectId).then(setMemoryState)
    }
  }, [activeTab, projectId])

  const targetExt = previewTarget ? extOf(previewTarget.path) : ''
  const isCadTarget = CAD_EXTS.has(targetExt)
  const isModelTarget = MODEL_3D_EXTS.has(targetExt)
  const isPdfTarget = targetExt === 'pdf'
  const isSheetTarget = targetExt === 'xlsx' || targetExt === 'xls' || targetExt === 'xlsm'
  const isDocxTarget = targetExt === 'docx'
  const isPptxTarget = targetExt === 'pptx'

  useEffect(() => {
    if (
      !previewTarget ||
      isCadTarget ||
      isModelTarget ||
      isPdfTarget ||
      isSheetTarget ||
      isDocxTarget ||
      isPptxTarget
    ) {
      return
    }
    let cancelled = false
    setEditingTextMode(false)
    setPreviewState({ loading: true })
    window.zmo.files
      .readPreview(previewTarget.path)
      .then((res) => {
        if (!cancelled) {
          setPreviewState({
            loading: false,
            kind: res.kind,
            content: res.content,
            size: res.size
          })
          if (res.kind === 'text' && res.content !== undefined) {
            setEditedTextDraft(res.content)
          }
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setPreviewState({
            loading: false,
            error: err instanceof Error ? err.message : String(err)
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [
    previewTarget,
    reloadTextTick,
    isCadTarget,
    isModelTarget,
    isPdfTarget,
    isSheetTarget,
    isDocxTarget,
    isPptxTarget
  ])

  const goParentDir = (): void => {
    if (!currentDir || !rootDir) return
    const normCur = currentDir.replace(/[\\/]+$/, '')
    const normRoot = rootDir.replace(/[\\/]+$/, '')
    if (normCur.toLowerCase() === normRoot.toLowerCase()) return
    const lastSep = Math.max(normCur.lastIndexOf('/'), normCur.lastIndexOf('\\'))
    if (lastSep > 2) {
      setCurrentDir(normCur.slice(0, lastSep))
    }
  }

  return (
    <aside className="w-[420px] xl:w-[540px] shrink-0 border-l border-zinc-200 bg-white flex flex-col h-full">
      <div className="h-12 px-3 border-b border-zinc-200 flex items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-1 overflow-x-auto">
          <button
            type="button"
            onClick={() => onTabChange('files')}
            className={clsx(
              'px-2.5 py-1 rounded-lg text-xs font-medium whitespace-nowrap transition-colors cursor-pointer',
              activeTab === 'files'
                ? 'bg-zinc-900 text-white'
                : 'text-zinc-600 hover:bg-zinc-100'
            )}
          >
            工作区文件
          </button>
          <button
            type="button"
            onClick={() => onTabChange('preview')}
            className={clsx(
              'px-2.5 py-1 rounded-lg text-xs font-medium whitespace-nowrap transition-colors cursor-pointer',
              activeTab === 'preview'
                ? 'bg-zinc-900 text-white'
                : 'text-zinc-600 hover:bg-zinc-100'
            )}
          >
            专业预览
          </button>
          <button
            type="button"
            onClick={() => onTabChange('skills')}
            className={clsx(
              'px-2.5 py-1 rounded-lg text-xs font-medium whitespace-nowrap transition-colors cursor-pointer',
              activeTab === 'skills'
                ? 'bg-zinc-900 text-white'
                : 'text-zinc-600 hover:bg-zinc-100'
            )}
          >
            本地技能 ({skills.length})
          </button>
          {projectId && (
            <button
              type="button"
              onClick={() => onTabChange('memory')}
              className={clsx(
                'px-2.5 py-1 rounded-lg text-xs font-medium whitespace-nowrap transition-colors cursor-pointer',
                activeTab === 'memory'
                  ? 'bg-zinc-900 text-white'
                  : 'text-zinc-600 hover:bg-zinc-100'
              )}
            >
              项目记忆
            </button>
          )}
        </div>

        <button
          type="button"
          onClick={onClose}
          title="收起右侧工作台"
          className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-800 hover:bg-zinc-100 cursor-pointer shrink-0"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col">
        {activeTab === 'files' && (
          <div className="p-3 space-y-2">
            {currentDir ? (
              <>
                <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-zinc-50 border border-zinc-200/80 text-[11px] text-zinc-600">
                  <button
                    type="button"
                    onClick={goParentDir}
                    title="返回上级目录"
                    className="p-1 rounded hover:bg-zinc-200/70 cursor-pointer"
                  >
                    <ArrowUp className="w-3.5 h-3.5" />
                  </button>
                  <span className="truncate flex-1 font-mono" title={currentDir}>
                    {currentDir}
                  </span>
                  <button
                    type="button"
                    onClick={() => void refreshFiles(currentDir)}
                    title="刷新"
                    className="p-1 rounded hover:bg-zinc-200/70 cursor-pointer"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => void window.zmo.shell.openPath(currentDir)}
                    title="在资源管理器中打开"
                    className="p-1 rounded hover:bg-zinc-200/70 cursor-pointer"
                  >
                    <FolderOpen className="w-3.5 h-3.5" />
                  </button>
                </div>

                {entries.length === 0 ? (
                  <div className="py-12 text-center text-xs text-zinc-400">
                    当前工作区暂无文件，发送消息或上传图纸/模型后将显示在这里
                  </div>
                ) : (
                  <div className="divide-y divide-zinc-100 border border-zinc-200/70 rounded-xl overflow-hidden">
                    {entries.map((item) => (
                      <button
                        key={item.path}
                        type="button"
                        onClick={() => {
                          if (item.isDirectory) {
                            setCurrentDir(item.path)
                          } else {
                            onSelectPreview(item.path, item.name)
                          }
                        }}
                        className="w-full flex items-center gap-2.5 px-3 py-2 text-left text-xs hover:bg-zinc-50 transition-colors cursor-pointer"
                      >
                        {item.isDirectory ? (
                          <Folder className="w-4 h-4 text-amber-500 shrink-0" />
                        ) : (
                          <File className="w-4 h-4 text-zinc-400 shrink-0" />
                        )}
                        <span className="truncate flex-1 text-zinc-800">{item.name}</span>
                        {!item.isDirectory && (
                          <span className="text-[11px] text-zinc-400 tabular-nums shrink-0">
                            {item.size < 1024
                              ? `${item.size} B`
                              : `${Math.round(item.size / 1024)} KB`}
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <div className="py-12 text-center text-xs text-zinc-400">
                新建或选择一个对话后显示其工作区目录
              </div>
            )}
          </div>
        )}

        {activeTab === 'preview' && (
          <div className="p-3 flex-1 min-h-0 flex flex-col">
            {!previewTarget ? (
              <div className="py-16 text-center text-xs text-zinc-400 space-y-1">
                <div>支持直接预览 CAD(.dwg/.dxf)、3D(.skp/.3dm/.obj/.fbx/.glb)、PDF、Excel、Word、PPTX、HTML 与图片</div>
                <div className="text-[11px] text-zinc-300">在 CAD 与 3D 视口内可圈选或打点批注直接加入对话</div>
              </div>
            ) : (
              <div className="flex-1 min-h-0 flex flex-col gap-2.5">
                <div className="flex items-center justify-between gap-2 px-3 py-2 rounded-xl bg-zinc-50 border border-zinc-200 shrink-0">
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-zinc-900 truncate">
                      {previewTarget.title}
                    </div>
                    <div className="text-[11px] text-zinc-400 font-mono truncate">
                      {previewTarget.path}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {onAttachFileToChat && (
                      <button
                        type="button"
                        onClick={() => {
                          const isImg = /\.(png|jpg|jpeg|webp|gif|bmp|svg)$/i.test(previewTarget.title)
                          onAttachFileToChat({
                            path: previewTarget.path,
                            name: previewTarget.title,
                            kind: isImg ? 'image' : 'file',
                            size: previewState.size
                          })
                        }}
                        title="将此文件加入左侧对话附件"
                        className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-blue-50 text-blue-700 hover:bg-blue-100 text-[11px] font-medium cursor-pointer"
                      >
                        <MessageSquarePlus className="w-3.5 h-3.5" />
                        <span>加入对话</span>
                      </button>
                    )}
                    {previewState.kind === 'text' && (
                      <>
                        <button
                          type="button"
                          onClick={() => setEditingTextMode(!editingTextMode)}
                          title={editingTextMode ? '切换只读预览' : '在线编辑文本/代码'}
                          className={clsx(
                            'inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] cursor-pointer',
                            editingTextMode
                              ? 'bg-zinc-900 text-white'
                              : 'text-zinc-600 hover:bg-zinc-200/70'
                          )}
                        >
                          {editingTextMode ? <Eye className="w-3.5 h-3.5" /> : <Pencil className="w-3.5 h-3.5" />}
                          <span>{editingTextMode ? '预览' : '编辑'}</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => setReloadTextTick((t) => t + 1)}
                          title="重新读取此文件"
                          className="p-1.5 rounded-lg text-zinc-600 hover:bg-zinc-200/70 cursor-pointer"
                        >
                          <RefreshCw className="w-3.5 h-3.5" />
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      onClick={() => void window.zmo.shell.openPath(previewTarget.path)}
                      title="使用系统默认软件打开"
                      className="p-1.5 rounded-lg text-zinc-600 hover:bg-zinc-200/70 cursor-pointer"
                    >
                      <ExternalLink className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => void window.zmo.shell.showItemInFolder(previewTarget.path)}
                      title="在文件夹中定位"
                      className="p-1.5 rounded-lg text-zinc-600 hover:bg-zinc-200/70 cursor-pointer"
                    >
                      <FolderOpen className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                {isCadTarget ? (
                  <CadViewerPanel
                    filePath={previewTarget.path}
                    title={previewTarget.title}
                    onAttachAnnotations={onAttachAnnotations}
                  />
                ) : isModelTarget ? (
                  <ModelViewerPanel
                    filePath={previewTarget.path}
                    title={previewTarget.title}
                    onAttachAnnotations={onAttachAnnotations}
                  />
                ) : isPdfTarget ? (
                  <PdfPreviewPanel filePath={previewTarget.path} />
                ) : isSheetTarget ? (
                  <SheetPreviewPanel filePath={previewTarget.path} />
                ) : isDocxTarget ? (
                  <DocxPreviewPanel filePath={previewTarget.path} />
                ) : isPptxTarget ? (
                  <PptWorkbenchPanel
                    filePath={previewTarget.path}
                    selection={pptSelection}
                    pendingProposal={
                      pendingPptProposals[previewTarget.path.replace(/\\/g, '/').toLowerCase()] ?? null
                    }
                    onChangeSelection={onChangePptSelection}
                    onResolveProposal={onResolvePptProposal}
                  />
                ) : (
                  <div className="flex-1 min-h-0 rounded-xl border border-zinc-200 bg-zinc-50/50 overflow-auto p-3">
                    {previewState.loading ? (
                      <div className="text-xs text-zinc-400 py-8 text-center">正在读取预览…</div>
                    ) : previewState.error ? (
                      <div className="text-xs text-rose-600 py-8 text-center">
                        {previewState.error}
                      </div>
                    ) : previewState.kind === 'image' && previewState.content ? (
                      <img
                        src={previewState.content}
                        alt={previewTarget.title}
                        className="max-w-full h-auto rounded-lg mx-auto shadow-xs"
                      />
                    ) : previewState.kind === 'text' && previewState.content !== undefined ? (
                      editingTextMode ? (
                        <div className="h-full flex flex-col gap-2">
                          <div className="flex items-center justify-between text-[11px] text-zinc-500">
                            <span>文件编辑器（直接保存回工作区磁盘）</span>
                            <button
                              type="button"
                              onClick={async () => {
                                const res = await window.zmo.files.saveText(
                                  previewTarget.path,
                                  editedTextDraft
                                )
                                if (res.ok) {
                                  setTextSavedFlag(true)
                                  setPreviewState((s) => ({ ...s, content: editedTextDraft }))
                                  setTimeout(() => setTextSavedFlag(false), 1500)
                                }
                              }}
                              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-600 text-white font-medium hover:bg-emerald-700 cursor-pointer"
                            >
                              {textSavedFlag ? <Check className="w-3.5 h-3.5" /> : <Save className="w-3.5 h-3.5" />}
                              <span>{textSavedFlag ? '已保存' : '保存'}</span>
                            </button>
                          </div>
                          <textarea
                            value={editedTextDraft}
                            onChange={(e) => setEditedTextDraft(e.target.value)}
                            className="flex-1 min-h-[340px] w-full p-3 rounded-lg border border-zinc-200 bg-white text-xs font-mono text-zinc-900 outline-none focus:border-blue-500 resize-none"
                          />
                        </div>
                      ) : targetExt === 'html' || targetExt === 'htm' ? (
                        <iframe
                          title={previewTarget.title}
                          sandbox="allow-scripts"
                          srcDoc={previewState.content}
                          className="w-full h-full min-h-[380px] rounded-lg border border-zinc-200 bg-white"
                        />
                      ) : targetExt === 'md' || targetExt === 'markdown' ? (
                        <div className="bg-white rounded-lg p-4 border border-zinc-200/70 zmo-markdown">
                          <MarkdownRenderer content={previewState.content} />
                        </div>
                      ) : targetExt === 'csv' || targetExt === 'tsv' ? (
                        <div className="overflow-auto bg-white rounded-lg border border-zinc-200">
                          <table className="w-full border-collapse text-xs">
                            <tbody>
                              {parseCsvRows(
                                previewState.content,
                                targetExt === 'tsv' ? '\t' : ','
                              ).map((row, rIdx) => (
                                <tr
                                  key={rIdx}
                                  className={rIdx === 0 ? 'bg-zinc-100 font-semibold' : 'border-t border-zinc-100'}
                                >
                                  {row.map((cell, cIdx) => (
                                    <td key={cIdx} className="px-2.5 py-1.5 border-r border-zinc-100">
                                      {cell}
                                    </td>
                                  ))}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      ) : (
                        <pre className="text-xs font-mono text-zinc-800 whitespace-pre-wrap break-words leading-relaxed">
                          {previewState.content}
                        </pre>
                      )
                    ) : (
                      <div className="py-12 text-center space-y-3">
                        <p className="text-xs text-zinc-500">
                          此文件为专业二进制格式（
                          {(previewState.size ?? 0) > 0
                            ? `${Math.round((previewState.size ?? 0) / 1024)} KB`
                            : ''}
                          ）
                        </p>
                        <button
                          type="button"
                          onClick={() => void window.zmo.shell.openPath(previewTarget.path)}
                          className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-zinc-900 text-white text-xs font-medium hover:bg-zinc-800 cursor-pointer"
                        >
                          <ExternalLink className="w-3.5 h-3.5" />
                          <span>用本机软件打开</span>
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {activeTab === 'skills' && (
          <div className="p-3 space-y-2.5">
            <div className="px-2.5 py-2 rounded-xl bg-blue-50/60 border border-blue-100 text-[11px] text-blue-900 leading-relaxed">
              以下本地专业技能已原装挂载至智能体。智能体会在命中对应设计场景时自动按需读取对应的{' '}
              <code className="font-mono">SKILL.md</code> 与执行脚本。
            </div>
            {skills.map((sk) => (
              <div
                key={sk.path}
                className="rounded-xl border border-zinc-200 bg-white p-3 space-y-1.5 hover:border-zinc-300 transition-colors"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5">
                    <Sparkles className="w-3.5 h-3.5 text-blue-600" />
                    <span className="text-xs font-semibold text-zinc-900">{sk.name}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => onSelectPreview(sk.path, `${sk.name}/SKILL.md`)}
                    className="inline-flex items-center gap-1 text-[11px] text-blue-600 hover:underline cursor-pointer"
                  >
                    <BookOpen className="w-3 h-3" />
                    <span>查看规则</span>
                  </button>
                </div>
                <p className="text-[11px] text-zinc-600 leading-relaxed">{sk.description}</p>
              </div>
            ))}
          </div>
        )}

        {activeTab === 'memory' && projectId && (
          <div className="p-3 space-y-3">
            <div className="flex items-center justify-between px-2.5 py-2 rounded-xl bg-indigo-50/70 border border-indigo-100 text-[11px] text-indigo-900">
              <span className="flex items-center gap-1.5">
                <BrainCircuit className="w-3.5 h-3.5 text-indigo-600" />
                <span>项目记忆由自动蒸馏器在每轮结束后沉淀，跨会话自动生效</span>
              </span>
              <button
                type="button"
                onClick={() => void window.zmo.projects.readMemory(projectId).then(setMemoryState)}
                className="p-1 rounded hover:bg-indigo-100 cursor-pointer"
              >
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className="rounded-xl border border-zinc-200 bg-white p-3 space-y-2">
              <div className="text-xs font-semibold text-zinc-900">关键决策记录 (project_decisions.md)</div>
              {memoryState.decisions ? (
                <div className="zmo-markdown text-xs">
                  <MarkdownRenderer content={memoryState.decisions} />
                </div>
              ) : (
                <div className="text-xs text-zinc-400">暂无自动蒸馏的项目决策记录</div>
              )}
            </div>

            {memoryState.memory && (
              <div className="rounded-xl border border-zinc-200 bg-white p-3 space-y-2">
                <div className="text-xs font-semibold text-zinc-900">长期记忆索引 (memory.md)</div>
                <div className="zmo-markdown text-xs">
                  <MarkdownRenderer content={memoryState.memory} />
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  )
}
