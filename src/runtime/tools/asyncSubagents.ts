import { randomUUID } from 'node:crypto'
import { HumanMessage, type BaseMessage } from '@langchain/core/messages'
import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import type { ModelProviderProfile } from '@shared/protocol'
import { createChatModel } from '../modelFactory'
// 仅类型引用：编译后擦除，运行期不会形成 index → asyncSubagents 的循环依赖
import type { runAgentLoop } from '../index'

export interface AsyncSubagentRecord {
  taskId: string
  description: string
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  controller: AbortController
  output: string
  error?: string
  toolLogs: string[]
  startedAt: number
  finishedAt?: number
}

export type SubagentRole = 'general' | 'research' | 'cad-analyzer' | 'modeler'

export interface UsageDelta {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  totalTokens: number
}

const ROLE_TOOL_ALLOWLISTS: Record<Exclude<SubagentRole, 'general'>, Set<string>> = {
  // 工具名必须与实际注册名一致（规范检索为 retrieve_regulation_chunks）
  research: new Set(['ls', 'glob', 'grep', 'read_file', 'retrieve_regulation_chunks', 'search_inspiration', 'web_search']),
  'cad-analyzer': new Set(['ls', 'glob', 'grep', 'read_file', 'execute', 'retrieve_regulation_chunks', 'web_search']),
  modeler: new Set(['ls', 'glob', 'grep', 'read_file', 'write_file', 'edit_file', 'execute'])
}

const ROLE_INSTRUCTIONS: Record<SubagentRole, string> = {
  research: '【角色：只读调研专家】仅可检索工作区文档、查阅建筑规范与联网资料，严禁修改文件或操作外部建模软件。',
  'cad-analyzer': '【角色：CAD/文档解析专员】专责解析 CAD/PDF/Office 文件（含运行解析脚本），不得改动业务源码或交付稿。',
  modeler: '【角色：三维建模专员】专责驱动已连接的本地软件 MCP 工具与脚本编写，完成后简明汇报产物与坐标信息。',
  general: '【角色：综合专项子智能体】可根据任务自由调用已挂载的文件、规范检索、联网或 MCP 建模工具。'
}

/**
 * 按子智能体职责角色裁剪工具白名单，避免长任务误调用无关写入或建模工具。
 */
export function selectToolsForSubagentRole(
  role: SubagentRole | undefined,
  allSubTools: DynamicStructuredTool[]
): { tools: DynamicStructuredTool[]; roleInstruction: string } {
  const effectiveRole: SubagentRole = role ?? 'general'
  if (effectiveRole === 'general') {
    return { tools: allSubTools, roleInstruction: ROLE_INSTRUCTIONS.general }
  }
  const allow = ROLE_TOOL_ALLOWLISTS[effectiveRole]
  const filtered = allSubTools.filter((t) => {
    if (allow.has(t.name)) return true
    if (effectiveRole === 'modeler' && (t.name.includes('__') || t.name === 'mcp_tools' || t.name === 'tool_search')) {
      return true
    }
    return false
  })
  return { tools: filtered, roleInstruction: ROLE_INSTRUCTIONS[effectiveRole] }
}

/** 直接用 runAgentLoop 的真实签名，避免手写副本随主循环演进悄悄失真 */
export type AsyncLoopRunner = (
  params: Parameters<typeof runAgentLoop>[0]
) => Promise<{ completedNaturally: boolean }>

