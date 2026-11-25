import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import type {
  CadEntity,
  CadLayerInfo,
  CadPreviewResult,
  CadSnapPoint
} from '@shared/ipc'

/** AutoCAD ACI 标准色号到浅色/深色高对比可读颜色映射 */
const ACI_PALETTE: Record<number, string> = {
  1: '#ef4444', // Red
  2: '#eab308', // Yellow
  3: '#22c55e', // Green
  4: '#06b6d4', // Cyan
  5: '#3b82f6', // Blue
  6: '#d946ef', // Magenta
  7: '#e4e4e7', // White/Default (在深色 CAD 画布上显示为亮灰白)
  8: '#9ca3af', // Gray
  9: '#d1d5db', // Light Gray
  30: '#f97316',
  40: '#f59e0b',
  50: '#eab308',
  140: '#38bdf8',
  250: '#52525b',
  251: '#71717a',
  252: '#a1a1aa',
  253: '#d4d4d8',
  254: '#e4e4e7'
}

function aciToHex(aci: number): string {
  const idx = Math.abs(aci)
  if (ACI_PALETTE[idx]) return ACI_PALETTE[idx]
  if (idx >= 10 && idx < 250) {
    const hue = ((idx - 10) * 1.5) % 360
    return `hsl(${Math.round(hue)}, 75%, 60%)`
  }
  return '#e4e4e7'
}

function decodeDxfBuffer(buf: Buffer): string {
  const head = buf.subarray(0, 64).toString('latin1')
  if (head.startsWith('AutoCAD Binary DXF')) {
    throw new Error('暂不支持二进制格式 DXF，请导出为 ASCII DXF 或 DWG')
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    try {
      return new TextDecoder('gbk').decode(buf)
    } catch {
      return buf.toString('latin1')
    }
  }
}

function cleanMText(raw: string): string {
  return raw
    .replace(/\\P/gi, '\n')
    .replace(/\\[A-Za-z][^;]*;/g, '')
    .replace(/[{}]/g, '')
    .replace(/%%c/gi, 'Ø')
    .replace(/%%d/gi, '°')
    .replace(/%%p/gi, '±')
    .trim()
}

interface DxfPair {
  code: number
  value: string
}

function tokenizeDxf(text: string): DxfPair[] {
  const lines = text.split(/\r?\n/)
  const pairs: DxfPair[] = []
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i].trim(), 10)
    if (Number.isNaN(code)) continue
    pairs.push({ code, value: lines[i + 1].trim() })
  }
  return pairs
}

interface RawBlock {
  name: string
  baseX: number
  baseY: number
  entities: CadEntity[]
}

