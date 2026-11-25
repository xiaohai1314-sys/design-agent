import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import type {
  AskImageEditToolData,
  GenerateImageToolData,
  ImageEditAnswer,
  ImageGenConfig,
  ModelProviderProfile
} from '@shared/protocol'
import type { ApprovalGate } from './workspaceTools'

function normalizeWinPath(raw: string): string {
  const t = raw.trim()
  return /^\/[a-zA-Z]:[\\/]/.test(t) ? t.slice(1) : t
}

function resolveLocalFile(rootDir: string, input: string): string {
  const cleaned = normalizeWinPath(input)
  return isAbsolute(cleaned) ? resolve(cleaned) : resolve(rootDir, cleaned)
}

function mimeForExt(p: string): string {
  const ext = extname(p).toLowerCase()
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.webp') return 'image/webp'
  return 'image/png'
}

function normalizeOpenAiBaseUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim().replace(/\/+$/, '').replace(/\/images\/(generations|edits)$/i, '')
  if (!trimmed) return 'https://api.openai.com/v1'
  return /\/v\d+$/i.test(trimmed) ? trimmed : `${trimmed}/v1`
}

function withRequestTimeout(parentSignal: AbortSignal, timeoutMs: number): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([parentSignal, timeoutSignal])
  }
  const ac = new AbortController()
  const onParentAbort = (): void => ac.abort(parentSignal.reason)
  const onTimeoutAbort = (): void => ac.abort(timeoutSignal.reason)
  if (parentSignal.aborted) ac.abort(parentSignal.reason)
  else {
    parentSignal.addEventListener('abort', onParentAbort, { once: true })
    timeoutSignal.addEventListener('abort', onTimeoutAbort, { once: true })
  }
  return ac.signal
}

const IMAGE_CAPABLE_MODEL_RE =
  /(dall-e|gpt-image|gpt-4o-image|imagen|flux|sdxl|stable-diffusion|midjourney|\bmj\b|jimeng|seedream|wanx|cogview|kolors|recraft|ideogram|nano-?banana|banana|image-preview|flash-image|pro-image|gemini-.*image|grok-2-image|doubao-seedream|hunyuan-image|qwen-image)/i

// Gemini / Nano-Banana 类中转生图模型通常原生走 /chat/completions，先走对话生图可省去 /images/* 60s 无效等待与重连超时
const CHAT_IMAGE_FIRST_RE = /(gemini-|nano-?banana|banana)/i
const IMAGE_REQUEST_TIMEOUT_MS = 90000

export function isImageCapableModel(modelName?: string): boolean {
  const m = (modelName || '').trim()
  if (!m) return false
  return IMAGE_CAPABLE_MODEL_RE.test(m)
}

export function hasImageGenCapability(params: {
  modelProfile?: ModelProviderProfile
  imageGenConfig?: ImageGenConfig
}): boolean {
  if (params.imageGenConfig?.enabled && params.imageGenConfig.apiKey.trim()) {
    return true
  }
  if (params.modelProfile?.apiKey?.trim() && isImageCapableModel(params.modelProfile.model)) {
    return true
  }
  return false
}

function formatFetchError(err: unknown, parentSignal: AbortSignal, timeoutSec: number): string {
  if (parentSignal.aborted) return '操作已取消'
  const name = (err as { name?: string })?.name ?? ''
  if (name === 'TimeoutError' || name === 'AbortError') {
    return `生图接口请求超时（等待超过 ${timeoutSec} 秒未响应）`
  }
  return err instanceof Error ? err.message : String(err)
}

async function decodeImagePayload(params: {
  dataUrlOrUrl?: string
  b64?: string
  signal: AbortSignal
}): Promise<Buffer> {
  if (params.b64) return Buffer.from(params.b64, 'base64')
  const val = (params.dataUrlOrUrl || '').trim()
  if (!val) throw new Error('响应中未包含有效图片数据')
  const dataMatch = /^data:image\/[a-zA-Z0-9+.-]+;base64,(.+)$/s.exec(val)
  if (dataMatch) return Buffer.from(dataMatch[1], 'base64')
  const resp = await fetch(val, { signal: withRequestTimeout(params.signal, 45000) })
  if (!resp.ok) throw new Error(`下载生成的图片失败：HTTP ${resp.status}`)
  return Buffer.from(await resp.arrayBuffer())
}

