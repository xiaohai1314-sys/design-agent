import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import { resolveToolCallId } from './callId'
import type {
  AskImageEditToolData,
  GenerateImageToolData,
  ImageEditAnswer,
  ImageGenChannel,
  ImageGenConfig,
  ModelProviderProfile,
  SceneParam,
  VisionConfig
} from '@shared/protocol'
import { capturePreEditSnapshot, recordImageLineageSnapshot } from '@shared/fileSnapshots'
import { resolveImageChannels, sortChannelsForRole } from '@shared/imageChannels'
import { resolveImageTaskRoute } from '../imageRouting'
import { runImageOnChannel, type ImageRunRequest } from './imageChannelExec'
import type { ApprovalGate } from './workspaceTools'

function normalizeWinPath(raw: string): string {
  const t = raw.trim()
  return /^\/[a-zA-Z]:[\\/]/.test(t) ? t.slice(1) : t
}

function resolveLocalFile(rootDir: string, input: string): string {
  const cleaned = normalizeWinPath(input)
  return isAbsolute(cleaned) ? resolve(cleaned) : resolve(rootDir, cleaned)
}

const IMAGE_CAPABLE_MODEL_RE =
  /(dall-e|gpt-image|gpt-4o-image|imagen|flux|sdxl|stable-diffusion|midjourney|\bmj\b|jimeng|seedream|wanx|cogview|kolors|recraft|ideogram|nano-?banana|banana|image-preview|flash-image|pro-image|gemini-.*image|grok-2-image|doubao-seedream|hunyuan-image|qwen-image)/i

export function isImageCapableModel(modelName?: string): boolean {
  const m = (modelName || '').trim()
  if (!m) return false
  return IMAGE_CAPABLE_MODEL_RE.test(m)
}

/** 能看图的模型。「能生图」和「能看图」是两件事，别用上面那个判断代替。 */
const VISION_CAPABLE_MODEL_RE =
  /(claude-|gpt-4o|gpt-4\.1|gpt-5|\bo3\b|\bo4\b|gemini|qwen[\w.-]*vl|glm-4(\.\d)?v|internvl|llava|pixtral|step-1v|yi-vision|doubao[\w.-]*vision|grok[\w.-]*vision|moonshot[\w.-]*vision|kimi[\w.-]*vision)/i

export function isVisionCapableModel(modelName?: string): boolean {
  const m = (modelName || '').trim()
  if (!m) return false
  return VISION_CAPABLE_MODEL_RE.test(m)
}

/**
 * 审图该用哪个模型：配了独立视觉模型就用它；没配则只有主模型确实支持视觉时才退回主模型；
 * 两者都不满足返回 null，调用方据此不注册 review_image，避免暴露一个注定失败的工具。
 */
export function resolveVisionProfile(params: {
  modelProfile: ModelProviderProfile
  visionConfig?: VisionConfig
}): ModelProviderProfile | null {
  const cfg = params.visionConfig
  if (cfg?.enabled && cfg.apiKey.trim() && cfg.model.trim()) {
    return {
      id: 'vision',
      label: '视觉模型',
      protocol: cfg.protocol ?? 'openai',
      baseUrl: cfg.baseUrl.trim(),
      apiKey: cfg.apiKey,
      model: cfg.model.trim(),
      subagentModel: cfg.model.trim(),
      supportsThinking: false,
      maxOutputTokens: 4096
    }
  }
  return isVisionCapableModel(params.modelProfile.model) ? params.modelProfile : null
}

export function hasImageGenCapability(params: {
  modelProfile?: ModelProviderProfile
  imageGenConfig?: ImageGenConfig
}): boolean {
  if (resolveImageChannels(params.imageGenConfig).length > 0) {
    return true
  }
  if (params.modelProfile?.apiKey?.trim() && isImageCapableModel(params.modelProfile.model)) {
    return true
  }
  return false
}