function parseEntityList(
  pairs: DxfPair[],
  startIdx: number,
  endToken: string
): { entities: CadEntity[]; inserts: Array<{ block: string; layer: string; x: number; y: number; sx: number; sy: number; rot: number }>; nextIdx: number } {
  const entities: CadEntity[] = []
  const inserts: Array<{ block: string; layer: string; x: number; y: number; sx: number; sy: number; rot: number }> = []
  let i = startIdx

  while (i < pairs.length) {
    const p = pairs[i]
    if (p.code === 0 && p.value === endToken) {
      return { entities, inserts, nextIdx: i + 1 }
    }
    if (p.code !== 0) {
      i++
      continue
    }

    const type = p.value
    i++
    let layer = '0'
    let colorCode: number | undefined
    let linetype = ''

    if (type === 'LINE') {
      let x1 = 0, y1 = 0, x2 = 0, y2 = 0
      while (i < pairs.length && pairs[i].code !== 0) {
        const { code, value } = pairs[i++]
        if (code === 8) layer = value
        else if (code === 62) colorCode = parseInt(value, 10)
        else if (code === 6) linetype = value.toUpperCase()
        else if (code === 10) x1 = parseFloat(value)
        else if (code === 20) y1 = parseFloat(value)
        else if (code === 11) x2 = parseFloat(value)
        else if (code === 21) y2 = parseFloat(value)
      }
      if (Number.isFinite(x1) && Number.isFinite(y1) && Number.isFinite(x2) && Number.isFinite(y2)) {
        entities.push({
          kind: 'polyline',
          layer,
          color: colorCode ? aciToHex(colorCode) : undefined,
          closed: false,
          dashed: linetype.includes('DASH') || linetype.includes('HIDDEN') || linetype.includes('CENTER'),
          pts: [[x1, y1], [x2, y2]]
        })
      }
    } else if (type === 'LWPOLYLINE') {
      const pts: Array<[number, number]> = []
      let curX: number | null = null
      let flags = 0
      while (i < pairs.length && pairs[i].code !== 0) {
        const { code, value } = pairs[i++]
        if (code === 8) layer = value
        else if (code === 62) colorCode = parseInt(value, 10)
        else if (code === 6) linetype = value.toUpperCase()
        else if (code === 70) flags = parseInt(value, 10)
        else if (code === 10) curX = parseFloat(value)
        else if (code === 20 && curX !== null) {
          const y = parseFloat(value)
          if (Number.isFinite(curX) && Number.isFinite(y)) pts.push([curX, y])
          curX = null
        }
      }
      if (pts.length >= 2) {
        entities.push({
          kind: 'polyline',
          layer,
          color: colorCode ? aciToHex(colorCode) : undefined,
          closed: (flags & 1) === 1,
          dashed: linetype.includes('DASH') || linetype.includes('HIDDEN'),
          pts
        })
      }
    } else if (type === 'POLYLINE') {
      const pts: Array<[number, number]> = []
      let flags = 0
      while (i < pairs.length && pairs[i].code !== 0) {
        const { code, value } = pairs[i++]
        if (code === 8) layer = value
        else if (code === 62) colorCode = parseInt(value, 10)
        else if (code === 70) flags = parseInt(value, 10)
      }
      while (i < pairs.length) {
        if (pairs[i].code === 0 && pairs[i].value === 'SEQEND') {
          i++
          break
        }
        if (pairs[i].code === 0 && pairs[i].value === 'VERTEX') {
          i++
          let vx = 0, vy = 0
          while (i < pairs.length && pairs[i].code !== 0) {
            const { code, value } = pairs[i++]
            if (code === 10) vx = parseFloat(value)
            else if (code === 20) vy = parseFloat(value)
          }
          if (Number.isFinite(vx) && Number.isFinite(vy)) pts.push([vx, vy])
        } else {
          break
        }
      }
      if (pts.length >= 2) {
        entities.push({
          kind: 'polyline',
          layer,
          color: colorCode ? aciToHex(colorCode) : undefined,
          closed: (flags & 1) === 1,
          pts
        })
      }
    } else if (type === 'CIRCLE') {
      let cx = 0, cy = 0, r = 0
      while (i < pairs.length && pairs[i].code !== 0) {
        const { code, value } = pairs[i++]
        if (code === 8) layer = value
        else if (code === 62) colorCode = parseInt(value, 10)
        else if (code === 10) cx = parseFloat(value)
        else if (code === 20) cy = parseFloat(value)
        else if (code === 40) r = parseFloat(value)
      }
      if (r > 0 && Number.isFinite(cx) && Number.isFinite(cy)) {
        entities.push({
          kind: 'circle',
          layer,
          color: colorCode ? aciToHex(colorCode) : undefined,
          cx,
          cy,
          r
        })
      }
    } else if (type === 'ARC') {
      let cx = 0, cy = 0, r = 0, sa = 0, ea = 360
      while (i < pairs.length && pairs[i].code !== 0) {
        const { code, value } = pairs[i++]
        if (code === 8) layer = value
        else if (code === 62) colorCode = parseInt(value, 10)
        else if (code === 10) cx = parseFloat(value)
        else if (code === 20) cy = parseFloat(value)
        else if (code === 40) r = parseFloat(value)
        else if (code === 50) sa = (parseFloat(value) * Math.PI) / 180
        else if (code === 51) ea = (parseFloat(value) * Math.PI) / 180
      }
      if (r > 0 && Number.isFinite(cx) && Number.isFinite(cy)) {
        entities.push({
          kind: 'arc',
          layer,
          color: colorCode ? aciToHex(colorCode) : undefined,
          cx,
          cy,
          r,
          startAngle: sa,
          endAngle: ea
        })
      }
    } else if (type === 'TEXT' || type === 'MTEXT' || type === 'ATTRIB') {
      let x = 0, y = 0, h = 250, rot = 0
      const textChunks: string[] = []
      while (i < pairs.length && pairs[i].code !== 0) {
        const { code, value } = pairs[i++]
        if (code === 8) layer = value
        else if (code === 62) colorCode = parseInt(value, 10)
        else if (code === 10) x = parseFloat(value)
        else if (code === 20) y = parseFloat(value)
        else if (code === 40) h = parseFloat(value)
        else if (code === 50) rot = parseFloat(value)
        else if (code === 1 || code === 3) textChunks.push(value)
      }
      const cleaned = cleanMText(textChunks.join(''))
      if (cleaned && Number.isFinite(x) && Number.isFinite(y)) {
        entities.push({
          kind: 'text',
          layer,
          color: colorCode ? aciToHex(colorCode) : undefined,
          x,
          y,
          height: h > 0 ? h : 200,
          rotation: rot,
          text: cleaned
        })
      }
    } else if (type === 'INSERT') {
      let block = '', x = 0, y = 0, sx = 1, sy = 1, rot = 0
      while (i < pairs.length && pairs[i].code !== 0) {
        const { code, value } = pairs[i++]
        if (code === 8) layer = value
        else if (code === 2) block = value
        else if (code === 10) x = parseFloat(value)
        else if (code === 20) y = parseFloat(value)
        else if (code === 41) sx = parseFloat(value)
        else if (code === 42) sy = parseFloat(value)
        else if (code === 50) rot = (parseFloat(value) * Math.PI) / 180
      }
      if (block) {
        inserts.push({ block, layer, x, y, sx: sx || 1, sy: sy || 1, rot: rot || 0 })
      }
    } else {
      while (i < pairs.length && pairs[i].code !== 0) i++
    }
  }

  return { entities, inserts, nextIdx: i }
}