async function tryChatCompletionsImageFallback(params: {
  baseUrl: string
  apiKey: string
  model: string
  prompt: string
  refPath?: string
  signal: AbortSignal
}): Promise<Buffer | null> {
  const endpoint = `${params.baseUrl}/chat/completions`
  const userContent: unknown = params.refPath
    ? [
        { type: 'text', text: params.prompt },
        {
          type: 'image_url',
          image_url: {
            url: `data:${mimeForExt(params.refPath)};base64,${readFileSync(params.refPath).toString('base64')}`
          }
        }
      ]
    : params.prompt

  let resp: Response
  try {
    resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${params.apiKey}`
      },
      body: JSON.stringify({
        model: params.model,
        messages: [{ role: 'user', content: userContent }]
      }),
      signal: withRequestTimeout(params.signal, IMAGE_REQUEST_TIMEOUT_MS)
    })
  } catch (err) {
    if (params.signal.aborted) throw err
    return null
  }
  if (!resp.ok) return null

  const json = (await resp.json()) as {
    choices?: Array<{
      message?: {
        content?: string | Array<{ type?: string; image_url?: { url?: string }; text?: string }>
        images?: Array<{ image_url?: { url?: string }; b64_json?: string; url?: string }>
      }
    }>
  }
  const msg = json.choices?.[0]?.message
  if (!msg) return null

  const attachedImg = msg.images?.[0]
  if (attachedImg?.b64_json || attachedImg?.url || attachedImg?.image_url?.url) {
    return decodeImagePayload({
      b64: attachedImg.b64_json,
      dataUrlOrUrl: attachedImg.url || attachedImg.image_url?.url,
      signal: params.signal
    })
  }

  if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if (part?.type === 'image_url' && part.image_url?.url) {
        return decodeImagePayload({ dataUrlOrUrl: part.image_url.url, signal: params.signal })
      }
    }
  }

  const text =
    typeof msg.content === 'string'
      ? msg.content
      : Array.isArray(msg.content)
        ? msg.content.map((p) => p?.text || '').join('\n')
        : ''

  const dataUriMatch = /data:image\/[a-zA-Z0-9+.-]+;base64,[A-Za-z0-9+/=]+/.exec(text)
  if (dataUriMatch) {
    return decodeImagePayload({ dataUrlOrUrl: dataUriMatch[0], signal: params.signal })
  }
  const mdUrlMatch = /!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/.exec(text)
  if (mdUrlMatch) {
    return decodeImagePayload({ dataUrlOrUrl: mdUrlMatch[1], signal: params.signal })
  }
  return null
}

export function createImageTools(params: {
  rootDir: string
  modelProfile?: ModelProviderProfile
  imageGenConfig?: ImageGenConfig
  signal: AbortSignal
  requireApproval: ApprovalGate
  waitForImageEdit: (toolCallId: string, imagePath: string, hint: string) => Promise<ImageEditAnswer>
  recordToolData: (toolCallId: string, data: AskImageEditToolData | GenerateImageToolData) => void
}): DynamicStructuredTool[] {
  const tools: DynamicStructuredTool[] = []

  // 1. ask_image_edit —— 前端局部涂抹/框选标注交互
  const askImageEditTool = new DynamicStructuredTool({
    name: 'ask_image_edit',
    description:
      '图片局部标注交互：当用户希望修改某张效果图/平面图的特定局部、但文字未指明精确位置时，调用此工具弹出画笔/框选编辑器让用户在原图上圈出要修改的区域，返回标注后的图片路径。',
    schema: z.object({
      image_path: z.string().min(1).describe('待用户标注的本机底图路径（绝对路径或相对工作区路径）'),
      hint: z.string().min(1).describe('展示在编辑器顶部的简短引导提示，如“请用画笔圈出需要更换材质的沙发区域”')
    }),
    func: async ({ image_path, hint }, runManager) => {
      const resolved = resolveLocalFile(params.rootDir, image_path)
      if (!existsSync(resolved)) {
        throw new Error(`无法打开标注底图，文件不存在：${resolved}`)
      }
      const callId =
        (runManager as unknown as { configurable?: { toolCallId?: string } })?.configurable?.toolCallId ??
        `imgedit_${Date.now()}`

      const answer = await params.waitForImageEdit(callId, resolved, hint)
      if (answer.action === 'cancel') {
        params.recordToolData(callId, {
          kind: 'ask_image_edit',
          hint,
          sourcePath: resolved,
          result: 'cancelled'
        })
        return '用户取消了本次图片标注操作，请询问用户是否改为文字描述或终止修改。'
      }

      params.recordToolData(callId, {
        kind: 'ask_image_edit',
        hint,
        sourcePath: resolved,
        editedPath: answer.imagePath,
        result: 'confirmed'
      })
      return `用户已完成图片局部标注，标注后的图片保存在：${answer.imagePath.replace(/\\/g, '/')}（可用 read_file 查看标注位置，再结合 edit_image_with_ref 进行图生图改图）。`
    }
  })
  tools.push(askImageEditTool)

  // 2. generate_image & edit_image_with_ref：优先使用独立配置「效果图 / 图生图 API」，否则仅在当前主模型本身具备生图能力时挂载
  const useLegacyConfig = Boolean(
    params.imageGenConfig?.enabled && params.imageGenConfig.apiKey.trim()
  )
  const rawBaseUrl = useLegacyConfig
    ? params.imageGenConfig!.baseUrl
    : params.modelProfile?.baseUrl || ''
  const activeApiKey = (
    useLegacyConfig ? params.imageGenConfig!.apiKey : params.modelProfile?.apiKey || ''
  ).trim()
  const activeModel = (
    useLegacyConfig ? params.imageGenConfig!.model : params.modelProfile?.model || ''
  ).trim()
  const activeEditModel = (
    useLegacyConfig ? params.imageGenConfig!.editModel || activeModel : activeModel
  ).trim()
  const defaultSize = params.imageGenConfig?.defaultSize || '1024x1024'

  const canGenerate = hasImageGenCapability({
    modelProfile: params.modelProfile,
    imageGenConfig: params.imageGenConfig
  })

  if (canGenerate && activeApiKey) {
    const baseUrl = normalizeOpenAiBaseUrl(rawBaseUrl)

    const saveImageBuffer = (buf: Buffer, outPath: string): number => {
      mkdirSync(dirname(outPath), { recursive: true })
      writeFileSync(outPath, buf)
      return buf.byteLength
    }

    const extractFromImagesResp = async (resp: Response): Promise<Buffer> => {
      const json = (await resp.json()) as {
        data?: Array<{ b64_json?: string; url?: string }>
      }
      const first = json.data?.[0]
      if (!first) throw new Error('接口未返回图片数据')
      return decodeImagePayload({
        b64: first.b64_json,
        dataUrlOrUrl: first.url,
        signal: params.signal
      })
    }

    const runWithFallback = async (paramsRun: {
      targetModel: string
      prompt: string
      refPath?: string
      unsupportedLabel: string
      callImagesEndpoint: () => Promise<Response>
    }): Promise<Buffer> => {
      const chatFirst = CHAT_IMAGE_FIRST_RE.test(paramsRun.targetModel)
      let resp: Response | null = null
      let imgBuf: Buffer | null = null
      let imgErrText = ''

      const tryImagesApi = async (): Promise<void> => {
        try {
          resp = await paramsRun.callImagesEndpoint()
          if (resp.ok) {
            imgBuf = await extractFromImagesResp(resp)
          } else {
            imgErrText = (await resp.text().catch(() => '')).slice(0, 220)
          }
        } catch (err) {
          if (params.signal.aborted) throw err
          imgErrText = formatFetchError(err, params.signal, IMAGE_REQUEST_TIMEOUT_MS / 1000)
        }
      }

      const tryChatApi = async (): Promise<void> => {
        imgBuf = await tryChatCompletionsImageFallback({
          baseUrl,
          apiKey: activeApiKey,
          model: paramsRun.targetModel,
          prompt: paramsRun.prompt,
          refPath: paramsRun.refPath,
          signal: params.signal
        })
      }

      if (chatFirst) {
        await tryChatApi()
        if (!imgBuf) await tryImagesApi()
      } else {
        await tryImagesApi()
        if (!imgBuf) await tryChatApi()
      }

      if (!imgBuf) {
        const statusNote = resp ? `HTTP ${(resp as Response).status}` : '请求异常/超时'
        throw new Error(
          `当前模型（${paramsRun.targetModel}）或所在中转渠道${paramsRun.unsupportedLabel}（${statusNote}${imgErrText ? `：${imgErrText}` : ''}）。请直接停下并如实告知用户切换支持出图的模型/渠道，严禁用相同参数重试或改用 Python 编写三维模型/软渲染器代替。`
        )
      }
      return imgBuf
    }

    const generateImageTool = new DynamicStructuredTool({
      name: 'generate_image',
      description:
        '文生图工具：直接通过当前模型/中转渠道生成空间效果图、概念意向图或彩平图并保存到工作区。生成前请先阅读 image-prompt-rewrite 技能优化提示词。若返回当前模型不支持生图，请直接如实告知用户切换支持出图的模型/渠道，严禁改用 Python 编写三维模型或渲染脚本代替。',
      schema: z.object({
        prompt: z.string().min(1).describe('精细完整的图像生成提示词（详细描述空间尺度、材质、光影、视角与风格）'),
        image_name: z.string().optional().describe('输出图片文件名（不含扩展名，如“茶室概念意向图_01”）'),
        size: z.string().optional().describe('图片尺寸，如 1024x1024、1536x1024 或 1024x768')
      }),
      func: async ({ prompt, image_name, size }, runManager) => {
        const callId =
          (runManager as unknown as { configurable?: { toolCallId?: string } })?.configurable?.toolCallId ??
          `genimg_${Date.now()}`

        const safeName = (image_name || `render_${Date.now()}`)
          .replace(/[<>:"/\\|?*]/g, '_')
          .replace(/\.png$/i, '')
        const outPath = join(params.rootDir, 'renders', `${safeName}.png`)

        await params.requireApproval('generate_image', { image_name: `${safeName}.png`, prompt }, callId)

        const targetModel = activeModel || 'dall-e-3'
        const endpoint = `${baseUrl}/images/generations`
        const imgBuf = await runWithFallback({
          targetModel,
          prompt,
          unsupportedLabel: '不支持生图或响应超时',
          callImagesEndpoint: () =>
            fetch(endpoint, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${activeApiKey}`
              },
              body: JSON.stringify({
                model: targetModel,
                prompt,
                n: 1,
                size: size || defaultSize
              }),
              signal: withRequestTimeout(params.signal, IMAGE_REQUEST_TIMEOUT_MS)
            })
        })

        const bytesLen = saveImageBuffer(imgBuf, outPath)
        params.recordToolData(callId, {
          kind: 'generate_image',
          prompt,
          imagePath: outPath
        })

        return `图片已生成并保存至：${outPath.replace(/\\/g, '/')}（${bytesLen} bytes）。如需作为最终成果展示给用户，请调用 deliver 工具交付该路径。`
      }
    })
    tools.push(generateImageTool)

    const editImageWithRefTool = new DynamicStructuredTool({
      name: 'edit_image_with_ref',
      description:
        '图生图 / 垫图出效果图工具：以本地参考底图（如 CAD 导出 PNG、白模截图、现场照或局部标注图）为基础，按提示词直接生成效果图。若当前模型不支持生图报错，请直接如实告知用户切换支持出图的模型/渠道，严禁私自编写 Python 三维建模或渲染脚本代替。',
      schema: z.object({
        reference_image_path: z.string().min(1).describe('参考底图/标注图的本机路径'),
        prompt: z.string().min(1).describe('改图或效果图渲染提示词（说明保留结构与材质/光影/环境/视角细节）'),
        image_name: z.string().optional().describe('输出文件名（不含扩展名）'),
        size: z.string().optional().describe('输出尺寸，如 1024x1024')
      }),
      func: async ({ reference_image_path, prompt, image_name, size }, runManager) => {
        const refPath = resolveLocalFile(params.rootDir, reference_image_path)
        if (!existsSync(refPath)) {
          throw new Error(`参考底图不存在：${refPath}`)
        }
        const callId =
          (runManager as unknown as { configurable?: { toolCallId?: string } })?.configurable?.toolCallId ??
          `editimg_${Date.now()}`

        const safeName = (image_name || `edit_${Date.now()}`)
          .replace(/[<>:"/\\|?*]/g, '_')
          .replace(/\.png$/i, '')
        const outPath = join(params.rootDir, 'renders', `${safeName}.png`)

        await params.requireApproval(
          'edit_image_with_ref',
          { image_name: `${safeName}.png`, reference: basename(refPath), prompt },
          callId
        )

        const targetModel = activeEditModel || activeModel || 'gpt-image-1'
        const fileBuf = readFileSync(refPath)
        const editEndpoint = `${baseUrl}/images/edits`
        const imgBuf = await runWithFallback({
          targetModel,
          prompt,
          refPath,
          unsupportedLabel: '不支持图生图或响应超时',
          callImagesEndpoint: () => {
            const form = new FormData()
            form.append('image', new Blob([fileBuf], { type: mimeForExt(refPath) }), basename(refPath))
            form.append('prompt', prompt)
            form.append('model', targetModel)
            form.append('n', '1')
            form.append('size', size || defaultSize)
            return fetch(editEndpoint, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${activeApiKey}`
              },
              body: form,
              signal: withRequestTimeout(params.signal, IMAGE_REQUEST_TIMEOUT_MS)
            })
          }
        })

        const bytesLen = saveImageBuffer(imgBuf, outPath)
        params.recordToolData(callId, {
          kind: 'generate_image',
          prompt,
          imagePath: outPath,
          referenceImagePath: refPath
        })

        return `图生图完成，结果已保存至：${outPath.replace(/\\/g, '/')}（${bytesLen} bytes）。若作为最终成品交付给用户，请调用 deliver 工具。`
      }
    })
    tools.push(editImageWithRefTool)
  }

  return tools
}
