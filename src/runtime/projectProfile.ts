import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * 结构化项目档案 project.json：项目的尺寸、房间、风格、主材、预算、硬约束与否决项的唯一权威来源。
 * 建模、出图提示词、规范核查、汇报文档都从这里读取，避免各处各写一个数字（如 PPT 写 120㎡、模型做成 110㎡）。
 * memory.md / project_decisions.md 仍保留，用于记录不适合结构化的长期备注。
 */
export const PROJECT_SCHEMA = 'design-agent/project@1'

export interface ProjectRoom {
  id?: string
  name: string
  area_m2?: number
  function?: string
  notes?: string
  source?: string
}

export interface ProjectMaterial {
  item: string
  spec: string
  rooms?: string[]
}

export interface ProjectDecision {
  text: string
  date?: string
  source?: string
}

export interface ProjectProfile {
  schema: typeof PROJECT_SCHEMA
  name?: string
  building_type?: string
  location?: string
  total_area_m2?: number
  storey_height_mm?: number
  style?: { direction?: string; keywords?: string[]; reference_images?: string[] }
  materials?: ProjectMaterial[]
  budget?: { total?: number; currency?: string; note?: string }
  rooms?: ProjectRoom[]
  constraints?: string[]
  rejected?: string[]
  decisions?: ProjectDecision[]
  plan_file?: string
  updated_at?: string
}

export function projectProfilePath(projectMemoryFile: string): string {
  return join(dirname(projectMemoryFile), 'project.json')
}

export function emptyProfile(): ProjectProfile {
  return { schema: PROJECT_SCHEMA }
}

export function loadProjectProfile(path: string): ProjectProfile | null {
  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as ProjectProfile
    return raw && typeof raw === 'object' ? { ...raw, schema: PROJECT_SCHEMA } : null
  } catch {
    return null
  }
}

export function saveProjectProfile(path: string, profile: ProjectProfile): void {
  mkdirSync(dirname(path), { recursive: true })
  const next: ProjectProfile = { ...profile, schema: PROJECT_SCHEMA, updated_at: new Date().toISOString() }
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
  try {
    renameSync(tmp, path)
  } catch {
    writeFileSync(path, JSON.stringify(next, null, 2), 'utf8')
  }
}

function uniqueStrings(list: unknown[]): string[] {
  const out: string[] = []
  for (const item of list) {
    if (typeof item !== 'string') continue
    const t = item.trim()
    if (t && !out.includes(t)) out.push(t)
  }
  return out
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeDecision(item: unknown): ProjectDecision | null {
  const d = typeof item === 'string' ? { text: item } : (item as ProjectDecision | undefined)
  if (!d || typeof d.text !== 'string' || !d.text.trim()) return null
  return { ...d, text: d.text.trim() }
}

/** 合并决策：两侧都归一成 { text } 再按文本去重，新条目补当天日期 */
function mergeDecisions(base: unknown[], incoming: unknown[]): ProjectDecision[] {
  const list: ProjectDecision[] = []
  const seen = new Set<string>()
  for (const raw of base) {
    const d = normalizeDecision(raw)
    if (!d || seen.has(d.text)) continue
    seen.add(d.text)
    list.push(d)
  }
  for (const raw of incoming) {
    const d = normalizeDecision(raw)
    if (!d || seen.has(d.text)) continue
    seen.add(d.text)
    list.push({ date: new Date().toISOString().slice(0, 10), ...d })
  }
  return list
}

/**
 * 合并更新：标量直接覆盖、值为 null 表示删除该字段；
 * rooms 按房间名合并（同名房间只更新给出的字段）、materials 按 item 合并；
 * constraints / rejected 取并集，decisions 追加并去重。
 * 需要整体替换数组时，在 patch 里写 `"replace": ["rooms"]` 之类。
 * 这几个数组字段即使原先不存在也会走归一化，否则首次写入会把重复项原样存下来。
 */
export function applyProfilePatch(base: ProjectProfile, patch: Record<string, unknown>): ProjectProfile {
  const next: Record<string, unknown> = { ...base }
  const replace = new Set(Array.isArray(patch.replace) ? (patch.replace as unknown[]).map(String) : [])
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'replace' || key === 'schema' || key === 'updated_at') continue
    if (value === null) {
      delete next[key]
      continue
    }
    const current = next[key]
    if (replace.has(key)) {
      next[key] = value
      continue
    }
    const baseList = Array.isArray(current) ? current : []
    if (key === 'rooms' && Array.isArray(value)) {
      const rooms = (baseList as ProjectRoom[]).map((r) => ({ ...r }))
      for (const item of value as ProjectRoom[]) {
        if (!item || typeof item.name !== 'string') continue
        const hit = rooms.find((r) => r.name === item.name)
        if (hit) Object.assign(hit, item)
        else rooms.push({ ...item })
      }
      next.rooms = rooms
    } else if (key === 'materials' && Array.isArray(value)) {
      const mats = (baseList as ProjectMaterial[]).map((m) => ({ ...m }))
      for (const item of value as ProjectMaterial[]) {
        if (!item || typeof item.item !== 'string') continue
        const hit = mats.find((m) => m.item === item.item)
        if (hit) Object.assign(hit, item)
        else mats.push({ ...item })
      }
      next.materials = mats
    } else if ((key === 'constraints' || key === 'rejected') && Array.isArray(value)) {
      next[key] = uniqueStrings([...baseList, ...value])
    } else if (key === 'decisions' && Array.isArray(value)) {
      next.decisions = mergeDecisions(baseList, value)
    } else if (current === undefined) {
      next[key] = value
    } else if (isPlainObject(value) && isPlainObject(current)) {
      next[key] = { ...current, ...value }
    } else {
      next[key] = value
    }
  }
  return { ...(next as unknown as ProjectProfile), schema: PROJECT_SCHEMA }
}

