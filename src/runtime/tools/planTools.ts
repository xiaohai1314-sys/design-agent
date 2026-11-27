import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import { resolvePathWithinRoot } from '@shared/workspacePaths'

const execFileAsync = promisify(execFile)
/** 内联进上下文的 JSON 上限，超过就只回路径，让模型自己 read_file */
const MAX_INLINE_JSON = 24 * 1024

interface RunResult {
  code: number
  text: string
}

/**
 * plan 工具组：把 cad 技能里「平面提取 / 楼层合并 / 规范初查 / 工程量」四个脚本封成结构化工具。
 *
 * 和 execute 的区别：参数是类型化的、路径只能在工作区内、输出是解析后的 JSON 摘要而不是一屏文本；
 * 脚本只写 .design-agent/plans 下的派生产物，所以不弹审批。
 */
export function createPlanTools(params: {
  rootDir: string
  pythonExe: string
  skillsRoot: string
  signal?: AbortSignal
}): DynamicStructuredTool[] {
  const scriptDir = join(params.skillsRoot, 'cad', 'scripts')
  const plansDir = join(params.rootDir, '.design-agent', 'plans')

  const inside = (value: string | undefined, label: string): string => {
    if (!value?.trim()) throw new Error(`缺少 ${label}`)
    return resolvePathWithinRoot(params.rootDir, value.trim())
  }

  /** out 只能写派生产物的扩展名：这几个工具不弹审批，不能让它覆盖工作区里的设计文件 */
  const outPathOf = (value: string, allowed: string[]): string => {
    const target = inside(value, 'out')
    if (!allowed.some((ext) => target.toLowerCase().endsWith(ext))) {
      throw new Error(`out 只能是 ${allowed.join(' / ')} 文件`)
    }
    return target
  }

  const defaultOut = (input: string, suffix: string): string => join(plansDir, `${basename(input, extname(input))}${suffix}`)

  async function run(script: string, args: string[]): Promise<RunResult> {
    const options = {
      cwd: params.rootDir,
      encoding: 'utf8' as const,
      windowsHide: true,
      maxBuffer: 24 * 1024 * 1024,
      timeout: 300000,
      signal: params.signal,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
    }
    try {
      const { stdout, stderr } = await execFileAsync(params.pythonExe, [join(scriptDir, script), ...args], options)
      return { code: 0, text: [stdout, stderr].filter(Boolean).join('\n').trim() }
    } catch (error) {
      const failure = error as { code?: number | string; stdout?: string; stderr?: string; message?: string }
      const text = [failure.stdout ?? '', failure.stderr ?? ''].filter(Boolean).join('\n').trim()
      return { code: typeof failure.code === 'number' ? failure.code : 1, text: text || failure.message || '执行失败' }
    }
  }

  /** 读回脚本产出的 JSON；太大就只给路径。 */
  function loadJson(path: string): Record<string, unknown> | null {
    if (!existsSync(path)) return null
    try {
      if (statSync(path).size > MAX_INLINE_JSON) return null
      return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    } catch {
      return null
    }
  }

  function digest(plan: Record<string, any>): Record<string, unknown> {
    return {
      schema: plan.schema,
      bounds: plan.bounds,
      storey: plan.storey,
      summary: plan.summary,
      rooms: (plan.rooms ?? []).map((room: any) => ({
        id: room.id,
        name: room.name,
        type: room.type,
        area_m2: room.area_m2,
        confidence: room.confidence
      })),
      failed_checks: (plan.checks ?? []).filter((item: any) => !item.ok),
      assumptions: plan.assumptions,
      warnings: plan.warnings
    }
  }

  function render(result: RunResult, outPath: string, data: unknown): string {
    const parts = [result.text, `输出文件：${outPath}`]
    if (data) parts.push(JSON.stringify(data, null, 1))
    if (result.code !== 0) parts.push(`（脚本退出码 ${result.code}）`)
    return parts.filter(Boolean).join('\n\n')
  }

  const buildingTypes = ['residential', 'education', 'office', 'medical', 'commercial', 'industrial', 'unknown'] as const

  const extractTool = new DynamicStructuredTool({
    name: 'plan_extract',
    description:
      '把 DWG / DXF 平面图提取成结构化 plan.json（墙体、门窗洞口、柱、房间与面积），返回摘要与房间清单。' +
      '施工图里常并排画着各层平面、剖面、立面：先不传 frame 跑一次，脚本会拒绝并列出所有图幅，再用 frame 指定。' +
      '建筑类型建议从项目档案 project.json 的 building_type 传进来，不要每层各猜各的。',
    schema: z.object({
      file: z.string().describe('图纸路径（工作区内，DWG 或 DXF）'),
      frame: z.string().optional().describe('图幅编号，如 "7" 或 "frame-7"；不传则整张提取，多图幅时脚本会列出清单'),
      bbox: z.string().optional().describe('只提取这个范围：x0,y0,x1,y1（与 frame 二选一）'),
      wall_layer: z.string().optional().describe('墙体图层，逗号分隔；自动识别不对时指定'),
      room_layer: z.string().optional().describe('房间轮廓图层（闭合多段线），指定后房间面积比从房间名推断可靠'),
      height: z.number().optional().describe('层高 mm，默认 2800'),
      building_type: z.enum(buildingTypes).optional().describe('建筑类型，写进 plan.json，规范初查按它选规则库'),
      out: z.string().optional().describe('输出路径，默认 .design-agent/plans/<图名>.plan.json；必须以 .plan.json 结尾')
    }),
    func: async ({ file, frame, bbox, wall_layer, room_layer, height, building_type, out }) => {
      const source = inside(file, 'file')
      const outPath = out ? outPathOf(out, ['.plan.json']) : defaultOut(source, '.plan.json')
      const args = [source, '--out', outPath]
      if (frame) args.push('--frame', frame)
      if (bbox) args.push('--bbox', bbox)
      if (wall_layer) args.push('--wall-layer', wall_layer)
      if (room_layer) args.push('--room-layer', room_layer)
      if (height) args.push('--height', String(height))
      if (building_type) args.push('--building-type', building_type)
      const result = await run('plan_extract.py', args)
      const plan = loadJson(outPath)
      return render(result, outPath, plan ? digest(plan) : null)
    }
  })

  const buildingTool = new DynamicStructuredTool({
    name: 'plan_building',
    description:
      '把施工图里的各层平面合并成 building.json（层号、标高、每层完整 plan），供建模时按层堆叠。' +
      'auto=true 按图名认层号（一层 / 二层 / 负一层 / 十一层），标准层、屋顶层、机房层认不出；也可以用 levels 显式指定。' +
      '同一层号认出多个图幅时结果里会带警告，要按警告用 levels 指定具体图幅。',
    schema: z.object({
      file: z.string().describe('图纸路径（工作区内）'),
      auto: z.boolean().optional().describe('按图名自动认层号'),
      levels: z.array(z.string()).optional().describe('显式指定，如 ["1=frame-5","2=frame-9","-1=frame-2"]'),
      storey: z.number().optional().describe('层高 mm，默认取平面里的 storey.height'),
      wall_layer: z.string().optional().describe('墙体图层，透传给提取'),
      building_type: z.enum(buildingTypes).optional().describe('建筑类型，写进每一层'),
      out: z.string().optional().describe('输出路径，默认 .design-agent/plans/<图名>.building.json；必须以 .building.json 结尾')
    }),
    func: async ({ file, auto, levels, storey, wall_layer, building_type, out }) => {
      const source = inside(file, 'file')
      const outPath = out ? outPathOf(out, ['.building.json']) : defaultOut(source, '.building.json')
      const args = [source, '--out', outPath]
      if (auto) args.push('--auto')
      for (const level of levels ?? []) args.push('--level', level)
      if (storey) args.push('--storey', String(storey))
      if (wall_layer) args.push('--wall-layer', wall_layer)
      if (building_type) args.push('--building-type', building_type)
      const result = await run('plan_building.py', args)
      const building = loadJson(outPath)
      const data = building
        ? {
            floors: (building.floors as any[] | undefined)?.map((floor) => ({
              level: floor.level,
              name: floor.name,
              elevation: floor.elevation,
              summary: floor.plan?.summary
            })),
            assumptions: building.assumptions,
            warnings: building.warnings
          }
        : null
      return render(result, outPath, data)
    }
  })

  const checkTool = new DynamicStructuredTool({
    name: 'plan_check',
    description:
      '按单层 plan.json 做规范初查（房间面积、门洞宽高、层高净高、外窗防护、直接采光），返回问题清单。' +
      '不接受 building.json：多层要对每层的 plan.json 分别调用。' +
      '建筑类型是项目级设置：优先用 building_type 参数，其次用 plan.json 里记的，最后才按房间名猜。' +
      '退出码 0 = 通过或只有需注意；1 = 有不满足项；2 = 没有判定（规则库不覆盖这个建筑类型，或房间没识别全）。' +
      '结论只作初查，正式出结论前要用 retrieve_regulation_chunks 核对现行条文。',
    schema: z.object({
      plan: z.string().describe('单层 plan.json 路径（工作区内）'),
      building_type: z.enum(buildingTypes).optional().describe('建筑类型；不传则用 plan.json 里记的，再没有就按房间名猜'),
      ceiling_height: z.number().optional().describe('吊顶后净高 mm，默认按层高计'),
      rules: z.string().optional().describe('规则 JSON 路径，默认住宅规则库')
    }),
    func: async ({ plan, building_type, ceiling_height, rules }) => {
      const target = inside(plan, 'plan')
      if (/\.building\.json$/i.test(target)) {
        return '规范初查只接受单层 plan.json。building.json 里每层的平面在 floors[].plan，请先用 plan_extract 按层提取（或从 building.json 拆出），再逐层调用 plan_check。'
      }
      const args = ['--plan', target, '--no-image']
      if (building_type) args.push('--building-type', building_type)
      if (ceiling_height) args.push('--ceiling-height', String(ceiling_height))
      if (rules) args.push('--rules', inside(rules, 'rules'))
      const result = await run('plan_codecheck.py', args)
      const report = loadJson(target.replace(/\.plan\.json$|\.json$/, '.codecheck.json'))
      return render(result, target.replace(/\.plan\.json$|\.json$/, '.codecheck.md'), report)
    }
  })

  const quantityTool = new DynamicStructuredTool({
    name: 'plan_quantity',
    description:
      '按 plan.json 计算装修工程量（地面、墙面、顶棚、踢脚线、防水、门窗表、墙体体积），可套单价表出报价。' +
      '默认写 .xlsx（报价单 / 房间明细 / 工程量汇总三张表，金额是公式）；out 用 .quote.json 结尾时返回结构化工程量。' +
      '单价表里的数值只是示例，不是市场价，没有用户提供的单价表时要在回复里说明。',
    schema: z.object({
      plan: z.string().describe('plan.json 路径（工作区内）'),
      prices: z.string().optional().describe('单价表 JSON 路径，不给则只算工程量'),
      ceiling_height: z.number().optional().describe('吊顶后净高 mm，默认按层高计'),
      out: z
        .string()
        .optional()
        .describe('输出路径，默认 .design-agent/plans/<图名>.quote.xlsx；只能用 .xlsx 或 .quote.json 结尾（.quote.json 时返回工程量 JSON）')
    }),
    func: async ({ plan, prices, ceiling_height, out }) => {
      const target = inside(plan, 'plan')
      if (/\.building\.json$/i.test(target)) {
        return '工程量只接受单层 plan.json，请对每层的 plan.json 分别调用。'
      }
      const outPath = out
        ? outPathOf(out, ['.xlsx', '.quote.json'])
        : defaultOut(target.replace(/\.plan\.json$/, ''), '.quote.xlsx')
      const args = ['--plan', target, '--out', outPath]
      if (prices) args.push('--prices', inside(prices, 'prices'))
      if (ceiling_height) args.push('--ceiling-height', String(ceiling_height))
      const result = await run('plan_quantity.py', args)
      const data = outPath.toLowerCase().endsWith('.json') ? loadJson(outPath) : null
      return render(result, outPath, data)
    }
  })

  return [extractTool, buildingTool, checkTool, quantityTool]
}
