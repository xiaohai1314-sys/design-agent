import { LayoutGrid, Maximize2, Minimize2, Plus, Search, Settings, X } from 'lucide-react'
import clsx from 'clsx'

export interface WindowTitleBarTab {
  id: string
  title: string
  running: boolean
  active: boolean
}

export interface WindowTitleBarProps {
  toolboxActive: boolean
  onToggleToolbox: () => void
  tabs: WindowTitleBarTab[]
  onSelectTask: (id: string) => void
  onCloseTab: (id: string) => void
  onCreateTask: () => void
  onFocusSearch: () => void
  onOpenSettings: () => void
  isMaximized: boolean
}

/** 顶部无边框自定义窗口栏 + 多标签页条（保留 flex-1 空白拖拽热区，Windows 无边框才拖得动） */
export function WindowTitleBar({
  toolboxActive,
  onToggleToolbox,
  tabs,
  onSelectTask,
  onCloseTab,
  onCreateTask,
  onFocusSearch,
  onOpenSettings,
  isMaximized
}: WindowTitleBarProps): React.JSX.Element {
  return (
    <div className="h-9 shrink-0 bg-[#eceef2] border-b border-zinc-200/90 flex items-center px-2 select-none app-drag-region">
      <div className="flex items-center gap-1 min-w-0 max-w-[calc(100%-250px)] overflow-x-auto">
        <div className="w-6 h-6 rounded-md bg-zinc-900 text-white flex items-center justify-center text-[11px] font-bold shrink-0 mr-1">
          Z
        </div>

        <button
          type="button"
          onClick={onToggleToolbox}
          className={clsx(
            'app-no-drag inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium shrink-0 cursor-pointer transition-colors',
            toolboxActive ? 'bg-white text-blue-700 shadow-2xs' : 'text-zinc-600 hover:bg-zinc-200/70'
          )}
        >
          <LayoutGrid className="w-3 h-3" />
          <span>工具箱</span>
        </button>

        <div className="h-3.5 w-[1px] bg-zinc-300 mx-0.5 shrink-0" />

        {tabs.map((tab) => (
          <div
            key={tab.id}
            onClick={() => onSelectTask(tab.id)}
            className={clsx(
              'app-no-drag group flex items-center gap-1.5 pl-2.5 pr-1.5 py-1 rounded-md text-[11px] max-w-44 cursor-pointer transition-colors shrink-0',
              tab.active
                ? 'bg-white text-zinc-900 font-medium shadow-2xs'
                : 'text-zinc-600 hover:bg-zinc-200/60'
            )}
          >
            {tab.running && (
              <span className="w-1.5 h-1.5 rounded-full bg-blue-600 animate-ping shrink-0" />
            )}
            <span className="truncate">{tab.title}</span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onCloseTab(tab.id)
              }}
              title="关闭标签页"
              className="p-0.5 rounded text-zinc-400 hover:text-zinc-900 hover:bg-zinc-100 cursor-pointer opacity-70 group-hover:opacity-100"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        ))}

        <button
          type="button"
          onClick={onCreateTask}
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
          onClick={onFocusSearch}
          title="搜索任务"
          className="p-1.5 rounded-md text-zinc-600 hover:bg-zinc-200/70 cursor-pointer"
        >
          <Search className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onClick={onOpenSettings}
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
  )
}
