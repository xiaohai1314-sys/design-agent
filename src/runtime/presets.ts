import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { SceneParam } from '@shared/protocol'
import type { SelectedMcpConnector } from '@shared/mcp'

export interface ModelingPresetInfo {
  id: string
  title: string
  targetHost: 'sketchup' | 'blender' | 'rhino' | '3dsmax' | 'cad'
  entryScript: string
  entryScriptPath: string
  presetDir: string
  invokeMethod: string
  sceneTools: string[]
  keywords: string[]
  styles: Record<string, string>
  defaultParams: Record<string, unknown>
  description: string
}

interface RawPresetManifest {
  presets?: Array<{
    id: string
    title: string
    targetHost?: ModelingPresetInfo['targetHost']
    entryScript?: string
    invokeMethod?: string
    sceneTools?: string[]
    keywords?: string[]
    styles?: Record<string, string>
    defaultParams?: Record<string, unknown>
    description?: string
  }>
}

export function resolvePresetsRoot(explicitRoot?: string, skillsRoot?: string): string {
  const direct = (explicitRoot || process.env.DESIGN_AGENT_PRESETS_ROOT || '').trim()
  if (direct && existsSync(direct)) return direct
  const sk = (skillsRoot || process.env.DESIGN_AGENT_SKILLS_ROOT || '').trim()
  if (sk) {
    const sibling = join(dirname(sk), 'presets')
    if (existsSync(sibling)) return sibling
  }
  return ''
}

export function discoverModelingPresets(explicitRoot?: string, skillsRoot?: string): ModelingPresetInfo[] {
  const root = resolvePresetsRoot(explicitRoot, skillsRoot)
  if (!root) return []
  const manifestPath = join(root, 'manifest.json')
  if (!existsSync(manifestPath)) return []

  try {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as RawPresetManifest
    const list: ModelingPresetInfo[] = []
    for (const item of parsed.presets ?? []) {
      if (!item.id || !item.entryScript) continue
      const presetDir = join(root, item.id)
      const entryScriptPath = join(presetDir, item.entryScript)
      if (!existsSync(entryScriptPath)) continue
      list.push({
        id: item.id,
        title: item.title || item.id,
        targetHost: item.targetHost ?? 'sketchup',
        entryScript: item.entryScript,
        entryScriptPath: entryScriptPath.replace(/\\/g, '/'),
        presetDir: presetDir.replace(/\\/g, '/'),
        invokeMethod: item.invokeMethod || 'LivingRoomPreset.build',
        sceneTools: item.sceneTools ?? [],
        keywords: item.keywords ?? [],
        styles: item.styles ?? {},
        defaultParams: item.defaultParams ?? {},
        description: item.description ?? ''
      })
    }
    return list
  } catch {
    return []
  }
}

