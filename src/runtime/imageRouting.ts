import type { ImageChannelRole } from '@shared/protocol'

/**
 * 生图任务 → 渠道偏好路由表（15 个依赖生图的目录任务）。
 *
 * preferRole 表示该任务更吃哪类渠道：声明了对应 role 的渠道会被排到降级链前面；
 * 没有任何渠道声明该 role、或任务未命中路由表时，一律按渠道配置顺序走默认降级链，
 * 因此只配一个渠道的用户行为与此前完全一致。
 *
 * featureCode 来自 SceneParam.featureCode（目录提交时由 compose 写入）；
 * 旧会话/恢复轮次只有 toolTitle 时按标题兜底匹配（标题与 featureCatalog.json 保持一致）。
 */
export interface ImageTaskRoute {
  featureCode: string
  title: string
  tool: 'generate' | 'edit' | 'either'
  preferRole?: ImageChannelRole
}

export const IMAGE_TASK_ROUTES: ImageTaskRoute[] = [
  // 概念方案 B2.2–B2.8
  { featureCode: 'B2.2', title: '平面布局', tool: 'generate', preferRole: 'generate' },
  { featureCode: 'B2.3', title: '形体推敲', tool: 'generate', preferRole: 'generate' },
  { featureCode: 'B2.4', title: '平立剖转效果图', tool: 'edit', preferRole: 'edit' },
  { featureCode: 'B2.5', title: '创意快速渲染', tool: 'generate', preferRole: 'generate' },
  { featureCode: 'B2.6', title: '照片实景改造', tool: 'edit', preferRole: 'edit' },
  { featureCode: 'B2.7', title: '室内毛坯设计', tool: 'generate', preferRole: 'generate' },
  { featureCode: 'B2.8', title: '空房设计', tool: 'generate', preferRole: 'generate' },
  // 生图 B4.1–B4.8
  { featureCode: 'B4.1', title: '概念意象图制作', tool: 'generate', preferRole: 'generate' },
  { featureCode: 'B4.2', title: '设计分析图制作', tool: 'generate', preferRole: 'generate' },
  { featureCode: 'B4.3', title: '精准渲染', tool: 'generate', preferRole: 'generate' },
  { featureCode: 'B4.4', title: '效果图美化', tool: 'edit', preferRole: 'edit' },
  { featureCode: 'B4.5', title: '图片编辑', tool: 'edit', preferRole: 'edit' },
  { featureCode: 'B4.6', title: '更换视角', tool: 'either' },
  { featureCode: 'B4.7', title: '更换氛围', tool: 'edit', preferRole: 'edit' },
  { featureCode: 'B4.8', title: '平立剖填彩', tool: 'edit', preferRole: 'edit' }
]

const ROUTE_BY_CODE = new Map(IMAGE_TASK_ROUTES.map((r) => [r.featureCode, r]))
const ROUTE_BY_TITLE = new Map(IMAGE_TASK_ROUTES.map((r) => [r.title, r]))

export function resolveImageTaskRoute(params: {
  featureCode?: string
  toolTitle?: string
}): ImageTaskRoute | undefined {
  const code = params.featureCode?.trim()
  if (code && ROUTE_BY_CODE.has(code)) return ROUTE_BY_CODE.get(code)
  const title = params.toolTitle?.trim()
  if (title && ROUTE_BY_TITLE.has(title)) return ROUTE_BY_TITLE.get(title)
  return undefined
}
