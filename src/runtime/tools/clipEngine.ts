import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as ort from 'onnxruntime-node'
import jpeg from 'jpeg-js'
import { PNG } from 'pngjs'

/**
 * Chinese-CLIP ViT-B/16 (Xenova ONNX) 本地推理引擎 —— spike 验证版（spike/clipEngine.mjs）的 TS 移植。
 *
 * - 文本：BERT WordPiece 分词（vocab.txt），与 tokenizer_config 对齐：
 *   do_lower_case、tokenize_chinese_chars、[CLS]/[SEP] 包裹。
 * - 图像：JPEG/PNG 解码 → 双线性缩放 224×224 → /255 → CLIP mean/std 归一化 → CHW。
 *   常量来自 preprocessor_config.json（do_center_crop=false，直接 resize 到 224×224）。
 * - 会话：合并图（单 model_fp16.onnx 同时出 text_embeds / image_embeds），缺一侧输入时喂零/占位张量。
 *   FP16 图自动做 f32<->f16 位转换。
 * - 模型目录约定：<dir>/model_fp16.onnx + <dir>/vocab.txt（见 @shared/clipModel）。
 *   文件缺失时 getClipEngine 返回 null，调用方自动退化（灵感检索退回纯关键词），不硬失败。
 */

export const CLIP_MODEL_FILE = 'model_fp16.onnx'
export const CLIP_VOCAB_FILE = 'vocab.txt'

// ---------------------------------------------------------------- 分词（BERT WordPiece）
export class BertTokenizer {
  private readonly vocab = new Map<string, number>()
  private readonly unkId: number
  private readonly clsId: number
  private readonly sepId: number

  constructor(vocabPath: string) {
    const lines = readFileSync(vocabPath, 'utf8').split('\n')
    lines.forEach((tok, i) => {
      const t = tok.replace(/\r$/, '')
      if (t) this.vocab.set(t, i)
    })
    this.unkId = this.vocab.get('[UNK]') ?? 100
    this.clsId = this.vocab.get('[CLS]') ?? 101
    this.sepId = this.vocab.get('[SEP]') ?? 102
  }

  /** CJK 字符两侧加空格（tokenize_chinese_chars） */
  private addSpacesAroundCjk(text: string): string {
    let out = ''
    for (const ch of text) {
      const cp = ch.codePointAt(0) ?? 0
      const isCjk =
        (cp >= 0x4e00 && cp <= 0x9fff) ||
        (cp >= 0x3400 && cp <= 0x4dbf) ||
        (cp >= 0xf900 && cp <= 0xfaff) ||
        (cp >= 0x20000 && cp <= 0x2a6df)
      out += isCjk ? ` ${ch} ` : ch
    }
    return out
  }

  private isPunctuation(ch: string): boolean {
    const cp = ch.codePointAt(0) ?? 0
    return (
      (cp >= 33 && cp <= 47) ||
      (cp >= 58 && cp <= 64) ||
      (cp >= 91 && cp <= 96) ||
      (cp >= 123 && cp <= 126) ||
      /\p{P}/u.test(ch)
    )
  }

  /** 基础切分：小写化 → CJK 加空格 → 空白切分 → 标点独立成词 */
  private basicTokenize(text: string): string[] {
    const spaced = this.addSpacesAroundCjk(String(text).toLowerCase())
    const tokens: string[] = []
    for (const word of spaced.split(/\s+/)) {
      if (!word) continue
      let cur = ''
      for (const ch of word) {
        if (this.isPunctuation(ch)) {
          if (cur) tokens.push(cur)
          cur = ''
          tokens.push(ch)
        } else {
          cur += ch
        }
      }
      if (cur) tokens.push(cur)
    }
    return tokens
  }