export function matchModelingPreset(
  presets: ModelingPresetInfo[],
  params: {
    text: string
    sceneParam?: SceneParam
    mcp?: SelectedMcpConnector[]
    /** 用户本轮带了自己的附件（图纸、照片等） */
    hasAttachments?: boolean
  }
): ModelingPresetInfo | null {
  if (!presets || presets.length === 0) return null
  const pv = params.sceneParam?.paramValues ?? {}
  const explicitId = (pv['预置包'] || pv['preset'] || pv['预置脚本'] || '').trim()
  if (explicitId) {
    const hit = presets.find((p) => p.id === explicitId)
    if (hit) return hit
  }

  // 用户带了自己的图纸/资料时不做自动匹配，避免用示例工程包替代用户的真实文件（显式指定预置包时仍然生效）
  if (params.hasAttachments) return null

  const lowerText = params.text.toLowerCase()
  const toolTitle = (params.sceneParam?.toolTitle ?? '').trim()
  const hostPref = (pv['建模软件'] || pv['targetHost'] || '').trim().toLowerCase()
  const mcpNames = new Set((params.mcp ?? []).map((m) => m.name.toLowerCase()))

  for (const preset of presets) {
    if (hostPref && !hostPref.includes(preset.targetHost) && !(preset.targetHost === 'sketchup' && hostPref === 'su')) {
      continue
    }
    // multicad 连接器在 MCP 里名为 multicad，对应预置宿主 cad
    const hostMcpNames =
      preset.targetHost === 'cad' ? ['cad', 'multicad'] : [preset.targetHost]
    if (mcpNames.size > 0 && !hostMcpNames.some((n) => mcpNames.has(n))) {
      continue
    }

    const inSceneTool = Boolean(toolTitle && preset.sceneTools.includes(toolTitle))
    // CAD 种子图包关键词（CAD/DWG/平面图/户型…）过于宽泛，只在用户从场景工具里明确选择时匹配
    if (preset.targetHost === 'cad' && !inSceneTool) continue
    const hasHostSignal =
      preset.targetHost === 'cad'
        ? mcpNames.has('multicad') ||
          mcpNames.has('cad') ||
          inSceneTool ||
          /(autocad|\bcad\b|dwg|dxf|平面图|户型|转绘|描图|图纸检查)/i.test(params.text)
        : mcpNames.has('sketchup') ||
          inSceneTool ||
          /(sketchup|\bsu\b|草图大师|三维建模|建模型|白模|参数化建模)/i.test(params.text)
    if (!hasHostSignal) continue

    const keywordHit =
      preset.keywords.some((kw) => lowerText.includes(kw.toLowerCase())) ||
      lowerText.includes(preset.id.toLowerCase()) ||
      inSceneTool
    if (keywordHit) return preset
  }

  return null
}

function parseStyleKey(raw: string): string | null {
  // 先去掉否定表达（“不要新中式”“别用石材”），避免把用户排除的风格识别成目标风格
  const s = raw.toLowerCase().replace(/(不要|不用|不想要|别用|别做|避免|拒绝|排除|而不是|不喜欢)[^，,。；;、\s]{0,8}/g, ' ')
  if (/new_chinese|新中式|东方|中式/.test(s)) return 'new_chinese'
  if (/wabi_wood|侘寂|原木|日式/.test(s)) return 'wabi_wood'
  if (/light_luxury|轻奢|石材|金属/.test(s)) return 'light_luxury'
  if (/modern_minimal|现代|极简|简约/.test(s)) return 'modern_minimal'
  return null
}

