import { ChatOpenAI } from '@langchain/openai'
import { ChatAnthropic } from '@langchain/anthropic'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { ModelProviderProfile } from '@shared/protocol'

export function createChatModel(
  profile: ModelProviderProfile,
  options: { thinking?: boolean; isSubagent?: boolean } = {}
): BaseChatModel {
  const modelName =
    options.isSubagent && profile.subagentModel?.trim()
      ? profile.subagentModel.trim()
      : profile.model.trim()

  const apiKey = profile.apiKey.trim()
  if (!apiKey) {
    throw new Error(`未配置 API Key（模型配置：${profile.label}）。请先点击左下角「模型与 API 设置」填入有效的 API Key。`)
  }
  if (!modelName) {
    throw new Error(`未填写模型名称（模型配置：${profile.label}）。`)
  }

  const maxTokens = profile.maxOutputTokens ?? 16384

  if (profile.protocol === 'anthropic') {
    const cleanBase = profile.baseUrl
      .trim()
      .replace(/\/+$/, '')
      .replace(/\/v1$/i, '')
    const thinkingEnabled = Boolean(options.thinking && profile.supportsThinking)
    // @anthropic-ai/sdk 1.7+ 的 apiKeyAuth 默认只发 Authorization: Bearer；
    // 按 authStyle 显式控制 x-api-key 与 Bearer，确保经典 Anthropic 中转与 Claude Code AUTH_TOKEN 中转都能鉴权通过
    const authStyle = profile.authStyle ?? 'auto'
    const anthropicHeaders: Record<string, string | null> =
      authStyle === 'x-api-key'
        ? { 'x-api-key': apiKey, Authorization: null }
        : authStyle === 'bearer'
          ? { 'x-api-key': null }
          : { 'x-api-key': apiKey }
    return new ChatAnthropic({
      model: modelName,
      anthropicApiKey: apiKey,
      ...(cleanBase ? { anthropicApiUrl: cleanBase } : {}),
      clientOptions: { defaultHeaders: anthropicHeaders },
      maxTokens: thinkingEnabled ? Math.max(maxTokens, 16000) : maxTokens,
      streaming: true,
      ...(thinkingEnabled
        ? {
            thinking: {
              type: 'enabled',
              budget_tokens: Math.min(8000, Math.floor(Math.max(maxTokens, 16000) / 2))
            }
          }
        : {})
    })
  }

  const cleanBase = profile.baseUrl.trim().replace(/\/+$/, '') || 'https://api.openai.com/v1'
  return new ChatOpenAI({
    model: modelName,
    apiKey,
    maxTokens,
    streaming: true,
    streamUsage: true,
    ...(profile.useResponsesApi ? { useResponsesApi: true } : {}),
    configuration: {
      baseURL: cleanBase
    }
  })
}
