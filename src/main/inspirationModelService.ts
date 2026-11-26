import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
  type Dirent
} from 'node:fs'
import { basename, dirname, extname, join, relative } from 'node:path'
import type {
  ClipModelDownloadProgress,
  ClipModelStatus,
  InspirationIndexRecord,
  InspirationRebuildProgress,
  InspirationRebuildResult
} from '@shared/protocol'
import { CLIP_MODEL_FILES, CLIP_MODEL_ID, CLIP_MODEL_TOTAL_BYTES } from '@shared/clipModel'
import {
  encodeVector,
  getClipEngine,
  isClipModelReady
} from '../runtime/tools/clipEngine'

/**
 * 灵感库向量模型管理 + 应用内重建索引（设置页「本地规范知识库」页签的后端）。
 *
 * - 模型管理：Chinese-CLIP ViT-B/16 ONNX（Xenova 转换版，MIT）不打包进安装包，
 *   首次使用时从 HuggingFace 原始来源下载到 userData 模型目录，之后完全离线。
 * - 重建索引：扫描灵感库目录内的三类来源（与离线生成器 build-inspiration-index-v2.mjs 同口径）：
 *   ① catalog.json（素材库清单）→ asset；② dataset-photo-render.jsonl（+ dataset-clean.jsonl /
 *   typed_indices.json / imgs/）→ recipe；③ 散文件（图片→recipe、模型/HDRI→asset，贴图目录合并为一条 asset）。
 *   模型就绪时同步算文本/图像向量写入索引；未就绪时只写关键词元数据并在结果里注明。
 */

const INDEX_OUT = 'inspiration-index.json'
const MAX_REPORTED_ERRORS = 50

// ---------------------------------------------------------------- 模型状态 / 下载
interface DownloadState {
  dir: string
  file: string
  downloadedBytes: number
  totalBytes: number
}

let downloadState: DownloadState | null = null
let downloadInFlight: Promise<ClipModelStatus> | null = null

export function getClipModelStatus(modelDir: string): ClipModelStatus {
  const dir = modelDir?.trim() ?? ''
  const files = CLIP_MODEL_FILES.map((spec) => {
    const p = dir ? join(dir, spec.name) : ''
    const present = Boolean(p) && existsSync(p)
    return {
      name: spec.name,
      present,
      ...(present ? { sizeBytes: statSync(p).size } : {})
    }
  })
  const requiredOk = CLIP_MODEL_FILES.filter((f) => f.required).every((spec) => {
    const s = files.find((f) => f.name === spec.name)
    return Boolean(s?.present) && (s?.sizeBytes ?? 0) >= spec.expectedBytes * 0.99
  })
  const downloading = downloadState && downloadState.dir === dir ? downloadState : null
  return {
    state: downloading ? 'downloading' : requiredOk ? 'ready' : 'missing',
    modelDir: dir,
    files,
    sizeBytes: files.reduce((sum, f) => sum + (f.sizeBytes ?? 0), 0),
    ...(downloading
      ? {
          download: {
            file: downloading.file,
            downloadedBytes: downloading.downloadedBytes,
            totalBytes: downloading.totalBytes
          }
        }
      : {})
  }
}

export async function downloadClipModel(
  modelDir: string,
  onProgress?: (p: ClipModelDownloadProgress) => void
): Promise<ClipModelStatus> {
  const dir = modelDir?.trim() ?? ''
  if (!dir) throw new Error('向量模型目录为空')
  if (downloadInFlight) return downloadInFlight
  downloadInFlight = (async () => {
    mkdirSync(dir, { recursive: true })
    let completedBytes = 0
    try {
      for (const spec of CLIP_MODEL_FILES) {
        const dest = join(dir, spec.name)
        // 已完整下载的文件跳过（断点续传以文件为粒度）
        if (existsSync(dest) && statSync(dest).size >= spec.expectedBytes * 0.99) {
          completedBytes += spec.expectedBytes
          continue
        }
        const resp = await fetch(spec.url)
        if (!resp.ok || !resp.body) {
          throw new Error(`下载 ${spec.name} 失败（HTTP ${resp.status}）：请检查网络后重试`)
        }
        const total = Number(resp.headers.get('content-length')) || spec.expectedBytes
        downloadState = { dir, file: spec.name, downloadedBytes: 0, totalBytes: total }
        const tmp = `${dest}.part`
        const out = createWriteStream(tmp)
        const reader = resp.body.getReader()
        let got = 0
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          got += value.byteLength
          if (downloadState && downloadState.dir === dir) {
            downloadState.downloadedBytes = got
          }
          onProgress?.({
            file: spec.name,
            downloadedBytes: got,
            totalBytes: total,
            overallRatio: Math.min(1, (completedBytes + got) / CLIP_MODEL_TOTAL_BYTES)
          })
          if (!out.write(Buffer.from(value))) {
            await new Promise<void>((res) => out.once('drain', res))
          }
        }
        await new Promise<void>((res, rej) => {
          out.once('error', rej)
          out.end(() => res())
        })
        renameSync(tmp, dest)
        completedBytes += total
      }
    } finally {
      downloadState = null
      downloadInFlight = null
    }
    return getClipModelStatus(dir)
  })()
  return downloadInFlight
}

