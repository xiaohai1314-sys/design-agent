import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import JSZip from 'jszip'
import type { PptOperation, PptProposal } from '@shared/protocol'

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function buildTxBodyParagraphsXml(
  text: string,
  style?: { colorHex?: string; fontSizePt?: number; bold?: boolean }
): string {
  const lines = text.split(/\r?\n/)
  const szAttr = style?.fontSizePt ? ` sz="${Math.round(style.fontSizePt * 100)}"` : ''
  const bAttr = style?.bold !== undefined ? ` b="${style.bold ? '1' : '0'}"` : ''
  const fillXml = style?.colorHex
    ? `<a:solidFill><a:srgbClr val="${style.colorHex.replace(/^#/, '').toUpperCase()}"/></a:solidFill>`
    : ''

  return lines
    .map(
      (line) =>
        `<a:p><a:r><a:rPr lang="zh-CN"${szAttr}${bAttr}>${fillXml}</a:rPr><a:t>${escapeXml(line)}</a:t></a:r></a:p>`
    )
    .join('')
}

function slideNumberFromId(slideId: string): number {
  const m = /(\d+)/.exec(slideId)
  return m ? parseInt(m[1], 10) : 1
}

function shapeIdFromElementId(elementId?: string): string | null {
  if (!elementId) return null
  const m = /-el-(\d+)$/.exec(elementId)
  if (m) return m[1]
  const n = /^(\d+)$/.exec(elementId.trim())
  return n ? n[1] : null
}

function patchShapeInSlideXml(slideXml: string, shapeId: string, op: PptOperation): { xml: string; patched: boolean } {
  // 匹配包含 cNvPr id="shapeId" 的 <p:sp> 块
  const spRe = /<p:sp\b[\s\S]*?<\/p:sp>/g
  let patched = false
  const out = slideXml.replace(spRe, (spBlock) => {
    const idRe = new RegExp(`<p:cNvPr\\b[^>]*\\bid="${shapeId}"`)
    if (!idRe.test(spBlock)) return spBlock

    let nextBlock = spBlock
    if (op.op === 'update_text' && typeof op.text === 'string') {
      if (/<p:txBody>[\s\S]*?<\/p:txBody>/.test(nextBlock)) {
        nextBlock = nextBlock.replace(/<p:txBody>[\s\S]*?<\/p:txBody>/, (txBody) => {
          const bodyPrMatch = /<a:bodyPr\b[^>]*?(?:\/>|>[\s\S]*?<\/a:bodyPr>)/.exec(txBody)
          const lstStyleMatch = /<a:lstStyle\b[^>]*?(?:\/>|>[\s\S]*?<\/a:lstStyle>)/.exec(txBody)
          const bodyPr = bodyPrMatch?.[0] ?? '<a:bodyPr/>'
          const lstStyle = lstStyleMatch?.[0] ?? '<a:lstStyle/>'
          const paras = buildTxBodyParagraphsXml(op.text!, {
            colorHex: op.colorHex,
            fontSizePt: op.fontSizePt,
            bold: op.bold
          })
          patched = true
          return `<p:txBody>${bodyPr}${lstStyle}${paras}</p:txBody>`
        })
      }
    } else if (op.op === 'update_style') {
      // 更新所有 <a:rPr> 的字号/加粗/颜色
      nextBlock = nextBlock.replace(/<a:rPr\b([^>]*)>([\s\S]*?)<\/a:rPr>|<a:rPr\b([^>]*)\/>/g, (_m, a1, inner, a2) => {
        let attrs = (a1 ?? a2 ?? '') as string
        let body = (inner ?? '') as string
        if (op.fontSizePt) {
          const szVal = Math.round(op.fontSizePt * 100)
          attrs = /\bsz="\d+"/.test(attrs) ? attrs.replace(/\bsz="\d+"/, `sz="${szVal}"`) : `${attrs} sz="${szVal}"`
        }
        if (op.bold !== undefined) {
          const bVal = op.bold ? '1' : '0'
          attrs = /\bb="[01]"/.test(attrs) ? attrs.replace(/\bb="[01]"/, `b="${bVal}"`) : `${attrs} b="${bVal}"`
        }
        if (op.colorHex) {
          const hex = op.colorHex.replace(/^#/, '').toUpperCase()
          const fillTag = `<a:solidFill><a:srgbClr val="${hex}"/></a:solidFill>`
          body = /<a:solidFill>[\s\S]*?<\/a:solidFill>/.test(body)
            ? body.replace(/<a:solidFill>[\s\S]*?<\/a:solidFill>/, fillTag)
            : `${fillTag}${body}`
        }
        patched = true
        return body ? `<a:rPr${attrs}>${body}</a:rPr>` : `<a:rPr${attrs}/>`
      })
    }
    return nextBlock
  })

  return { xml: out, patched }
}

/** 将用户确认接受的 PPT 修改提案原子写回原始 .pptx 文件 */
export async function applyPptProposalToFile(
  proposal: PptProposal
): Promise<{ ok: boolean; appliedCount: number; error?: string }> {
  try {
    if (!existsSync(proposal.pptPath)) {
      return { ok: false, appliedCount: 0, error: `PPT 文件不存在：${proposal.pptPath}` }
    }
    const raw = readFileSync(proposal.pptPath)
    const zip = await JSZip.loadAsync(raw)
    let appliedCount = 0

    for (const op of proposal.operations) {
      const slideNum = slideNumberFromId(op.slideId)
      const slideXmlPath = `ppt/slides/slide${slideNum}.xml`
      const file = zip.file(slideXmlPath)
      if (!file) continue
      const xml = await file.async('string')
      const shapeId = shapeIdFromElementId(op.elementId)
      if (!shapeId) continue
      const { xml: nextXml, patched } = patchShapeInSlideXml(xml, shapeId, op)
      if (patched) {
        zip.file(slideXmlPath, nextXml)
        appliedCount++
      }
    }

    const outBuf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
    writeFileSync(proposal.pptPath, outBuf)
    return { ok: true, appliedCount }
  } catch (err) {
    return {
      ok: false,
      appliedCount: 0,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}
