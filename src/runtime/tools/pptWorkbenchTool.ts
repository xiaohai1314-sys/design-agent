import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import { resolveToolCallId } from './callId'
import { parsePptxDeck, type PptDeckModel } from '@shared/pptParser'
import type {
  PptOperation,
  PptProposal,
  PptWorkbenchSelection,
  PptWorkbenchToolData
} from '@shared/protocol'

function findPptxInWorkspace(rootDir: string): string | null {
  if (!existsSync(rootDir)) return null
  try {
    const queue = [rootDir]
    while (queue.length > 0) {
      const dir = queue.shift()!
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue
        const full = join(dir, ent.name)
        if (ent.isFile() && ent.name.toLowerCase().endsWith('.pptx')) return full
        if (ent.isDirectory() && queue.length < 20) queue.push(full)
      }
    }
  } catch {
    // ignore
  }
  return null
}

/** 100% 对齐原版 F3n Schema：read (outline/elements 分页)、suggest (局改提案)、snapshot (整稿快照) */
export function createPptWorkbenchTool(params: {
  rootDir: string
  pptSelection?: PptWorkbenchSelection
  recordToolData: (toolCallId: string, data: PptWorkbenchToolData) => void
  onEmitProposal: (proposal: PptProposal) => void
}): DynamicStructuredTool | null {
  const targetPpt =
    params.pptSelection?.documentPath && existsSync(params.pptSelection.documentPath)
      ? params.pptSelection.documentPath
      : findPptxInWorkspace(params.rootDir)

  if (!targetPpt) return null

  let cachedDeck: PptDeckModel | null = null
  const getDeck = async (): Promise<PptDeckModel> => {
    if (!cachedDeck) {
      cachedDeck = await parsePptxDeck(new Uint8Array(readFileSync(targetPpt)), false)
    }
    return cachedDeck
  }

  return new DynamicStructuredTool({
    name: 'ppt_workbench',
    description:
      '读取当前任务的 .pptx 可编辑演示文稿（outline 大纲或 elements 要素分页）、提交基于稳定 slideId/elementId 的局部修改提案（suggest），或生成整稿可编辑副本快照（snapshot）。用户选中特定页或元素时，仅能在授权范围内读改，suggest 会提交修改提案供用户在右侧工作台一键接受或拒绝，不会直接覆盖原稿。',
    schema: z.strictObject({
      action: z.enum(['read', 'suggest', 'snapshot']),
      mode: z.enum(['outline', 'elements']).optional(),
      slideId: z.string().optional(),
      elementId: z.string().optional(),
      offset: z.number().int().nonnegative().optional(),
      limit: z.number().int().min(1).max(20).optional(),
      operations: z
        .array(
          z.object({
            op: z.enum(['update_text', 'update_style', 'add_note']),
            slideId: z.string().min(1),
            elementId: z.string().optional(),
            text: z.string().optional(),
            colorHex: z.string().optional(),
            fontSizePt: z.number().optional(),
            bold: z.boolean().optional(),
            note: z.string().optional()
          })
        )
        .min(1)
        .max(80)
        .optional(),
      summary: z.string().max(1000).optional()
    }),
    func: async ({ action, mode, slideId, elementId, offset, limit, operations, summary }, runManager, config) => {
      const callId =
        resolveToolCallId(runManager, config)
      const deck = await getDeck()
      const sel = params.pptSelection

      if (action === 'read') {
        const readMode = mode ?? (slideId ? 'elements' : 'outline')
        const off = offset ?? 0
        const lim = limit ?? 10

        if (readMode === 'outline') {
          const slice = deck.slides.slice(off, off + lim)
          params.recordToolData(callId, {
            kind: 'ppt_workbench',
            action: 'read',
            slideCount: deck.slides.length
          })
          return JSON.stringify(
            {
              documentPath: targetPpt.replace(/\\/g, '/'),
              totalSlides: deck.slides.length,
              currentSlideId: sel?.currentSlideId ?? slice[0]?.slideId,
              selectedRefs: sel?.references ?? [],
              slides: slice.map((s) => ({
                slideId: s.slideId,
                index: s.index,
                elementCount: s.elements.length,
                previewTitle: s.elements.find((e) => e.text)?.text.split('\n')[0]?.slice(0, 60) ?? ''
              }))
            },
            null,
            2
          )
        }

        const targetSlide =
          deck.slides.find((s) => s.slideId === (slideId ?? sel?.currentSlideId ?? 'slide-1')) ??
          deck.slides[0]
        if (!targetSlide) throw new Error('未找到目标幻灯片页面。')

        let elems = targetSlide.elements
        if (elementId) elems = elems.filter((e) => e.elementId === elementId)
        const paged = elems.slice(off, off + lim)

        params.recordToolData(callId, {
          kind: 'ppt_workbench',
          action: 'read',
          slideCount: deck.slides.length
        })
        return JSON.stringify(
          {
            slideId: targetSlide.slideId,
            totalElements: elems.length,
            nextOffset: off + paged.length < elems.length ? off + paged.length : null,
            elements: paged.map((el) => ({
              elementId: el.elementId,
              name: el.name,
              kind: el.kind,
              xPct: Math.round(el.xPct),
              yPct: Math.round(el.yPct),
              wPct: Math.round(el.wPct),
              hPct: Math.round(el.hPct),
              text: el.text
            }))
          },
          null,
          2
        )
      }

      if (action === 'snapshot') {
        const snapDir = join(params.rootDir, '.design-agent', 'ppt-snapshots')
        mkdirSync(snapDir, { recursive: true })
        const snapPath = join(snapDir, `${Date.now()}_${basename(targetPpt)}`)
        copyFileSync(targetPpt, snapPath)
        params.recordToolData(callId, {
          kind: 'ppt_workbench',
          action: 'snapshot',
          slideCount: deck.slides.length
        })
        return `已创建 PPT 整稿副本快照：${snapPath.replace(/\\/g, '/')}（如需增删页或大改布局，可基于该副本用 python-pptx 编辑后调用 deliver 交付）。`
      }

      // action === 'suggest'
      if (!operations || operations.length === 0) {
        throw new Error('suggest 必须提供至少一条 operations。')
      }

      // 范围保护：如果用户勾选了元素级或页面级引用，校验所有操作不越界
      if (sel && sel.references.length > 0) {
        for (const op of operations) {
          const allowed = sel.references.some((ref) => {
            if (ref.kind === 'slide') return ref.slideId === op.slideId
            return ref.slideId === op.slideId && (!op.elementId || ref.elementId === op.elementId)
          })
          if (!allowed) {
            throw new Error(
              `请求超出本轮允许范围（out_of_scope）：操作指向 ${op.slideId}/${op.elementId ?? '*'}，但用户当前仅授权了选中引用范围。`
            )
          }
        }
      }

      const proposal: PptProposal = {
        proposalId: randomUUID(),
        pptPath: isAbsolute(targetPpt) ? targetPpt : resolve(params.rootDir, targetPpt),
        summary: summary?.trim() || `拟修改 ${operations.length} 处幻灯片内容`,
        operations: operations as PptOperation[],
        status: 'pending',
        createdAt: Date.now()
      }

      params.onEmitProposal(proposal)
      params.recordToolData(callId, {
        kind: 'ppt_workbench',
        action: 'suggest',
        summary: proposal.summary,
        slideCount: deck.slides.length,
        operationCount: proposal.operations.length
      })

      return `已向右侧 PPT 工作台提交修改提案（${proposal.operations.length} 项改动）：${proposal.summary}。请提示用户在工作台预览对比并点击「接受并写回 PPTX」或「拒绝」。`
    }
  })
}
