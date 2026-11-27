import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import { resolveToolCallId } from './callId'
import type {
  InspirationHit,
  InspirationIndexRecord,
  InspirationToolData,
  WebSearchConfig
} from '@shared/protocol'
import { runWebSearch } from './webSearchTool'
import { cosine, decodeVector, getClipEngine, isClipModelReady } from './clipEngine'

/**
 * search_inspiration —— C1.1「搜索」的后端工具。
 * 检索顺序：本地配方库（参考图 + 生图提示词）→ 本地素材库（模型/贴图/HDRI）→ 联网兜底。
 * 本地两库合并在一份统一索引里：<灵感库目录>/inspiration-index.json（或 -v2.json），
 * 记录字段见 @shared/protocol 的 InspirationIndexRecord；localPath 相对索引目录解析。
 * 索引可由 build-inspiration-index(-v2).mjs 离线生成，或在设置页用「重建索引」应用内生成。
 *
 * 打分 = 关键词分（与规范检索同款切分加权）+ 向量分（本地 Chinese-CLIP，索引 v2 字段）：
 * 查询文本向量与记录 textVector / imageVector 做余弦（跨模态），传入 image_path 时再与
 * imageVector 做图→图余弦。向量模型未下载/索引无向量时自动退化为纯关键词，绝不硬失败。
 */

const INDEX_FILES = ['inspiration-index.json', 'inspiration-index-v2.json']
/** 本地命中达到该数量视为足够，不再联网兜底 */
const LOCAL_SUFFICIENT = 3
const MAX_HITS = 8
/** 向量权重：关键词分量级为整串命中 +20/+12、词元命中个位数，向量余弦（0~0.6）乘权重后与之可比 */
const TEXT_VECTOR_WEIGHT = 25
const IMAGE_VECTOR_WEIGHT = 30
/** 纯语义命中（关键词分=0）的入选下限：低于此余弦视为不相关 */
const SEMANTIC_MIN_COS = 0.24
const IMAGE_MIN_COS = 0.5

interface LoadedIndex {
  file: string
  mtimeMs: number
  records: InspirationIndexRecord[]
}

let indexCache: LoadedIndex | null = null

function parseIndexFile(indexPath: string): InspirationIndexRecord[] {
  const parsed = JSON.parse(readFileSync(indexPath, 'utf8')) as {
    records?: InspirationIndexRecord[]
  }
  return Array.isArray(parsed.records)
    ? parsed.records.filter(
        (r) => r && typeof r.title === 'string' && (r.kind === 'recipe' || r.kind === 'asset')
      )
    : []
}

function loadIndex(folder: string): InspirationIndexRecord[] | null {
  const candidates = INDEX_FILES.map((name) => join(folder, name)).filter((p) => existsSync(p))
  if (candidates.length === 0) return null
  try {
    // 只有一个候选时走 mtime 缓存快路径
    if (candidates.length === 1) {
      const indexPath = candidates[0]
      const mtimeMs = statSync(indexPath).mtimeMs
      if (indexCache && indexCache.file === indexPath && indexCache.mtimeMs === mtimeMs) {
        return indexCache.records
      }
      const records = parseIndexFile(indexPath)
      indexCache = { file: indexPath, mtimeMs, records }
      return records
    }
    // 两个候选都在（如离线生成的 v1 + v2 并存）：选带向量记录更多的那份；
    // 向量数相同则选 inspiration-index.json（应用内重建的落盘名，视为更新）
    let best: { file: string; mtimeMs: number; records: InspirationIndexRecord[]; vecCount: number } | null =
      null
    for (const indexPath of candidates) {
      const mtimeMs = statSync(indexPath).mtimeMs
      if (indexCache && indexCache.file === indexPath && indexCache.mtimeMs === mtimeMs) {
        const vecCount = indexCache.records.filter((r) => r.textVector || r.imageVector).length
        if (!best || vecCount > best.vecCount) {
          best = { file: indexPath, mtimeMs, records: indexCache.records, vecCount }
        }
        continue
      }
      const records = parseIndexFile(indexPath)
      const vecCount = records.filter((r) => r.textVector || r.imageVector).length
      if (!best || vecCount > best.vecCount) best = { file: indexPath, mtimeMs, records, vecCount }
    }
    if (!best) return null
    indexCache = { file: best.file, mtimeMs: best.mtimeMs, records: best.records }
    return best.records
  } catch {
    return null
  }
}

/** 与规范检索同款的查询切分：英文/数字按词，中文短语补 2-gram 与 3-gram 提高召回 */
function tokenizeQuery(query: string): string[] {
  const cleaned = query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\-./]/gu, ' ')
    .trim()
  const words = cleaned.split(/\s+/).filter(Boolean)
  const grams = new Set<string>(words)
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

