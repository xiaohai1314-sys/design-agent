import type {
  ImageChannelTestLevel,
  ImageChannelTestResult,
  ImageGenChannel
} from '@shared/protocol'
import { normalizeOpenAiBaseUrl, runImageOnChannel } from '../runtime/tools/imageChannelExec'

/**
 * 生图渠道连通性测试（设置页渠道卡片「测试」/「真实出图测试」按钮的后端）。
 * 与 ccSwitchService.testModelProfileConnection 同构：主进程执行、返回 { ok, latencyMs, detail/error }。
 *
 * 两级语义：
 * - probe（轻量探活，免费）：GET {baseUrl}/models，只验可达性 + 鉴权 + 模型是否在列表中。
 *   中转渠道的 /models 经常未开放或列表不完整，因此「探活未通过」与「硬失败」严格区分：
 *   只有网络层失败（DNS/拒连/超时）与鉴权 401/403 才算 error（渠道基本不可用）；
 *   /models 本身不可用（404/405/空列表/不可解析）只记 warning——探活未通过，不代表出图不可用。
 * - generate（真实出图，用户手动触发）：走与运行时完全相同的单渠道出图路径
 *   （runtime/tools/imageChannelExec.runImageOnChannel）真出一张图，验全链。
 *   绝不自动调用（不在保存/启动时跑），避免无谓消耗出图额度。
 */

const PROBE_TIMEOUT_MS = 15000
const GENERATE_TEST_TIMEOUT_MS = 180000
const GENERATE_TEST_PROMPT =
  'A single solid red circle centered on a pure white background, minimal flat illustration, no text'
// 1024x1024 是主流生图模型（gpt-image-1 / dall-e-3 / Kolors / Nano 类）共同接受的最小尺寸；
// 256/512 会被部分模型直接拒绝、造成误报，故测试图固定用它，仍只计一次出图调用。
const GENERATE_TEST_SIZE = '1024x1024'

function describeProbeFetchFailure(err: unknown): string {
  const name = (err as { name?: string })?.name ?? ''
  if (name === 'TimeoutError' || name === 'AbortError') {
    return `请求超时（${PROBE_TIMEOUT_MS / 1000} 秒内无响应）：请检查 Base URL 与网络/中转状态`
  }
  const cause = (err as { cause?: { code?: string } })?.cause
  if (cause?.code === 'ENOTFOUND' || cause?.code === 'EAI_AGAIN') {
    return `域名解析失败（${cause.code}）：请检查 Base URL 是否写错`
  }
  if (cause?.code === 'ECONNREFUSED') {
    return '连接被拒绝（ECONNREFUSED）：请确认中转服务已启动且端口正确'
  }
  return err instanceof Error ? err.message : String(err)
}

function looksLikeImage(buf: Buffer): boolean {
  if (buf.length < 12) return false
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  ) {
    return true // PNG
  }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true // JPEG
  if (buf.toString('ascii', 0, 4) === 'GIF8') return true // GIF
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return true // WebP
  }
  if (buf.toString('ascii', 0, 2) === 'BM') return true // BMP
  return false
}

