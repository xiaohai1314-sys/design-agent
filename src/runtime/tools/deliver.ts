import { existsSync, statSync } from 'node:fs'
import { basename, isAbsolute, resolve } from 'node:path'
import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import { fileCategoryOf } from '@shared/fileCategory'
import type { Deliverable } from '@shared/protocol'

function normalizeWinDrivePath(raw: string): string {
  // 修正类似 "/D:/foo/bar" 的路径写法 —— 对齐原版 Jue(t)
  if (/^\/[a-zA-Z]:[\\/]/.test(raw)) {
    return raw.slice(1)
  }
  return raw
}

export function createDeliverTool(params: {
  rootDir: string
  onDeliver: (items: Deliverable[]) => void
}): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'deliver',
    description:
      '把已落盘的正式成品交付给用户（文档/表格/PPT/PDF/图片/图纸/压缩包，含生成的图片）。保存到磁盘不等于交到用户手里——这一步才是交付本身，不调用户就收不到成品。改动已交付的文件后要重新交付；中间脚本、临时文件、过程产物不要交付；纯文本回答或只读分析不要调用。',
    schema: z.object({
      items: z
        .array(
          z.object({
            path: z.string().describe('已生成成品文件的路径（相对工作区根目录或本机绝对路径）')
          })
        )
        .describe('要交付给用户的正式成品列表')
    }),
    func: async ({ items }) => {
      const valid: Deliverable[] = []
      const problems: string[] = []

      for (const item of items) {
        const cleaned = normalizeWinDrivePath(item.path.trim())
        const resolved = isAbsolute(cleaned) ? resolve(cleaned) : resolve(params.rootDir, cleaned)
        if (!existsSync(resolved)) {
          problems.push(`- ${item.path}（按 ${resolved} 查找）：不存在或无法访问`)
          continue
        }
        try {
          const st = statSync(resolved)
          if (!st.isFile()) {
            problems.push(`- ${item.path}：是目录而非文件，请交付具体文件`)
            continue
          }
          const title = basename(resolved)
          valid.push({
            path: resolved,
            title,
            kind: fileCategoryOf(title, resolved),
            size: st.size
          })
        } catch {
          problems.push(`- ${item.path}：无法读取文件状态`)
        }
      }

      if (problems.length > 0) {
        throw new Error(
          [
            '不能交付以下路径：',
            ...problems,
            '如果文件已经生成，多半是路径写法不对：改用相对工作区根的路径或文件的真实绝对路径，再重新交付。若本轮只输出文字建议或大纲、没有成品文件，不要调用 deliver。'
          ].join('\n')
        )
      }

      if (valid.length > 0) {
        params.onDeliver(valid)
      }

      return valid.length > 0
        ? `已把 ${valid.length} 项成品交付给用户（${valid.map((v) => v.title).join('、')}）。若之后又修改了已交付的文件，改完要重新交付。`
        : '未交付任何成品（items 为空）。'
    }
  })
}
