import { basename } from 'node:path'

/** 100% 对齐原版 agent-runtime U1s 工具中文名称对照表 */
const TOOL_LABELS: Readonly<Record<string, string>> = {
  ls: '浏览目录',
  glob: '匹配文件',
  grep: '搜索内容',
  read_file: '读取文件',
  write_file: '生成/写入文件',
  edit_file: '编辑文件',
  execute: '执行命令',
  write_todos: '制定计划',
  generate_image: '生成图片',
  edit_image_with_ref: '图生图/参考改图',
  retrieve_regulation_chunks: '规范检索',
  search_inspiration: '灵感/素材搜索',
  web_search: '联网检索',
  ppt_workbench: 'PPT 工作台',
  deliver: '交付成品',
  ask_image_edit: '图片标注',
  ask_user: '需求澄清',
  remember: '标记项目记忆',
  project_profile: '项目档案',
  review_image: '审查效果图',
  task: '子任务',
  start_async_task: '启动后台子任务',
  check_async_task: '查询后台子任务',
  list_async_tasks: '列出后台子任务',
  cancel_async_task: '取消后台子任务'
}

export function splitMcpToolName(name: string): { server: string; tool: string } | null {
  const idx = name.indexOf('__')
  if (idx <= 0 || idx + 2 >= name.length) return null
  return { server: name.slice(0, idx), tool: name.slice(idx + 2) }
}

export function toolLabel(name: string): string {
  if (name === 'mcp_tools') return '检索连接器'
  if (name === 'tool_search') return '加载工具'
  const mcp = splitMcpToolName(name)
  if (mcp) return `${mcp.server}#执行 ${mcp.tool}`
  return TOOL_LABELS[name] ?? name
}

function strOf(val: unknown): string {
  return typeof val === 'string' ? val : ''
}

function singleLine(val: unknown): string {
  return strOf(val).replace(/\s+/g, ' ').trim()
}

function shortPathLabel(raw: string): string | undefined {
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  return basename(trimmed) || trimmed
}

export function toolDelta(name: string, args?: Record<string, unknown>): string | undefined {
  const a = args ?? {}
  if (name === 'mcp_tools') return '检索中'
  if (name === 'tool_search') return '加载中'
  if (splitMcpToolName(name)) return '执行中'

  switch (name) {
    case 'read_file':
    case 'write_file':
    case 'edit_file':
      return shortPathLabel(strOf(a.file_path ?? a.path))
    case 'ls':
      return shortPathLabel(strOf(a.path)) || '当前工作区'
    case 'glob':
      return singleLine(a.pattern) || undefined
    case 'grep':
      return singleLine(a.pattern ?? a.query) || undefined
    case 'generate_image':
    case 'edit_image_with_ref':
      return singleLine(a.image_name) || singleLine(a.prompt).slice(0, 30) || undefined
    case 'retrieve_regulation_chunks':
      return singleLine(a.query) || undefined
    case 'search_inspiration':
      return singleLine(a.query) || undefined
    case 'web_search':
      return singleLine(a.query) || undefined
    case 'ppt_workbench':
      return singleLine(a.action) + (a.slideId ? ` · ${singleLine(a.slideId)}` : '')
    case 'start_async_task':
      return singleLine(a.description) || undefined
    case 'check_async_task':
    case 'cancel_async_task':
      return singleLine(a.task_id) || undefined
    case 'execute':
      return singleLine(a.description) || singleLine(a.command) || undefined
    case 'deliver': {
      const items = Array.isArray(a.items) ? a.items : []
      return items.length > 0 ? `共 ${items.length} 项成品` : undefined
    }
    case 'write_todos': {
      const todos = Array.isArray(a.todos) ? a.todos : []
      return todos.length > 0 ? `${todos.length} 个步骤` : undefined
    }
    case 'task':
      return singleLine(a.description) || undefined
    default:
      return undefined
  }
}

export function approvalDelta(name: string, args?: Record<string, unknown>): string | undefined {
  if (name === 'execute') {
    return singleLine(args?.command) || undefined
  }
  return toolDelta(name, args)
}
