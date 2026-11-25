import JSZip from 'jszip'
import { findAllDesc, findChildren, findFirst, localTag, parseXml, type XmlNode } from './xmlMini'

export interface PptParagraphRun {
  text: string
  fontSizePt?: number
  colorHex?: string
  bold?: boolean
}

export interface PptParagraph {
  align?: 'left' | 'center' | 'right'
  text: string
  runs: PptParagraphRun[]
}

export interface PptElementModel {
  elementId: string
  shapeXmlId: string
  name: string
  kind: 'text' | 'image' | 'shape' | 'table'
  xPct: number
  yPct: number
  wPct: number
  hPct: number
  fillHex?: string
  strokeHex?: string
  text: string
  paragraphs: PptParagraph[]
  imageDataUrl?: string
  tableRows?: string[][]
}

export interface PptSlideModel {
  slideId: string
  index: number
  slideXmlPath: string
  backgroundHex?: string
  noteText?: string
  elements: PptElementModel[]
}

export interface PptDeckModel {
  slideWidthEmu: number
  slideHeightEmu: number
  aspectRatio: number
  slides: PptSlideModel[]
}

const DEFAULT_W = 12192000 // 16:9 13.333 in
const DEFAULT_H = 6858000

function parseColorFromNode(node: XmlNode | undefined, themeColors: Record<string, string>): string | undefined {
  if (!node) return undefined
  const srgb = findFirst(node, 'srgbClr')
  if (srgb?.attrs.val) return `#${srgb.attrs.val}`
  const scheme = findFirst(node, 'schemeClr')
  if (scheme?.attrs.val && themeColors[scheme.attrs.val]) {
    return themeColors[scheme.attrs.val]
  }
  return undefined
}

function parseThemeColors(xml: string): Record<string, string> {
  const map: Record<string, string> = {
    dk1: '#18181b',
    lt1: '#ffffff',
    dk2: '#27272a',
    lt2: '#f4f4f5',
    accent1: '#2563eb',
    accent2: '#ea580c',
    accent3: '#16a34a',
    accent4: '#9333ea',
    accent5: '#0891b2',
    accent6: '#ca8a04',
    tx1: '#18181b',
    bg1: '#ffffff'
  }
  const tree = parseXml(xml)
  const clrScheme = findAllDesc(tree, 'clrScheme')[0]
  if (!clrScheme) return map
  for (const child of clrScheme.children) {
    const k = localTag(child.tag)
    const srgb = findFirst(child, 'srgbClr')
    const sys = findFirst(child, 'sysClr')
    if (srgb?.attrs.val) map[k] = `#${srgb.attrs.val}`
    else if (sys?.attrs.lastClr) map[k] = `#${sys.attrs.lastClr}`
  }
  map.tx1 = map.dk1
  map.tx2 = map.dk2
  map.bg1 = map.lt1
  map.bg2 = map.lt2
  return map
}

function parseXfrmBox(
  spPr: XmlNode | undefined,
  slideW: number,
  slideH: number
): { xPct: number; yPct: number; wPct: number; hPct: number } {
  const xfrm = findFirst(spPr, 'xfrm')
  const off = findFirst(xfrm, 'off')
  const ext = findFirst(xfrm, 'ext')
  const x = Number(off?.attrs.x ?? 0)
  const y = Number(off?.attrs.y ?? 0)
  const cx = Number(ext?.attrs.cx ?? 0)
  const cy = Number(ext?.attrs.cy ?? 0)
  return {
    xPct: Math.max(0, Math.min(100, (x / slideW) * 100)),
    yPct: Math.max(0, Math.min(100, (y / slideH) * 100)),
    wPct: Math.max(1, Math.min(100, (cx / slideW) * 100 || 12)),
    hPct: Math.max(1, Math.min(100, (cy / slideH) * 100 || 8))
  }
}

function parseParagraphs(txBody: XmlNode | undefined, themeColors: Record<string, string>): PptParagraph[] {
  if (!txBody) return []
  const paras: PptParagraph[] = []
  for (const pNode of findChildren(txBody, 'p')) {
    const pPr = findFirst(pNode, 'pPr')
    const algn = pPr?.attrs.algn
    const align = algn === 'ctr' ? 'center' : algn === 'r' ? 'right' : 'left'
    const runs: PptParagraphRun[] = []
    for (const rNode of pNode.children) {
      const lTag = localTag(rNode.tag)
      if (lTag === 'r' || lTag === 'fld') {
        const rPr = findFirst(rNode, 'rPr')
        const tNode = findFirst(rNode, 't')
        const txt = tNode?.text ?? ''
        const szRaw = rPr?.attrs.sz ? Number(rPr.attrs.sz) : undefined
        const solidFill = findFirst(rPr, 'solidFill')
        runs.push({
          text: txt,
          fontSizePt: szRaw ? Math.round(szRaw / 100) : undefined,
          colorHex: parseColorFromNode(solidFill, themeColors),
          bold: rPr?.attrs.b === '1'
        })
      } else if (lTag === 'br') {
        runs.push({ text: '\n' })
      }
    }
    const text = runs.map((r) => r.text).join('')
    paras.push({ align, text, runs })
  }
  return paras
}