export function createAsyncSubagentTools(params: {
  rootDir: string
  skillsRoot: string
  modelProfile: ModelProviderProfile
  parentSignal: AbortSignal
  subTools: DynamicStructuredTool[]
  runLoop: AsyncLoopRunner
  onUsage?: (delta: UsageDelta) => void
}): { tools: DynamicStructuredTool[]; cancelAll: () => void } {
  const jobs = new Map<string, AsyncSubagentRecord>()

  const cancelAll = (): void => {
    for (const job of jobs.values()) {
      if (job.status === 'running') {
        job.status = 'cancelled'
        job.controller.abort()
      }
    }
  }

  const startAsyncTask = new DynamicStructuredTool({
    name: 'start_async_task',
    description:
      '在本轮对话内启动一个后台子智能体并行执行耗时的专项研究或批处理，立即返回 task_id，可用 check_async_task 查询进度与结果。注意：后台任务只在当前这一轮有效，本轮回复结束时会被自动取消，下一轮无法再查询；需要它的结论时，请在结束本轮回复之前用 check_async_task 取回。',
    schema: z.object({
      description: z.string().min(1).describe('简短后台任务标题'),
      prompt: z.string().min(1).describe('完整的后台子任务指令'),
      role: z
        .enum(['general', 'research', 'cad-analyzer', 'modeler'])
        .optional()
        .describe('职责角色（裁剪可用工具子集）：research=只读查资料/规范；cad-analyzer=解析图纸与脚本只读；modeler=三维MCP建模；general=全工具')
    }),
    func: async ({ description, prompt, role }) => {
      const taskId = `async_${randomUUID().slice(0, 8)}`
      const controller = new AbortController()
      const onParentAbort = (): void => controller.abort()
      params.parentSignal.addEventListener('abort', onParentAbort, { once: true })

      const rec: AsyncSubagentRecord = {
        taskId,
        description,
        status: 'running',
        controller,
        output: '',
        toolLogs: [],
        startedAt: Date.now()
      }
      jobs.set(taskId, rec)

      const { tools: scopedTools, roleInstruction } = selectToolsForSubagentRole(role, params.subTools)
      const subModel = createChatModel(params.modelProfile, { thinking: false, isSubagent: true })
      const subHistory: BaseMessage[] = [new HumanMessage(prompt)]
      const sys = `你是后台异步执行子智能体（工作目录：${params.rootDir.replace(/\\/g, '/')}，技能目录：${params.skillsRoot.replace(/\\/g, '/')}）。${roleInstruction} 请独立完成调查并产出清晰结论。`

      void params
        .runLoop({
          model: subModel,
          systemPrompt: sys,
          history: subHistory,
          tools: scopedTools,
          signal: controller.signal,
          maxIterations: 15,
          offloadRootDir: params.rootDir,
          // 传入 profile，工具结果里的图片才会按接口能力降级或转交，否则 OpenAI 兼容接口会直接 400；
          // model 要用子智能体实际跑的模型，否则视觉判定会拿主模型的名字去判断
          profile: {
            ...params.modelProfile,
            model: params.modelProfile.subagentModel?.trim() || params.modelProfile.model
          },
          enableAnthropicCache:
            params.modelProfile.protocol === 'anthropic' &&
            params.modelProfile.enablePromptCache !== false,
          onUsage: params.onUsage,
          onToken: (d) => {
            rec.output += d
          },
          onReasoning: () => {},
          onToolStart: (_id, name) => {
            rec.toolLogs.push(`调用 ${name}`)
          },
          onToolEnd: (_id, name, ok) => {
            rec.toolLogs.push(`${name}: ${ok ? '成功' : '失败'}`)
          },
          takeRecordedToolData: () => null
        })
        .then(() => {
          if (rec.status === 'running') {
            rec.status = 'completed'
            rec.finishedAt = Date.now()
          }
        })
        .catch((err: unknown) => {
          if (rec.status === 'running') {
            rec.status = controller.signal.aborted ? 'cancelled' : 'failed'
            rec.error = err instanceof Error ? err.message : String(err)
            rec.finishedAt = Date.now()
          }
        })
        .finally(() => {
          params.parentSignal.removeEventListener('abort', onParentAbort)
        })

      return JSON.stringify({ task_id: taskId, status: 'running', description })
    }
  })

  const checkAsyncTask = new DynamicStructuredTool({
    name: 'check_async_task',
    description: '查询本轮内启动的后台子任务的当前状态、已执行步骤及最终结论（上一轮启动的任务已被取消，无法查询）。',
    schema: z.object({
      task_id: z.string().min(1)
    }),
    func: async ({ task_id }) => {
      const rec = jobs.get(task_id)
      if (!rec) return `未找到后台任务：${task_id}`
      return JSON.stringify(
        {
          task_id: rec.taskId,
          description: rec.description,
          status: rec.status,
          recentTools: rec.toolLogs.slice(-8),
          output: rec.output || undefined,
          error: rec.error
        },
        null,
        2
      )
    }
  })

  const listAsyncTasks = new DynamicStructuredTool({
    name: 'list_async_tasks',
    description: '列出本轮内启动的所有后台子任务及其状态。',
    schema: z.object({}),
    func: async () => {
      const items = [...jobs.values()].map((j) => ({
        task_id: j.taskId,
        description: j.description,
        status: j.status
      }))
      return JSON.stringify(items, null, 2)
    }
  })

  const cancelAsyncTask = new DynamicStructuredTool({
    name: 'cancel_async_task',
    description: '终止正在运行的后台异步子任务。',
    schema: z.object({
      task_id: z.string().min(1)
    }),
    func: async ({ task_id }) => {
      const rec = jobs.get(task_id)
      if (!rec) return `未找到后台任务：${task_id}`
      if (rec.status === 'running') {
        rec.status = 'cancelled'
        rec.controller.abort()
        rec.finishedAt = Date.now()
      }
      return `已取消后台任务 ${task_id}。`
    }
  })

  return {
    tools: [startAsyncTask, checkAsyncTask, listAsyncTasks, cancelAsyncTask],
    cancelAll
  }
}