// ---------------------------------------------------------------- 索引记录构建（与离线生成器同口径）
const BUILDING_TYPE_ZH: Record<string, string[]> = {
  villa_house: ['独栋住宅', '别墅', '住宅'],
  cityscape: ['城市街景', '城市', '街景'],
  highrise: ['高层建筑', '高层'],
  traditional: ['传统古典', '古典建筑', '传统建筑'],
  futuristic: ['未来科幻', '科幻建筑'],
  commercial: ['商业建筑', '商业'],
  public: ['公共建筑'],
  rural: ['乡村建筑', '乡村'],
  other_arch: ['其他建筑']
}
const STYLE_ZH: Record<string, string[]> = {
  photo: ['照片', '摄影', '写实'],
  render: ['渲染图', '效果图', '三维渲染']
}
const CATEGORY_ZH: Record<string, string[]> = {
  trees: ['树木', '配景树'],
  plants: ['植物', '绿植'],
  cars: ['汽车', '车辆'],
  people: ['人物', '配景人物'],
  street: ['街道家具', '街具'],
  rocks: ['石头', '岩石'],
  furniture: ['家具'],
  textures: ['贴图', '材质', '纹理'],
  hdri: ['环境光', 'HDRI', '天空光']
}
const PROMPT_KEYWORD_TAGS: [RegExp, string][] = [
  [/\bmodern\b/i, '现代'],
  [/\bcontemporary\b/i, '当代'],
  [/\bminimal(ist)?\b/i, '极简'],
  [/\bluxury\b/i, '豪华'],
  [/\bnight\b/i, '夜景'],
  [/\b(dusk|sunset)\b/i, '黄昏'],
  [/\b(dawn|sunrise|morning)\b/i, '清晨'],
  [/\baerial\b/i, '鸟瞰'],
  [/\bsnow\b/i, '雪景'],
  [/\bwooden\b/i, '木质'],
  [/\bglass\b/i, '玻璃'],
  [/\bconcrete\b/i, '混凝土'],
  [/\bbrick\b/i, '砖'],
  [/\bwhite\b/i, '白色']
]

