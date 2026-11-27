import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import { resolveToolCallId } from './callId'
import type { RegulationChunk, RegulationToolData } from '@shared/protocol'

function findRegIndexerExe(pythonExe: string): string | null {
  const candidates = [
    process.env.DESIGN_AGENT_RT_DIR ? join(process.env.DESIGN_AGENT_RT_DIR, 'reg-indexer.exe') : '',
    process.env.DESIGN_AGENT_SKILLS_ROOT ? join(dirname(process.env.DESIGN_AGENT_SKILLS_ROOT), 'runtime', 'reg-indexer.exe') : '',
    pythonExe && pythonExe !== 'python' ? join(dirname(dirname(pythonExe)), 'reg-indexer.exe') : '',
    join(process.cwd(), 'resources', 'runtime', 'reg-indexer.exe'),
    join(process.cwd(), 'tools', 'RegIndexerCs', 'publish', 'reg-indexer.exe')
  ].filter(Boolean)
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return null
}

// R15：改为异步子进程，检索期间不再冻结整个 runtime（其他会话的流式输出、停止按钮照常工作）
const execFileAsync = promisify(execFile)

interface NativeRegQueryResult {
  indexedDocs: number
  indexedPages: number
  totalHits: number
  queryMs: number
  chunks: RegulationChunk[]
}

async function queryWithNativeIndexer(params: {
  signal?: AbortSignal
  exePath: string
  folder: string
  pythonExe: string
  query: string
  standard?: string
  currentOnly?: boolean
  mandatoryOnly?: boolean
}): Promise<NativeRegQueryResult | null> {
  try {
    const dbPath = join(params.folder, '.design-agent-reg-index.db')
    const args = [
      'query',
      '--folder',
      params.folder,
      '--db',
      dbPath,
      '--python',
      params.pythonExe,
      '--q',
      params.query,
      '--limit',
      '8'
    ]
    if (params.standard?.trim()) {
      args.push('--standard', params.standard.trim())
    }
    if (params.currentOnly) {
      args.push('--current-only')
    }
    if (params.mandatoryOnly) {
      args.push('--mandatory-only')
    }
    const { stdout: raw } = await execFileAsync(params.exePath, args, {
      timeout: 60000,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 12 * 1024 * 1024,
      signal: params.signal
    })
    const parsed = JSON.parse(raw) as NativeRegQueryResult
    if (parsed && Array.isArray(parsed.chunks)) {
      return parsed
    }
    return null
  } catch {
    return null
  }
}

function collectRegulationFiles(root: string, acc: string[] = []): string[] {
  if (!root || !existsSync(root)) return acc
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const full = join(root, entry.name)
      if (entry.isDirectory()) {
        collectRegulationFiles(full, acc)
      } else if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase()
        if (['.json', '.md', '.txt', '.pdf'].includes(ext)) acc.push(full)
      }
    }
  } catch {
    // ignore
  }
  return acc
}

function tokenizeQuery(query: string): string[] {
  const cleaned = query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\-./]/gu, ' ')
    .trim()
  const words = cleaned.split(/\s+/).filter(Boolean)
  const grams = new Set<string>(words)
  // 对中文短语补切 2-gram 与 3-gram 提高模糊召回率
  for (const w of words) {
    if (/[\u4e00-\u9fff]/.test(w) && w.length >= 2) {
      for (let i = 0; i <= w.length - 2; i++) grams.add(w.slice(i, i + 2))
      if (w.length >= 3) {
        for (let i = 0; i <= w.length - 3; i++) grams.add(w.slice(i, i + 3))
      }
    }
  }
  return [...grams]
}

function scoreText(haystack: string, tokens: string[], rawQuery: string): number {
  const lower = haystack.toLowerCase()
  let score = 0
  if (lower.includes(rawQuery.toLowerCase())) score += 20
  for (const t of tokens) {
    if (lower.includes(t)) {
      score += t.length >= 3 ? 3 : 1
    }
  }
  return score
}

async function tryExtractPdfText(pdfPath: string, pythonExe: string, signal?: AbortSignal): Promise<string | null> {
  const pyCode = `
import sys
p = sys.argv[1]
txt = ""
try:
    import fitz
    doc = fitz.open(p)
    txt = "\\n".join(page.get_text() for page in doc[:120])
except Exception:
    try:
        from pypdf import PdfReader
        r = PdfReader(p)
        txt = "\\n".join((pg.extract_text() or "") for pg in r.pages[:120])
    except Exception:
        txt = ""
print(txt)
`
  try {
    const { stdout: out } = await execFileAsync(pythonExe, ['-c', pyCode, pdfPath], {
      timeout: 15000,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      signal
    })
    return out.trim() || null
  } catch {
    return null
  }
}

