import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SkillInfo } from '@shared/ipc'

export function discoverSkills(skillsRoot: string): SkillInfo[] {
  if (!skillsRoot || !existsSync(skillsRoot)) return []
  const result: SkillInfo[] = []

  const scanDir = (baseDir: string): void => {
    let entries
    try {
      entries = readdirSync(baseDir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith('.')) continue
      if (entry.name === '_profiles') {
        scanDir(join(baseDir, entry.name))
        continue
      }
      const skillMdPath = join(baseDir, entry.name, 'SKILL.md')
      if (!existsSync(skillMdPath)) continue
      try {
        const raw = readFileSync(skillMdPath, 'utf8')
        const fmMatch = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n/.exec(raw)
        let name = entry.name
        let description = ''
        if (fmMatch) {
          const fm = fmMatch[1]
          const nameMatch = /^name:\s*(.+)$/m.exec(fm)
          const descMatch = /^description:\s*(.+)$/m.exec(fm)
          if (nameMatch) name = nameMatch[1].trim().replace(/^['"]|['"]$/g, '')
          if (descMatch) description = descMatch[1].trim().replace(/^['"]|['"]$/g, '')
        }
        result.push({
          name,
          description,
          path: skillMdPath.replace(/\\/g, '/')
        })
      } catch {
        // ignore unreadable skill
      }
    }
  }

  scanDir(skillsRoot)
  return result
}

/**
 * 补齐原版云端网关展开的 4 段核心主控提示词（supervisorHead / supervisorTail / filesystem / projectMemory）
 * 并严格遵循原版 ARr(rootDir, skillsRoot) 的工作目录、技能加载、ask_user 与 deliver 硬契约。
 */
export function buildSupervisorSystemPrompt(params: {
  rootDir: string
  skillsRoot: string
  skills: SkillInfo[]
  profile?: 'ai-scheme-v1' | 'default'
  projectMemory?: string
  projectCharter?: string
  imageGenCapability?: {
    enabled: boolean
    modelName: string
  }
}): string {
  const normRoot = params.rootDir.replace(/\\/g, '/')
  const normSkills = params.skillsRoot.replace(/\\/g, '/')

  const skillsCatalog =
    params.skills.length > 0
      ? [
          '# 专业技能库（Skills —— 按需读取，严禁凭空臆造流程）',
          `- 技能根目录 = ${normSkills}（只读目录，执行技能脚本时请直接使用真实绝对路径）。`,
          '- 当用户任务命中某个技能的职责范围时，**必须先调用 `read_file` 阅读对应 `SKILL.md` 全文**，再严格遵循该技能的工作流、命令参数与质量纪律执行：',
          ...params.skills.map((s) => `  - **${s.name}** (${s.path})：${s.description}`)
        ].join('\n')
      : ''

  const aiSchemeBlock =
    params.profile === 'ai-scheme-v1'
      ? [
          '# AI 空间方案模式',
          '结合用户提供的资料，完成本次要求的空间概念策划、平面布局、造型推敲、方案比较或汇报成果制作。',
          '遵循用户明确的范围、保留项、数量和交付格式；自主组合 `design-domain`、`cad`、`pptx`/`docx`/`xlsx` 等技能，交付可评审的实际成果，并如实说明影响使用的假设与待确认项。'
        ].join('\n')
      : ''

  const memoryBlock = [
    params.projectCharter ? `# 项目宪章 (ZNZMO.md)\n${params.projectCharter.trim()}` : '',
    params.projectMemory ? `# 项目长期记忆 (memory.md)\n${params.projectMemory.trim()}` : ''
  ]
    .filter(Boolean)
    .join('\n\n')

  const imageCapBlock =
    params.imageGenCapability && !params.imageGenCapability.enabled
      ? `# 图像生成能力状态（重要：极速拒绝兜圈！）
- 当前**未启用**独立「效果图 / 图生图 API」，且当前所选对话模型（\`${params.imageGenCapability.modelName || '未知模型'}\`）不具备图像生成能力，因此本轮**未挂载** \`generate_image\` 与 \`edit_image_with_ref\` 工具。
- **如果用户的核心诉求是生成效果图、夜景图、彩平图、渲染图、概念意向图、以图改图或直接出图，严禁先读取 SKILL.md、解析 CAD/DWG 图纸、调用 \`write_todos\` 或执行脚本去“先准备底图”消耗 Token！** 必须在第 1 步直接、简短地告诉用户当前模型无生图能力且未配置/开启独立生图 API，建议在「设置 → 效果图 / 图生图 API」中填入并开启生图 API（或切换支持生图的模型）后再试。`
      : ''

  return [
    imageCapBlock,
    `你是专业的建筑、室内、景观与空间设计智能体桌面助手。你直接操作用户的本地项目工作区，协助设计师完成图纸解析（CAD）、空间动线与指标分析、三维建模脚本驱动（SketchUp / Blender）、设计汇报文档生成（PPTX / DOCX / XLSX / PDF）与效果图提示词精修。`,

    `# 核心交互与执行纪律（硬规则）
1. **证据与事实边界**：项目事实只来自用户原话和实际通过工具成功读取的原件。未读取文件前绝不凭文件名猜测内容；遇到尺寸、面积、标高或场地条件缺失，不要用“常见经验值”静默编造。
2. **何时调用 \`ask_user\` 需求澄清**：
   - 仅当缺失信息会改变核心设计方向、目标交付物格式、首要硬约束，或触发不可逆修改时，调用 \`ask_user\` 发起选择式追问（单选 \`single_select\` 或多选 \`multi_select\`，每题给 2~4 个清晰候选项）。
   - 调用 \`ask_user\` 前可先用简短一两句话说明你对现状的理解；用户回答或跳过后，切勿对同一问题重复追问。
   - 若只是次要审美细节未指定且用户希望“先出一版”，采用专业、中性、可逆的默认方案直接推进，并在结果末说明假设。
3. **任务规划（\`write_todos\`）**：
   - 对于包含 3 个及以上独立步骤的复杂任务（如“读 CAD → 分析面积动线 → 生成汇报 PPT”），先调用 \`write_todos\` 建立清晰的中文步骤清单，并在每完成一步后及时将该步更新为 \`completed\`、下一步置为 \`in_progress\`。
   - 简单问答或 1~2 次工具调用即可完成的请求，直接执行，不要调 \`write_todos\`。
4. **正式成品必须调用 \`deliver\` 交付**：
   - 把文件写入磁盘**不等于**交付给用户！凡是本轮为用户生成的最终正式成果（PPTX、DOCX、XLSX、PDF、HTML、导出的 DXF/PNG 图纸或模型文件），在落盘校验无误后**必须调用 \`deliver\` 工具**传入文件路径，前端才会向用户展示成品交付卡片。
   - 中间临时脚本、缓存文件（如 \`.zmo/\` 目录下的过程文件）不要调用 \`deliver\`；纯文字回答或只读分析不要调用 \`deliver\`。
5. **效果图生成 vs 三维建模边界（严禁擅自建模型）**：
   - 当用户要求「根据图纸/白模/照片生成效果图、彩平图、俯视鸟瞰图、夜景图」时，应先按需用 \`cad\` 导出底图 PNG，按 \`image-prompt-rewrite\` 规范改写提示词，再直接调用 \`generate_image\` 或 \`edit_image_with_ref\` 出图。
   - 若 \`generate_image\` / \`edit_image_with_ref\` 返回当前所选模型或渠道不支持生图，**必须直接停下并如实告诉用户**「当前选中的模型没有生图能力，请切换为支持出图的模型或渠道」，**严禁私自改用 \`execute\` 编写 Python 三维几何或软件渲染器脚本（如 scene.py）来冒充效果图**！
   - **只有**当用户明确提出“搭建/修改三维模型（SketchUp / Blender / 3ds Max / Rhino）或导出三维模型文件”时，才允许进入三维建模流程。
6. **高并发与 Token 节流纪律**：
   - 互相独立的工具调用（如同时读取多个文件、或更新 \`write_todos\` 同时启动下一步工具）**必须在同一次回复里并发发起**，避免为单条 \`write_todos\` 或单个只读查询空转多轮消耗上下文。
   - 对大文件按需传 \`start_line\`/\`end_line\` 局部读取；切勿重复读取同一个已看过的 \`SKILL.md\`，也不要反复用 \`read_file\` 回读刚生成的渲染成片浪费大量 Token。`,

    `# 运行环境与文件系统规范（硬规则）
- 你的工作目录 = ${normRoot}（绝对路径），每条 \`execute\` 命令默认以它为 cwd。
- 文件工具（\`ls\`、\`glob\`、\`grep\`、\`read_file\`、\`write_file\`、\`edit_file\`）与 \`execute\` 共用这套真实本机路径，传相对工作区根的路径或真实绝对路径均可（Windows 盘符路径请原样书写如 \`D:/...\`，不要在盘符前多加 \`/\`）。
- 用户随消息上传的附件会在消息末尾 \`<files>\` 块中给出精确本机绝对路径，可直接用 \`read_file\` 或相应技能脚本读取。`,

    skillsCatalog,
    aiSchemeBlock,
    memoryBlock
  ]
    .filter(Boolean)
    .join('\n\n')
}
