import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import type { RuntimeMcpServerSpec } from '@shared/protocol'
import type { ApprovalGate } from './workspaceTools'
import { resolveToolCallId } from './callId'

export interface ConnectedMcpBundle {
  tools: DynamicStructuredTool[]
  serverPrompts: string[]
  failedServers: RuntimeMcpServerSpec[]
  closeAll: () => Promise<void>
}

/**
 * 将 MCP JSON Schema 动态映射为宽松透传的 Zod Object，保留每个属性的描述供大模型准确传参
 */
function jsonSchemaToZodObject(inputSchema?: Record<string, unknown>): z.ZodObject<any> {
  const props = (inputSchema?.properties ?? {}) as Record<
    string,
    { type?: string; description?: string; enum?: string[] }
  >
  const required = new Set<string>(Array.isArray(inputSchema?.required) ? inputSchema.required : [])
  const shape: Record<string, z.ZodTypeAny> = {}

  for (const [key, spec] of Object.entries(props)) {
    let field: z.ZodTypeAny
    if (Array.isArray(spec?.enum) && spec.enum.length > 0) {
      field = z.string()
    } else {
      switch (spec?.type) {
        case 'number':
        case 'integer':
          field = z.number()
          break
        case 'boolean':
          field = z.boolean()
          break
        case 'array':
          field = z.array(z.any())
          break
        case 'object':
          field = z.record(z.any())
          break
        default:
          field = z.any()
      }
    }
    if (spec?.description) {
      field = field.describe(spec.description)
    }
    if (!required.has(key)) {
      field = field.optional()
    }
    shape[key] = field
  }

  return z.object(shape).passthrough()
}

// 名称看起来像密钥的环境变量不传给第三方 MCP 子进程（连接器自身需要的变量应写在 spec.env 里显式传入）
const SECRET_ENV_RE = /(API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY)/i

function buildCleanMcpEnv(extra?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v !== 'string' || k === 'NODE_OPTIONS') continue
    if (SECRET_ENV_RE.test(k)) continue
    out[k] = v
  }
  for (const [k, v] of Object.entries(extra ?? {})) {
    if (typeof v === 'string') out[k] = v
  }
  return out
}

