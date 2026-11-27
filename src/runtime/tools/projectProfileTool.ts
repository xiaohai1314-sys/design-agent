import { existsSync } from 'node:fs'
import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import { resolvePathWithinRoot } from '@shared/workspacePaths'
import {
  applyProfilePatch,
  emptyProfile,
  importPlanIntoProfile,
  loadProjectProfile,
  saveProjectProfile,
  summarizeProfile
} from '../projectProfile'

/**
 * project_profile：读取 / 更新结构化项目档案 project.json，或从 plan.json 同步房间。
 * 自用版本不需要审批；每次写入都会把变化摘要回传给模型，便于在回复里告诉用户改了什么。
 */
export function createProjectProfileTool(params: { profilePath: string; rootDir: string }): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'project_profile',
    description:
      '读取或更新本项目的结构化档案 project.json（项目类型、面积、层高、房间清单、风格方向与参考图、主材、预算、硬约束、否决项、已确认决策、平面数据文件）。' +
      '它是尺寸、风格、主材、约束的唯一权威来源：建模、出图提示词、规范核查、汇报文档都以它为准。' +
      'action=get 读取全文；action=update 传 patch 合并更新（标量覆盖、null 删除、rooms 按房间名合并、constraints/rejected 取并集、decisions 追加；需要整体替换某个数组时在 patch 里加 "replace": ["rooms"]）；' +
      'action=import_plan 传 plan_path，从 plan_extract.py 生成的 plan.json 同步房间与面积。只写入用户明确给出或确认过的信息，不要把推测写进档案。',
    schema: z.object({
      action: z.enum(['get', 'update', 'import_plan']).describe('get 读取；update 合并更新；import_plan 从 plan.json 同步房间'),
      patch: z.record(z.any()).optional().describe('action=update 时的更新内容，字段同 project.json'),
      plan_path: z.string().optional().describe('action=import_plan 时 plan.json 的路径（相对工作区或绝对路径）')
    }),
    func: async ({ action, patch, plan_path }) => {
      const current = loadProjectProfile(params.profilePath) ?? emptyProfile()
      if (action === 'get') {
        return existsSync(params.profilePath)
          ? `项目档案（${params.profilePath.replace(/\\/g, '/')}）：\n${JSON.stringify(current, null, 2)}`
          : '本项目还没有 project.json。可用 action=update 建立，或用 action=import_plan 从 plan.json 导入房间。'
      }
      if (action === 'import_plan') {
        if (!plan_path) throw new Error('import_plan 需要 plan_path')
        // 与其它工具一致：只允许工作区内的路径，拒绝词法穿越与符号链接逃逸
        const target = resolvePathWithinRoot(params.rootDir, plan_path)
        if (!existsSync(target)) throw new Error(`找不到 plan.json：${target}`)
        const { profile, summary } = importPlanIntoProfile(current, target)
        saveProjectProfile(params.profilePath, profile)
        return `${summary}。\n当前档案摘要：\n${summarizeProfile(profile)}`
      }
      if (!patch || Object.keys(patch).length === 0) throw new Error('update 需要非空的 patch')
      const next = applyProfilePatch(current, patch)
      saveProjectProfile(params.profilePath, next)
      return `已更新项目档案字段：${Object.keys(patch).filter((k) => k !== 'replace').join('、')}。\n当前档案摘要：\n${summarizeProfile(next)}`
    }
  })
}
