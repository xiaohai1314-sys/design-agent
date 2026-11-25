import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import type { AskAnswer, AskQuestion, AskUserToolData } from '@shared/protocol'

export function formatAnswersForModel(answers: AskAnswer[]): string {
  const answered = answers.filter((a) => a.selected.length > 0 || (a.text && a.text.trim().length > 0))
  if (answered.length === 0) {
    return '用户跳过了本次澄清（未作选择），不要再就相同问题重复追问。这不代表授权改用邻近来源或放宽硬约束：只有不影响任务核心的可选细节可以采用中性默认；若缺失仍阻塞，请说明限制并停止。'
  }
  const lines = answered.map((a) => {
    const val = a.text && a.text.trim() ? a.text.trim() : a.selected.join('、')
    return `- ${a.question}：${val}`
  })
  return `用户已完成需求澄清：\n${lines.join('\n')}\n请据此继续本轮任务。`
}

export function createAskUserTool(params: {
  waitForUserAnswer: (toolCallId: string, questions: AskQuestion[]) => Promise<AskAnswer[]>
  recordToolData: (toolCallId: string, data: AskUserToolData) => void
}): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'ask_user',
    description:
      '需求澄清：信息不足时向用户发起一次选择式追问。调用前必须先说明你的理解与判断，再就歧义/决策点提问。仅用于：①澄清任务歧义点/决策点；②补充会影响核心结果或交付格式的缺失条件。单轮最多 1~3 个精炼问题，用户回答或跳过后不要重复追问。',
    schema: z.object({
      questions: z
        .array(
          z.object({
            question: z.string().min(1).describe('向用户提问的问题正文'),
            type: z.enum(['single_select', 'multi_select']).describe('单选或可多选'),
            options: z.array(z.string().min(1)).min(2).max(6).describe('供用户点击选择的候选项（无需手写“其他”，界面自带自由输入框）')
          })
        )
        .min(1)
        .max(4)
        .describe('本次需要向用户澄清的问题列表')
    }),
    func: async ({ questions }, runManager) => {
      const toolCallId = (runManager as unknown as { toolCallId?: string })?.toolCallId ?? `ask_${Date.now()}`
      const answers = await params.waitForUserAnswer(toolCallId, questions)
      params.recordToolData(toolCallId, {
        kind: 'ask_user',
        questions,
        answers
      })
      return formatAnswersForModel(answers)
    }
  })
}
