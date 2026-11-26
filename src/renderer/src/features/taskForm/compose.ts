import type { AgentAttachment, SceneParam } from '@shared/protocol'
import rawCatalog from '../../config/featureCatalog.json'
import rawForms from '../../config/featureForms.json'

export type FeatureFieldWidget = 'text' | 'textFile' | 'file'

export interface FeatureCatalogItem {
  featureCode: string
  title: string
  category: string
  description: string
  cover?: {
    kind: string
    single?: string | null
    input?: string | null
    generated?: string | null
  }
  order: number
  searchAlias: string[]
  todayRecommend?: string
  recommendTab?: boolean
}

export interface FeatureFieldDef {
  code: string
  label: string
  widget: FeatureFieldWidget
  required: boolean
  placeholder: string
  order: number
}

export interface FeatureFieldDraft {
  text: string
  attachments: AgentAttachment[]
}

export interface FeatureFormDraft {
  fields: Record<string, FeatureFieldDraft>
}

export interface FeatureSubmission {
  title: string
  text: string
  attachments: AgentAttachment[]
  sceneParam: SceneParam
}

export const FEATURE_CATALOG: FeatureCatalogItem[] = [...(rawCatalog as FeatureCatalogItem[])].sort(
  (a, b) => a.order - b.order
)

export const FEATURE_FORMS: Record<string, { fields: FeatureFieldDef[] }> = rawForms as Record<
  string,
  { fields: FeatureFieldDef[] }
>

export const FEATURE_CATEGORIES = [
  '全部',
  '推荐',
  '策划',
  '概念方案',
  '深化建模',
  '生图',
  '汇报',
  '施工',
  '评审',
  '检索'
] as const

const WEEKDAYS_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

export function getTodayWeekdayLabel(now: Date = new Date()): string {
  return WEEKDAYS_ZH[now.getDay()] ?? '周一'
}

export function filterFeatures(
  catalog: FeatureCatalogItem[],
  category: string,
  searchQuery: string
): FeatureCatalogItem[] {
  const q = searchQuery.trim().toLowerCase()
  return catalog.filter((f) => {
    const catOk =
      !category || category === '全部'
        ? true
        : category === '推荐'
          ? Boolean(f.recommendTab)
          : f.category === category
    if (!catOk) return false
    if (!q) return true
    return (
      f.title.toLowerCase().includes(q) ||
      f.description.toLowerCase().includes(q) ||
      f.featureCode.toLowerCase().includes(q) ||
      f.category.toLowerCase().includes(q) ||
      f.searchAlias.some((alias) => alias.toLowerCase().includes(q))
    )
  })
}

export function validateFeatureDraft(
  fields: FeatureFieldDef[],
  draft: FeatureFormDraft
): string[] {
  const missing: string[] = []
  for (const field of fields) {
    if (!field.required) continue
    const fd = draft.fields[field.code]
    const hasText = Boolean(fd?.text?.trim())
    const hasFiles = Boolean(fd?.attachments && fd.attachments.length > 0)
    if (field.widget === 'file' && !hasFiles) {
      missing.push(field.code)
    } else if (field.widget === 'text' && !hasText) {
      missing.push(field.code)
    } else if (field.widget === 'textFile' && !hasText && !hasFiles) {
      missing.push(field.code)
    }
  }
  return missing
}

export function composeFeatureSubmission(
  feature: FeatureCatalogItem,
  fields: FeatureFieldDef[],
  draft: FeatureFormDraft
): FeatureSubmission {
  const numberedAttachments: Array<AgentAttachment & { number: number }> = []
  const sections: string[] = []
  let titleSource = ''

  for (const field of [...fields].sort((a, b) => a.order - b.order)) {
    const fd = draft.fields[field.code]
    const text = fd?.text?.trim() ?? ''
    const files = fd?.attachments ?? []
    if (!field.required && !text && files.length === 0) continue

    const refs: string[] = []
    for (const att of files) {
      const num = numberedAttachments.length + 1
      numberedAttachments.push({ ...att, number: num })
      refs.push(`附件[${num}] ${att.name}`)
    }

    if (!titleSource && field.required && field.widget !== 'file' && text) {
      titleSource = text
    }

    sections.push([`【${field.label}】`, text, ...refs].filter(Boolean).join('\n'))
  }

  const title = titleSource
    ? `${feature.title}：${[...titleSource].slice(0, 20).join('')}`
    : feature.title

  return {
    title,
    text: sections.join('\n\n'),
    attachments: numberedAttachments.map(({ number: _n, ...att }) => att),
    sceneParam: { toolTitle: feature.title, featureCode: feature.featureCode }
  }
}