async function loadChunksFromFile(filePath: string, pythonExe: string, signal?: AbortSignal): Promise<RegulationChunk[]> {
  const ext = extname(filePath).toLowerCase()
  const baseName = filePath.split(/[\\/]/).pop() ?? '规范文档'

  if (ext === '.json') {
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as {
        citations?: Array<Record<string, unknown>>
        chunks?: Array<Record<string, unknown>>
      }
      const list = Array.isArray(parsed)
        ? (parsed as Array<Record<string, unknown>>)
        : parsed.citations ?? parsed.chunks ?? []
      return list
        .filter((item) => item && typeof item.text === 'string')
        .map((item) => ({
          cite: String(item.cite ?? `${baseName}#${item.clauseId ?? ''}`),
          standardName: String(item.standardName ?? item.guifanName ?? baseName),
          standardNo: String(item.standardNo ?? ''),
          clauseId: String(item.clauseId ?? ''),
          text: String(item.text ?? ''),
          explanation: typeof item.explanation === 'string' ? item.explanation : undefined,
          validityStatus: String(item.validityStatus ?? '现行'),
          isMandatory: Boolean(item.isMandatory),
          sourceFile: filePath
        }))
    } catch {
      return []
    }
  }

  let rawText = ''
  if (ext === '.md' || ext === '.txt') {
    try {
      rawText = readFileSync(filePath, 'utf8')
    } catch {
      return []
    }
  } else if (ext === '.pdf') {
    rawText = (await tryExtractPdfText(filePath, pythonExe, signal)) ?? ''
  }

  if (!rawText) return []

  // 按空行或条文号切分成 300~800 字检索段落
  const paragraphs = rawText
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 20)

  const stdMatch = /([A-Z]{1,4}\s*\/?[A-Z]?\s*\d{4,6}(?:[-—]\d{4})?)/.exec(baseName)
  const standardNo = stdMatch ? stdMatch[1] : baseName.replace(/\.[^.]+$/, '')

  return paragraphs.map((p, idx) => {
    const clauseMatch = /^第?\s*(\d+\.\d+(?:\.\d+)?)\s*[条款]?/.exec(p)
    const clauseId = clauseMatch ? clauseMatch[1] : `P${idx + 1}`
    return {
      cite: `${standardNo}-${clauseId}`,
      standardName: baseName.replace(/\.[^.]+$/, ''),
      standardNo,
      clauseId,
      text: p.slice(0, 1500),
      validityStatus: '本地规范库',
      isMandatory: /必须|严禁|不得|不应/.test(p),
      sourceFile: filePath
    }
  })
}

/** 证据登记时回报的条文信息：只保留能核验身份和效力的字段，正文不回传 */
interface RetrievedClause {
  cite: string
  standardName: string
  standardNo: string
  clauseId: string
  validityStatus: string
  isMandatory: boolean
  supersededBy?: string
}

/** 子问缺证时的原因（闭集，避免模型用「资料不足」这种含糊说法糊过去） */
const GAP_REASONS = [
  'no_evidence',
  'asset_unavailable',
  'region_unconfirmed',
  'project_input_missing',
  'filter_unavailable',
  'timeout',
  'tool_error'
] as const