function scoreRecord(rec: InspirationIndexRecord, tokens: string[], rawQuery: string): number {
  const title = rec.title.toLowerCase()
  const tags = (rec.tags ?? []).join(' ').toLowerCase()
  const meta = `${rec.style ?? ''} ${rec.buildingType ?? ''}`.toLowerCase()
  const prompt = (rec.prompt ?? '').toLowerCase()
  let score = 0
  const q = rawQuery.toLowerCase()
  if (title.includes(q)) score += 20
  if (tags.includes(q)) score += 12
  for (const t of tokens) {
    const w = t.length >= 3 ? 3 : 1
    if (title.includes(t)) score += w * 2
    if (tags.includes(t)) score += w * 2
    if (meta.includes(t)) score += w
    if (prompt.includes(t)) score += w
  }
  return score
}

function toHit(folder: string, rec: InspirationIndexRecord, score: number): InspirationHit {
  let filePath: string | undefined
  if (rec.localPath) {
    const abs = resolve(folder, rec.localPath)
    if (existsSync(abs)) filePath = abs
  }
  return {
    id: rec.id,
    kind: rec.kind,
    title: rec.title,
    score: Math.round(score * 10) / 10,
    ...(rec.style ? { style: rec.style } : {}),
    ...(rec.buildingType ? { buildingType: rec.buildingType } : {}),
    ...(rec.prompt ? { prompt: rec.prompt.slice(0, 600) } : {}),
    ...(filePath ? { filePath } : {}),
    ...(rec.sourceUrl ? { sourceUrl: rec.sourceUrl } : {}),
    source: rec.source,
    tags: rec.tags ?? []
  }
}

