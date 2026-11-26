import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { appendFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import { capturePreEditSnapshot } from '@shared/fileSnapshots'
import { resolvePathWithinRoot, samePath } from '@shared/workspacePaths'
import type { TodoItem, WriteTodosToolData } from '@shared/protocol'

function resolveTarget(rootDir: string, inputPath?: string, allowedReadPaths: string[] = []): string {
  let cleaned = inputPath?.trim() ?? ''
  if (/^\/[a-zA-Z]:[\\/]/.test(cleaned)) cleaned = cleaned.slice(1)
  try {
    return resolvePathWithinRoot(rootDir, cleaned)
  } catch (error) {
    const candidate = cleaned ? (isAbsolute(cleaned) ? resolve(cleaned) : resolve(rootDir, cleaned)) : resolve(rootDir)
    if (
      allowedReadPaths.some((allowedPath) => samePath(allowedPath, candidate)) &&
      existsSync(candidate) &&
      statSync(candidate).isFile()
    ) {
      return candidate
    }
    throw error
  }
}

function globToRegExp(pattern: string): RegExp {
  const norm = pattern.replace(/\\/g, '/')
  let re = '^'
  let i = 0
  while (i < norm.length) {
    const c = norm[i]
    if (c === '*' && norm[i + 1] === '*') {
      if (norm[i + 2] === '/') {
        re += '(?:.*/)?'
        i += 3
      } else {
        re += '.*'
        i += 2
      }
    } else if (c === '*') {
      re += '[^/]*'
      i++
    } else if (c === '?') {
      re += '[^/]'
      i++
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += '\\' + c
      i++
    } else {
      re += c
      i++
    }
  }
  re += '$'
  return new RegExp(re, 'i')
}

function walkFiles(dir: string, maxFiles = 2000, acc: string[] = []): string[] {
  if (acc.length >= maxFiles) return acc
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return acc
  }
  for (const e of entries) {
    if (acc.length >= maxFiles) break
    if (e.name === 'node_modules' || e.name === '.git' || e.name === '__pycache__') continue
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      walkFiles(full, maxFiles, acc)
    } else if (e.isFile()) {
      acc.push(full)
    }
  }
  return acc
}

export interface ApprovalGate {
  (toolName: string, args: Record<string, unknown>, toolCallId: string): Promise<void>
}