/** 从 plan.json 同步房间清单、总面积与层高；房间的功能、备注等人工填写的字段按房间名保留 */
export function importPlanIntoProfile(
  base: ProjectProfile,
  planPath: string
): { profile: ProjectProfile; summary: string } {
  const plan = JSON.parse(readFileSync(planPath, 'utf8')) as {
    schema?: string
    storey?: { height?: number }
    rooms?: Array<{ id: string; name: string; area_m2: number }>
    summary?: { room_area_m2?: number }
  }
  if (!String(plan.schema ?? '').startsWith('design-agent/plan@')) {
    throw new Error(`${planPath} 不是 plan.json（schema=${plan.schema ?? '缺失'}）`)
  }
  const previous = new Map((base.rooms ?? []).map((r) => [r.name, r]))
  const rooms: ProjectRoom[] = (plan.rooms ?? []).map((r) => ({
    ...(previous.get(r.name) ?? {}),
    id: r.id,
    name: r.name,
    area_m2: r.area_m2,
    source: 'plan.json'
  }))
  // 档案里有、平面里没有的房间（例如用户口述的室外区域）保留，标注来源
  for (const r of base.rooms ?? []) {
    if (!rooms.some((x) => x.name === r.name)) rooms.push(r)
  }
  const profile: ProjectProfile = {
    ...base,
    schema: PROJECT_SCHEMA,
    rooms,
    plan_file: planPath,
    total_area_m2: plan.summary?.room_area_m2 ?? base.total_area_m2,
    storey_height_mm: plan.storey?.height ?? base.storey_height_mm
  }
  const summary = `已从 plan.json 同步 ${plan.rooms?.length ?? 0} 个房间，套内合计 ${profile.total_area_m2 ?? '?'} ㎡，层高 ${profile.storey_height_mm ?? '?'} mm`
  return { profile, summary }
}

/** 系统提示词里的项目档案摘要：只放关键字段，控制长度 */
export function summarizeProfile(profile: ProjectProfile, maxChars = 3000): string {
  const lines: string[] = []
  const head = [
    profile.name && `项目：${profile.name}`,
    profile.building_type && `类型：${profile.building_type}`,
    profile.location && `地点：${profile.location}`,
    profile.total_area_m2 !== undefined && `套内面积：${profile.total_area_m2}㎡`,
    profile.storey_height_mm !== undefined && `层高：${profile.storey_height_mm}mm`
  ].filter(Boolean)
  if (head.length) lines.push(head.join('｜'))
  const style = profile.style ?? {}
  const keywords = style.keywords ?? []
  const refs = style.reference_images ?? []
  const rooms = profile.rooms ?? []
  const materials = profile.materials ?? []
  const constraints = profile.constraints ?? []
  const rejected = profile.rejected ?? []
  const decisions = profile.decisions ?? []
  if (style.direction || keywords.length) {
    lines.push(`风格：${[style.direction, ...keywords].filter(Boolean).join('、')}`)
  }
  if (refs.length) lines.push(`风格参考图：${refs.join('；')}`)
  if (rooms.length) {
    lines.push(
      `房间：${rooms
        .map((r) => `${r.name}${r.area_m2 !== undefined ? ` ${r.area_m2}㎡` : ''}${r.function ? `（${r.function}）` : ''}`)
        .join('，')}`
    )
  }
  if (materials.length) lines.push(`主材：${materials.map((m) => `${m.item}=${m.spec}`).join('；')}`)
  if (profile.budget?.total !== undefined) lines.push(`预算：${profile.budget.total}${profile.budget.currency ?? '元'}${profile.budget.note ? `（${profile.budget.note}）` : ''}`)
  if (constraints.length) lines.push(`硬约束：${constraints.join('；')}`)
  if (rejected.length) lines.push(`已否决：${rejected.join('；')}`)
  if (decisions.length) lines.push(`已确认决策：${decisions.slice(-12).map((d) => d.text).join('；')}`)
  if (profile.plan_file) lines.push(`平面数据：${profile.plan_file.replace(/\\/g, '/')}`)
  const text = lines.join('\n')
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n…（其余内容见 project.json）` : text
}
