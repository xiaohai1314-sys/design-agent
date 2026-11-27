import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { BaseMessage, HumanMessage, SystemMessage } from '@langchain/core/messages'
import type { PersistedTurnItem } from '@shared/ipc'
import type { ModelProviderProfile } from '@shared/protocol'
import { createChatModel } from './modelFactory'
import { applyProfilePatch, emptyProfile, loadProjectProfile, saveProjectProfile } from './projectProfile'

/** 100% 对齐原版 s3r「下一步建议」生成器系统提示词 */
const NEXT_SUGGESTIONS_SYSTEM_PROMPT = `你是「下一步建议」生成器，服务于室内设计、建筑设计、景观设计师使用的 AI 设计智能体。
读完最近几轮对话，站在用户的视角，根据任务当前的完成状态，推测用户下一步可能要让智能体做什么，生成 0～3 条下一步建议。用户点击某条建议后，这句话会原样填进输入框，作为用户的下一轮提示词发给智能体。

视角：
- 你写的是「用户接下来要对智能体说的话」，不是智能体的总结或建议。

通用要求：
1. 写成用户可以直接发给智能体的指令，具体、可执行，紧扣最后一轮的结果（例如对交付物细化、调整、延展、换方案）。
2. 每条一句话、单行，不超过 30 个字（建模任务可放宽到 50 字）；按优先级排序，多条之间方向要有明显区分。
3. 只建议智能体能做的事（出图改图、建模、整理文档或 PPT、分析资料、CAD 读图等），不建议线下动作。
4. 不要重复最后一轮已经完成的事；不要问句；不要客套或评价（如「谢谢」「很好」）；不要用智能体口吻（如「我来」「让我」）。
5. 严格以 JSON 字符串数组输出，例如 ["生成一份给甲方汇报的PPT方案", "把客厅部分拆成三个备选布局对比"]。不要输出 Markdown 代码块或任何多余解释。`

function parseSuggestionsList(raw: string): string[] {
  const cleaned = raw.trim().replace(/^```json\s*/i, '').replace(/```$/i, '').trim()
  try {
    const arr = JSON.parse(cleaned) as unknown
    if (Array.isArray(arr)) {
      return arr
        .filter((x): x is string => typeof x === 'string' && x.trim().length > 1 && x.trim().length <= 80)
        .map((x) => x.trim())
        .slice(0, 3)
    }
  } catch {
    // fallback line split
  }
  return cleaned
    .split(/\r?\n/)
    .map((l) => l.replace(/^[-*•\d.)\s]+/, '').trim())
    .filter((l) => l.length >= 4 && l.length <= 60)
    .slice(0, 3)
}

function extractMessagePlainText(msg: BaseMessage): string {
  if (typeof msg.content === 'string') return msg.content
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((p) => (p && typeof p === 'object' && 'text' in p ? String((p as { text?: unknown }).text ?? '') : ''))
      .join(' ')
  }
  return ''
}

export async function generateNextSuggestions(params: {
  profile: ModelProviderProfile
  history: BaseMessage[]
  deliverables: string[]
}): Promise<string[]> {
  try {
    const recent = params.history.slice(-6)
    const digest = recent
      .map((m) => {
        const role = m instanceof HumanMessage ? '用户' : '智能体'
        const txt = extractMessagePlainText(m).slice(0, 600)
        return txt ? `${role}：${txt}` : ''
      })
      .filter(Boolean)
      .join('\n')

    if (!digest) return []

    const userBlock = [
      '最近对话摘录：',
      digest,
      params.deliverables.length > 0 ? `\n本轮交付成品：${params.deliverables.join('、')}` : ''
    ].join('\n')

    const model = createChatModel(params.profile, { thinking: false, isSubagent: true })
    const res = await Promise.race([
      model.invoke([
        new SystemMessage(NEXT_SUGGESTIONS_SYSTEM_PROMPT),
        new HumanMessage(userBlock)
      ]),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 12000))
    ])

    return parseSuggestionsList(extractMessagePlainText(res))
  } catch {
    return []
  }
}

const DISTILL_SYSTEM_PROMPT = `你是空间设计项目记忆蒸馏器（Distiller）。
阅读一段完整的项目对话记录，提取出对后续跨会话工作有长期价值的「硬约束、设计决策与项目参数」（例如：建筑用途、面积、风格偏好、已确认采用的方案、明确否决/禁用的元素、材料预算要求）。
不要记录一次性操作过程或无关寒暄。

请以如下 JSON 格式返回，不要附带任何其他文字：
{
  "confirmed": ["已确认决策1", "已确认决策2"],
  "rejected": ["明确否决或不采用的项1"]
}
如果没有提取到有价值的长期项目决策，返回 {"confirmed": [], "rejected": []}。`