  /** WordPiece 贪心最长匹配；整词失败 → [UNK] */
  private wordPiece(token: string): number[] {
    if (token.length > 100) return [this.unkId]
    const ids: number[] = []
    let start = 0
    while (start < token.length) {
      let end = token.length
      let curId: number | undefined
      while (start < end) {
        let sub = token.slice(start, end)
        if (start > 0) sub = `##${sub}`
        const id = this.vocab.get(sub)
        if (id !== undefined) {
          curId = id
          break
        }
        end -= 1
      }
      if (curId === undefined) return [this.unkId]
      ids.push(curId)
      start = end
    }
    return ids
  }

  /** 编码为 input_ids（不填充，单条推理）；maxLen 截断（BERT 位置上限 512） */
  encode(text: string, maxLen = 512): number[] {
    const ids = [this.clsId]
    for (const tok of this.basicTokenize(text)) {
      for (const id of this.wordPiece(tok)) {
        if (ids.length >= maxLen - 1) break
        ids.push(id)
      }
      if (ids.length >= maxLen - 1) break
    }
    ids.push(this.sepId)
    return ids
  }
}

// ---------------------------------------------------------------- f16 位转换
export function f32ToF16(val: number): number {
  const buf = new DataView(new ArrayBuffer(4))
  buf.setFloat32(0, val)
  const x = buf.getUint32(0)
  const sign = (x >> 16) & 0x8000
  let exp = ((x >> 23) & 0xff) - 112
  let frac = x & 0x7fffff
  if (exp >= 32) return sign | 0x7c00 // Inf / 溢出
  if (exp <= 0) {
    if (exp < -10) return sign // 太小 → 0
    frac |= 0x800000
    const shift = 14 - exp
    let half = frac >> shift
    if ((frac >> (shift - 1)) & 1 && (half & 1 || frac & ((1 << (shift - 1)) - 1))) half += 1
    return sign | half
  }
  let half = sign | (exp << 10) | (frac >> 13)
  if (frac & 0x1000 && (frac & 0x1fff || half & 1)) half += 1
  return half
}

export function f16ToF32(h: number): number {
  const sign = (h & 0x8000) << 16
  const exp = (h >> 10) & 0x1f
  const frac = h & 0x3ff
  const buf = new DataView(new ArrayBuffer(4))
  if (exp === 0) {
    if (frac === 0) {
      buf.setUint32(0, sign)
    } else {
      // 次正规数
      let e = -14
      let f = frac
      while (!(f & 0x400)) {
        f <<= 1
        e -= 1
      }
      f &= 0x3ff
      buf.setUint32(0, sign | ((e + 127) << 23) | (f << 13))
    }
  } else if (exp === 31) {
    buf.setUint32(0, sign | 0x7f800000 | (frac << 13))
  } else {
    buf.setUint32(0, sign | ((exp - 15 + 127) << 23) | (frac << 13))
  }
  return buf.getFloat32(0)
}

// ---------------------------------------------------------------- 图像预处理
const IMG_SIZE = 224
const MEAN = [0.48145466, 0.4578275, 0.40821073]
const STD = [0.26862954, 0.26130258, 0.27577711]

export interface DecodedImage {
  width: number
  height: number
  data: Uint8Array
}

/** 解码图片文件为 RGBA 像素（仅 JPEG / PNG） */
export function decodeImage(buf: Buffer | Uint8Array): DecodedImage {
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    const raw = jpeg.decode(Buffer.from(buf), { useTArray: true, formatAsRGBA: true })
    return { width: raw.width, height: raw.height, data: raw.data }
  }
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    const png = PNG.sync.read(Buffer.from(buf))
    return { width: png.width, height: png.height, data: png.data }
  }
  throw new Error('不支持的图片格式（仅 JPEG / PNG）')
}

