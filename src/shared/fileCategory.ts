export const FILE_CATEGORIES = [
  'document',
  'spreadsheet',
  'slides',
  'pdf',
  'html',
  'image',
  'archive',
  'data',
  'other'
] as const

export type FileCategory = (typeof FILE_CATEGORIES)[number]

const EXT_CATEGORY: Readonly<Record<string, FileCategory>> = {
  pdf: 'pdf',
  doc: 'document',
  docx: 'document',
  rtf: 'document',
  txt: 'document',
  text: 'document',
  md: 'document',
  markdown: 'document',
  log: 'document',
  odt: 'document',
  pages: 'document',
  xls: 'spreadsheet',
  xlsx: 'spreadsheet',
  xlsm: 'spreadsheet',
  csv: 'spreadsheet',
  tsv: 'spreadsheet',
  numbers: 'spreadsheet',
  ppt: 'slides',
  pptx: 'slides',
  key: 'slides',
  odp: 'slides',
  html: 'html',
  htm: 'html',
  xhtml: 'html',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  svg: 'image',
  bmp: 'image',
  ico: 'image',
  avif: 'image',
  heic: 'image',
  heif: 'image',
  tiff: 'image',
  zip: 'archive',
  rar: 'archive',
  '7z': 'archive',
  tar: 'archive',
  gz: 'archive',
  bz2: 'archive',
  xz: 'archive',
  dmg: 'archive',
  iso: 'archive',
  json: 'data',
  geojson: 'data',
  xml: 'data',
  yaml: 'data',
  yml: 'data',
  sql: 'data',
  db: 'data',
  sqlite: 'data',
  parquet: 'data',
  protobuf: 'data'
}

export function fileExtOf(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined
  const dot = raw.lastIndexOf('.')
  if (dot < 0 || dot === raw.length - 1) return undefined
  return raw.slice(dot + 1).toLowerCase()
}

export function fileCategoryOf(fileName: string, hintUrl?: string): FileCategory {
  const direct = EXT_CATEGORY[fileExtOf(fileName) ?? '']
  if (direct) return direct
  if (hintUrl) {
    const segment = hintUrl.split(/[?#]/)[0].split(/[\\/]/).pop()
    const hinted = EXT_CATEGORY[fileExtOf(segment ?? '') ?? '']
    if (hinted) return hinted
  }
  return 'other'
}