async function probeImageChannel(channel: ImageGenChannel): Promise<ImageChannelTestResult> {
  const started = Date.now()
  const done = (partial: Omit<ImageChannelTestResult, 'level' | 'latencyMs'>): ImageChannelTestResult => ({
    level: 'probe',
    latencyMs: Date.now() - started,
    ...partial
  })

  const apiKey = channel.apiKey.trim()
  if (!apiKey) {
    return done({ ok: false, error: '未填写 API Key，无法探活' })
  }
  const baseUrl = normalizeOpenAiBaseUrl(channel.baseUrl)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  let resp: Response
  try {
    resp = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal
    })
  } catch (err) {
    return done({ ok: false, error: describeProbeFetchFailure(err) })
  } finally {
    clearTimeout(timer)
  }

  if (resp.status === 401 || resp.status === 403) {
    return done({
      ok: false,
      error: `鉴权失败（HTTP ${resp.status}）：API Key 无效或无权限，请检查 Key`
    })
  }

  // /models 在不少中转上未开放或行为不标准：非 2xx 一律按「探活未通过」软处理，
  // 不据此判定渠道坏死（与上面的网络层失败、鉴权失败相区分）。
  if (!resp.ok) {
    return done({
      ok: false,
      warning: `探活未通过：该渠道未开放 /models 模型列表接口（HTTP ${resp.status}），不少中转属于这种情况，不代表出图不可用——可用「真实出图测试」确认`
    })
  }

  let ids: string[] = []
  try {
    const json = (await resp.json()) as { data?: Array<{ id?: string }> }
    if (!Array.isArray(json.data)) throw new Error('missing data array')
    ids = json.data.map((m) => (m?.id || '').trim()).filter(Boolean)
  } catch {
    return done({
      ok: false,
      warning:
        '探活未通过：/models 返回内容无法解析为模型列表，无法确认模型可用性（不代表出图不可用）'
    })
  }

  if (ids.length === 0) {
    return done({
      ok: false,
      warning: '探活未通过：/models 返回了空的模型列表，无法确认模型可用性（不代表出图不可用）'
    })
  }

  const wanted = [...new Set([channel.model, channel.editModel ?? ''].map((m) => m.trim()).filter(Boolean))]
  const missing = wanted.filter((m) => !ids.includes(m))
  if (missing.length > 0) {
    return done({
      ok: true,
      detail: '接口可达、鉴权通过',
      warning: `模型列表中未找到「${missing.join('」「')}」（渠道共返回 ${ids.length} 个模型；中转的模型列表常不完整，未列出不代表不能出图）`
    })
  }
  return done({
    ok: true,
    detail:
      wanted.length > 0
        ? `接口可达、鉴权通过；模型「${wanted.join('」「')}」在渠道模型列表中`
        : `接口可达、鉴权通过（渠道共返回 ${ids.length} 个模型）`
  })
}

async function generateImageChannelTest(
  channel: ImageGenChannel
): Promise<ImageChannelTestResult> {
  const started = Date.now()
  const done = (partial: Omit<ImageChannelTestResult, 'level' | 'latencyMs'>): ImageChannelTestResult => ({
    level: 'generate',
    latencyMs: Date.now() - started,
    ...partial
  })

  if (!channel.apiKey.trim()) {
    return done({ ok: false, error: '未填写 API Key，无法测试出图' })
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), GENERATE_TEST_TIMEOUT_MS)
  try {
    const { buf, model } = await runImageOnChannel({
      channel,
      req: { kind: 'generate', prompt: GENERATE_TEST_PROMPT, size: GENERATE_TEST_SIZE },
      signal: controller.signal
    })
    if (!looksLikeImage(buf)) {
      return done({
        ok: false,
        error: `接口返回了内容（${buf.length} bytes），但不是可识别的图片数据（PNG/JPEG/WebP 等），渠道响应格式可能不兼容`
      })
    }
    return done({
      ok: true,
      detail: `真实出图成功：模型「${model}」返回图片 ${buf.length} bytes`
    })
  } catch (err) {
    if (controller.signal.aborted) {
      return done({
        ok: false,
        error: `真实出图测试超时（${GENERATE_TEST_TIMEOUT_MS / 1000} 秒内未完成出图）`
      })
    }
    const msg = err instanceof Error ? err.message : String(err)
    return done({ ok: false, error: msg.slice(0, 300) })
  } finally {
    clearTimeout(timer)
  }
}

export async function testImageChannelConnection(
  channel: ImageGenChannel,
  level: ImageChannelTestLevel
): Promise<ImageChannelTestResult> {
  return level === 'generate' ? generateImageChannelTest(channel) : probeImageChannel(channel)
}
