import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname } from 'node:path'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import type { ModelProviderProfile } from '@shared/protocol'
import { resolvePathWithinRoot } from '@shared/workspacePaths'
import { createChatModel } from '../modelFactory'
import { loadProjectProfile, summarizeProfile } from '../projectProfile'

const REVIEW_PROMPT = `你是室内 / 建筑效果图的审图员。对照「出图要求」和「项目档案」检查这张图，只看图上真实可见的内容，不要脑补。
重点检查：
1. 空间关系：墙、门、窗的位置与数量是否和要求一致，有没有多出或缺少的墙、门窗，透视是否明显变形。
2. 风格与材质：整体风格、主材是否符合要求；有没有出现项目档案里明确否决的材料或元素。
3. 关键物件：要求中点名的家具、灯具、陈设是否出现、尺度是否合理。
4. 画面质量：明显的畸变、穿模、文字乱码、水印、人物或物体残缺。
只返回一个 JSON 对象，不要附加其他文字：
{"pass": true/false, "score": 0-100, "issues": ["具体问题，指出画面位置"], "prompt_fix": "重出时应在提示词里补充或修改的内容（通过时留空）"}
判定标准：存在空间关系错误、出现否决项、或缺少点名的关键物件时 pass 必须为 false；只有轻微瑕疵时 pass 为 true 并把瑕疵写进 issues。`

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp'
}

function plainText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === 'object' && 'text' in part ? String((part as { text?: unknown }).text ?? '') : ''))
      .join('')
  }
  return String(content ?? '')
}

/**
 * review_image：用当前对话模型的视觉能力审查一张效果图，返回是否通过、问题清单与改提示词的建议。
 * 模型不支持看图或调用失败时如实返回“无法自动审查”，不阻断交付流程。
 */
export function createImageReviewTool(params: {
  rootDir: string
  modelProfile: ModelProviderProfile
  profilePath?: string
  signal: AbortSignal
}): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'review_image',
    description:
      '出图后的自动审查：把生成的效果图交给视觉模型，对照出图要求和项目档案（风格、主材、否决项）检查空间关系、风格材质、关键物件和画面质量，返回 {pass, score, issues, prompt_fix}。' +
      '每张准备交付的效果图都应先调用；pass=false 时按 prompt_fix 调整提示词重出一次再审，仍不通过就如实向用户说明问题，不要把不合格的图当成品交付。',
    schema: z.object({
      image_path: z.string().min(1).describe('要审查的图片路径（工作区内，png / jpg / webp）'),
      requirements: z.string().min(1).describe('这张图的出图要求：空间、视角、风格、必须出现的物件、门窗位置等，尽量具体')
    }),
    func: async ({ image_path, requirements }) => {
      const target = resolvePathWithinRoot(params.rootDir, image_path)
      if (!existsSync(target)) throw new Error(`图片不存在：${target}`)
      const mime = MIME[extname(target).toLowerCase()]
      if (!mime) throw new Error('只支持 png / jpg / webp 图片')
      const size = statSync(target).size
      if (size > 8 * 1024 * 1024) {
        return JSON.stringify({ pass: null, reviewed: false, reason: `图片过大（${Math.round(size / 1024 / 1024)}MB），请先压缩到 8MB 以内再审查` })
      }
      const profile = params.profilePath ? loadProjectProfile(params.profilePath) : null
      const context = [
        `出图要求：\n${requirements}`,
        profile ? `项目档案：\n${summarizeProfile(profile, 1500)}` : '项目档案：无'
      ].join('\n\n')
      const dataUrl = `data:${mime};base64,${readFileSync(target).toString('base64')}`
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const model = createChatModel(params.modelProfile, { thinking: false })
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('审查超时（60 秒）')), 60000)
        })
        const res = await Promise.race([
          model.invoke(
            [
              new SystemMessage(REVIEW_PROMPT),
              new HumanMessage({
                content: [
                  { type: 'text', text: context },
                  { type: 'image_url', image_url: { url: dataUrl } }
                ] as never
              })
            ],
            { signal: params.signal }
          ),
          timeout
        ])
        const text = plainText(res.content).trim()
        const match = /\{[\s\S]*\}/.exec(text)
        if (!match) {
          return JSON.stringify({ pass: null, reviewed: false, reason: '审查模型没有返回结构化结果', raw: text.slice(0, 600) })
        }
        const parsed = JSON.parse(match[0]) as { pass?: boolean; score?: number; issues?: string[]; prompt_fix?: string }
        return JSON.stringify(
          {
            reviewed: true,
            image: target.replace(/\\/g, '/'),
            pass: parsed.pass === true,
            score: typeof parsed.score === 'number' ? parsed.score : undefined,
            issues: Array.isArray(parsed.issues) ? parsed.issues : [],
            prompt_fix: parsed.prompt_fix ?? ''
          },
          null,
          2
        )
      } catch (err) {
        if (params.signal.aborted) throw err
        const message = err instanceof Error ? err.message : String(err)
        return JSON.stringify({
          pass: null,
          reviewed: false,
          reason: `无法自动审查（当前模型可能不支持看图，或调用失败：${message}）。请用 read_file 自行查看图片，对照要求检查后再决定是否交付。`
        })
      } finally {
        if (timer) clearTimeout(timer)
      }
    }
  })
}