export function createSearchInspirationTool(params: {
  inspirationFolder?: string
  clipModelDir?: string
  webSearchConfig?: WebSearchConfig
  signal: AbortSignal
  recordToolData: (toolCallId: string, data: InspirationToolData) => void
}): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'search_inspiration',
    description:
      '本地灵感/素材检索工具（任务「搜索」专用）：先检索本机灵感库中的建筑参考图与生图配方（recipe，含提示词、风格与建筑类型）及 3D 模型/贴图/HDRI 素材（asset），返回名称、风格、类型、本地文件路径与来源；支持语义检索（换个说法也能找到）与以图搜图（传 image_path 找视觉相近的参考图）；本地结果不足时自动联网补充公开资料。找参考图、找素材、查产品资料时优先调用本工具，不要直接凭记忆编造素材来源。' +
      '拿到结果后按 inspiration-search 技能讲给用户：hits 最多 8 条、未经二次筛选，不要说成「精选」；vectorUsed=false 时不能说「语义匹配」；webFallback 的结果要单独标出是联网补充的。',
    schema: z.object({
      query: z.string().min(1).describe('检索目标关键词或描述（如“现代独栋住宅 效果图”“木质家具 模型”）'),
      kind: z
        .enum(['recipe', 'asset'])
        .optional()
        .describe('限定结果类型：recipe=参考图/生图配方，asset=模型/贴图素材；不填则两类都查'),
      style: z.string().optional().describe('限定配方风格（如 photo / render），仅对 recipe 生效'),
      building_type: z
        .string()
        .optional()
        .describe(
          '限定建筑类型（villa_house 独栋住宅 / cityscape 城市街景 / highrise 高层 / traditional 传统古典 / futuristic 未来科幻 / commercial 商业 / public 公共 / rural 乡村），仅对 recipe 生效'
        ),
      image_path: z
        .string()
        .optional()
        .describe(
          '可选：参考图路径（绝对路径，或相对灵感库目录）。传入时按图搜图——找视觉上相近的参考图/贴图，与 query 文本混合排序；需要本地向量模型与带图像向量的索引'
        )
    }),
    func: async ({ query, kind, style, building_type, image_path }, runManager, config) => {
      const callId =
        resolveToolCallId(runManager, config)

      const folder = params.inspirationFolder?.trim() ?? ''
      const records = folder ? loadIndex(folder) : null

      // ---- 向量准备（模型缺失/加载失败一律退化为纯关键词，不硬失败） ----
      const clipDir = params.clipModelDir?.trim() ?? ''
      let vectorNote: string | undefined
      let queryVec: Float32Array | null = null
      let imageVec: Float32Array | null = null
      let vectorUsed = false
      if (records && records.length > 0 && clipDir) {
        const engine = await getClipEngine(clipDir)
        if (engine) {
          try {
            queryVec = await engine.embedText(query)
          } catch {
            queryVec = null
          }
          if (image_path) {
            const candidates = isAbsolute(image_path)
              ? [image_path]
              : [resolve(image_path), resolve(folder, image_path)]
            const imgFile = candidates.find((p) => existsSync(p))
            if (imgFile) {
              try {
                imageVec = await engine.embedImage(readFileSync(imgFile))
              } catch {
                imageVec = null
              }
            }
          }
          if (!queryVec && !imageVec) {
            vectorNote = '本地向量模型推理失败，本次为纯关键词检索'
          }
        } else if (!isClipModelReady(clipDir)) {
          vectorNote =
            '本地向量模型未下载，本次为纯关键词检索（可在「设置 → 本地规范知识库 → 本地向量模型」下载模型，启用语义检索与以图搜图）'
        } else {
          vectorNote = '本地向量模型加载失败，本次为纯关键词检索'
        }
      }

      let hits: InspirationHit[] = []
      let total = 0
      if (records && records.length > 0) {
        const tokens = tokenizeQuery(query)
        const scored: { rec: InspirationIndexRecord; score: number }[] = []
        for (const rec of records) {
          if (kind && rec.kind !== kind) continue
          if (style && rec.style !== style) continue
          if (building_type && rec.buildingType !== building_type) continue
          const kw = scoreRecord(rec, tokens, query)
          let semCos = -1
          let imgCos = -1
          if (queryVec) {
            const tv = decodeVector(rec.textVector)
            if (tv) semCos = Math.max(semCos, cosine(queryVec, tv))
            const iv = decodeVector(rec.imageVector)
            if (iv) semCos = Math.max(semCos, cosine(queryVec, iv))
          }
          if (imageVec) {
            const iv = decodeVector(rec.imageVector)
            if (iv) imgCos = cosine(imageVec, iv)
          }
          let score = kw
          if (semCos > 0) score += TEXT_VECTOR_WEIGHT * semCos
          if (imgCos > 0) score += IMAGE_VECTOR_WEIGHT * imgCos
          const included =
            kw > 0 || semCos >= SEMANTIC_MIN_COS || imgCos >= IMAGE_MIN_COS
          if (included && score > 0) {
            if (semCos > 0 || imgCos > 0) vectorUsed = true
            scored.push({ rec, score })
          }
        }
        scored.sort((a, b) => b.score - a.score)
        total = scored.length
        hits = scored.slice(0, MAX_HITS).map((x) => toHit(folder, x.rec, x.score))
      }

      // 本地不足 → 联网兜底（复用 web_search 的通道实现；被禁用或失败时静默降级为纯本地结论）
      let webFallbackUsed = false
      let webAttempted = false
      let webProvider: string | undefined
      let webResults: InspirationToolData['webResults']
      if (hits.length < LOCAL_SUFFICIENT && params.webSearchConfig?.enabled !== false) {
        webAttempted = true
        try {
          const web = await runWebSearch({
            config: params.webSearchConfig,
            query,
            signal: params.signal
          })
          if (web.results.length > 0) {
            webFallbackUsed = true
            webProvider = web.provider
            webResults = web.results
          }
        } catch {
          // 联网失败不阻断本地结果返回
        }
      }

      params.recordToolData(callId, {
        kind: 'search_inspiration',
        query,
        total,
        localHits: hits,
        webFallbackUsed,
        vectorUsed,
        ...(webProvider ? { webProvider } : {}),
        ...(webResults ? { webResults } : {})
      })

      if (!records) {
        const head = folder
          ? `本地灵感库尚未就绪：目录（${folder}）内没有可用的索引文件（${INDEX_FILES.join(' / ')}）。可在「设置 → 本地规范知识库」页签确认灵感/素材库目录并用「重建索引」生成，或先放入索引文件。`
          : '本地灵感库目录尚未配置。可在「设置 → 本地规范知识库」页签的「本地灵感 / 素材库目录」中指定存放索引文件的文件夹。'
        if (webFallbackUsed) {
          return `${head}\n已先联网补充公开资料：\n${JSON.stringify({ query, provider: webProvider, results: webResults }, null, 2)}`
        }
        return webAttempted
          ? `${head}\n本次联网兜底也未取得结果，请更换关键词或提示用户先配置本地灵感库。`
          : `${head}\n请提示用户先配置本地灵感库后重试。`
      }

      if (hits.length === 0 && !webFallbackUsed) {
        const vecHint = vectorNote ? `\n（${vectorNote}）` : ''
        return webAttempted
          ? `在本地灵感库（共 ${records.length} 条索引）中未检索到与“${query}”直接匹配的灵感/素材，联网兜底亦无结果。请调整检索词（可补充风格、建筑类型或材质关键词）或扩充本地库。${vecHint}`
          : `在本地灵感库（共 ${records.length} 条索引）中未检索到与“${query}”直接匹配的灵感/素材。请调整检索词（可补充风格、建筑类型或材质关键词）或扩充本地库。${vecHint}`
      }

      return JSON.stringify(
        {
          query,
          libraryFolder: folder,
          indexTotal: records.length,
          localTotal: total,
          vectorUsed,
          ...(vectorNote ? { vectorNote } : {}),
          hits: hits.map((h) => ({
            kind: h.kind,
            title: h.title,
            ...(h.style ? { style: h.style } : {}),
            ...(h.buildingType ? { buildingType: h.buildingType } : {}),
            ...(h.prompt ? { prompt: h.prompt } : {}),
            ...(h.filePath ? { filePath: h.filePath } : {}),
            ...(h.sourceUrl ? { sourceUrl: h.sourceUrl } : {}),
            source: h.source,
            tags: h.tags
          })),
          ...(webFallbackUsed
            ? { webFallback: { provider: webProvider, results: webResults } }
            : {})
        },
        null,
        2
      )
    }
  })
}