export function createLocalRegulationTools(params: {
  regulationFolder?: string
  pythonExe: string
  recordToolData: (toolCallId: string, data: RegulationToolData) => void
}): DynamicStructuredTool[] {
  /** 本轮检索到过的条文（按 cite）：证据登记只认这里面的条，挡住「引用没查过的条文」 */
  const retrieved = new Map<string, RetrievedClause>()
  /** 本轮提交次数：第一次有问题回 review_evidence，第二次起放行并带 warnings —— 只给一轮补证 */
  let submissions = 0
  /** 本轮检索次数：区分「没检索」和「检索了但没查到」，后者可以直接空数组登记 */
  let searches = 0

  const remember = (chunks: ReadonlyArray<RegulationChunk>): void => {
    for (const c of chunks) {
      if (!c.cite) continue
      retrieved.set(c.cite, {
        cite: c.cite,
        standardName: c.standardName,
        standardNo: c.standardNo,
        clauseId: c.clauseId,
        validityStatus: c.validityStatus,
        isMandatory: Boolean(c.isMandatory),
        ...(c.supersededBy ? { supersededBy: c.supersededBy } : {})
      })
    }
  }

  const retrieveTool = new DynamicStructuredTool({
    name: 'retrieve_regulation_chunks',
    description:
      '本地建筑规范知识库检索：检索本地规范库目录中存放的国标/行标/地标条文（JSON、Markdown、TXT 或 PDF），返回可核验的规范名称、编号、条号、正文及效力状态。查询规范限值或合规依据前必须先阅读 regulation-consultation 技能再调用本工具。',
    schema: z.object({
      query: z.string().min(1).describe('检索查询语句（建议包含建筑用途、空间对象与具体指标，如“无障碍厕所 轮椅回转空间 扶手”）'),
      standard: z.string().optional().describe('限定规范编号或名称关键词（仅当用户点名规范时填写）'),
      current_only: z.boolean().optional().describe('是否只返回现行有效条文'),
      mandatory_only: z.boolean().optional().describe('是否仅过滤强制性/含强约束关键词条文')
    }),
    func: async ({ query, standard, current_only, mandatory_only }, runManager, config) => {
      searches += 1
      const callId =
        resolveToolCallId(runManager, config)
      const signal = (config as { signal?: AbortSignal } | undefined)?.signal

      const folder = params.regulationFolder?.trim()
      if (!folder || !existsSync(folder)) {
        return '本地规范库目录尚未配置或为空。可在「设置 → 本地规范库目录」指定存放国标/地标 PDF 或 Markdown 文档的文件夹。'
      }

      // 优先使用内置 C# + SQLite FTS5 持久化规范搜索引擎（一次抽文本落库，毫秒级命中+单位等价+效力分级+页码定位）
      const nativeExe = findRegIndexerExe(params.pythonExe)
      if (nativeExe) {
        const nativeRes = await queryWithNativeIndexer({
          signal,
          exePath: nativeExe,
          folder,
          pythonExe: params.pythonExe,
          query,
          standard,
          currentOnly: current_only,
          mandatoryOnly: mandatory_only
        })
        if (nativeRes && nativeRes.indexedDocs > 0) {
          params.recordToolData(callId, {
            kind: 'regulation_chunks',
            queriesUsed: [query],
            total: nativeRes.chunks.length,
            retrievedChunks: nativeRes.chunks
          })
          if (nativeRes.chunks.length === 0) {
            return `在本地规范持久化索引库（共 ${nativeRes.indexedDocs} 份规范 / ${nativeRes.indexedPages} 页，耗时 ${nativeRes.queryMs.toFixed(1)}ms）中未检索到与“${query}”直接匹配的条文。请补充本地规范或调整检索词。`
          }
          remember(nativeRes.chunks)
          return JSON.stringify(
            {
              engine: 'sqlite-fts5',
              sourceFolder: folder,
              indexedDocs: nativeRes.indexedDocs,
              indexedPages: nativeRes.indexedPages,
              queryMs: Number(nativeRes.queryMs.toFixed(2)),
              total: nativeRes.chunks.length,
              chunks: nativeRes.chunks.map((c) => ({
                cite: c.cite,
                standardName: c.standardName,
                standardNo: c.standardNo,
                clauseId: c.clauseId,
                ...(typeof c.pageNo === 'number' ? { pageNo: c.pageNo } : {}),
                validityStatus: c.validityStatus,
                ...(c.supersededBy ? { supersededBy: c.supersededBy } : {}),
                ...(c.warningText ? { warningText: c.warningText } : {}),
                isMandatory: Boolean(c.isMandatory),
                text: c.text,
                ...(c.explanation ? { explanation: c.explanation } : {})
              }))
            },
            null,
            2
          )
        }
      }

      const files = collectRegulationFiles(folder)
      if (files.length === 0) {
        return `本地规范库目录（${folder}）内暂无可检索的 .json/.md/.txt/.pdf 规范文件。`
      }

      const allChunks: RegulationChunk[] = []
      for (const f of files) {
        allChunks.push(...(await loadChunksFromFile(f, params.pythonExe, signal)))
      }

      const tokens = tokenizeQuery(query)
      const scored = allChunks
        .filter((c) => {
          if (standard && !`${c.standardName} ${c.standardNo} ${c.cite}`.toLowerCase().includes(standard.toLowerCase())) {
            return false
          }
          if (current_only && c.validityStatus.includes('废止')) return false
          if (mandatory_only && !c.isMandatory) return false
          return true
        })
        .map((chunk) => ({
          chunk,
          score: scoreText(
            `${chunk.standardName} ${chunk.standardNo} ${chunk.clauseId} ${chunk.text} ${chunk.explanation ?? ''}`,
            tokens,
            query
          )
        }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 8)
        .map((x) => x.chunk)

      params.recordToolData(callId, {
        kind: 'regulation_chunks',
        queriesUsed: [query],
        total: scored.length,
        retrievedChunks: scored
      })

      if (scored.length === 0) {
        return `在本地规范库（${files.length} 份文件）中未检索到与“${query}”直接匹配的条文。请补充更完整的本地规范文档，或尝试调整检索词。`
      }

      remember(scored)
      return JSON.stringify(
        {
          sourceFolder: folder,
          total: scored.length,
          chunks: scored.map((c) => ({
            cite: c.cite,
            standardName: c.standardName,
            standardNo: c.standardNo,
            clauseId: c.clauseId,
            validityStatus: c.validityStatus,
            isMandatory: c.isMandatory,
            text: c.text,
            ...(c.explanation ? { explanation: c.explanation } : {})
          }))
        },
        null,
        2
      )
    }
  })

  const evidenceTool = new DynamicStructuredTool({
    name: 'submit_regulation_evidence',
    description:
      '规范问答的证据登记：把本轮实际检索到、并真正用于作答的条文登记给系统，逐个子问说明用了哪几条、缺证的原因是什么。' +
      '回答任何规范问题之前必须先调用本工具；只能登记本轮 retrieve_regulation_chunks 返回过的条文（用它的 cite）。' +
      '返回 status=review_evidence 时按 issues 修正后重新提交（本轮只允许补证一次）；status=accepted 之后才能作答。',
    schema: z.object({
      question_type: z.enum(['条文精准检索', '宽泛检索', '设计检索推荐', '综合咨询']).describe('本轮问题的类型'),
      // 不设 min(1)：所有子问都查不到条文时也要能登记（每个子问写 gap_reason），
      // 否则模型只能编一条 cite 凑数才交得上
      selected_clause_keys: z.array(z.string().min(1)).describe('按优先级列出实际采用的条文 cite；全部子问都缺证时可为空'),
      coverage: z
        .array(
          z.object({
            question: z.string().min(1).describe('用户的一个子问'),
            clause_keys: z.array(z.string()).default([]).describe('回答这个子问用到的条文 cite；没有就留空并写 gap_reason'),
            gap_reason: z
              .enum(GAP_REASONS)
              .optional()
              .describe('缺证原因：no_evidence / asset_unavailable / region_unconfirmed / project_input_missing / filter_unavailable / timeout / tool_error')
          })
        )
        .min(1)
        .describe('逐个子问的覆盖情况')
    }),
    func: async ({ question_type, selected_clause_keys, coverage }) => {
      submissions += 1
      const available = [...retrieved.keys()]
      const used = [...new Set([...selected_clause_keys, ...coverage.flatMap((entry) => entry.clause_keys)])]
      const unknown = used.filter((key) => !retrieved.has(key))
      const covered = new Set(coverage.flatMap((entry) => entry.clause_keys))
      const uncovered = selected_clause_keys.filter((key) => !covered.has(key))
      const issues: string[] = []

      if (searches === 0) {
        issues.push('本轮还没有检索过条文：先用 retrieve_regulation_chunks 检索，再登记证据。')
      }
      if (unknown.length > 0) {
        issues.push(`这些条号本轮没有检索到，不能引用：${unknown.join('、')}。可用的是：${available.join('、') || '（无）'}`)
      }
      if (uncovered.length > 0) {
        issues.push(`这些条没有写进任何子问的 coverage：${uncovered.join('、')}`)
      }
      coverage.forEach((entry, index) => {
        if (entry.clause_keys.length === 0 && !entry.gap_reason) {
          issues.push(`第 ${index + 1} 个子问「${entry.question}」既没有条文，也没有 gap_reason`)
        }
      })

      // 只给一轮补证：第二次提交起放行，问题降级成 warnings，避免模型卡在登记这一步出不来
      if (issues.length > 0 && submissions === 1) {
        return JSON.stringify(
          {
            status: 'review_evidence',
            issues,
            available_clause_keys: available,
            instruction: '按 issues 修正后重新提交；本轮只剩这一次补证机会，再次提交会直接放行。'
          },
          null,
          2
        )
      }

      return JSON.stringify(
        {
          status: 'accepted',
          question_type,
          evidence: coverage.map((entry) => ({
            question: entry.question,
            ...(entry.gap_reason ? { gap_reason: entry.gap_reason } : {}),
            clauses: entry.clause_keys
              .map((key) => retrieved.get(key))
              .filter((clause): clause is RetrievedClause => Boolean(clause))
              .map((clause) => ({ ...clause }))
          })),
          ...(issues.length > 0 ? { warnings: issues } : {}),
          instruction:
            '按上述证据作答：每条结论句末用 <source>cite</source> 标注；有 gap_reason 的子问要如实说明没查到什么、缺什么条件，不要用记忆补限值。'
        },
        null,
        2
      )
    }
  })

  return [retrieveTool, evidenceTool]
}