export async function parsePptxDeck(bytes: Uint8Array, includeImages = true): Promise<PptDeckModel> {
  const zip = await JSZip.loadAsync(bytes)

  let slideW = DEFAULT_W
  let slideH = DEFAULT_H
  const presFile = zip.file('ppt/presentation.xml')
  let orderedRelIds: string[] = []
  if (presFile) {
    const presTree = parseXml(await presFile.async('string'))
    const sldSz = findAllDesc(presTree, 'sldSz')[0]
    if (sldSz?.attrs.cx && sldSz?.attrs.cy) {
      slideW = Number(sldSz.attrs.cx) || DEFAULT_W
      slideH = Number(sldSz.attrs.cy) || DEFAULT_H
    }
    orderedRelIds = findAllDesc(presTree, 'sldId')
      .map((n) => n.attrs['r:id'] ?? '')
      .filter(Boolean)
  }

  let themeColors = parseThemeColors('')
  const themeFile = zip.file('ppt/theme/theme1.xml')
  if (themeFile) {
    themeColors = parseThemeColors(await themeFile.async('string'))
  }

  let slidePaths: string[] = []
  const presRelsFile = zip.file('ppt/_rels/presentation.xml.rels')
  if (presRelsFile && orderedRelIds.length > 0) {
    const relTree = parseXml(await presRelsFile.async('string'))
    const idToTarget = new Map<string, string>()
    for (const rel of findAllDesc(relTree, 'Relationship')) {
      if (rel.attrs.Id && rel.attrs.Target) {
        const clean = rel.attrs.Target.replace(/^\/+/, '').replace(/^ppt\//, '')
        idToTarget.set(rel.attrs.Id, `ppt/${clean}`)
      }
    }
    slidePaths = orderedRelIds.map((rid) => idToTarget.get(rid)).filter((p): p is string => Boolean(p))
  }

  if (slidePaths.length === 0) {
    slidePaths = Object.keys(zip.files)
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
      .sort((a, b) => {
        const na = parseInt(/slide(\d+)\.xml/i.exec(a)?.[1] ?? '0', 10)
        const nb = parseInt(/slide(\d+)\.xml/i.exec(b)?.[1] ?? '0', 10)
        return na - nb
      })
  }

  const slides: PptSlideModel[] = []
  for (let i = 0; i < slidePaths.length; i++) {
    const slideXmlPath = slidePaths[i]
    const slideFile = zip.file(slideXmlPath)
    if (!slideFile) continue
    const slideNo = i + 1
    const slideId = `slide-${slideNo}`
    const tree = parseXml(await slideFile.async('string'))

    // 解析关系表（图片、备注）
    const baseFile = slideXmlPath.split('/').pop() ?? ''
    const relPath = `ppt/slides/_rels/${baseFile}.rels`
    const relMap = new Map<string, { type: string; target: string }>()
    let noteText: string | undefined
    const relFile = zip.file(relPath)
    if (relFile) {
      const relTree = parseXml(await relFile.async('string'))
      for (const rel of findAllDesc(relTree, 'Relationship')) {
        if (rel.attrs.Id && rel.attrs.Target) {
          const norm = rel.attrs.Target.replace(/^(\.\.\/)+/, 'ppt/').replace(/^\/+/, '')
          relMap.set(rel.attrs.Id, { type: rel.attrs.Type ?? '', target: norm })
          if ((rel.attrs.Type ?? '').endsWith('/notesSlide') && zip.file(norm)) {
            const notesTree = parseXml(await zip.file(norm)!.async('string'))
            const txts = findAllDesc(notesTree, 't')
              .map((t) => t.text.trim())
              .filter(Boolean)
            if (txts.length > 0) noteText = txts.join('\n')
          }
        }
      }
    }

    const bgNode = findAllDesc(tree, 'bgPr')[0]
    const backgroundHex = parseColorFromNode(findFirst(bgNode, 'solidFill'), themeColors)

    const spTree = findAllDesc(tree, 'spTree')[0]
    const elements: PptElementModel[] = []

    const visitNodes = async (nodes: XmlNode[]): Promise<void> => {
      for (const node of nodes) {
        const tag = localTag(node.tag)
        if (tag === 'grpSp') {
          await visitNodes(node.children)
          continue
        }
        if (tag === 'sp') {
          const cNvPr = findFirst(findFirst(node, 'nvSpPr'), 'cNvPr')
          const shapeXmlId = cNvPr?.attrs.id ?? String(elements.length + 1)
          const name = cNvPr?.attrs.name || `文本框 ${shapeXmlId}`
          const spPr = findFirst(node, 'spPr')
          const box = parseXfrmBox(spPr, slideW, slideH)
          const fillHex = parseColorFromNode(findFirst(spPr, 'solidFill'), themeColors)
          const ln = findFirst(spPr, 'ln')
          const strokeHex = parseColorFromNode(findFirst(ln, 'solidFill'), themeColors)
          const paragraphs = parseParagraphs(findFirst(node, 'txBody'), themeColors)
          const text = paragraphs.map((p) => p.text).join('\n').trim()
          if (!text && !fillHex && !strokeHex) continue
          elements.push({
            elementId: `${slideId}-el-${shapeXmlId}`,
            shapeXmlId,
            name,
            kind: text ? 'text' : 'shape',
            ...box,
            fillHex,
            strokeHex,
            text,
            paragraphs
          })
        } else if (tag === 'pic') {
          const cNvPr = findFirst(findFirst(node, 'nvPicPr'), 'cNvPr')
          const shapeXmlId = cNvPr?.attrs.id ?? String(elements.length + 1)
          const name = cNvPr?.attrs.name || `图片 ${shapeXmlId}`
          const spPr = findFirst(node, 'spPr')
          const box = parseXfrmBox(spPr, slideW, slideH)
          const blip = findAllDesc(findFirst(node, 'blipFill'), 'blip')[0]
          const rEmbed = blip?.attrs['r:embed']
          let imageDataUrl: string | undefined
          if (includeImages && rEmbed && relMap.has(rEmbed)) {
            const mediaPath = relMap.get(rEmbed)!.target
            const mediaFile = zip.file(mediaPath)
            if (mediaFile) {
              const b64 = await mediaFile.async('base64')
              const ext = mediaPath.split('.').pop()?.toLowerCase() ?? 'png'
              const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`
              imageDataUrl = `data:${mime};base64,${b64}`
            }
          }
          elements.push({
            elementId: `${slideId}-el-${shapeXmlId}`,
            shapeXmlId,
            name,
            kind: 'image',
            ...box,
            text: '',
            paragraphs: [],
            imageDataUrl
          })
        } else if (tag === 'graphicFrame') {
          const cNvPr = findFirst(findFirst(node, 'nvGraphicFramePr'), 'cNvPr')
          const shapeXmlId = cNvPr?.attrs.id ?? String(elements.length + 1)
          const name = cNvPr?.attrs.name || `表格 ${shapeXmlId}`
          const xfrm = findFirst(node, 'xfrm')
          const off = findFirst(xfrm, 'off')
          const ext = findFirst(xfrm, 'ext')
          const tbl = findAllDesc(node, 'tbl')[0]
          if (tbl) {
            const rows: string[][] = []
            for (const tr of findChildren(tbl, 'tr')) {
              const cells: string[] = []
              for (const tc of findChildren(tr, 'tc')) {
                const cellTxt = findAllDesc(tc, 't')
                  .map((t) => t.text)
                  .join('')
                  .trim()
                cells.push(cellTxt)
              }
              rows.push(cells)
            }
            elements.push({
              elementId: `${slideId}-el-${shapeXmlId}`,
              shapeXmlId,
              name,
              kind: 'table',
              xPct: Math.max(0, Math.min(100, (Number(off?.attrs.x ?? 0) / slideW) * 100)),
              yPct: Math.max(0, Math.min(100, (Number(off?.attrs.y ?? 0) / slideH) * 100)),
              wPct: Math.max(5, Math.min(100, (Number(ext?.attrs.cx ?? 0) / slideW) * 100 || 50)),
              hPct: Math.max(5, Math.min(100, (Number(ext?.attrs.cy ?? 0) / slideH) * 100 || 30)),
              text: rows.map((r) => r.join(' | ')).join('\n'),
              paragraphs: [],
              tableRows: rows
            })
          }
        }
      }
    }

    if (spTree) {
      await visitNodes(spTree.children)
    }

    slides.push({
      slideId,
      index: slideNo,
      slideXmlPath,
      backgroundHex,
      noteText,
      elements
    })
  }

  return {
    slideWidthEmu: slideW,
    slideHeightEmu: slideH,
    aspectRatio: slideW / Math.max(1, slideH),
    slides
  }
}