export async function checkSingleMcpServer(
  spec: RuntimeMcpServerSpec
): Promise<{ ok: boolean; toolCount?: number; reason?: string }> {
  let transport: StdioClientTransport | null = null
  try {
    transport = new StdioClientTransport({
      command: spec.command,
      args: spec.args,
      env: buildCleanMcpEnv(spec.env),
      stderr: 'pipe'
    })
    const client = new Client({ name: 'design-agent-runtime', version: '1.0.0' })
    await Promise.race([
      client.connect(transport),
      new Promise((_, rej) => setTimeout(() => rej(new Error('MCP 握手连接超时 (10s)')), 10000))
    ])
    const listed = await client.listTools()
    await client.close().catch(() => {})
    return { ok: true, toolCount: listed.tools.length }
  } catch (err) {
    try {
      await transport?.close()
    } catch {
      // ignore
    }
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

/** 把 MCP 返回的图片落盘，只把路径交给模型，避免大段 base64 文本挤占上下文 */
function persistMcpImage(imageDir: string | undefined, data: string, mimeType?: string): string | null {
  if (!imageDir || !data) return null
  try {
    mkdirSync(imageDir, { recursive: true })
    const ext = mimeType?.includes('jpeg') || mimeType?.includes('jpg') ? 'jpg' : mimeType?.includes('webp') ? 'webp' : 'png'
    const filePath = join(imageDir, `mcp_${Date.now()}_${randomUUID().slice(0, 6)}.${ext}`)
    writeFileSync(filePath, Buffer.from(data, 'base64'))
    return filePath.replace(/\\/g, '/')
  } catch {
    return null
  }
}

type McpConnectResult =
  | { ok: true; spec: RuntimeMcpServerSpec; client: Client; tools: DynamicStructuredTool[]; prompt: string }
  | { ok: false; spec: RuntimeMcpServerSpec; reason: string }

export async function connectMcpServers(
  specs: RuntimeMcpServerSpec[],
  requireApproval: ApprovalGate,
  options: { imageDir?: string } = {}
): Promise<ConnectedMcpBundle> {
  const clients: Client[] = []
  const tools: DynamicStructuredTool[] = []
  const serverPrompts: string[] = []
  const failedLines: string[] = []
  const failedServers: RuntimeMcpServerSpec[] = []

  // 各连接器并行握手（原先串行，每个最长 12 秒）
  const connectOne = async (spec: RuntimeMcpServerSpec): Promise<McpConnectResult> => {
    let transport: StdioClientTransport | null = null
    let client: Client | null = null
    let timer: NodeJS.Timeout | undefined
    try {
      transport = new StdioClientTransport({
        command: spec.command,
        args: spec.args,
        env: buildCleanMcpEnv(spec.env),
        stderr: 'pipe'
      })
      client = new Client({ name: 'design-agent-runtime', version: '1.0.0' })
      await Promise.race([
        client.connect(transport),
        new Promise((_, rej) => {
          timer = setTimeout(() => rej(new Error('连接超时')), 12000)
        })
      ])
      clearTimeout(timer)
      const listed = await client.listTools()
      const connected = client
      const serverTools: DynamicStructuredTool[] = []

      for (const mcpTool of listed.tools) {
        // 严格采用原版命名规则：<server>__<tool>，例如 sketchup__eval_ruby / blender__execute_blender_code
        const fullToolName = `${spec.name}__${mcpTool.name}`
        const schema = jsonSchemaToZodObject(mcpTool.inputSchema as Record<string, unknown>)

        serverTools.push(
          new DynamicStructuredTool({
            name: fullToolName,
            description: `[${spec.label}] ${mcpTool.description ?? mcpTool.name}`,
            schema,
            func: async (args, runManager, config) => {
              const callId = resolveToolCallId(runManager, config)
              await requireApproval(fullToolName, args as Record<string, unknown>, callId)
              const result = await connected.callTool({
                name: mcpTool.name,
                arguments: args as Record<string, unknown>
              })
              const contentArr = Array.isArray(result.content) ? result.content : []
              const texts = contentArr
                .map((c: any) => {
                  if (c.type === 'text') return String(c.text ?? '')
                  if (c.type === 'image' && typeof c.data === 'string') {
                    const saved = persistMcpImage(options.imageDir, c.data, c.mimeType)
                    return saved
                      ? `[图片已保存：${saved}，需要查看时可用 read_file 读取]`
                      : '[返回了一张图片，但保存失败]'
                  }
                  return JSON.stringify(c)
                })
                .join('\n')
              if (result.isError) {
                throw new Error(texts || 'MCP 工具返回错误')
              }
              return texts || '执行成功'
            }
          })
        )
      }
      return {
        ok: true,
        spec,
        client: connected,
        tools: serverTools,
        prompt: `- **${spec.name}** (${spec.label})：${spec.description}（已就绪，共 ${listed.tools.length} 个工具）`
      }
    } catch (err) {
      clearTimeout(timer)
      // 握手失败时关闭连接，避免残留 MCP 子进程
      try {
        if (client) await client.close()
        else await transport?.close()
      } catch {
        // ignore
      }
      return { ok: false, spec, reason: err instanceof Error ? err.message : String(err) }
    }
  }

  const results = await Promise.all(specs.map((spec) => connectOne(spec)))

  for (const res of results) {
    if (res.ok) {
      clients.push(res.client)
      tools.push(...res.tools)
      serverPrompts.push(res.prompt)
      continue
    }
    const { spec, reason } = res
    const prevHost = spec.hostState
    const state =
      prevHost?.state === 'plugin-missing' || prevHost?.state === 'host-not-running'
        ? prevHost.state
        : 'handshake-failed'
    const attribution =
      state === 'plugin-missing'
        ? prevHost?.reason || `${spec.label} 宿主插件未安装或未启用`
        : state === 'host-not-running'
          ? prevHost?.reason || `${spec.label} 宿主软件未启动`
          : prevHost?.hostRunning
            ? `${spec.label} 进程运行中，但 MCP 端口握手失败/超时`
            : `${spec.label} MCP 握手失败（${reason}）`

    failedLines.push(`- ${spec.name} (${spec.label})：连接失败 [hostState=${state}] — ${attribution}（详情：${reason}）`)
    failedServers.push({
      ...spec,
      hostState: {
        state,
        hostRunning: prevHost?.hostRunning,
        pluginInstalled: prevHost?.pluginInstalled,
        reason: attribution
      }
    })
  }

  const promptSections: string[] = []
  if (serverPrompts.length > 0) {
    promptSections.push(`<mcp-servers>\n已启用的本机设计软件连接器：\n${serverPrompts.join('\n')}\n</mcp-servers>`)
  }
  if (failedLines.length > 0) {
    promptSections.push(`<mcp-status>\n本轮未能启动的连接器：\n${failedLines.join('\n')}\n</mcp-status>`)
  }

  return {
    tools,
    serverPrompts: promptSections,
    failedServers,
    closeAll: async () => {
      await Promise.allSettled(clients.map((c) => c.close()))
    }
  }
}

/**
 * 对齐原版 DeferredToolFilter + mcp_tools / tool_search：
 * 当同时开启多个三维软件导致 MCP 工具 > 15 个时，只暴露检索/按需加载工具，避免撑爆主模型上下文。
 */
export function createDeferredMcpTools(
  mcpTools: DynamicStructuredTool[],
  activeToolsRef: DynamicStructuredTool[]
): { initialTools: DynamicStructuredTool[]; summaryHint: string } {
  if (mcpTools.length <= 15) {
    return { initialTools: mcpTools, summaryHint: '' }
  }

  const toolMap = new Map(mcpTools.map((t) => [t.name, t]))

  const listMcpTools = new DynamicStructuredTool({
    name: 'mcp_tools',
    description:
      '按连接器名或关键词检索当前已连接的本地软件 MCP 工具列表（返回 tool_name 与简短功能说明）。如需实际调用某工具，请再用 tool_search 将其加载激活。',
    schema: z.object({
      query: z.string().optional().describe('关键词或软件前缀，如 sketchup、blender、wall、render；留空列出概览')
    }),
    func: async ({ query }) => {
      const q = (query ?? '').trim().toLowerCase()
      const matched = mcpTools.filter((t) => {
        if (!q) return true
        return t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q)
      })
      const items = matched.slice(0, 30).map((t) => ({
        name: t.name,
        description: t.description.slice(0, 120)
      }))
      return JSON.stringify({ totalMatched: matched.length, tools: items }, null, 2)
    }
  })

  const loadMcpTool = new DynamicStructuredTool({
    name: 'tool_search',
    description:
      '按名称按需加载激活指定的 MCP 工具（支持一次加载 1~8 个），加载完成后下一轮即可直接调用这些工具。',
    schema: z.object({
      names: z.array(z.string().min(1)).min(1).max(8).describe('要加载激活的完整 MCP 工具名列表')
    }),
    func: async ({ names }) => {
      const loaded: string[] = []
      const missing: string[] = []
      for (const n of names) {
        const target = toolMap.get(n)
        if (!target) {
          missing.push(n)
          continue
        }
        if (!activeToolsRef.some((existing) => existing.name === n)) {
          activeToolsRef.push(target)
        }
        loaded.push(n)
      }
      return JSON.stringify({ loaded, missing }, null, 2)
    }
  })

  return {
    initialTools: [listMcpTools, loadMcpTool],
    summaryHint: `\n（注：当前已连接 ${mcpTools.length} 个 MCP 软件工具，已启用按需延迟加载；请先调用 mcp_tools 检索并用 tool_search 激活需要使用的工具名。）`
  }
}