export async function distillProjectMemory(params: {
  workspacesBase: string
  projectId: string
  conversationId: string
  transcriptPath: string
  modelProfile: ModelProviderProfile
}): Promise<boolean> {
  try {
    if (!existsSync(params.transcriptPath)) return false
    const raw = readFileSync(params.transcriptPath, 'utf8')
    const items = JSON.parse(raw) as PersistedTurnItem[]
    if (!Array.isArray(items) || items.length < 2) return false

    const projDir = join(params.workspacesBase, params.projectId)
    mkdirSync(projDir, { recursive: true })
    const registryPath = join(projDir, 'distill_registry.json')
    const memoryPath = join(projDir, 'memory.md')
    const decisionsPath = join(projDir, 'project_decisions.md')

    const hash = createHash('sha256').update(raw).digest('hex').slice(0, 16)
    let registry: Record<string, string> = {}
    if (existsSync(registryPath)) {
      try {
        registry = JSON.parse(readFileSync(registryPath, 'utf8')) as Record<string, string>
      } catch {
        registry = {}
      }
    }
    if (registry[params.conversationId] === hash) {
      return false
    }

    const transcriptDigest = items
      .slice(-12)
      .map((it) => {
        if (it.role === 'user') return `用户：${it.text.slice(0, 400)}`
        return `智能体：${it.content.slice(0, 500)}`
      })
      .join('\n')

    const model = createChatModel(params.modelProfile, { thinking: false, isSubagent: true })
    const res = await Promise.race([
      model.invoke([new SystemMessage(DISTILL_SYSTEM_PROMPT), new HumanMessage(transcriptDigest)]),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 15000))
    ])

    const txt = extractMessagePlainText(res)
      .trim()
      .replace(/^```json\s*/i, '')
      .replace(/```$/i, '')
      .trim()

    let parsed: { confirmed?: string[]; rejected?: string[] } = {}
    try {
      parsed = JSON.parse(txt) as { confirmed?: string[]; rejected?: string[] }
    } catch {
      return false
    }

    const confirmed = (parsed.confirmed ?? []).filter((x) => typeof x === 'string' && x.trim())
    const rejected = (parsed.rejected ?? []).filter((x) => typeof x === 'string' && x.trim())

    registry[params.conversationId] = hash
    writeFileSync(registryPath, JSON.stringify(registry, null, 2), 'utf8')

    if (confirmed.length === 0 && rejected.length === 0) return false

    // 同步写入结构化项目档案：已确认 → decisions，否决 → rejected
    try {
      const profilePath = join(projDir, 'project.json')
      const profile = loadProjectProfile(profilePath) ?? emptyProfile()
      saveProjectProfile(
        profilePath,
        applyProfilePatch(profile, {
          decisions: confirmed.map((text) => ({ text: text.trim(), source: `会话${params.conversationId.slice(0, 8)}` })),
          rejected
        })
      )
    } catch {
      // 档案写入失败不影响 project_decisions.md
    }

    const today = new Date().toISOString().slice(0, 10)
    const shortConv = params.conversationId.slice(0, 8)

    // 更新 project_decisions.md（对齐原版 @design-agent/agent-shared/src/memory.ts 结构）
    const existingDec = existsSync(decisionsPath) ? readFileSync(decisionsPath, 'utf8') : ''
    const existingLines = new Set(existingDec.split(/\r?\n/).map((l) => l.trim()))

    const newLines: string[] = []
    if (!existingDec) {
      newLines.push('# 项目关键决策记录（project_decisions.md）', '')
      newLines.push('## 已确认')
    }
    for (const c of confirmed) {
      const line = `- ${c.trim()} · 来源:会话${shortConv} · ${today}`
      if (!existingLines.has(line)) newLines.push(line)
    }
    if (rejected.length > 0) {
      if (!existingDec.includes('## 当前不默认采用')) {
        newLines.push('', '## 当前不默认采用')
      }
      for (const r of rejected) {
        const line = `- [不默认采用] ${r.trim()} · 来源:会话${shortConv} · ${today}`
        if (!existingLines.has(line)) newLines.push(line)
      }
    }

    if (newLines.length > 0) {
      writeFileSync(
        decisionsPath,
        existingDec ? `${existingDec.trimEnd()}\n${newLines.join('\n')}\n` : `${newLines.join('\n')}\n`,
        'utf8'
      )
    }

    // 确保 memory.md 索引存在（对齐 initialMemoryMd()）
    if (!existsSync(memoryPath)) {
      mkdirSync(dirname(memoryPath), { recursive: true })
      writeFileSync(
        memoryPath,
        [
          '# 项目记忆索引（memory.md）',
          '> 本文件只指向少量长期上下文文件；项目事实以原始文件为准，会话任务计划保留在 conversation 状态。',
          '',
          '## 🔖 索引',
          '- 当前项目决策（默认值与历史审计）：同目录 `project_decisions.md`',
          '- 蒸馏登记表：同目录 `distill_registry.json`',
          ''
        ].join('\n'),
        'utf8'
      )
    }

    return true
  } catch {
    return false
  }
}