function transformPoint(
  px: number,
  py: number,
  bx: number,
  by: number,
  ins: { x: number; y: number; sx: number; sy: number; rot: number }
): [number, number] {
  const lx = (px - bx) * ins.sx
  const ly = (py - by) * ins.sy
  const cos = Math.cos(ins.rot)
  const sin = Math.sin(ins.rot)
  return [ins.x + lx * cos - ly * sin, ins.y + lx * sin + ly * cos]
}

export class CadPreviewService {
  constructor(
    private readonly cacheDir: string,
    private readonly skillsRoot: string
  ) {
    mkdirSync(this.cacheDir, { recursive: true })
  }

  private findDwgConverter(): string | null {
    const winBin = join(this.skillsRoot, 'cad', 'vendor', 'win64', 'dwg2dxf.exe')
    if (existsSync(winBin)) return winBin
    return null
  }

  private async ensureDxfFile(filePath: string): Promise<string> {
    const ext = extname(filePath).toLowerCase()
    if (ext === '.dxf') return filePath
    if (ext !== '.dwg') throw new Error(`不支持的 CAD 后缀：${ext}`)

    const st = statSync(filePath)
    const key = createHash('sha256')
      .update(`${filePath}:${st.size}:${Math.floor(st.mtimeMs)}`)
      .digest('hex')
      .slice(0, 20)
    const cachedDxf = join(this.cacheDir, `${key}.dxf`)
    if (existsSync(cachedDxf) && statSync(cachedDxf).size > 128) {
      return cachedDxf
    }

    const converter = this.findDwgConverter()
    if (!converter) {
      throw new Error('缺少 LibreDWG 转换组件（dwg2dxf.exe），无法转换 DWG 图纸')
    }

    await new Promise<void>((resolveConv, rejectConv) => {
      execFile(
        converter,
        ['-y', '-o', cachedDxf, filePath],
        { timeout: 60000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
        (err, _stdout, stderr) => {
          if (existsSync(cachedDxf) && statSync(cachedDxf).size > 128) {
            resolveConv()
          } else {
            rejectConv(new Error(`DWG 转换失败：${err?.message || String(stderr).slice(-200)}`))
          }
        }
      )
    })

    return cachedDxf
  }

  async prepare(filePath: string): Promise<CadPreviewResult> {
    try {
      if (!existsSync(filePath)) {
        return { ok: false, error: '图纸文件不存在' }
      }
      const dxfPath = await this.ensureDxfFile(filePath)
      const rawBuf = readFileSync(dxfPath)
      const text = decodeDxfBuffer(rawBuf)
      const pairs = tokenizeDxf(text)

      const layerColors = new Map<string, string>()
      const layerVisible = new Map<string, boolean>()
      const blocks = new Map<string, RawBlock>()
      let topEntities: CadEntity[] = []
      let topInserts: Array<{ block: string; layer: string; x: number; y: number; sx: number; sy: number; rot: number }> = []
      let insUnits = 4 // 默认毫米

      let i = 0
      while (i < pairs.length) {
        if (pairs[i].code === 0 && pairs[i].value === 'SECTION' && i + 1 < pairs.length && pairs[i + 1].code === 2) {
          const secName = pairs[i + 1].value
          i += 2
          if (secName === 'HEADER') {
            while (i < pairs.length && !(pairs[i].code === 0 && pairs[i].value === 'ENDSEC')) {
              if (pairs[i].code === 9 && pairs[i].value === '$INSUNITS' && i + 1 < pairs.length) {
                insUnits = parseInt(pairs[i + 1].value, 10) || 4
              }
              i++
            }
          } else if (secName === 'TABLES') {
            while (i < pairs.length && !(pairs[i].code === 0 && pairs[i].value === 'ENDSEC')) {
              if (pairs[i].code === 0 && pairs[i].value === 'LAYER') {
                i++
                let lname = '0'
                let lcolor = 7
                let lflags = 0
                while (i < pairs.length && pairs[i].code !== 0) {
                  const { code, value } = pairs[i++]
                  if (code === 2) lname = value
                  else if (code === 62) lcolor = parseInt(value, 10)
                  else if (code === 70) lflags = parseInt(value, 10)
                }
                layerColors.set(lname, aciToHex(lcolor))
                layerVisible.set(lname, lcolor >= 0 && (lflags & 1) === 0)
                continue
              }
              i++
            }
          } else if (secName === 'BLOCKS') {
            while (i < pairs.length && !(pairs[i].code === 0 && pairs[i].value === 'ENDSEC')) {
              if (pairs[i].code === 0 && pairs[i].value === 'BLOCK') {
                i++
                let bname = ''
                let bx = 0, by = 0
                while (i < pairs.length && pairs[i].code !== 0) {
                  const { code, value } = pairs[i++]
                  if (code === 2) bname = value
                  else if (code === 10) bx = parseFloat(value)
                  else if (code === 20) by = parseFloat(value)
                }
                const parsed = parseEntityList(pairs, i, 'ENDBLK')
                i = parsed.nextIdx
                if (bname && !bname.startsWith('*Model_Space') && !bname.startsWith('*Paper_Space')) {
                  blocks.set(bname, { name: bname, baseX: bx, baseY: by, entities: parsed.entities })
                }
                continue
              }
              i++
            }
          } else if (secName === 'ENTITIES') {
            const parsed = parseEntityList(pairs, i, 'ENDSEC')
            topEntities = parsed.entities
            topInserts = parsed.inserts
            i = parsed.nextIdx
            continue
          }
        }
        i++
      }

      // 展开顶层块引用（限制最多展开以保证渲染帧率流畅）
      const expanded: CadEntity[] = [...topEntities]
      for (const ins of topInserts) {
        if (expanded.length > 65000) break
        const blk = blocks.get(ins.block)
        if (!blk) continue
        for (const ent of blk.entities) {
          if (expanded.length > 65000) break
          const effLayer = ent.layer === '0' ? ins.layer : ent.layer
          if (ent.kind === 'polyline') {
            expanded.push({
              ...ent,
              layer: effLayer,
              pts: ent.pts.map(([px, py]) => transformPoint(px, py, blk.baseX, blk.baseY, ins))
            })
          } else if (ent.kind === 'circle') {
            const [cx, cy] = transformPoint(ent.cx, ent.cy, blk.baseX, blk.baseY, ins)
            expanded.push({
              ...ent,
              layer: effLayer,
              cx,
              cy,
              r: ent.r * Math.max(Math.abs(ins.sx), Math.abs(ins.sy))
            })
          } else if (ent.kind === 'arc') {
            const [cx, cy] = transformPoint(ent.cx, ent.cy, blk.baseX, blk.baseY, ins)
            expanded.push({
              ...ent,
              layer: effLayer,
              cx,
              cy,
              r: ent.r * Math.max(Math.abs(ins.sx), Math.abs(ins.sy)),
              startAngle: ent.startAngle + ins.rot,
              endAngle: ent.endAngle + ins.rot
            })
          } else if (ent.kind === 'text') {
            const [tx, ty] = transformPoint(ent.x, ent.y, blk.baseX, blk.baseY, ins)
            expanded.push({
              ...ent,
              layer: effLayer,
              x: tx,
              y: ty,
              height: ent.height * Math.abs(ins.sy)
            })
          }
        }
      }

      if (expanded.length === 0) {
        return { ok: false, error: '图纸中未解析到可显示的模型空间图元（可能仅含天正私有实体或空白图）' }
      }

      // 统计图层、包围盒与捕捉特征点
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      const extendBox = (x: number, y: number): void => {
        if (!Number.isFinite(x) || !Number.isFinite(y)) return
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
      }

      const layerCounts = new Map<string, number>()
      const snapPoints: CadSnapPoint[] = []
      const maxSnaps = 15000

      for (const ent of expanded) {
        layerCounts.set(ent.layer, (layerCounts.get(ent.layer) ?? 0) + 1)
        if (!layerColors.has(ent.layer)) {
          layerColors.set(ent.layer, '#e4e4e7')
          layerVisible.set(ent.layer, true)
        }

        if (ent.kind === 'polyline') {
          for (let k = 0; k < ent.pts.length; k++) {
            const [x, y] = ent.pts[k]
            extendBox(x, y)
            if (snapPoints.length < maxSnaps) {
              snapPoints.push({ x, y, kind: 'endpoint', layer: ent.layer })
              if (k + 1 < ent.pts.length) {
                const [nx, ny] = ent.pts[k + 1]
                snapPoints.push({ x: (x + nx) / 2, y: (y + ny) / 2, kind: 'midpoint', layer: ent.layer })
              }
            }
          }
        } else if (ent.kind === 'circle' || ent.kind === 'arc') {
          extendBox(ent.cx - ent.r, ent.cy - ent.r)
          extendBox(ent.cx + ent.r, ent.cy + ent.r)
          if (snapPoints.length < maxSnaps) {
            snapPoints.push({ x: ent.cx, y: ent.cy, kind: 'center', layer: ent.layer })
          }
        } else if (ent.kind === 'text') {
          extendBox(ent.x, ent.y)
        }
      }

      const layers: CadLayerInfo[] = [...layerCounts.entries()]
        .map(([name, entityCount]) => ({
          name,
          color: layerColors.get(name) ?? '#e4e4e7',
          visible: layerVisible.get(name) ?? true,
          entityCount
        }))
        .sort((a, b) => b.entityCount - a.entityCount)

      const unitMap: Record<number, string> = { 1: 'in', 2: 'ft', 4: 'mm', 5: 'cm', 6: 'm' }

      return {
        ok: true,
        layers,
        entities: expanded,
        snapPoints,
        bbox: { minX, minY, maxX, maxY },
        unitLabel: unitMap[insUnits] ?? 'mm',
        entityTotal: expanded.length
      }
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err)
      }
    }
  }
}