/** 生成可安全放进 Ruby 单引号字符串的文本 */
function rubyStr(value: string): string {
  return value.replace(/\\/g, '/').replace(/'/g, "\\'")
}

export function extractPresetOptions(
  preset: ModelingPresetInfo,
  text: string,
  sceneParam?: SceneParam
): Record<string, unknown> & { __defaulted?: string[] } {
  const pv = sceneParam?.paramValues ?? {}
  // 场景表单字段优先，用户原文只作补充
  const formText = Object.values(pv).join(' ')
  const combined = `${formText} ${text}`
  const result: Record<string, unknown> & { __defaulted?: string[] } = { ...preset.defaultParams }
  const detected = new Set<string>()

  const styleKey = parseStyleKey(pv['风格'] || pv['style'] || '') ?? parseStyleKey(combined)
  if (styleKey) {
    result.style = styleKey
    detected.add('style')
  }

  // 解析开间×进深（支持 4800×6400mm 或 4.8×6.4m / 5米x7米）；先在表单里找，再在原文里找
  const sizeMmRe = /(\d{4})\s*[x×*]\s*(\d{4})(?:\s*[x×*]\s*(\d{4}))?/i
  const sizeMmMatch = sizeMmRe.exec(formText) ?? sizeMmRe.exec(text)
  if (sizeMmMatch) {
    result.width_mm = Number(sizeMmMatch[1])
    result.depth_mm = Number(sizeMmMatch[2])
    detected.add('width_mm').add('depth_mm')
    if (sizeMmMatch[3]) {
      result.height_mm = Number(sizeMmMatch[3])
      detected.add('height_mm')
    }
  } else {
    const sizeMeterMatch = /(\d+(?:\.\d+)?)\s*(?:m|米)?\s*[x×*]\s*(\d+(?:\.\d+)?)\s*(?:m|米)/i.exec(combined)
    if (sizeMeterMatch) {
      const wVal = Number(sizeMeterMatch[1])
      const dVal = Number(sizeMeterMatch[2])
      if (wVal >= 2.5 && wVal <= 20 && dVal >= 2.5 && dVal <= 20) {
        result.width_mm = Math.round(wVal * 1000)
        result.depth_mm = Math.round(dVal * 1000)
        detected.add('width_mm').add('depth_mm')
      }
    }
  }

  const heightMatch = /(?:层高|净高|高)\s*[:：]?\s*(\d{4}|\d(?:\.\d+)?)\s*(mm|m|米)?/i.exec(combined)
  if (heightMatch) {
    const rawH = Number(heightMatch[1])
    if (rawH >= 2000 && rawH <= 6000) {
      result.height_mm = Math.round(rawH)
      detected.add('height_mm')
    } else if (rawH >= 2.2 && rawH <= 6.5) {
      result.height_mm = Math.round(rawH * 1000)
      detected.add('height_mm')
    }
  }

  if (/无阳台|不要阳台|不含阳台/.test(combined)) {
    result.include_balcony = false
  }
  if (/只要硬装|仅硬装|空房无家具/.test(combined)) {
    result.include_furniture = false
    result.include_decor = false
  }

  result.__defaulted = ['style', 'width_mm', 'depth_mm', 'height_mm'].filter((k) => !detected.has(k))
  return result
}

function buildCadPresetDirective(preset: ModelingPresetInfo): string {
  const dp = preset.defaultParams ?? {}
  const runSpecPath = join(preset.presetDir, preset.entryScript).replace(/\\/g, '/')
  const seedDxfPath = join(preset.presetDir, String(dp.seed_dxf ?? 'seed/plan.dxf')).replace(
    /\\/g,
    '/'
  )
  const auditPath = join(
    preset.presetDir,
    String(dp.audit_notes ?? 'notes/dimension-audit.md')
  ).replace(/\\/g, '/')
  const layers = Array.isArray(dp.required_layers)
    ? dp.required_layers.join('、')
    : 'A-WALL、A-DOOR、A-WIND、A-ROOM、A-DIMS'

  return [
    `<modeling-preset id="${preset.id}" host="${preset.targetHost}">`,
    `本轮请求已匹配本机 CAD 预置工程包「${preset.title}」（${preset.description}）。`,
    `**适用前提**：只有当用户确实要基于这份内置种子图工作时才使用本工程包；如果用户要处理的是自己的图纸，忽略本段，按用户的文件和 cad 技能正常执行。`,
    `**使用本工程包时的执行规则：**`,
    `1. **不要从零重绘整套平面几何**，也不要改动预置包内任何文件；先用 \`read_file\` 通读入口规范 \`${runSpecPath}\`，全程按其中的 operations（操作序列）、validation（校验基线）与 protection（保护规则）执行。`,
    `2. 编辑图纸只能用 multicad 连接器（AutoCAD / 中望 / 浩辰 / BricsCAD）：直接调用 \`multicad__\` 开头的文档管理与导出数据工具；如果工具列表里只有 \`mcp_tools\` / \`tool_search\`（已启用延迟加载），先用 \`mcp_tools\` 检索，再用 \`tool_search({ names: [...] })\` 激活。连接器不可用时按原始错误如实告知；\`cad\` 解析技能只读，严禁用它冒充编辑能力。`,
    `3. 种子原件只读：把 \`${seedDxfPath}\` 复制到本轮唯一输出目录后打开副本，用户已打开的文档只记录、不关闭、不重置、不修改。`,
    `4. 动手前先按 validation 复核种子副本：图层齐全（${layers}）、DIMENSION 数量 = ${Number(dp.expected_dimensions ?? 30)}、总尺寸 ${Number(dp.overall_x_mm ?? 11400)}×${Number(dp.overall_y_mm ?? 9000)}mm（对账细节见 \`${auditPath}\`）；复核不符先报告差异，不要带病继续。`,
    `5. 在副本上另存 DWG 后再进行本轮绘制/修改；新图元放对应 A-* 图层，标注使用实测值、禁止手工改写标注文字。`,
    `6. 完成后再次导出数据复核（图层 / 标注计数 / 尺寸链闭合 / 房间面积），成果只另存到输出目录、不覆盖已有文件，复核通过后用 \`deliver\` 交付 DWG 与复核结论。`,
    `</modeling-preset>`
  ].join('\n')
}

export function buildModelingPresetDirective(
  preset: ModelingPresetInfo,
  params: {
    text: string
    sceneParam?: SceneParam
    skillsRoot?: string
  }
): string {
  if (preset.targetHost === 'cad') {
    return buildCadPresetDirective(preset)
  }
  const opts = extractPresetOptions(preset, params.text, params.sceneParam)
  const ensureScript = params.skillsRoot
    ? join(params.skillsRoot, 'sketchup', 'scripts', 'ensure_sketchup.py').replace(/\\/g, '/')
    : '<技能目录>/sketchup/scripts/ensure_sketchup.py'

  const defaulted = opts.__defaulted ?? []
  const defaultedLabels: Record<string, string> = {
    style: '风格',
    width_mm: '开间',
    depth_mm: '进深',
    height_mm: '层高'
  }
  const rubyOpts = [
    `width_mm: ${Number(opts.width_mm ?? 4800)}`,
    `depth_mm: ${Number(opts.depth_mm ?? 6400)}`,
    `height_mm: ${Number(opts.height_mm ?? 2900)}`,
    `style: '${rubyStr(String(opts.style ?? 'modern_minimal'))}'`,
    `include_balcony: ${Boolean(opts.include_balcony ?? true)}`,
    `include_furniture: ${Boolean(opts.include_furniture ?? true)}`,
    `include_decor: ${Boolean(opts.include_decor ?? true)}`
  ].join(', ')

  return [
    `<modeling-preset id="${preset.id}" host="${preset.targetHost}">`,
    `本轮请求已匹配本机确定性参数化建模工程包「${preset.title}」（${preset.description}）。`,
    `**适用前提**：只有当用户要的是一个参数化客厅模型时才使用本工程包；如果用户给了自己的户型/尺寸且与下列参数不符，以用户资料为准，不要套用默认值。`,
    ...(defaulted.length > 0
      ? [
          `**注意**：以下参数没有从用户输入中识别到，当前使用的是默认值：${defaulted
            .map((k) => defaultedLabels[k] ?? k)
            .join('、')}。执行前请用 ask_user 向用户确认，或在结果中明确说明使用了默认值。`
        ]
      : []),
    `**使用本工程包时的执行规则：**`,
    `1. **无需从零编写客厅几何/家具/材质建模 Ruby 代码**，也无需用 read_file 逐个通读或改写预置子脚本（architecture/furniture/decor/finish/refine）。`,
    `2. 先按 sketchup 技能检查并启动宿主：\`python ${ensureScript}\`（如报连接失败/未启用扩展，按原始错误指导处理环境，切勿重写预置脚本）。`,
    `3. SketchUp 就绪后，直接调用 \`sketchup__eval_ruby\` 执行以下入口调用（如果工具列表里没有它、只有 \`mcp_tools\` / \`tool_search\`，说明启用了延迟加载，先调用 \`tool_search({ names: ['sketchup__eval_ruby'] })\` 激活）。可按用户特殊需求追加 \`export_preview_path\` 或 \`output_skp_path\` 参数，并在导出后用 \`deliver\` 交付：`,
    '```ruby',
    `load '${rubyStr(preset.entryScriptPath)}'`,
    `${preset.invokeMethod}('${rubyStr(preset.presetDir)}', { ${rubyOpts} })`,
    '```',
    `4. 若执行完成后用户需要微调某件家具或尺寸，可用不同参数重跑或追加小段 \`sketchup__eval_ruby\` 增量修改。`,
    `</modeling-preset>`
  ].join('\n')
}