export function createImageTools(params: {
  rootDir: string
  modelProfile?: ModelProviderProfile
  imageGenConfig?: ImageGenConfig
  /** 当前轮次的任务上下文（目录 featureCode / toolTitle），用于生图渠道按任务路由 */
  sceneParam?: SceneParam
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
    func: async ({ image_path, hint }, runManager, config) => {
      const resolved = resolveLocalFile(params.rootDir, image_path)
      if (!existsSync(resolved)) {
        throw new Error(`无法打开标注底图，文件不存在：${resolved}`)
      }
      const callId =
        resolveToolCallId(runManager, config)

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

  // 2. generate_image & edit_image_with_ref：
  //    优先使用独立配置的生图渠道列表（多渠道降级链），未配渠道时才回退到主模型原生生图。
  const taskRoute = resolveImageTaskRoute({
    featureCode: params.sceneParam?.featureCode,
    toolTitle: params.sceneParam?.toolTitle
  })

  const configuredChannels = resolveImageChannels(params.imageGenConfig)
  // 非主渠道要求字段完整（baseUrl + model），残缺的备用渠道直接跳过、不进降级链
  const usableConfigured = configuredChannels.filter(
    (c, i) => i === 0 || (c.baseUrl.trim() && c.model.trim())
  )
  const profileChannel: ImageGenChannel | null =
    params.modelProfile?.apiKey?.trim() && isImageCapableModel(params.modelProfile.model)
      ? {
          id: 'chat-profile',
          name: `主对话模型（${params.modelProfile.label || params.modelProfile.model}）`,
          enabled: true,
          baseUrl: params.modelProfile.baseUrl || '',
          apiKey: params.modelProfile.apiKey,
          model: params.modelProfile.model || '',
          protocol: 'auto'
        }
      : null
  const candidateChannels: ImageGenChannel[] =
    usableConfigured.length > 0 ? usableConfigured : profileChannel ? [profileChannel] : []

  if (candidateChannels.length > 0) {
    const saveImageBuffer = (buf: Buffer, outPath: string): number => {
      mkdirSync(dirname(outPath), { recursive: true })
      writeFileSync(outPath, buf)
      return buf.byteLength
    }

    // 单渠道出图走共享执行模块（imageChannelExec），与设置页渠道连通性测试共用同一条调用路径
    const runOnChannel = (
      channel: ImageGenChannel,
      req: ImageRunRequest
    ): Promise<{ buf: Buffer; model: string }> =>
      runImageOnChannel({
        channel,
        req,
        signal: params.signal,
        fallbackDefaultSize: params.imageGenConfig?.defaultSize
      })

    // 降级链：按任务路由偏好排序渠道，逐个尝试；全部失败后才报错，
    // 报错语义保持不变——如实告知用户，严禁用假图/脚本渲染顶替。
    const runWithChannelChain = async (
      req: ImageRunRequest
    ): Promise<{ buf: Buffer; channel: ImageGenChannel; model: string }> => {
      const ordered = sortChannelsForRole(
        candidateChannels,
        taskRoute?.preferRole ?? req.kind
      )
      const failures: string[] = []
      for (const channel of ordered) {
        try {
          const hit = await runOnChannel(channel, req)
          return { buf: hit.buf, channel, model: hit.model }
        } catch (err) {
          if (params.signal.aborted) throw err
          failures.push(
            `${channel.name}：${err instanceof Error ? err.message : String(err)}`
          )
        }
      }
      throw new Error(
        `已依次尝试全部 ${ordered.length} 个生图渠道仍未出图（${failures.join('；')}）。请直接停下并如实告知用户检查或切换生图渠道，严禁用相同参数重试或改用 Python 编写三维模型/软渲染器代替。`
      )
    }

    const generateImageTool = new DynamicStructuredTool({
      name: 'generate_image',
      description:
        '文生图工具：直接通过生图渠道（多渠道自动降级）生成空间效果图、概念意向图或彩平图并保存到工作区。生成前请先阅读 image-prompt-rewrite 技能优化提示词。若返回全部渠道不支持生图，请直接如实告知用户检查或切换生图渠道，严禁改用 Python 编写三维模型或渲染脚本代替。',
      schema: z.object({
        prompt: z.string().min(1).describe('精细完整的图像生成提示词（详细描述空间尺度、材质、光影、视角与风格）'),
        image_name: z.string().optional().describe('输出图片文件名（不含扩展名，如“茶室概念意向图_01”）'),
        size: z.string().optional().describe('图片尺寸，如 1024x1024、1536x1024 或 1024x768')
      }),
      func: async ({ prompt, image_name, size }, runManager, config) => {
        const callId =
          resolveToolCallId(runManager, config)

        const safeName = (image_name || `render_${Date.now()}`)
          .replace(/[<>:"/\\|?*]/g, '_')
          .replace(/\.png$/i, '')
        const outPath = join(params.rootDir, 'renders', `${safeName}.png`)

        await params.requireApproval('generate_image', { image_name: `${safeName}.png`, prompt }, callId)

        const { buf: imgBuf, channel, model } = await runWithChannelChain({
          kind: 'generate',
          prompt,
          size
        })

        if (existsSync(outPath)) {
          capturePreEditSnapshot({
            targetPath: outPath,
            rootDir: params.rootDir,
            sourceTool: 'generate_image',
            summary: prompt.slice(0, 80)
          })
        }
        const bytesLen = saveImageBuffer(imgBuf, outPath)
        params.recordToolData(callId, {
          kind: 'generate_image',
          prompt,
          imagePath: outPath,
          channelName: channel.name,
          model
        })

        return `图片已生成并保存至：${outPath.replace(/\\/g, '/')}（${bytesLen} bytes，出图渠道：${channel.name} / ${model}）。如需作为最终成果展示给用户，请调用 deliver 工具交付该路径。`
      }
    })
    tools.push(generateImageTool)

    const editImageWithRefTool = new DynamicStructuredTool({
      name: 'edit_image_with_ref',
      description:
        '图生图 / 垫图出效果图工具：以本地参考底图（如 CAD 导出 PNG、白模截图、现场照或局部标注图）为基础，按提示词直接生成效果图。若全部生图渠道报错，请直接如实告知用户检查或切换生图渠道，严禁私自编写 Python 三维建模或渲染脚本代替。',
      schema: z.object({
        reference_image_path: z.string().min(1).describe('参考底图/标注图的本机路径'),
        prompt: z.string().min(1).describe('改图或效果图渲染提示词（说明保留结构与材质/光影/环境/视角细节）'),
        image_name: z.string().optional().describe('输出文件名（不含扩展名）'),
        size: z.string().optional().describe('输出尺寸，如 1024x1024')
      }),
      func: async ({ reference_image_path, prompt, image_name, size }, runManager, config) => {
        const refPath = resolveLocalFile(params.rootDir, reference_image_path)
        if (!existsSync(refPath)) {
          throw new Error(`参考底图不存在：${refPath}`)
        }
        const callId =
          resolveToolCallId(runManager, config)

        const safeName = (image_name || `edit_${Date.now()}`)
          .replace(/[<>:"/\\|?*]/g, '_')
          .replace(/\.png$/i, '')
        const outPath = join(params.rootDir, 'renders', `${safeName}.png`)

        await params.requireApproval(
          'edit_image_with_ref',
          { image_name: `${safeName}.png`, reference: basename(refPath), prompt },
          callId
        )

        const fileBuf = readFileSync(refPath)
        const { buf: imgBuf, channel, model } = await runWithChannelChain({
          kind: 'edit',
          prompt,
          refPath,
          fileBuf,
          size
        })

        if (existsSync(outPath)) {
          capturePreEditSnapshot({
            targetPath: outPath,
            rootDir: params.rootDir,
            sourceTool: 'edit_image_with_ref',
            summary: `重绘前版本：${prompt.slice(0, 60)}`
          })
        }
        const bytesLen = saveImageBuffer(imgBuf, outPath)
        recordImageLineageSnapshot({
          afterPath: outPath,
          beforeRefPath: refPath,
          rootDir: params.rootDir,
          sourceTool: 'edit_image_with_ref',
          summary: `${prompt.slice(0, 80)}（出图渠道：${channel.name} / ${model}）`
        })
        params.recordToolData(callId, {
          kind: 'generate_image',
          prompt,
          imagePath: outPath,
          referenceImagePath: refPath,
          channelName: channel.name,
          model
        })

        return `图生图完成，结果已保存至：${outPath.replace(/\\/g, '/')}（${bytesLen} bytes，出图渠道：${channel.name} / ${model}）。若作为最终成品交付给用户，请调用 deliver 工具。`
      }
    })
    tools.push(editImageWithRefTool)
  }

  return tools
}
