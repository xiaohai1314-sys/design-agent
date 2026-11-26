import {
  Activity,
  Check,
  Eye,
  EyeOff,
  Import,
  KeyRound,
  LoaderCircle,
  Plus,
  Trash2
} from 'lucide-react'
import clsx from 'clsx'
import type { ModelSettingsState } from '@shared/ipc'
import type { ModelProviderProfile } from '@shared/protocol'
import type { ProbeResultState } from './types'

export interface LlmTabProps {
  draft: ModelSettingsState
  setDraft: (draft: ModelSettingsState) => void
  selectedId: string
  onSelectProfile: (id: string) => void
  showKey: boolean
  onToggleShowKey: () => void
  profileProbe: ProbeResultState | null
  onTestProfile: () => void
  onAddProfile: () => void
  onRemoveProfile: () => void
  onUpdateProfile: (patch: Partial<ModelProviderProfile>) => void
  onOpenCcSwitchPicker: () => void
}

/** 设置 → 对话模型渠道（列表 + 表单） */
export function LlmTab({
  draft,
  setDraft,
  selectedId,
  onSelectProfile,
  showKey,
  onToggleShowKey,
  profileProbe,
  onTestProfile,
  onAddProfile,
  onRemoveProfile,
  onUpdateProfile,
  onOpenCcSwitchPicker
}: LlmTabProps): React.JSX.Element {
  const current = draft.profiles.find((p) => p.id === selectedId) ?? draft.profiles[0]

  return (
    <div className="flex flex-1 min-h-0">
      <div className="w-56 border-r border-zinc-200 bg-zinc-50/70 p-3 flex flex-col gap-1.5 overflow-y-auto">
        {draft.profiles.map((p) => {
          const isSelected = p.id === current?.id
          const isActive = p.id === draft.activeProfileId
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => onSelectProfile(p.id)}
              className={clsx(
                'w-full flex items-center justify-between gap-2 px-3 py-2 rounded-xl text-left text-xs transition-colors cursor-pointer',
                isSelected
                  ? 'bg-white border border-zinc-200/90 shadow-2xs font-medium text-zinc-900'
                  : 'text-zinc-600 hover:bg-zinc-100'
              )}
            >
              <div className="min-w-0">
                <div className="truncate">{p.label}</div>
                <div className="text-[11px] text-zinc-400 font-mono truncate">{p.model}</div>
              </div>
              {isActive && (
                <span
                  className="w-4 h-4 rounded-full bg-emerald-500 text-white flex items-center justify-center shrink-0"
                  title="当前默认使用"
                >
                  <Check className="w-2.5 h-2.5" />
                </span>
              )}
            </button>
          )
        })}

        <button
          type="button"
          onClick={onAddProfile}
          className="mt-2 flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl border border-dashed border-zinc-300 text-xs text-zinc-600 hover:border-zinc-400 hover:text-zinc-900 cursor-pointer"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>新增 API 渠道</span>
        </button>

        <button
          type="button"
          onClick={onOpenCcSwitchPicker}
          className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl border border-blue-200 bg-blue-50/60 text-xs font-medium text-blue-700 hover:bg-blue-100/80 cursor-pointer transition-colors"
          title="扫描本机 CC Switch / Claude Code / Codex 配置并自选节点导入"
        >
          <Import className="w-3.5 h-3.5" />
          <span>从 CC Switch 选择导入</span>
        </button>
      </div>

      {current ? (
        <div className="flex-1 p-5 space-y-4 overflow-y-auto text-xs">
          <div className="flex items-center justify-between gap-2">
            <label className="inline-flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={draft.activeProfileId === current.id}
                onChange={() => setDraft({ ...draft, activeProfileId: current.id })}
                className="rounded border-zinc-300 text-blue-600"
              />
              <span className="font-medium text-zinc-800">设为当前默认激活渠道</span>
            </label>

            <div className="flex items-center gap-3">
              <button
                type="button"
                disabled={profileProbe?.status === 'testing'}
                onClick={onTestProfile}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 cursor-pointer"
              >
                {profileProbe?.status === 'testing' ? (
                  <LoaderCircle className="w-3.5 h-3.5 animate-spin text-blue-600" />
                ) : (
                  <Activity className="w-3.5 h-3.5 text-blue-600" />
                )}
                <span>{profileProbe?.status === 'testing' ? '测试中…' : '测试连接'}</span>
              </button>
              <button
                type="button"
                onClick={onRemoveProfile}
                className="inline-flex items-center gap-1 text-rose-600 hover:text-rose-700 cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>删除此渠道</span>
              </button>
            </div>
          </div>

          {profileProbe && profileProbe.status !== 'testing' && (
            <div
              className={clsx(
                'rounded-lg px-3 py-2 text-[11px] border',
                profileProbe.status === 'ok'
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                  : 'bg-rose-50 border-rose-200 text-rose-800'
              )}
            >
              {profileProbe.status === 'ok'
                ? `✅ 连接成功 (${profileProbe.latencyMs}ms)${profileProbe.message ? ` · ${profileProbe.message}` : ''}`
                : `❌ 连接失败 (${profileProbe.latencyMs}ms)：${profileProbe.message || '请检查地址、Key 或模型名'}`}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block font-medium text-zinc-700 mb-1">渠道显示名称</label>
              <input
                type="text"
                value={current.label}
                onChange={(e) => onUpdateProfile({ label: e.target.value })}
                className="w-full px-3 py-2 rounded-lg border border-zinc-200 focus:border-blue-500 outline-none"
              />
            </div>
            <div>
              <label className="block font-medium text-zinc-700 mb-1">接口协议类型</label>
              <select
                value={current.protocol}
                onChange={(e) =>
                  onUpdateProfile({ protocol: e.target.value as 'openai' | 'anthropic' })
                }
                className="w-full px-3 py-2 rounded-lg border border-zinc-200 focus:border-blue-500 outline-none bg-white"
              >
                <option value="openai">
                  OpenAI 兼容 (DeepSeek / Qwen / GPT / 中转 / Ollama)
                </option>
                <option value="anthropic">Anthropic 原生协议 (Claude)</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block font-medium text-zinc-700 mb-1">Base URL</label>
            <input
              type="text"
              value={current.baseUrl}
              onChange={(e) => onUpdateProfile({ baseUrl: e.target.value })}
              placeholder={
                current.protocol === 'anthropic'
                  ? 'https://api.anthropic.com'
                  : 'https://api.openai.com/v1'
              }
              className="w-full px-3 py-2 rounded-lg border border-zinc-200 font-mono focus:border-blue-500 outline-none"
            />
            {current.protocol === 'anthropic' && (
              <div className="mt-1 text-[11px] text-zinc-400">
                提示：Anthropic 协议会自动去除末尾 /v1，避免中转拼出 /v1/v1/messages。
              </div>
            )}
          </div>

          <div>
            <label className="block font-medium text-zinc-700 mb-1">API Key</label>
            <div className="relative flex items-center">
              <input
                type={showKey ? 'text' : 'password'}
                value={current.apiKey}
                onChange={(e) => onUpdateProfile({ apiKey: e.target.value })}
                placeholder="sk-..."
                className="w-full pl-3 pr-9 py-2 rounded-lg border border-zinc-200 font-mono focus:border-blue-500 outline-none"
              />
              <button
                type="button"
                onClick={onToggleShowKey}
                className="absolute right-2.5 text-zinc-400 hover:text-zinc-700 cursor-pointer"
              >
                {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block font-medium text-zinc-700 mb-1">主控模型名 (Model ID)</label>
              <input
                type="text"
                value={current.model}
                onChange={(e) => onUpdateProfile({ model: e.target.value })}
                placeholder="如 deepseek-chat / qwen-max / gpt-4o"
                className="w-full px-3 py-2 rounded-lg border border-zinc-200 font-mono focus:border-blue-500 outline-none"
              />
            </div>
            <div>
              <label className="block font-medium text-zinc-700 mb-1">
                子任务 / 记忆蒸馏模型 <span className="text-zinc-400 font-normal">(可选)</span>
              </label>
              <input
                type="text"
                value={current.subagentModel ?? ''}
                onChange={(e) => onUpdateProfile({ subagentModel: e.target.value })}
                placeholder="如 qwen-turbo / gpt-4o-mini"
                className="w-full px-3 py-2 rounded-lg border border-zinc-200 font-mono focus:border-blue-500 outline-none"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 items-center pt-1">
            <div>
              <label className="block font-medium text-zinc-700 mb-1">最大输出 Tokens</label>
              <input
                type="number"
                min={1024}
                max={128000}
                value={current.maxOutputTokens ?? 16384}
                onChange={(e) =>
                  onUpdateProfile({ maxOutputTokens: Number(e.target.value) || 16384 })
                }
                className="w-full px-3 py-2 rounded-lg border border-zinc-200 font-mono focus:border-blue-500 outline-none"
              />
            </div>
            <div>
              <label className="block font-medium text-zinc-700 mb-1">上下文窗口上限</label>
              <input
                type="number"
                min={8192}
                max={1000000}
                value={current.contextWindowTokens ?? 64000}
                onChange={(e) =>
                  onUpdateProfile({ contextWindowTokens: Number(e.target.value) || 64000 })
                }
                className="w-full px-3 py-2 rounded-lg border border-zinc-200 font-mono focus:border-blue-500 outline-none"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-4 pt-1">
            <label className="inline-flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={Boolean(current.supportsThinking)}
                onChange={(e) => onUpdateProfile({ supportsThinking: e.target.checked })}
                className="rounded border-zinc-300 text-blue-600"
              />
              <span className="text-zinc-700">支持深度思考 / Reasoning 分流</span>
            </label>
            {current.protocol === 'anthropic' ? (
              <>
                <label
                  className="inline-flex items-center gap-2 cursor-pointer"
                  title="若小中转或反代不识别 cache_control 字段返回 HTTP 400，请取消勾选"
                >
                  <input
                    type="checkbox"
                    checked={current.enablePromptCache !== false}
                    onChange={(e) => onUpdateProfile({ enablePromptCache: e.target.checked })}
                    className="rounded border-zinc-300 text-blue-600"
                  />
                  <span className="text-zinc-700">启用 Prompt Caching (cache_control)</span>
                </label>
                <label className="inline-flex items-center gap-2">
                  <span className="text-zinc-600">鉴权请求头:</span>
                  <select
                    value={current.authStyle ?? 'auto'}
                    onChange={(e) =>
                      onUpdateProfile({
                        authStyle: e.target.value as 'auto' | 'bearer' | 'x-api-key'
                      })
                    }
                    className="px-2 py-1 rounded-md border border-zinc-200 bg-white text-zinc-700 outline-none focus:border-blue-500"
                  >
                    <option value="auto">自动兼容 (Bearer + x-api-key)</option>
                    <option value="bearer">Authorization: Bearer</option>
                    <option value="x-api-key">x-api-key</option>
                  </select>
                </label>
              </>
            ) : (
              <label
                className="inline-flex items-center gap-2 cursor-pointer"
                title="接入仅支持 /v1/responses 的 Codex 专用中转时勾选"
              >
                <input
                  type="checkbox"
                  checked={Boolean(current.useResponsesApi)}
                  onChange={(e) => onUpdateProfile({ useResponsesApi: e.target.checked })}
                  className="rounded border-zinc-300 text-blue-600"
                />
                <span className="text-zinc-700">Codex Responses API</span>
              </label>
            )}
          </div>
        </div>
      ) : (
        <div className="flex-1 p-6 flex flex-col items-center justify-center text-center space-y-4 text-xs text-zinc-600">
          <div className="w-11 h-11 rounded-2xl bg-amber-50 border border-amber-200 flex items-center justify-center text-amber-600">
            <KeyRound className="w-5 h-5" />
          </div>
          <div className="space-y-1.5 max-w-md">
            <div className="text-sm font-semibold text-zinc-900">请配置模型 API 渠道</div>
            <p className="text-zinc-500 leading-relaxed">
              启动时不预置空白模板。你可以一键从本机 CC Switch / Claude Code / Codex
              导入已有配置，或手动新增任意 OpenAI / Anthropic 兼容渠道。
            </p>
          </div>
          <div className="flex items-center gap-2.5 pt-1">
            <button
              type="button"
              onClick={onOpenCcSwitchPicker}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-blue-600 text-white font-medium hover:bg-blue-700 cursor-pointer transition-colors"
            >
              <Import className="w-3.5 h-3.5" />
              <span>从 CC Switch 选择导入</span>
            </button>
            <button
              type="button"
              onClick={onAddProfile}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl border border-zinc-200 bg-white text-zinc-800 font-medium hover:bg-zinc-50 cursor-pointer transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>手动新增渠道</span>
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
