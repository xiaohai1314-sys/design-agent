import React, { useEffect, useMemo, useRef, useState } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import * as XLSX from 'xlsx'
import mammoth from 'mammoth'
import JSZip from 'jszip'
import { LoaderCircle, ZoomIn, ZoomOut } from 'lucide-react'
import clsx from 'clsx'

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl

function decodeBase64ToUint8(b64: string): Uint8Array {
  const bin = atob(b64)
  const arr = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
  return arr
}

function useBinaryBytes(filePath: string): {
  bytes: Uint8Array | null
  loading: boolean
  error: string | null
} {
  const [state, setState] = useState<{
    bytes: Uint8Array | null
    loading: boolean
    error: string | null
  }>({ bytes: null, loading: true, error: null })

  useEffect(() => {
    let cancelled = false
    setState({ bytes: null, loading: true, error: null })
    window.zmo.files
      .readBytes(filePath)
      .then((res) => {
        if (cancelled) return
        if (!res.ok || !res.base64) {
          setState({ bytes: null, loading: false, error: res.error || '文件读取失败' })
        } else {
          setState({ bytes: decodeBase64ToUint8(res.base64), loading: false, error: null })
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState({
            bytes: null,
            loading: false,
            error: err instanceof Error ? err.message : String(err)
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [filePath])

  return state
}

/* ==================== 1. PDF 面板内渲染预览 ==================== */
export const PdfPreviewPanel: React.FC<{ filePath: string }> = ({ filePath }) => {
  const { bytes, loading, error } = useBinaryBytes(filePath)
  const [numPages, setNumPages] = useState(0)
  const [scale, setScale] = useState(1.15)
  const [pdfError, setPdfError] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!bytes || !containerRef.current) return
    let cancelled = false
    const host = containerRef.current
    host.innerHTML = ''
    setPdfError(null)

    const task = pdfjsLib.getDocument({
      data: bytes.slice(),
      cMapUrl: './pdfjs/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: './pdfjs/standard_fonts/'
    })
    task.promise
      .then(async (pdf) => {
        if (cancelled) return
        setNumPages(pdf.numPages)
        const maxRender = Math.min(pdf.numPages, 40)
        for (let pageNo = 1; pageNo <= maxRender; pageNo++) {
          if (cancelled) return
          const page = await pdf.getPage(pageNo)
          const viewport = page.getViewport({ scale })
          const wrap = document.createElement('div')
          wrap.className = 'mb-3 bg-white shadow-sm rounded-lg overflow-hidden border border-zinc-200 mx-auto'
          wrap.style.width = `${Math.floor(viewport.width)}px`

          const canvas = document.createElement('canvas')
          const dpr = Math.min(window.devicePixelRatio || 1, 2)
          canvas.width = Math.floor(viewport.width * dpr)
          canvas.height = Math.floor(viewport.height * dpr)
          canvas.style.width = `${Math.floor(viewport.width)}px`
          canvas.style.height = `${Math.floor(viewport.height)}px`
          const ctx = canvas.getContext('2d')!
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

          const footer = document.createElement('div')
          footer.className = 'px-2 py-1 text-[10px] text-zinc-400 bg-zinc-50 border-t border-zinc-100 text-center'
          footer.textContent = `第 ${pageNo} / ${pdf.numPages} 页`

          wrap.appendChild(canvas)
          wrap.appendChild(footer)
          host.appendChild(wrap)

          await page.render({ canvasContext: ctx, viewport, canvas }).promise
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setPdfError(err instanceof Error ? err.message : String(err))
      })

    return () => {
      cancelled = true
      void task.destroy()
    }
  }, [bytes, scale])

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center gap-2 text-xs text-zinc-500 py-12">
        <LoaderCircle className="w-4 h-4 animate-spin text-blue-600" />
        <span>正在加载 PDF 文档…</span>
      </div>
    )
  }

  if (error || pdfError) {
    return <div className="p-6 text-xs text-rose-600 text-center">{error || pdfError}</div>
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-2">
      <div className="flex items-center justify-between px-3 py-1.5 rounded-xl bg-zinc-100 text-xs text-zinc-700 shrink-0">
        <span>共 {numPages} 页</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setScale((s) => Math.max(0.5, Number((s - 0.15).toFixed(2))))}
            className="p-1 rounded hover:bg-zinc-200 cursor-pointer"
            title="缩小"
          >
            <ZoomOut className="w-3.5 h-3.5" />
          </button>
          <span className="w-12 text-center font-mono text-[11px]">{Math.round(scale * 100)}%</span>
          <button
            type="button"
            onClick={() => setScale((s) => Math.min(2.5, Number((s + 0.15).toFixed(2))))}
            className="p-1 rounded hover:bg-zinc-200 cursor-pointer"
            title="放大"
          >
            <ZoomIn className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div
        ref={containerRef}
        className="flex-1 min-h-0 overflow-auto rounded-xl border border-zinc-200 bg-zinc-200/60 p-3"
      />
    </div>
  )
}

/* ==================== 2. Excel (.xlsx / .xls) 多 Sheet 合并单元格预览 ==================== */
interface SheetCellData {
  value: string
  rowSpan?: number
  colSpan?: number
  skip: boolean
}

function colIndexToLetter(idx: number): string {
  let result = ''
  let n = idx + 1
  while (n > 0) {
    const rem = (n - 1) % 26
    result = String.fromCharCode(65 + rem) + result
    n = Math.floor((n - 1) / 26)
  }
  return result
}

function parseWorksheet(ws: XLSX.WorkSheet): SheetCellData[][] {
  if (!ws['!ref']) return []
  const range = XLSX.utils.decode_range(ws['!ref'])
  const maxRow = Math.min(range.e.r, range.s.r + 300)
  const maxCol = Math.min(range.e.c, range.s.c + 60)
  const merges = ws['!merges'] ?? []
  const skipSet = new Set<string>()
  const spanMap = new Map<string, { rowSpan: number; colSpan: number }>()

  for (const { s, e } of merges) {
    spanMap.set(`${s.r},${s.c}`, {
      rowSpan: e.r - s.r + 1,
      colSpan: e.c - s.c + 1
    })
    for (let r = s.r; r <= e.r; r++) {
      for (let c = s.c; c <= e.c; c++) {
        if (r !== s.r || c !== s.c) skipSet.add(`${r},${c}`)
      }
    }
  }

  const cells: SheetCellData[][] = []
  for (let r = range.s.r; r <= maxRow; r++) {
    const row: SheetCellData[] = []
    for (let c = range.s.c; c <= maxCol; c++) {
      const key = `${r},${c}`
      if (skipSet.has(key)) {
        row.push({ value: '', skip: true })
        continue
      }
      const cell = ws[XLSX.utils.encode_cell({ r, c })]
      const span = spanMap.get(key)
      row.push({
        value: String(cell?.w ?? cell?.v ?? ''),
        rowSpan: span?.rowSpan,
        colSpan: span?.colSpan,
        skip: false
      })
    }
    cells.push(row)
  }
  return cells
}

export const SheetPreviewPanel: React.FC<{ filePath: string }> = ({ filePath }) => {
  const { bytes, loading, error } = useBinaryBytes(filePath)
  const [activeSheetIdx, setActiveSheetIdx] = useState(0)

  const sheets = useMemo(() => {
    if (!bytes) return []
    try {
      const wb = XLSX.read(bytes, { type: 'array' })
      return wb.SheetNames.map((name) => ({
        name,
        cells: parseWorksheet(wb.Sheets[name])
      }))
    } catch {
      return []
    }
  }, [bytes])

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center gap-2 text-xs text-zinc-500 py-12">
        <LoaderCircle className="w-4 h-4 animate-spin text-blue-600" />
        <span>正在解析 Excel 表格…</span>
      </div>
    )
  }

  if (error || sheets.length === 0) {
    return <div className="p-6 text-xs text-rose-600 text-center">{error || '未能解析到工作表'}</div>
  }

  const cur = sheets[Math.min(activeSheetIdx, sheets.length - 1)]
  const colCount = cur.cells[0]?.length ?? 0

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-2">
      <div className="flex items-center gap-1 overflow-x-auto pb-1 shrink-0">
        {sheets.map((s, idx) => (
          <button
            key={s.name}
            type="button"
            onClick={() => setActiveSheetIdx(idx)}
            className={clsx(
              'px-2.5 py-1 rounded-lg text-xs whitespace-nowrap cursor-pointer border',
              idx === activeSheetIdx
                ? 'bg-emerald-600 text-white border-emerald-600 font-medium'
                : 'bg-zinc-50 text-zinc-700 border-zinc-200 hover:bg-zinc-100'
            )}
          >
            {s.name}
          </button>
        ))}
      </div>

      <div className="flex-1 min-h-0 overflow-auto rounded-xl border border-zinc-200 bg-white">
        {cur.cells.length === 0 ? (
          <div className="py-12 text-center text-xs text-zinc-400">当前工作表为空</div>
        ) : (
          <table className="border-collapse text-[11px] w-max min-w-full">
            <thead className="sticky top-0 z-10 bg-zinc-100 text-zinc-500">
              <tr>
                <th className="border border-zinc-200 px-2 py-1 bg-zinc-100 w-9 text-center">#</th>
                {Array.from({ length: colCount }, (_, cIdx) => (
                  <th
                    key={cIdx}
                    className="border border-zinc-200 px-2.5 py-1 font-mono font-medium min-w-20 text-center"
                  >
                    {colIndexToLetter(cIdx)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {cur.cells.map((row, rIdx) => (
                <tr key={rIdx} className="hover:bg-blue-50/30">
                  <td className="border border-zinc-200 px-2 py-1 bg-zinc-50 text-zinc-400 font-mono text-center">
                    {rIdx + 1}
                  </td>
                  {row.map((cell, cIdx) =>
                    cell.skip ? null : (
                      <td
                        key={cIdx}
                        rowSpan={cell.rowSpan}
                        colSpan={cell.colSpan}
                        className="border border-zinc-200 px-2.5 py-1.5 text-zinc-800 whitespace-pre-wrap align-top"
                      >
                        {cell.value}
                      </td>
                    )
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

/* ==================== 3. Word (.docx) 富文本预览 ==================== */
export const DocxPreviewPanel: React.FC<{ filePath: string }> = ({ filePath }) => {
  const { bytes, loading, error } = useBinaryBytes(filePath)
  const [html, setHtml] = useState<string>('')
  const [parseError, setParseError] = useState<string | null>(null)

  useEffect(() => {
    if (!bytes) return
    let cancelled = false
    const copy = bytes.slice()
    mammoth
      .convertToHtml({ arrayBuffer: copy.buffer })
      .then((res) => {
        if (!cancelled) setHtml(res.value)
      })
      .catch((err: unknown) => {
        if (!cancelled) setParseError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [bytes])

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center gap-2 text-xs text-zinc-500 py-12">
        <LoaderCircle className="w-4 h-4 animate-spin text-blue-600" />
        <span>正在解析 Word 文档…</span>
      </div>
    )
  }

  if (error || parseError) {
    return <div className="p-6 text-xs text-rose-600 text-center">{error || parseError}</div>
  }

  return (
    <div className="flex-1 min-h-0 overflow-auto rounded-xl border border-zinc-200 bg-white p-5">
      <div
        className="zmo-markdown"
        // mammoth 已转换出安全 HTML 段落与表格
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  )
}

/* ==================== 4. PPTX (.pptx) 幻灯片逐页图文预览 ==================== */
interface ParsedSlide {
  index: number
  texts: string[]
  images: string[]
}

export const PptxPreviewPanel: React.FC<{ filePath: string }> = ({ filePath }) => {
  const { bytes, loading, error } = useBinaryBytes(filePath)
  const [slides, setSlides] = useState<ParsedSlide[]>([])
  const [parseError, setParseError] = useState<string | null>(null)

  useEffect(() => {
    if (!bytes) return
    let cancelled = false

    const parseSlides = async (): Promise<void> => {
      const zip = await JSZip.loadAsync(bytes)
      const slideEntries = Object.keys(zip.files)
        .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
        .sort((a, b) => {
          const na = parseInt(/slide(\d+)\.xml/i.exec(a)?.[1] ?? '0', 10)
          const nb = parseInt(/slide(\d+)\.xml/i.exec(b)?.[1] ?? '0', 10)
          return na - nb
        })

      const parser = new DOMParser()
      const out: ParsedSlide[] = []

      for (const slideName of slideEntries) {
        const idx = parseInt(/slide(\d+)\.xml/i.exec(slideName)?.[1] ?? '0', 10)
        const xmlText = await zip.file(slideName)!.async('string')
        const doc = parser.parseFromString(xmlText, 'application/xml')

        // 按段落 <a:p> 提取文本
        const pNodes = Array.from(doc.getElementsByTagNameNS('*', 'p'))
        const texts: string[] = []
        for (const p of pNodes) {
          const tNodes = Array.from(p.getElementsByTagNameNS('*', 't'))
          const line = tNodes.map((t) => t.textContent ?? '').join('').trim()
          if (line) texts.push(line)
        }

        // 查找当前页引用的图片资源
        const images: string[] = []
        const relPath = `ppt/slides/_rels/slide${idx}.xml.rels`
        const relFile = zip.file(relPath)
        if (relFile) {
          const relXml = await relFile.async('string')
          const relDoc = parser.parseFromString(relXml, 'application/xml')
          const rels = Array.from(relDoc.getElementsByTagName('Relationship'))
          for (const rel of rels) {
            const typeAttr = rel.getAttribute('Type') ?? ''
            const target = rel.getAttribute('Target') ?? ''
            if (typeAttr.endsWith('/image') && target) {
              const norm = target.replace(/^(\.\.\/)+/, 'ppt/').replace(/^\/+/, '')
              const mediaFile = zip.file(norm)
              if (mediaFile) {
                const b64 = await mediaFile.async('base64')
                const ext = norm.split('.').pop()?.toLowerCase() ?? 'png'
                const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`
                images.push(`data:${mime};base64,${b64}`)
              }
            }
          }
        }

        out.push({ index: idx, texts, images })
      }

      if (!cancelled) setSlides(out)
    }

    parseSlides().catch((err: unknown) => {
      if (!cancelled) setParseError(err instanceof Error ? err.message : String(err))
    })

    return () => {
      cancelled = true
    }
  }, [bytes])

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center gap-2 text-xs text-zinc-500 py-12">
        <LoaderCircle className="w-4 h-4 animate-spin text-blue-600" />
        <span>正在解析 PPTX 幻灯片…</span>
      </div>
    )
  }

  if (error || parseError) {
    return <div className="p-6 text-xs text-rose-600 text-center">{error || parseError}</div>
  }

  return (
    <div className="flex-1 min-h-0 overflow-auto rounded-xl border border-zinc-200 bg-zinc-100 p-3 space-y-3">
      {slides.length === 0 ? (
        <div className="py-12 text-center text-xs text-zinc-400">未解析到幻灯片内容</div>
      ) : (
        slides.map((sl) => (
          <div
            key={sl.index}
            className="rounded-xl bg-white border border-zinc-200 shadow-xs overflow-hidden"
          >
            <div className="px-3.5 py-2 bg-zinc-50 border-b border-zinc-100 flex items-center justify-between text-[11px] text-zinc-500">
              <span className="font-semibold text-zinc-700">第 {sl.index} 页</span>
              <span>{sl.texts.length} 段文字 · {sl.images.length} 张配图</span>
            </div>
            <div className="p-4 space-y-3">
              {sl.texts.length > 0 && (
                <div className="space-y-1.5">
                  {sl.texts.map((line, i) => (
                    <div
                      key={i}
                      className={clsx(
                        i === 0
                          ? 'text-sm font-semibold text-zinc-900'
                          : 'text-xs text-zinc-700 leading-relaxed'
                      )}
                    >
                      {line}
                    </div>
                  ))}
                </div>
              )}
              {sl.images.length > 0 && (
                <div className="grid grid-cols-2 gap-2 pt-1">
                  {sl.images.slice(0, 4).map((src, i) => (
                    <img
                      key={i}
                      src={src}
                      alt={`slide-${sl.index}-img-${i}`}
                      className="rounded-lg border border-zinc-100 object-cover max-h-40 w-full"
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        ))
      )}
    </div>
  )
}