function cleanPromptLead(prompt: unknown): string {
  const cleaned = String(prompt ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned.length > 90 ? `${cleaned.slice(0, 90)}…` : cleaned
}

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png'])
const MODEL_EXTS = new Set(['.glb', '.gltf', '.fbx', '.obj', '.hdr', '.exr'])
const SKIP_NAMES = new Set([
  'inspiration-index.json',
  'inspiration-index-v2.json',
  'catalog.json',
  'dataset-photo-render.jsonl',
  'dataset-clean.jsonl',
  'typed_indices.json'
])

interface ScanOutcome {
  records: InspirationIndexRecord[]
  /** 与 records 平行：可算图像向量的图片绝对路径（无则 null） */
  imagePaths: (string | null)[]
  errors: { path: string; error: string }[]
  /** catalog.json 已认领的绝对路径（文件或目录）：散文件扫描时跳过，避免同批素材重复入索引 */
  claimed: Set<string>
  /** 是否消费了配方数据集（消费后其 imgs/ 目录不再按散图重复扫描） */
  datasetConsumed: boolean
}

function scanFolder(folder: string): ScanOutcome {
  const records: InspirationIndexRecord[] = []
  const imagePaths: (string | null)[] = []
  const errors: { path: string; error: string }[] = []
  const claimed = new Set<string>()
  let datasetConsumed = false
  const rel = (abs: string) => relative(folder, abs).split('\\').join('/')
  const pushError = (path: string, err: unknown) => {
    errors.push({ path, error: err instanceof Error ? err.message : String(err) })
  }

  // ① catalog.json → asset（素材库清单，local_path 相对清单所在目录）
  const catalogPath = join(folder, 'catalog.json')
  if (existsSync(catalogPath)) {
    try {
      const catalog = JSON.parse(readFileSync(catalogPath, 'utf8')) as {
        id?: string
        name?: string
        category?: string
        format?: string
        source?: string
        source_url?: string
        local_path?: string
      }[]
      for (const a of Array.isArray(catalog) ? catalog : []) {
        const tags = new Set([a.category ?? '', a.format ?? '', '素材'])
        for (const t of CATEGORY_ZH[a.category ?? ''] ?? []) tags.add(t)
        for (const w of String(a.name ?? '').split(/[\s_\-]+/)) {
          if (w.trim()) tags.add(w.trim().toLowerCase())
        }
        const rec: InspirationIndexRecord = {
          id: String(a.id ?? `asset-${records.length}`),
          kind: 'asset',
          title: String(a.name ?? a.id ?? '未命名素材'),
          tags: [...tags].filter(Boolean),
          source: String(a.source ?? '本地素材库'),
          ...(a.source_url ? { sourceUrl: a.source_url } : {})
        }
        let imgAbs: string | null = null
        if (a.local_path) {
          const abs = join(folder, a.local_path)
          if (existsSync(abs)) {
            claimed.add(abs)
            rec.localPath = rel(abs)
            if (a.category === 'textures' && statSync(abs).isDirectory()) {
              const files = readdirSync(abs)
              const preview =
                files.find((f) => /^(diffuse|color|albedo|basecolor)/i.test(f) && IMAGE_EXTS.has(extname(f).toLowerCase())) ??
                files.find((f) => IMAGE_EXTS.has(extname(f).toLowerCase()))
              if (preview) imgAbs = join(abs, preview)
            }
          }
        }
        records.push(rec)
        imagePaths.push(imgAbs)
      }
    } catch (err) {
      pushError(catalogPath, err)
    }
  }

  // ② dataset-photo-render.jsonl → recipe（配方库导出，参考图经 clean 行序 + typed_indices 还原）
  const prPath = join(folder, 'dataset-photo-render.jsonl')
  if (existsSync(prPath)) {
    datasetConsumed = true
    try {
      const cleanPath = join(folder, 'dataset-clean.jsonl')
      const orderPath = join(folder, 'typed_indices.json')
      const cleanPos = new Map<string, number>()
      let order: number[] = []
      if (existsSync(cleanPath) && existsSync(orderPath)) {
        const cleanLines = readFileSync(cleanPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
        order = JSON.parse(readFileSync(orderPath, 'utf8')) as number[]
        cleanLines.forEach((r: { civitai_image_id?: string }, i: number) => {
          if (r.civitai_image_id) cleanPos.set(r.civitai_image_id, i)
        })
      }
      for (const line of readFileSync(prPath, 'utf8').trim().split('\n')) {
        if (!line.trim()) continue
        const r = JSON.parse(line) as {
          civitai_image_id?: string
          style?: string
          building_type?: string
          base_model?: string
          prompt?: string
          image_url?: string
        }
        const tags = new Set(['建筑外观', r.style ?? '', r.building_type ?? ''])
        for (const t of STYLE_ZH[r.style ?? ''] ?? []) tags.add(t)
        for (const t of BUILDING_TYPE_ZH[r.building_type ?? ''] ?? []) tags.add(t)
        if (r.base_model) tags.add(String(r.base_model))
        for (const [re, zh] of PROMPT_KEYWORD_TAGS) {
          if (re.test(String(r.prompt ?? ''))) tags.add(zh)
        }
        const rec: InspirationIndexRecord = {
          id: `civitai-${r.civitai_image_id ?? records.length}`,
          kind: 'recipe',
          title: cleanPromptLead(r.prompt) || `建筑参考图 ${r.civitai_image_id ?? ''}`,
          tags: [...tags].filter(Boolean),
          ...(r.style ? { style: r.style } : {}),
          ...(r.building_type ? { buildingType: r.building_type } : {}),
          prompt: String(r.prompt ?? '').slice(0, 1200),
          ...(r.image_url ? { sourceUrl: r.image_url } : {}),
          source: 'Civitai 配方库（本地整理）'
        }
        let imgAbs: string | null = null
        const pos = r.civitai_image_id ? cleanPos.get(r.civitai_image_id) : undefined
        if (pos !== undefined && order[pos] !== undefined) {
          const p = join(folder, 'imgs', `${order[pos]}.jpg`)
          if (existsSync(p)) {
            rec.localPath = rel(p)
            imgAbs = p
          }
        }
        records.push(rec)
        imagePaths.push(imgAbs)
      }
    } catch (err) {
      pushError(prPath, err)
    }
  }

  // ③ 散文件：先识别贴图目录（内含多张通道图 → 合并为一条 asset），其余图片→recipe、模型/HDRI→asset
  const textureDirs = new Set<string>()
  const walk = (dir: string): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (err) {
      pushError(dir, err)
      return
    }
    const files = entries.filter((e) => e.isFile())
    const imgFiles = files.filter((f) => IMAGE_EXTS.has(extname(f.name).toLowerCase()))
    const channelLike = imgFiles.filter((f) =>
      /(diffuse|color|albedo|basecolor|normal|roughness|metalness|ao|height|displacement)/i.test(f.name)
    )
    if (dir !== folder && imgFiles.length >= 2 && channelLike.length >= 1 && !claimed.has(dir)) {
      textureDirs.add(dir)
      const tags = new Set(['贴图', '材质', '纹理', '素材'])
      for (const seg of rel(dir).split('/')) if (seg) tags.add(seg.toLowerCase())
      records.push({
        id: `loose-tex-${records.length}`,
        kind: 'asset',
        title: basename(dir),
        tags: [...tags],
        localPath: rel(dir),
        source: '本地素材（文件夹扫描）'
      })
      const preview =
        imgFiles.find((f) => /^(diffuse|color|albedo|basecolor)/i.test(f.name)) ?? imgFiles[0]
      imagePaths.push(join(dir, preview.name))
    }
    for (const e of entries) {
      const abs = join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue
        if (claimed.has(abs)) continue // 已被 catalog.json 认领，避免重复入索引
        if (datasetConsumed && abs === join(folder, 'imgs')) continue // 配方数据集的参考图目录已按数据集入索引
        walk(abs)
        continue
      }
      if (!e.isFile() || SKIP_NAMES.has(e.name)) continue
      if (claimed.has(abs)) continue
      if (textureDirs.has(dir)) continue // 贴图目录内文件已合并
      const ext = extname(e.name).toLowerCase()
      const stem = basename(e.name, ext)
      const tags = new Set<string>()
      for (const seg of rel(dirname(abs)).split('/')) if (seg && seg !== '.') tags.add(seg.toLowerCase())
      for (const w of stem.split(/[\s_\-]+/)) if (w.trim()) tags.add(w.trim().toLowerCase())
      if (IMAGE_EXTS.has(ext)) {
        records.push({
          id: `loose-img-${records.length}`,
          kind: 'recipe',
          title: stem,
          tags: [...tags, '参考图'],
          localPath: rel(abs),
          source: '本地素材（文件夹扫描）'
        })
        imagePaths.push(abs)
      } else if (MODEL_EXTS.has(ext)) {
        records.push({
          id: `loose-asset-${records.length}`,
          kind: 'asset',
          title: stem,
          tags: [...tags, '素材'],
          localPath: rel(abs),
          source: '本地素材（文件夹扫描）'
        })
        imagePaths.push(null)
      }
    }
  }
  walk(folder)

  return { records, imagePaths, errors, claimed, datasetConsumed }
}