/** 双线性缩放 + 归一化 → CHW Float32Array(3*224*224) */
export function imageToTensor(img: DecodedImage): Float32Array {
  const { width: w, height: h, data } = img
  const out = new Float32Array(3 * IMG_SIZE * IMG_SIZE)
  const xRatio = w / IMG_SIZE
  const yRatio = h / IMG_SIZE
  for (let y = 0; y < IMG_SIZE; y++) {
    const srcY = (y + 0.5) * yRatio - 0.5
    const y0 = Math.max(0, Math.floor(srcY))
    const y1 = Math.min(h - 1, y0 + 1)
    const fy = Math.min(1, Math.max(0, srcY - y0))
    for (let x = 0; x < IMG_SIZE; x++) {
      const srcX = (x + 0.5) * xRatio - 0.5
      const x0 = Math.max(0, Math.floor(srcX))
      const x1 = Math.min(w - 1, x0 + 1)
      const fx = Math.min(1, Math.max(0, srcX - x0))
      const base = y * IMG_SIZE + x
      for (let c = 0; c < 3; c++) {
        const p00 = data[(y0 * w + x0) * 4 + c]
        const p01 = data[(y0 * w + x1) * 4 + c]
        const p10 = data[(y1 * w + x0) * 4 + c]
        const p11 = data[(y1 * w + x1) * 4 + c]
        const v =
          p00 * (1 - fx) * (1 - fy) + p01 * fx * (1 - fy) + p10 * (1 - fx) * fy + p11 * fx * fy
        out[c * IMG_SIZE * IMG_SIZE + base] = (v / 255 - MEAN[c]) / STD[c]
      }
    }
  }
  return out
}

// ---------------------------------------------------------------- 向量编解码（索引存储格式：base64 Float32）
export function encodeVector(vec: Float32Array): string {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength).toString('base64')
}

/** 解码索引里的向量；格式不对时返回 null（该条退化为纯关键词） */
export function decodeVector(b64: string | undefined): Float32Array | null {
  if (!b64) return null
  try {
    const buf = Buffer.from(b64, 'base64')
    if (buf.byteLength === 0 || buf.byteLength % 4 !== 0) return null
    const out = new Float32Array(buf.byteLength / 4)
    for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4)
    return out
  } catch {
    return null
  }
}

/** 余弦相似度（向量已归一化时即点积） */
export function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) s += a[i] * b[i]
  return s
}

// ---------------------------------------------------------------- CLIP 会话
export class ClipEngine {
  private session!: ort.InferenceSession
  private tokenizer!: BertTokenizer
  private half = false

  static async create(modelDir: string): Promise<ClipEngine> {
    const engine = new ClipEngine()
    engine.tokenizer = new BertTokenizer(join(modelDir, CLIP_VOCAB_FILE))
    engine.session = await ort.InferenceSession.create(join(modelDir, CLIP_MODEL_FILE), {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all'
    })
    return engine
  }

  get inputNames(): readonly string[] {
    return this.session.inputNames
  }
  get outputNames(): readonly string[] {
    return this.session.outputNames
  }

  private tensorFor(f32data: Float32Array, dims: number[]): ort.Tensor {
    if (this.half) {
      const u16 = new Uint16Array(f32data.length)
      for (let i = 0; i < f32data.length; i++) u16[i] = f32ToF16(f32data[i])
      return new ort.Tensor('float16', u16, dims)
    }
    return new ort.Tensor('float32', f32data, dims)
  }

  private readOutput(tensor: ort.Tensor): Float32Array {
    if (tensor.type === 'float16') {
      const data = tensor.data as unknown as Uint16Array
      const out = new Float32Array(data.length)
      for (let i = 0; i < data.length; i++) out[i] = f16ToF32(data[i])
      return out
    }
    return Float32Array.from(tensor.data as Float32Array)
  }

  private static normalize(vec: Float32Array): Float32Array {
    let norm = 0
    for (const v of vec) norm += v * v
    norm = Math.sqrt(norm) || 1
    const out = new Float32Array(vec.length)
    for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm
    return out
  }

  private async run(
    feeds: Record<string, ort.Tensor>
  ): Promise<Record<string, ort.Tensor>> {
    try {
      return await this.session.run(feeds)
    } catch (err) {
      // FP16 图首次以 float32 喂入会报类型错误 → 切换为 float16 重试并记住
      if (!this.half && /float16|tensor\(float\)|Unexpected input data type/i.test(String(err))) {
        this.half = true
        const converted: Record<string, ort.Tensor> = {}
        for (const [k, v] of Object.entries(feeds)) {
          converted[k] =
            v.type === 'float32'
              ? this.tensorFor(v.data as Float32Array, [...v.dims])
              : v
        }
        return await this.session.run(converted)
      }
      throw err
    }
  }

