import { useState } from 'react'
import type { ModelSettingsState } from '@shared/ipc'
import type { ApiProtocol, ModelProviderProfile, VisionConfig } from '@shared/protocol'

export interface VisionTabProps {
  draft: ModelSettingsState
  setDraft: (draft: ModelSettingsState) => void
}

const DEFAULTS: VisionConfig = {
  enabled: false,
  protocol: 'openai',
  baseUrl: '',
  apiKey: '',
  model: ''
}

type Probe = { status: 'testing' | 'ok' | 'fail'; message?: string }

/** 设置 → 视觉模型（审图、看参考图） */
export function VisionTab({ draft, setDraft }: VisionTabProps): React.JSX.Element {
  const vision: VisionConfig = { ...DEFAULTS, ...(draft.vision ?? {}) }
  const patch = (p: Partial<VisionConfig>): void => setDraft({ ...draft, vision: { ...vision, ...p } })
  const ready = vision.enabled && Boolean(vision.apiKey.trim()) && Boolean(vision.model.trim())
  const [probe, setProbe] = useState<Probe | null>(null)

  const testConnection = async (): Promise<void> => {
    if (!vision.model.trim() || !vision.apiKey.trim()) {
      setProbe({ status: 'fail', message: '请先填写模型名称与 API Key' })
      return
    }
    setProbe({ status: 'testing' })
    const profile: ModelProviderProfile = {
      id: 'vision',
      label: '视觉模型',
      protocol: vision.protocol ?? 'openai',
      baseUrl: vision.baseUrl.trim(),
      apiKey: vision.apiKey,
      model: vision.model.trim(),
      subagentModel: vision.model.trim(),
      supportsThinking: false,
      maxOutputTokens: 4096
    }
    try {
      const res = await window.designAgent.models.testConnection(profile)
      setProbe(
        res.ok
          ? { status: 'ok', message: `${res.detail ?? '连接正常'}（${res.latencyMs}ms）` }
          : { status: 'fail', message: res.error ?? '连接失败' }
      )
    } catch (err) {
      setProbe({ status: 'fail', message: err instanceof Error ? err.message : String(err) })
    }
  }

  return (
    <div className="flex-1 p-6 space-y-4 overflow-y-auto text-xs">
      <div className="p-3.5 rounded-xl bg-violet-50/70 border border-violet-100 text-violet-900 leading-relaxed">
        <p className="font-semibold mb-1">「能生图」和「能看图」是两件事</p>
        <p>
          生图渠道（FLUX、Kolors、GPT-Image 等）只负责出图，看不了图；主对话模型也可能是纯文本的（如 DeepSeek）。
          审图、看参考图、读 CAD 出图都需要一个真正支持视觉的模型，单独配在这里最省事——
          聊天和规划继续用便宜的主模型，只在要看图时切过来。
        </p>
      </div>

      <label className="inline-flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={vision.enabled}
          onChange={(e) => patch({ enabled: e.target.checked })}
          className="w-4 h-4 rounded accent-blue-600"
        />
        <span className="font-semibold text-zinc-900">启用独立视觉模型</span>
      </label>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block font-medium text-zinc-700 mb-1">协议</label>
          <select
            value={vision.protocol}
            onChange={(e) => patch({ protocol: e.target.value as ApiProtocol })}
            className="w-full px-3 py-2 rounded-lg border border-zinc-200 bg-white outline-none focus:border-blue-500"
          >
            <option value="openai">OpenAI 兼容</option>
            <option value="anthropic">Anthropic</option>
          </select>
        </div>
        <div>
          <label className="block font-medium text-zinc-700 mb-1">模型名称</label>
          <input
            value={vision.model}
            onChange={(e) => patch({ model: e.target.value })}
            placeholder="qwen-vl-max / gpt-4o / gemini-2.0-flash"
            className="w-full px-3 py-2 rounded-lg border border-zinc-200 font-mono outline-none focus:border-blue-500"
          />
        </div>
      </div>

      <div>
        <label className="block font-medium text-zinc-700 mb-1">Base URL</label>
        <input
          value={vision.baseUrl}
          onChange={(e) => patch({ baseUrl: e.target.value })}
          placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1"
          className="w-full px-3 py-2 rounded-lg border border-zinc-200 font-mono outline-none focus:border-blue-500"
        />
      </div>

      <div>
        <label className="block font-medium text-zinc-700 mb-1">API Key</label>
        <input
          type="password"
          value={vision.apiKey}
          onChange={(e) => patch({ apiKey: e.target.value })}
          placeholder="sk-..."
          className="w-full px-3 py-2 rounded-lg border border-zinc-200 font-mono outline-none focus:border-blue-500"
        />
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void testConnection()}
          disabled={probe?.status === 'testing'}
          className="px-3 py-1.5 rounded-lg border border-zinc-300 text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
        >
          {probe?.status === 'testing' ? '测试中…' : '测试连接'}
        </button>
        {probe && probe.status !== 'testing' ? (
          <span
            className={
              probe.status === 'ok' ? 'text-emerald-600' : 'text-red-600'
            }
          >
            {probe.message}
          </span>
        ) : (
          <span className="text-zinc-400">只验证地址、Key 与模型名是否可用</span>
        )}
      </div>

      <p className="text-[11px] leading-relaxed text-zinc-500">
        {ready
          ? '已配置。审图（review_image）与 read_file 读到的图片都会先交给这个模型，主对话可以继续用纯文本模型。'
          : '未配置或未填全时：主模型支持看图（Claude / GPT-4o / Gemini / Qwen-VL 等）就由主模型自己看；否则不提供审图工具，read_file 读图片也拿不到内容。'}
      </p>
    </div>
  )
}
