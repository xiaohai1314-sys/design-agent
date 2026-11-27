import { readFileSync, statSync } from 'node:fs'
import { extname } from 'node:path'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import type { ModelProviderProfile } from '@shared/protocol'
import { createChatModel } from '../modelFactory'

const DESCRIBE_PROMPT = `你负责把一张图片转述成文字，供一个看不到图片的模型阅读。
只描述图上真实可见的内容，不要推测图外信息，不要给设计建议。
请覆盖以下几项：
1. 整体：图种（效果图 / 平面图 / 立面图 / 软件截图 / 现场照片）、视角、构图与大致比例。
2. 空间与结构：可见的墙、门、窗、梁柱、楼梯、隔断的位置和数量关系，透视是否正常。
3. 材质与色彩：地面、墙面、顶面与主要家具的材质、颜色、纹理。
4. 物件与文字：可辨认的家具、灯具、陈设、植物、人物；图上出现的文字、尺寸标注、图例、水印，逐条照抄。
5. 异常：畸变、穿模、残缺、乱码、重复元素、明显的水印或遮挡。
用简洁的中文分条输出，不要开场白和结尾总结。`

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp'
}

const MAX_DESCRIBE_BYTES = 8 * 1024 * 1024

export function plainTextContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === 'object' && 'text' in part
          ? String((part as { text?: unknown }).text ?? '')
          : ''
      )
      .join('')
  }
  return String(content ?? '')
}

/**
 * 主模型看不了图时，把图片交给独立视觉模型转成文字描述。
 * 转述失败直接抛出，由调用方决定是如实告知还是退回“无视觉能力”的提示。
 */
export function createImageDescriber(params: {
  modelProfile: ModelProviderProfile
  signal: AbortSignal
}): (imagePath: string) => Promise<string> {
  // 同一轮里重复读同一张图不该重复计费；按 路径+大小+修改时间 判重
  const cache = new Map<string, string>()
  return async (imagePath: string): Promise<string> => {
    const ext = extname(imagePath).toLowerCase()
    const mime = MIME[ext]
    if (!mime) throw new Error(`不支持的图片格式：${ext || '未知'}`)
    const st = statSync(imagePath)
    const cacheKey = `${imagePath}|${st.size}|${st.mtimeMs}`
    const cached = cache.get(cacheKey)
    if (cached) return cached
    if (st.size > MAX_DESCRIBE_BYTES) {
      throw new Error(`图片过大（${Math.round(st.size / 1024 / 1024)}MB），请先压缩到 8MB 以内`)
    }
    const dataUrl = `data:${mime};base64,${readFileSync(imagePath).toString('base64')}`
    const model = createChatModel(params.modelProfile, { thinking: false })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('图片转述超时（60 秒）')), 60000)
      })
      const res = await Promise.race([
        model.invoke(
          [
            new SystemMessage(DESCRIBE_PROMPT),
            new HumanMessage({
              content: [
                { type: 'text', text: '请转述这张图片。' },
                { type: 'image_url', image_url: { url: dataUrl } }
              ] as never
            })
          ],
          { signal: params.signal }
        ),
        timeout
      ])
      const text = plainTextContent(res.content).trim()
      if (!text) throw new Error('视觉模型没有返回内容')
      cache.set(cacheKey, text)
      return text
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}