  /** 同时跑两侧（合并图）；只给一侧时另一侧喂零/占位，返回归一化后的 { text, image } */
  async embedBoth(input: {
    text?: string
    pixelValues?: Float32Array
  }): Promise<{ text?: Float32Array; image?: Float32Array }> {
    const ids = input.text !== undefined ? this.tokenizer.encode(input.text) : [101, 102]
    const seqLen = ids.length
    const inputIds = new BigInt64Array(seqLen)
    const attn = new BigInt64Array(seqLen)
    for (let i = 0; i < seqLen; i++) {
      inputIds[i] = BigInt(ids[i])
      attn[i] = 1n
    }
    const pixels = input.pixelValues ?? new Float32Array(3 * IMG_SIZE * IMG_SIZE)
    const feeds: Record<string, ort.Tensor> = {}
    for (const name of this.session.inputNames) {
      if (name === 'input_ids') feeds[name] = new ort.Tensor('int64', inputIds, [1, seqLen])
      else if (name === 'attention_mask') feeds[name] = new ort.Tensor('int64', attn, [1, seqLen])
      else if (name === 'token_type_ids')
        feeds[name] = new ort.Tensor('int64', new BigInt64Array(seqLen), [1, seqLen])
      else if (name === 'pixel_values') feeds[name] = this.tensorFor(pixels, [1, 3, IMG_SIZE, IMG_SIZE])
    }
    const results = await this.run(feeds)
    const out: { text?: Float32Array; image?: Float32Array } = {}
    for (const name of this.session.outputNames) {
      const t = results[name]
      if (!t) continue
      const vec = this.readOutput(t)
      if (/text/i.test(name) && vec.length >= 512) out.text = ClipEngine.normalize(vec.slice(0, 512))
      else if (/image/i.test(name) && vec.length >= 512)
        out.image = ClipEngine.normalize(vec.slice(0, 512))
    }
    return out
  }

  async embedText(text: string): Promise<Float32Array> {
    const { text: vec } = await this.embedBoth({ text })
    if (!vec) throw new Error(`模型未输出文本向量（outputs: ${this.outputNames.join(', ')}）`)
    return vec
  }

  async embedImage(imageBuf: Buffer | Uint8Array): Promise<Float32Array> {
    const pixels = imageToTensor(decodeImage(imageBuf))
    const { image } = await this.embedBoth({ pixelValues: pixels })
    if (!image) throw new Error(`模型未输出图像向量（outputs: ${this.outputNames.join(', ')}）`)
    return image
  }
}

// ---------------------------------------------------------------- 引擎单例（按模型目录缓存）
export function isClipModelReady(modelDir: string | undefined): boolean {
  if (!modelDir?.trim()) return false
  return (
    existsSync(join(modelDir, CLIP_MODEL_FILE)) && existsSync(join(modelDir, CLIP_VOCAB_FILE))
  )
}

let engineCache: { dir: string; promise: Promise<ClipEngine> } | null = null

/**
 * 取引擎单例：模型文件缺失返回 null（调用方退化）；加载失败不缓存，下次调用重试。
 * 首次加载约需 10~20 秒（377MB FP16 图），后续调用复用同一会话。
 */
export async function getClipEngine(modelDir: string | undefined): Promise<ClipEngine | null> {
  const dir = modelDir?.trim() ?? ''
  if (!dir || !isClipModelReady(dir)) return null
  if (engineCache && engineCache.dir === dir) {
    try {
      return await engineCache.promise
    } catch {
      engineCache = null
      return null
    }
  }
  const promise = ClipEngine.create(dir)
  engineCache = { dir, promise }
  try {
    return await promise
  } catch {
    if (engineCache?.promise === promise) engineCache = null
    return null
  }
}