export function createWorkspaceTools(params: {
  rootDir: string
  projectMemoryPath?: string
  extraEnvPaths?: string[]
  protectedPptPaths?: string[]
  allowedReadPaths?: string[]
  signal: AbortSignal
  requireApproval: ApprovalGate
  recordToolData: (toolCallId: string, data: unknown) => void
  onTodosChange: (todos: TodoItem[]) => void
}): DynamicStructuredTool[] {
  const { rootDir, signal, requireApproval, recordToolData, onTodosChange } = params
  const allowedReadPaths = params.allowedReadPaths ?? []

  const isProtectedPpt = (targetPath: string): boolean => {
    const lower = targetPath.replace(/\\/g, '/').toLowerCase()
    if (!lower.endsWith('.pptx')) return false
    return (params.protectedPptPaths ?? []).some(
      (p) => p.replace(/\\/g, '/').toLowerCase() === lower
    )
  }

  const isProtectedCharter = (targetPath: string): boolean =>
    resolve(targetPath).toLowerCase() === resolve(rootDir, 'ZNZMO.md').toLowerCase()

  const lsTool = new DynamicStructuredTool({
    name: 'ls',
    description: '浏览目录内容，列出子目录与文件（含大小）。',
    schema: z.object({
      path: z.string().optional().describe('目录路径（缺省为当前工作区根目录）')
    }),
    func: async ({ path }) => {
      const target = resolveTarget(rootDir, path)
      if (!existsSync(target)) return `目录不存在：${target}`
      const st = statSync(target)
      if (!st.isDirectory()) return `${target} 是文件（大小 ${st.size} 字节），请使用 read_file 读取。`
      const entries = readdirSync(target, { withFileTypes: true })
      if (entries.length === 0) return `目录为空：${target}`
      const visibleEntries = entries.filter((entry) => !entry.isSymbolicLink())
      const lines = visibleEntries.slice(0, 300).map((e) => {
        if (e.isDirectory()) return `[DIR]  ${e.name}/`
        try {
          const s = statSync(join(target, e.name))
          return `[FILE] ${e.name} (${s.size} bytes)`
        } catch {
          return `[FILE] ${e.name}`
        }
      })
      if (visibleEntries.length > 300) lines.push(`... 共 ${visibleEntries.length} 项，仅展示前 300 项`)
      return `目录 ${target.replace(/\\/g, '/')}：\n${lines.join('\n')}`
    }
  })

  const globTool = new DynamicStructuredTool({
    name: 'glob',
    description: '按通配符模式（如 **/*.dwg、**/*.py、*.md）在工作区匹配文件路径。',
    schema: z.object({
      pattern: z.string().describe('通配符模式，如 **/*.dwg 或 docs/*.md'),
      path: z.string().optional().describe('搜索起始目录（缺省为工作区根目录）')
    }),
    func: async ({ pattern, path }) => {
      const base = resolveTarget(rootDir, path)
      if (!existsSync(base)) return `起始目录不存在：${base}`
      const all = walkFiles(base, 3000)
      const regex = globToRegExp(pattern)
      const matched = all.filter((f) => {
        const rel = relative(base, f).replace(/\\/g, '/')
        return regex.test(rel) || regex.test(f.replace(/\\/g, '/'))
      })
      if (matched.length === 0) return `未匹配到符合 "${pattern}" 的文件。`
      return matched
        .slice(0, 200)
        .map((m) => m.replace(/\\/g, '/'))
        .join('\n')
    }
  })

  const grepTool = new DynamicStructuredTool({
    name: 'grep',
    description: '在目录或文件的文本内容中按关键词或正则表达式搜索匹配行。',
    schema: z.object({
      pattern: z.string().describe('要搜索的字符串或正则表达式'),
      path: z.string().optional().describe('要搜索的文件或目录路径（缺省为工作区根目录）')
    }),
    func: async ({ pattern, path }) => {
      const target = resolveTarget(rootDir, path, allowedReadPaths)
      if (!existsSync(target)) return `路径不存在：${target}`
      let re: RegExp
      try {
        re = new RegExp(pattern, 'i')
      } catch {
        re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      }
      const st = statSync(target)
      const files = st.isFile() ? [target] : walkFiles(target, 500)
      const hits: string[] = []
      const binaryExts = new Set(['.dwg', '.skp', '.3dm', '.max', '.png', '.jpg', '.jpeg', '.webp', '.pdf', '.pptx', '.docx', '.xlsx', '.zip', '.exe', '.dll', '.wasm'])

      for (const file of files) {
        if (hits.length >= 100) break
        if (binaryExts.has(extname(file).toLowerCase())) continue
        try {
          const fStat = statSync(file)
          if (fStat.size > 2 * 1024 * 1024) continue
          const content = readFileSync(file, 'utf8')
          const lines = content.split(/\r?\n/)
          for (let idx = 0; idx < lines.length; idx++) {
            if (re.test(lines[idx])) {
              hits.push(`${file.replace(/\\/g, '/')}:${idx + 1}: ${lines[idx].slice(0, 240)}`)
              if (hits.length >= 100) break
            }
          }
        } catch {
          // skip unreadable file
        }
      }
      return hits.length > 0 ? hits.join('\n') : `未找到匹配 "${pattern}" 的文本行。`
    }
  })

  const readFileTool = new DynamicStructuredTool({
    name: 'read_file',
    description:
      '读取本地文本文件（如 SKILL.md、Markdown、JSON、CSV、DXF 文本、代码脚本）或查看图片文件元信息。对于二进制 Office/PDF/CAD 文件，请先阅读对应 Skill 使用专用脚本提取内容。',
    schema: z.object({
      file_path: z.string().describe('要读取的文件路径（绝对路径或相对工作区路径）'),
      start_line: z.number().int().positive().optional().describe('起始行号（1开始，可选）'),
      end_line: z.number().int().positive().optional().describe('结束行号（包含，可选）')
    }),
    func: async ({ file_path, start_line, end_line }) => {
      const target = resolveTarget(rootDir, file_path, allowedReadPaths)
      if (!existsSync(target)) return `错误：文件不存在 -> ${target}`
      const st = statSync(target)
      if (st.isDirectory()) return `错误：${target} 是目录，请改用 ls 工具浏览。`

      const ext = extname(target).toLowerCase()
      if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'].includes(ext)) {
        const buf = readFileSync(target)
        const mime =
          ext === '.png'
            ? 'image/png'
            : ext === '.webp'
              ? 'image/webp'
              : ext === '.gif'
                ? 'image/gif'
                : 'image/jpeg'
        if (st.size <= 1.2 * 1024 * 1024) {
          // 返回多模态图片内容块，支持视觉大模型直接读图（如 cad.py render 产出的轻量预览图）
          return [
            {
              type: 'text',
              text: `已读取图片文件：${target.replace(/\\/g, '/')} (${st.size} bytes)`
            },
            {
              type: 'image_url',
              image_url: { url: `data:${mime};base64,${buf.toString('base64')}` }
            }
          ] as unknown as string
        }
        return `图片文件较大（${st.size} bytes），已跳过嵌入二进制图片流以免浪费上下文 Token，路径：${target.replace(/\\/g, '/')}`
      }

      if (['.dwg', '.skp', '.3dm', '.max', '.pptx', '.docx', '.xlsx', '.pdf'].includes(ext)) {
        return `文件 ${target.replace(/\\/g, '/')} 是二进制格式（${ext}，大小 ${st.size} bytes）。请先用 read_file 阅读对应的技能文档（cad / pptx / docx / xlsx / pdf SKILL.md），再通过 execute 运行解析脚本读取其结构化内容。`
      }

      const text = readFileSync(target, 'utf8')
      const lines = text.split(/\r?\n/)
      const start = Math.max(1, start_line ?? 1)
      const end = Math.min(lines.length, end_line ?? Math.min(lines.length, start + 239))
      const slice = lines
        .slice(start - 1, end)
        .map((line, idx) => `${start + idx}: ${line}`)
        .join('\n')

      const header = `文件 ${target.replace(/\\/g, '/')}（第 ${start}-${end} 行 / 共 ${lines.length} 行）：`
      return `${header}\n${slice}`
    }
  })

  const writeFileTool = new DynamicStructuredTool({
    name: 'write_file',
    description: '在工作区创建新文件或覆写已有文本文件（自动创建父目录）。',
    schema: z.object({
      file_path: z.string().describe('目标文件路径（相对工作区根或绝对路径）'),
      content: z.string().describe('要写入的完整文本内容')
    }),
    func: async ({ file_path, content }, runManager) => {
      const toolCallId = (runManager as unknown as { toolCallId?: string })?.toolCallId ?? `wf_${Date.now()}`
      const target = resolveTarget(rootDir, file_path)
      if (isProtectedCharter(target)) {
        throw new Error(
          'ZNZMO.md 为项目宪章配置文件（只读受保护），禁止自主改写；如需修改请由用户在工作区宪章面板编辑，或使用 remember 工具追加项目记忆。'
        )
      }
      if (isProtectedPpt(target)) {
        throw new Error(
          '该 PPT 交付物已在交互式 PPT 工作台打开，禁止使用 write_file 直接覆盖；请改用 ppt_workbench(action="suggest") 提交局改建议或 snapshot 获取副本。'
        )
      }
      await requireApproval('write_file', { file_path: target, content }, toolCallId)
      if (existsSync(target)) {
        capturePreEditSnapshot({
          targetPath: target,
          rootDir,
          sourceTool: 'write_file',
          summary: 'Agent 覆写文件前自动快照'
        })
      }
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, content, 'utf8')
      return `已写入文件：${target.replace(/\\/g, '/')}（${Buffer.byteLength(content, 'utf8')} 字节）`
    }
  })

  const editFileTool = new DynamicStructuredTool({
    name: 'edit_file',
    description: '精确替换已有文本文件中的指定片段（old_string 必须完全匹配文件中的原文）。',
    schema: z.object({
      file_path: z.string().describe('要编辑的文件路径'),
      old_string: z.string().min(1).describe('文件中待替换的精确原文片段'),
      new_string: z.string().describe('替换后的新内容')
    }),
    func: async ({ file_path, old_string, new_string }, runManager) => {
      const toolCallId = (runManager as unknown as { toolCallId?: string })?.toolCallId ?? `ef_${Date.now()}`
      const target = resolveTarget(rootDir, file_path)
      if (isProtectedCharter(target)) {
        throw new Error(
          'ZNZMO.md 为项目宪章配置文件（只读受保护），禁止自主改写；如需修改请由用户在工作区宪章面板编辑，或使用 remember 工具追加项目记忆。'
        )
      }
      if (isProtectedPpt(target)) {
        throw new Error(
          '该 PPT 交付物已在交互式 PPT 工作台打开，禁止使用 edit_file 直接修改；请改用 ppt_workbench(action="suggest") 提交局改建议。'
        )
      }
      if (!existsSync(target)) throw new Error(`文件不存在：${target}`)
      await requireApproval('edit_file', { file_path: target }, toolCallId)
      const current = readFileSync(target, 'utf8')
      if (!current.includes(old_string)) {
        throw new Error(`未在 ${target} 中找到完全匹配的 old_string，请先调用 read_file 核对原文与缩进。`)
      }
      const updated = current.replace(old_string, () => new_string)
      capturePreEditSnapshot({
        targetPath: target,
        rootDir,
        sourceTool: 'edit_file',
        summary: 'Agent 局部编辑前自动快照'
      })
      writeFileSync(target, updated, 'utf8')
      return `已成功编辑文件：${target.replace(/\\/g, '/')}`
    }
  })

  const executeTool = new DynamicStructuredTool({
    name: 'execute',
    description:
      '在工作区目录下执行本地命令或 Python / Node 脚本（例如运行 cad.py 解析图纸、运行 python-pptx / openpyxl 生成汇报文件、运行 ensure_sketchup.py 等）。',
    schema: z.object({
      command: z.string().min(1).describe('要执行的完整命令行'),
      description: z.string().optional().describe('简短中文说明该命令的用途（用于界面状态展示）'),
      timeout_ms: z.number().int().min(1000).max(300000).optional().describe('超时毫秒数（默认 120000）')
    }),
    func: async ({ command, description, timeout_ms }, runManager) => {
      const toolCallId = (runManager as unknown as { toolCallId?: string })?.toolCallId ?? `exec_${Date.now()}`
      await requireApproval('execute', { command, description }, toolCallId)

      mkdirSync(rootDir, { recursive: true })
      const timeout = timeout_ms ?? 120000
      const pathSep = process.platform === 'win32' ? ';' : ':'
      const mergedPath = [...(params.extraEnvPaths ?? []), process.env.PATH ?? ''].filter(Boolean).join(pathSep)

      return await new Promise<string>((resolvePromise, rejectPromise) => {
        const isWin = process.platform === 'win32'
        const shellCmd = isWin ? 'powershell.exe' : '/bin/sh'
        const shellArgs = isWin
          ? ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${command}`]
          : ['-c', command]

        const child = spawn(shellCmd, shellArgs, {
          cwd: rootDir,
          windowsHide: true,
          env: {
            ...process.env,
            PATH: mergedPath,
            PYTHONIOENCODING: 'utf-8',
            PYTHONUTF8: '1'
          }
        })

        let stdout = ''
        let stderr = ''
        const maxBuf = 64 * 1024

        child.stdout?.on('data', (chunk: Buffer) => {
          if (stdout.length < maxBuf) stdout += chunk.toString('utf8')
        })
        child.stderr?.on('data', (chunk: Buffer) => {
          if (stderr.length < maxBuf) stderr += chunk.toString('utf8')
        })

        const timer = setTimeout(() => {
          child.kill()
          resolvePromise(`命令执行超时（>${timeout}ms）已终止。\n已输出 stdout:\n${stdout}\nstderr:\n${stderr}`)
        }, timeout)

        const onAbort = (): void => {
          clearTimeout(timer)
          child.kill()
          rejectPromise(new Error('命令已被用户中止'))
        }
        signal.addEventListener('abort', onAbort, { once: true })

        child.on('error', (err) => {
          clearTimeout(timer)
          signal.removeEventListener('abort', onAbort)
          resolvePromise(`启动命令失败：${err.message}`)
        })

        child.on('close', (code) => {
          clearTimeout(timer)
          signal.removeEventListener('abort', onAbort)
          const combined = [
            `Exit code: ${code ?? 0}`,
            stdout.trim() ? `--- stdout ---\n${stdout.trim()}` : '',
            stderr.trim() ? `--- stderr ---\n${stderr.trim()}` : ''
          ]
            .filter(Boolean)
            .join('\n')
          resolvePromise(combined)
        })
      })
    }
  })

  const writeTodosTool = new DynamicStructuredTool({
    name: 'write_todos',
    description:
      '制定或更新当前复杂任务的步骤计划清单（供前端进度条展示与自我追踪）。每完成一步请立即将该步标为 completed、下一步标为 in_progress。',
    schema: z.object({
      todos: z
        .array(
          z.object({
            content: z.string().min(1).describe('简明中文步骤标题'),
            status: z.enum(['pending', 'in_progress', 'completed']).describe('步骤当前状态')
          })
        )
        .min(1)
        .max(15)
    }),
    func: async ({ todos }, runManager) => {
      const toolCallId = (runManager as unknown as { toolCallId?: string })?.toolCallId ?? `todo_${Date.now()}`
      onTodosChange(todos)
      const data: WriteTodosToolData = { kind: 'write_todos', todos }
      recordToolData(toolCallId, data)
      const done = todos.filter((t) => t.status === 'completed').length
      return `已更新任务计划（已完成 ${done}/${todos.length}）。`
    }
  })

  const rememberTool = new DynamicStructuredTool({
    name: 'remember',
    description: '将用户明确确认的项目长期约束、面积指标口径、风格偏好或关键设计决策追加记录到项目记忆（memory.md）。',
    schema: z.object({
      note: z.string().min(1).describe('要持久记住的精炼条目（一行或一小段事实/决策）')
    }),
    func: async ({ note }) => {
      const memFile = params.projectMemoryPath
        ? resolvePathWithinRoot(dirname(params.projectMemoryPath), params.projectMemoryPath)
        : resolvePathWithinRoot(rootDir, join(rootDir, '.zmo', 'memory.md'))
      mkdirSync(dirname(memFile), { recursive: true })
      const stamp = new Date().toISOString().slice(0, 10)
      await appendFile(memFile, `- [${stamp}] ${note.trim()}\n`, 'utf8')
      return `已写入项目记忆：${note.trim()}`
    }
  })

  return [
    lsTool,
    globTool,
    grepTool,
    readFileTool,
    writeFileTool,
    editFileTool,
    executeTool,
    writeTodosTool,
    rememberTool
  ]
}
