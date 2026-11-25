import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import type { RegulationChunk, RegulationToolData } from '@shared/protocol'

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

function tryExtractPdfText(pdfPath: string, pythonExe: string): string | null {
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
    const out = execFileSync(pythonExe, ['-c', pyCode, pdfPath], {
      timeout: 15000,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024
    })
    return out.trim() || null
  } catch {
    return null
  }
}

function loadChunksFromFile(filePath: string, pythonExe: string): RegulationChunk[] {
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
    rawText = tryExtractPdfText(filePath, pythonExe) ?? ''
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

export function createLocalRegulationTool(params: {
  regulationFolder?: string
  pythonExe: string
  recordToolData: (toolCallId: string, data: RegulationToolData) => void
}): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'retrieve_regulation_chunks',
    description:
      '本地建筑规范知识库检索：检索本地规范库目录中存放的国标/行标/地标条文（JSON、Markdown、TXT 或 PDF），返回可核验的规范名称、编号、条号、正文及效力状态。查询规范限值或合规依据前必须先阅读 regulation-consultation 技能再调用本工具。',
    schema: z.object({
      query: z.string().min(1).describe('检索查询语句（建议包含建筑用途、空间对象与具体指标，如“无障碍厕所 轮椅回转空间 扶手”）'),
      standard: z.string().optional().describe('限定规范编号或名称关键词（仅当用户点名规范时填写）'),
      current_only: z.boolean().optional().describe('是否只返回现行有效条文'),
      mandatory_only: z.boolean().optional().describe('是否仅过滤强制性/含强约束关键词条文')
    }),
    func: async ({ query, standard, current_only, mandatory_only }, runManager) => {
      const callId =
        (runManager as unknown as { configurable?: { toolCallId?: string } })?.configurable?.toolCallId ??
        `reg_${Date.now()}`

      const folder = params.regulationFolder?.trim()
      if (!folder || !existsSync(folder)) {
        return '本地规范库目录尚未配置或为空。可在「设置 → 本地规范库目录」指定存放国标/地标 PDF 或 Markdown 文档的文件夹。'
      }

      const files = collectRegulationFiles(folder)
      if (files.length === 0) {
        return `本地规范库目录（${folder}）内暂无可检索的 .json/.md/.txt/.pdf 规范文件。`
      }

      const allChunks: RegulationChunk[] = []
      for (const f of files) {
        allChunks.push(...loadChunksFromFile(f, params.pythonExe))
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
}