// ---------------------------------------------------------------- 重建索引
export async function rebuildInspirationIndex(params: {
  folder: string
  clipModelDir?: string
  onProgress?: (p: InspirationRebuildProgress) => void
}): Promise<InspirationRebuildResult> {
  const started = Date.now()
  const folder = params.folder?.trim() ?? ''
  const base: Omit<InspirationRebuildResult, 'ok' | 'elapsedMs'> = {
    folder,
    recordCount: 0,
    recipeCount: 0,
    assetCount: 0,
    textVectorCount: 0,
    imageVectorCount: 0,
    vectorsComputed: false,
    errors: [],
    errorCount: 0
  }
  const finish = (partial: Partial<InspirationRebuildResult>): InspirationRebuildResult => ({
    ...base,
    ok: false,
    ...partial,
    elapsedMs: Date.now() - started
  })

  if (!folder || !existsSync(folder) || !statSync(folder).isDirectory()) {
    return finish({ error: `灵感库目录不存在或不是文件夹：${folder || '（空）'}` })
  }

  params.onProgress?.({ phase: 'scan', done: 0, total: 0 })
  const { records, imagePaths, errors } = scanFolder(folder)
  if (records.length === 0) {
    return finish({
      errors: errors.slice(0, MAX_REPORTED_ERRORS),
      errorCount: errors.length,
      error:
        '未在该目录找到可索引的素材：需要 catalog.json（素材清单）、dataset-photo-render.jsonl（配方导出）或散放的图片/模型文件'
    })
  }

  // 向量：模型就绪才算；未就绪只写元数据并在结果里注明（vectorsComputed=false）
  const clipDir = params.clipModelDir?.trim() ?? ''
  const engine = clipDir ? await getClipEngine(clipDir) : null
  let textVectorCount = 0
  let imageVectorCount = 0
  if (engine) {
    const textForRecord = (rec: InspirationIndexRecord): string =>
      [rec.title, (rec.tags ?? []).join(' '), rec.style ?? '', rec.buildingType ?? '', (rec.prompt ?? '').slice(0, 400)]
        .filter(Boolean)
        .join(' ')
    for (let i = 0; i < records.length; i++) {
      const rec = records[i]
      try {
        rec.textVector = encodeVector(await engine.embedText(textForRecord(rec)))
        textVectorCount += 1
      } catch (err) {
        errors.push({ path: rec.id, error: `文本向量失败：${err instanceof Error ? err.message : String(err)}` })
      }
      if ((i + 1) % 25 === 0 || i === records.length - 1) {
        params.onProgress?.({ phase: 'text-vectors', done: i + 1, total: records.length })
      }
    }
    for (let i = 0; i < records.length; i++) {
      const img = imagePaths[i]
      if (!img) continue
      try {
        records[i].imageVector = encodeVector(await engine.embedImage(readFileSync(img)))
        imageVectorCount += 1
      } catch (err) {
        errors.push({ path: img, error: `图像向量失败：${err instanceof Error ? err.message : String(err)}` })
      }
      if ((i + 1) % 25 === 0 || i === records.length - 1) {
        params.onProgress?.({ phase: 'image-vectors', done: i + 1, total: records.length })
      }
    }
  }

  params.onProgress?.({ phase: 'write', done: records.length, total: records.length })
  const index = {
    version: 2,
    generatedAt: new Date().toISOString(),
    recordCount: records.length,
    ...(engine ? { vectorModel: CLIP_MODEL_ID, vectorDim: 512 } : {}),
    records
  }
  const outPath = join(folder, INDEX_OUT)
  const tmpPath = `${outPath}.tmp`
  writeFileSync(tmpPath, JSON.stringify(index), 'utf8')
  renameSync(tmpPath, outPath)

  return finish({
    ok: true,
    recordCount: records.length,
    recipeCount: records.filter((r) => r.kind === 'recipe').length,
    assetCount: records.filter((r) => r.kind === 'asset').length,
    textVectorCount,
    imageVectorCount,
    vectorsComputed: Boolean(engine),
    errors: errors.slice(0, MAX_REPORTED_ERRORS),
    errorCount: errors.length,
    ...(engine
      ? {}
      : {
          error: isClipModelReady(clipDir)
            ? '向量模型加载失败，本次索引仅含关键词元数据'
            : '本地向量模型未下载，本次索引仅含关键词元数据（下载模型后再次重建即可补齐向量）'
        })
  })
}
