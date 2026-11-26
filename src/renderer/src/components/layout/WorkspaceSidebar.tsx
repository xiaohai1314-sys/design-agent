import { useState } from 'react'
import {
  BookOpenCheck,
  Box,
  ChevronRight,
  FolderPlus,
  Image as ImageIcon,
  KeyRound,
  LayoutGrid,
  Library,
  MessageSquarePlus,
  Pencil,
  Presentation,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Trash2
} from 'lucide-react'
import clsx from 'clsx'
import type { PermissionMode } from '@shared/protocol'
import type { ProjectSummary, TaskSummary } from '@shared/ipc'

export type LeftNavMode = 'image' | 'modeling' | 'report' | 'regulation'

export interface WorkspaceSidebarProps {
  activeView: string
  composerMode: string
  onNewTask: () => void
  onSwitchMode: (mode: LeftNavMode) => void
  onOpenLibrary: () => void
  onOpenWorkbench: () => void
  onOpenToolbox: () => void

  projects: ProjectSummary[]
  activeProjectId: string | null
  taskCount: number
  onSelectProject: (id: string | null) => void
  onCreateProject: () => void
  onOpenProjectMeta: (project: ProjectSummary) => void
  onDeleteProject: (id: string) => void
  onRenameProject: (id: string, name: string) => void

  tasks: TaskSummary[]
  activeTaskId: string | null
  isTaskRunning: (id: string) => boolean
  searchInputRef: React.RefObject<HTMLInputElement | null>
  onSelectTask: (id: string) => void
  onDeleteTask: (id: string) => void
  onRenameTask: (id: string, title: string) => void

  permissionMode: PermissionMode
  onTogglePermission: () => void
  hasApiKey: boolean
  activeProfileLabel?: string
  onOpenSettings: () => void
}

const NAV_ITEMS = [
  { mode: 'image' as const, label: 'AI 生图', icon: ImageIcon },
  { mode: 'modeling' as const, label: 'AI 建模', icon: Box },
  { mode: 'report' as const, label: 'AI 汇报', icon: Presentation, tag: 'PPT' },
  { mode: 'regulation' as const, label: 'AI 查规范', icon: BookOpenCheck }
]

/** 左侧导航栏：场景导航 + 项目空间 + 任务记录 + 底部权限/模型入口 */
export function WorkspaceSidebar({
  activeView,
  composerMode,
  onNewTask,
  onSwitchMode,
  onOpenLibrary,
  onOpenWorkbench,
  onOpenToolbox,
  projects,
  activeProjectId,
  taskCount,
  onSelectProject,
  onCreateProject,
  onOpenProjectMeta,
  onDeleteProject,
  onRenameProject,
  tasks,
  activeTaskId,
  isTaskRunning,
  searchInputRef,
  onSelectTask,
  onDeleteTask,
  onRenameTask,
  permissionMode,
  onTogglePermission,
  hasApiKey,
  activeProfileLabel,
  onOpenSettings
}: WorkspaceSidebarProps): React.JSX.Element {
  const [moreMenuOpen, setMoreMenuOpen] = useState(false)
  const [editingProjId, setEditingProjId] = useState<string | null>(null)
  const [editingProjName, setEditingProjName] = useState('')
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  const [taskSearch, setTaskSearch] = useState('')

  const filteredTasks = tasks
    .filter((t) => (activeProjectId ? t.projectId === activeProjectId : true))
    .filter((t) =>
      taskSearch.trim() ? t.title.toLowerCase().includes(taskSearch.trim().toLowerCase()) : true
    )

  return (
    <aside className="w-[224px] shrink-0 border-r border-zinc-200/90 bg-[#f5f6f8] flex flex-col select-none">
      {/* 顶部功能导航区 */}
      <div className="p-2.5 space-y-0.5 border-b border-zinc-200/70 relative">
        <button
          type="button"
          onClick={onNewTask}
          className="w-full flex items-center gap-2 px-2.5 py-2 rounded-xl text-xs font-medium text-zinc-800 hover:bg-white hover:shadow-2xs transition-all cursor-pointer"
        >
          <MessageSquarePlus className="w-4 h-4 text-zinc-600 shrink-0" />
          <span>新建任务</span>
        </button>

        {NAV_ITEMS.map((nav) => {
          const Icon = nav.icon
          const isNavActive = activeView === 'chat' && composerMode === nav.mode
          return (
            <button
              key={nav.mode}
              type="button"
              onClick={() => {
                setMoreMenuOpen(false)
                onSwitchMode(nav.mode)
              }}
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
            onOpenLibrary()
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
                  onOpenWorkbench()
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
                  onOpenToolbox()
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
            onClick={onCreateProject}
            title="绑定本地项目文件夹"
            className="p-0.5 rounded text-zinc-400 hover:text-zinc-800 cursor-pointer"
          >
            <FolderPlus className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="space-y-0.5 max-h-28 overflow-y-auto">
          <button
            type="button"
            onClick={() => onSelectProject(null)}
            className={clsx(
              'w-full px-2.5 py-1.5 rounded-lg text-left text-xs truncate cursor-pointer transition-colors',
              activeProjectId === null
                ? 'bg-white text-zinc-900 font-medium shadow-2xs'
                : 'text-zinc-600 hover:bg-zinc-200/50'
            )}
          >
            全部对话 ({taskCount})
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
                      onRenameProject(proj.id, editingProjName)
                      setEditingProjId(null)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        onRenameProject(proj.id, editingProjName)
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
                    onClick={() => onSelectProject(proj.id)}
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
                        onOpenProjectMeta(proj)
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
                        onDeleteProject(proj.id)
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
            ref={searchInputRef}
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
            const isEditing = editingTaskId === t.id
            return (
              <div
                key={t.id}
                onClick={() => !isEditing && onSelectTask(t.id)}
                className={clsx(
                  'group flex items-center gap-1.5 px-2.5 py-2 rounded-xl text-xs cursor-pointer transition-colors',
                  isSelected
                    ? 'bg-white text-zinc-900 font-medium shadow-xs border border-zinc-200/60'
                    : 'text-zinc-600 hover:bg-zinc-200/50'
                )}
              >
                {isTaskRunning(t.id) && (
                  <span className="w-1.5 h-1.5 rounded-full bg-blue-600 animate-ping shrink-0" />
                )}
                {isEditing ? (
                  <input
                    autoFocus
                    value={editingTitle}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setEditingTitle(e.target.value)}
                    onBlur={() => {
                      onRenameTask(t.id, editingTitle)
                      setEditingTaskId(null)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        onRenameTask(t.id, editingTitle)
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
                    onDeleteTask(t.id)
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
          onClick={onTogglePermission}
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
          onClick={onOpenSettings}
          className={clsx(
            'w-full flex items-center justify-between gap-2 px-2.5 py-2 rounded-xl text-xs font-medium border transition-all cursor-pointer',
            hasApiKey
              ? 'bg-white border-zinc-200 text-zinc-800 hover:border-zinc-300'
              : 'bg-amber-50 border-amber-300 text-amber-900 hover:bg-amber-100'
          )}
        >
          <span className="flex items-center gap-1.5 truncate">
            <KeyRound className="w-3.5 h-3.5 text-blue-600 shrink-0" />
            <span className="truncate">{hasApiKey ? activeProfileLabel : '请配置模型'}</span>
          </span>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-100 text-zinc-500 shrink-0">
            设置
          </span>
        </button>
      </div>
    </aside>
  )
}
