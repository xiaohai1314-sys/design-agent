import { readFileSync } from 'node:fs'
import { basename, extname } from 'node:path'
import type { ImageGenChannel } from '@shared/protocol'

/**
 * 单个生图渠道的实际出图执行（协议顺序、端点兜底、响应解析）。
 * 从 imageTools.ts 抽出为共享模块：运行时生图工具与设置页「渠道连通性测试」
 * （主进程 imageChannelTestService）共用同一条调用路径，避免两套协议逻辑漂移。
 */

export function mimeForExt(p: string): string {
  const ext = extname(p).toLowerCase()
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.webp') return 'image/webp'
  return 'image/png'
}

export function normalizeOpenAiBaseUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim().replace(/\/+$/, '').replace(/\/images\/(generations|edits)$/i, '')
  if (!trimmed) return 'https://api.openai.com/v1'
  return /\/v\d+$/i.test(trimmed) ? trimmed : `${trimmed}/v1`
}

export function withRequestTimeout(parentSignal: AbortSignal, timeoutMs: number): AbortSignal {
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

// Gemini / Nano-Banana 类中转生图模型通常原生走 /chat/completions，先走对话生图可省去 /images/* 60s 无效等待与重连超时
export const CHAT_IMAGE_FIRST_RE = /(gemini-|nano-?banana|banana)/i
export const IMAGE_REQUEST_TIMEOUT_MS = 90000

export function formatFetchError(err: unknown, parentSignal: AbortSignal, timeoutSec: number): string {
  if (parentSignal.aborted) return '操作已取消'
  const name = (err as { name?: string })?.name ?? ''
  if (name === 'TimeoutError' || name === 'AbortError') {
    return `生图接口请求超时（等待超过 ${timeoutSec} 秒未响应）`
  }
  return err instanceof Error ? err.message : String(err)
}

export async function decodeImagePayload(params: {
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

export async function tryChatCompletionsImageFallback(params: {
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

export interface ImageRunRequest {
  kind: 'generate' | 'edit'
  prompt: string
  refPath?: string
  fileBuf?: Buffer
  size?: string
}

/**
 * 在单个渠道上出图：协议顺序由渠道 protocol 决定（auto 时沿用按模型名猜测的旧行为），
 * /chat/completions 与 /images/* 互为兜底；失败时抛错，交由调用方（降级链 / 测试服务）处理。
 */
export async function runImageOnChannel(params: {
  channel: ImageGenChannel
  req: ImageRunRequest
  signal: AbortSignal
  /** 渠道未设 defaultSize 时的兜底尺寸（运行时传入全局配置的 defaultSize） */
  fallbackDefaultSize?: string
}): Promise<{ buf: Buffer; model: string }> {
  const { channel, req, signal } = params
  const baseUrl = normalizeOpenAiBaseUrl(channel.baseUrl)
  const targetModel = (
    req.kind === 'edit'
      ? channel.editModel || channel.model || 'gpt-image-1'
      : channel.model || 'dall-e-3'
  ).trim()
  const size = req.size || channel.defaultSize || params.fallbackDefaultSize || '1024x1024'
  const unsupportedLabel = req.kind === 'edit' ? '不支持图生图或响应超时' : '不支持生图或响应超时'
  const chatFirst =
    channel.protocol === 'chat-first'
      ? true
      : channel.protocol === 'images-first'
        ? false
        : CHAT_IMAGE_FIRST_RE.test(targetModel)

  const extractFromImagesResp = async (resp: Response): Promise<Buffer> => {
    const json = (await resp.json()) as {
      data?: Array<{ b64_json?: string; url?: string }>
    }
    const first = json.data?.[0]
    if (!first) throw new Error('接口未返回图片数据')
    return decodeImagePayload({
      b64: first.b64_json,
      dataUrlOrUrl: first.url,
      signal
    })
  }

  let resp: Response | null = null
  let imgBuf: Buffer | null = null
  let imgErrText = ''

  const tryImagesApi = async (): Promise<void> => {
    try {
      if (req.kind === 'edit') {
        const form = new FormData()
        form.append(
          'image',
          new Blob([new Uint8Array(req.fileBuf!)], { type: mimeForExt(req.refPath!) }),
          basename(req.refPath!)
        )
        form.append('prompt', req.prompt)
        form.append('model', targetModel)
        form.append('n', '1')
        form.append('size', size)
        resp = await fetch(`${baseUrl}/images/edits`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${channel.apiKey}` },
          body: form,
          signal: withRequestTimeout(signal, IMAGE_REQUEST_TIMEOUT_MS)
        })
      } else {
        resp = await fetch(`${baseUrl}/images/generations`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${channel.apiKey}`
          },
          body: JSON.stringify({ model: targetModel, prompt: req.prompt, n: 1, size }),
          signal: withRequestTimeout(signal, IMAGE_REQUEST_TIMEOUT_MS)
        })
      }
      if (resp.ok) {
        imgBuf = await extractFromImagesResp(resp)
      } else {
        imgErrText = (await resp.text().catch(() => '')).slice(0, 220)
      }
    } catch (err) {
      if (signal.aborted) throw err
      imgErrText = formatFetchError(err, signal, IMAGE_REQUEST_TIMEOUT_MS / 1000)
    }
  }

  const tryChatApi = async (): Promise<void> => {
    try {
      imgBuf = await tryChatCompletionsImageFallback({
        baseUrl,
        apiKey: channel.apiKey,
        model: targetModel,
        prompt: req.prompt,
        refPath: req.refPath,
        signal
      })
    } catch (err) {
      if (signal.aborted) throw err
      imgErrText = formatFetchError(err, signal, IMAGE_REQUEST_TIMEOUT_MS / 1000)
    }
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
      `模型（${targetModel}）或所在中转渠道${unsupportedLabel}（${statusNote}${imgErrText ? `：${imgErrText}` : ''}）`
    )
  }
  return { buf: imgBuf, model: targetModel }
}
