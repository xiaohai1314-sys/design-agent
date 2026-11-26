import { Eye, EyeOff, Plus, Trash2 } from 'lucide-react'
import clsx from 'clsx'
import type { CcSwitchCandidate, ModelSettingsState } from '@shared/ipc'
import type {
  ImageChannelProtocol,
  ImageChannelRole,
  ImageGenChannel,
  ModelProviderProfile
} from '@shared/protocol'
import { imageChannelsOf } from '@shared/imageChannels'
import { filterActiveRecognizedCandidates } from '../../store/useWorkspaceStore'

export interface ImageGenTabProps {
  draft: ModelSettingsState
  current: ModelProviderProfile | undefined
  showImgKey: boolean
  onToggleShowImgKey: () => void
  saveProbeWarnings: string[]
  recognizedCandidates: CcSwitchCandidate[]
  onUpdateImageGen: (patch: Partial<ModelSettingsState['imageGen']>) => void
  onUpdateChannel: (id: string, patch: Partial<ImageGenChannel>) => void
  onAddChannel: () => void
  onMoveChannel: (id: string, dir: -1 | 1) => void
  onRemoveChannel: (id: string) => void
  onToggleChannelRole: (channel: ImageGenChannel, role: ImageChannelRole) => void
  renderTestButtons: (channel: ImageGenChannel) => React.ReactNode
  renderProbeResult: (channel: ImageGenChannel) => React.ReactNode
}

/** 设置 → 生图 / 图生图渠道（主渠道 + 备用降级链） */
export function ImageGenTab({
  draft,
  current,
  showImgKey,
  onToggleShowImgKey,
  saveProbeWarnings,
  recognizedCandidates,
  onUpdateImageGen,
  onUpdateChannel,
  onAddChannel,
  onMoveChannel,
  onRemoveChannel,
  onToggleChannelRole,
  renderTestButtons,
  renderProbeResult
}: ImageGenTabProps): React.JSX.Element {
  return (
    <div className="flex-1 p-6 space-y-4 overflow-y-auto text-xs">
      <div className="p-3.5 rounded-xl bg-amber-50/80 border border-amber-200/80 text-amber-950 leading-relaxed">
        如果你当前的主对话模型（例如 <strong>DeepSeek / Claude / gemini-4-hydrogen</strong>
        ）本身不出图，可直接复用你已选择的模型渠道，或从下方 CC Switch 识别到的生图模型（如{' '}
        <code className="font-mono">gemini-nano-banana-2.1</code>
        ）一键填入并开启生图 API；若主模型自身已支持生图（如直接选用生图模型），不配此处也能直接生图。
      </div>

      {saveProbeWarnings.length > 0 && (
        <div className="p-3.5 rounded-xl bg-amber-50 border border-amber-300 text-amber-900 leading-relaxed space-y-1.5">
          <div className="font-semibold">设置已保存，但以下生图渠道探活未通过：</div>
          <ul className="list-disc pl-4 space-y-0.5">
            {saveProbeWarnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
          <div className="text-[11px] text-amber-700">
            探活只检查渠道的 /models
            接口，中转未开放该接口时也会未通过、不代表出图不可用；可用各渠道下方的「真实出图测试」确认。
          </div>
        </div>
      )}

      {(draft.profiles.some((p) => Boolean(p.apiKey.trim())) ||
        filterActiveRecognizedCandidates(recognizedCandidates, draft.profiles).length > 0) && (
        <div className="rounded-xl border border-zinc-200 bg-zinc-50/70 p-3 space-y-2">
          <div className="text-[11px] font-medium text-zinc-700">
            从已配置渠道 / 当前激活模型一键填入（仅显示已激活或同渠道模型）
          </div>
          <div className="flex flex-wrap gap-1.5">
            {draft.profiles
              .filter((p) => Boolean(p.apiKey.trim()))
              .map((p) => {
                const isCurrentSelected = current?.id === p.id
                const isSameImg =
                  draft.imageGen.enabled &&
                  draft.imageGen.model === p.model &&
                  draft.imageGen.baseUrl.replace(/\/+$/, '') === p.baseUrl.replace(/\/+$/, '')
                return (
                  <button
                    key={`img_prof_${p.id}`}
                    type="button"
                    onClick={() =>
                      onUpdateImageGen({
                        enabled: true,
                        baseUrl: p.baseUrl,
                        apiKey: p.apiKey,
                        ...(p.ccUid ? { ccUid: p.ccUid } : {}),
                        model: p.model,
                        editModel: p.model
                      })
                    }
                    className={clsx(
                      'px-2.5 py-1 rounded-lg border text-[11px] cursor-pointer transition-colors inline-flex items-center gap-1',
                      isSameImg
                        ? 'bg-blue-600 text-white border-blue-600'
                        : isCurrentSelected
                          ? 'bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100'
                          : 'bg-white text-zinc-700 border-zinc-200 hover:bg-zinc-100'
                    )}
                  >
                    <span className="font-mono">{p.model}</span>
                    <span className="opacity-75">· {p.label}</span>
                    {isCurrentSelected && !isSameImg && (
                      <span className="text-[10px] opacity-80">(当前选中)</span>
                    )}
                  </button>
                )
              })}

            {filterActiveRecognizedCandidates(recognizedCandidates, draft.profiles).map((c) => {
              const isSameImg =
                draft.imageGen.enabled &&
                draft.imageGen.model === c.model &&
                draft.imageGen.baseUrl.replace(/\/+$/, '') === c.baseUrl.replace(/\/+$/, '')
              return (
                <button
                  key={`img_cc_${c.uid}`}
                  type="button"
                  onClick={() =>
                    onUpdateImageGen({
                      enabled: true,
                      baseUrl: c.baseUrl,
                      apiKey: c.apiKey,
                      ccUid: c.uid,
                      model: c.model,
                      editModel: c.model
                    })
                  }
                  className={clsx(
                    'px-2.5 py-1 rounded-lg border text-[11px] cursor-pointer transition-colors inline-flex items-center gap-1',
                    isSameImg
                      ? 'bg-blue-600 text-white border-blue-600'
                      : 'bg-white text-zinc-700 border-zinc-200 hover:bg-blue-50 hover:border-blue-200'
                  )}
                >
                  <span className="font-mono">{c.model}</span>
                  <span className="opacity-70">· {c.name}</span>
                </button>
              )
            })}
          </div>
        </div>
      )}

      <div className="flex items-center justify-between gap-3">
        <label className="inline-flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={draft.imageGen.enabled}
            onChange={(e) => onUpdateImageGen({ enabled: e.target.checked })}
            className="w-4 h-4 rounded accent-blue-600"
          />
          <span className="font-semibold text-zinc-900">启用独立的生图 / 图生图 API</span>
        </label>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() =>
              onUpdateImageGen({
                enabled: true,
                baseUrl: 'https://api.siliconflow.cn/v1',
                model: 'Kwai-Kolors/Kolors',
                editModel: ''
              })
            }
            className="px-2 py-1 rounded-md border border-zinc-200 bg-zinc-50 hover:bg-zinc-100 text-[11px] text-zinc-700 cursor-pointer"
          >
            硅基流动 Kolors
          </button>
          <button
            type="button"
            onClick={() =>
              onUpdateImageGen({
                enabled: true,
                baseUrl: 'https://api.openai.com/v1',
                model: 'gpt-image-1',
                editModel: 'gpt-image-1'
              })
            }
            className="px-2 py-1 rounded-md border border-zinc-200 bg-zinc-50 hover:bg-zinc-100 text-[11px] text-zinc-700 cursor-pointer"
          >
            OpenAI gpt-image-1
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
        <div className="sm:col-span-2">
          <label className="block font-medium text-zinc-700 mb-1">
            生图接口 Base URL (OpenAI 兼容)
          </label>
          <input
            type="text"
            value={draft.imageGen.baseUrl}
            onChange={(e) => onUpdateImageGen({ baseUrl: e.target.value })}
            placeholder="https://api.siliconflow.cn/v1 或 https://api.openai.com/v1"
            className="w-full px-3 py-2 rounded-lg border border-zinc-200 font-mono outline-none focus:border-blue-500"
          />
        </div>

        <div className="sm:col-span-2">
          <label className="block font-medium text-zinc-700 mb-1">API Key</label>
          <div className="relative">
            <input
              type={showImgKey ? 'text' : 'password'}
              value={draft.imageGen.apiKey}
              onChange={(e) => onUpdateImageGen({ apiKey: e.target.value })}
              placeholder="sk-..."
              className="w-full pl-3 pr-9 py-2 rounded-lg border border-zinc-200 font-mono outline-none focus:border-blue-500"
            />
            <button
              type="button"
              onClick={onToggleShowImgKey}
              className="absolute right-2.5 top-2.5 text-zinc-400 hover:text-zinc-700 cursor-pointer"
            >
              {showImgKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        </div>

        <div>
          <label className="block font-medium text-zinc-700 mb-1">
            文生图模型 (generate_image)
          </label>
          <input
            type="text"
            value={draft.imageGen.model}
            onChange={(e) => onUpdateImageGen({ model: e.target.value })}
            placeholder="Kwai-Kolors/Kolors / gpt-image-1 / gemini-2.5-flash-image"
            className="w-full px-3 py-2 rounded-lg border border-zinc-200 font-mono outline-none focus:border-blue-500"
          />
        </div>

        <div>
          <label className="block font-medium text-zinc-700 mb-1">图生图 / 改图模型 (可选)</label>
          <input
            type="text"
            value={draft.imageGen.editModel ?? ''}
            onChange={(e) => onUpdateImageGen({ editModel: e.target.value })}
            placeholder="留空则沿用文生图模型"
            className="w-full px-3 py-2 rounded-lg border border-zinc-200 font-mono outline-none focus:border-blue-500"
          />
        </div>

        <div>
          <label className="block font-medium text-zinc-700 mb-1">默认出图分辨率</label>
          <select
            value={draft.imageGen.defaultSize ?? '1024x1024'}
            onChange={(e) => onUpdateImageGen({ defaultSize: e.target.value })}
            className="w-full px-3 py-2 rounded-lg border border-zinc-200 bg-white font-mono outline-none focus:border-blue-500"
          >
            <option value="1024x1024">1024x1024（方图）</option>
            <option value="1536x1024">1536x1024（横幅 3:2）</option>
            <option value="1024x1536">1024x1536（竖幅 2:3）</option>
            <option value="1792x1024">1792x1024（宽屏 16:9）</option>
          </select>
        </div>

        <div>
          <label className="block font-medium text-zinc-700 mb-1">协议偏好（主渠道）</label>
          <select
            value={imageChannelsOf(draft.imageGen)[0]?.protocol ?? 'auto'}
            onChange={(e) =>
              onUpdateChannel(imageChannelsOf(draft.imageGen)[0]?.id ?? 'primary', {
                protocol: e.target.value as ImageChannelProtocol
              })
            }
            className="w-full px-3 py-2 rounded-lg border border-zinc-200 bg-white outline-none focus:border-blue-500"
          >
            <option value="auto">自动（按模型名判断）</option>
            <option value="chat-first">对话接口优先（Nano/Gemini 类中转）</option>
            <option value="images-first">图片接口优先（/images/*）</option>
          </select>
        </div>

        <div>
          <label className="block font-medium text-zinc-700 mb-1">
            主渠道擅长方向（任务路由）
          </label>
          <div className="flex items-center gap-4 px-1 py-2">
            {(
              [
                ['generate', '文生图'],
                ['edit', '图生图']
              ] as Array<[ImageChannelRole, string]>
            ).map(([role, label]) => {
              const primary = imageChannelsOf(draft.imageGen)[0]
              const checked = Boolean(primary?.roles?.includes(role))
              return (
                <label key={role} className="inline-flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => primary && onToggleChannelRole(primary, role)}
                    className="w-4 h-4 rounded accent-blue-600"
                  />
                  <span>{label}</span>
                </label>
              )
            })}
          </div>
        </div>
      </div>

      {(() => {
        const primary = imageChannelsOf(draft.imageGen)[0]
        if (!primary) return null
        return (
          <div className="space-y-2">
            {renderTestButtons(primary)}
            {renderProbeResult(primary)}
          </div>
        )
      })()}

      <div className="rounded-xl border border-zinc-200 p-3.5 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="font-semibold text-zinc-900">备用生图渠道（自动降级）</div>
            <div className="text-[11px] text-zinc-500 mt-0.5">
              出图时按顺序尝试：主渠道失败（超时 / 报错 / 无图）自动换下一个；任务会优先用标注了对应擅长方向的渠道。
            </div>
          </div>
          <button
            type="button"
            onClick={onAddChannel}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50 cursor-pointer shrink-0"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>新增渠道</span>
          </button>
        </div>

        {imageChannelsOf(draft.imageGen).length <= 1 && (
          <div className="text-[11px] text-zinc-400">
            暂无备用渠道：目前只使用上方主渠道，行为与单渠道配置一致。
          </div>
        )}

        {imageChannelsOf(draft.imageGen)
          .slice(1)
          .map((channel, i) => (
            <div
              key={channel.id}
              className="rounded-lg border border-zinc-200 bg-zinc-50/60 p-3 space-y-2.5"
            >
              <div className="flex items-center gap-2">
                <span className="text-zinc-400 font-mono">#{i + 2}</span>
                <input
                  type="text"
                  value={channel.name}
                  onChange={(e) => onUpdateChannel(channel.id, { name: e.target.value })}
                  placeholder="渠道名称"
                  className="flex-1 px-2.5 py-1.5 rounded-md border border-zinc-200 bg-white outline-none focus:border-blue-500"
                />
                <label className="inline-flex items-center gap-1.5 cursor-pointer shrink-0">
                  <input
                    type="checkbox"
                    checked={channel.enabled}
                    onChange={(e) => onUpdateChannel(channel.id, { enabled: e.target.checked })}
                    className="w-4 h-4 rounded accent-blue-600"
                  />
                  <span>启用</span>
                </label>
                <button
                  type="button"
                  onClick={() => onMoveChannel(channel.id, -1)}
                  className="px-2 py-1 rounded-md border border-zinc-200 bg-white hover:bg-zinc-100 cursor-pointer"
                >
                  上移
                </button>
                <button
                  type="button"
                  onClick={() => onMoveChannel(channel.id, 1)}
                  className="px-2 py-1 rounded-md border border-zinc-200 bg-white hover:bg-zinc-100 cursor-pointer"
                >
                  下移
                </button>
                <button
                  type="button"
                  onClick={() => onRemoveChannel(channel.id)}
                  className="inline-flex items-center px-2 py-1 rounded-md border border-red-200 bg-white text-red-600 hover:bg-red-50 cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                <div className="sm:col-span-2">
                  <input
                    type="text"
                    value={channel.baseUrl}
                    onChange={(e) => onUpdateChannel(channel.id, { baseUrl: e.target.value })}
                    placeholder="Base URL（OpenAI 兼容），如 https://xxx/v1"
                    className="w-full px-2.5 py-1.5 rounded-md border border-zinc-200 bg-white font-mono outline-none focus:border-blue-500"
                  />
                </div>
                <div className="sm:col-span-2">
                  <input
                    type="password"
                    value={channel.apiKey}
                    onChange={(e) => onUpdateChannel(channel.id, { apiKey: e.target.value })}
                    placeholder="API Key（sk-...）"
                    className="w-full px-2.5 py-1.5 rounded-md border border-zinc-200 bg-white font-mono outline-none focus:border-blue-500"
                  />
                </div>
                <input
                  type="text"
                  value={channel.model}
                  onChange={(e) => onUpdateChannel(channel.id, { model: e.target.value })}
                  placeholder="文生图模型"
                  className="px-2.5 py-1.5 rounded-md border border-zinc-200 bg-white font-mono outline-none focus:border-blue-500"
                />
                <input
                  type="text"
                  value={channel.editModel ?? ''}
                  onChange={(e) => onUpdateChannel(channel.id, { editModel: e.target.value })}
                  placeholder="图生图模型（留空同文生图）"
                  className="px-2.5 py-1.5 rounded-md border border-zinc-200 bg-white font-mono outline-none focus:border-blue-500"
                />
                <select
                  value={channel.protocol}
                  onChange={(e) =>
                    onUpdateChannel(channel.id, {
                      protocol: e.target.value as ImageChannelProtocol
                    })
                  }
                  className="px-2.5 py-1.5 rounded-md border border-zinc-200 bg-white outline-none focus:border-blue-500"
                >
                  <option value="auto">协议：自动判断</option>
                  <option value="chat-first">协议：对话接口优先</option>
                  <option value="images-first">协议：图片接口优先</option>
                </select>
                <div className="flex items-center gap-3 px-1">
                  {(
                    [
                      ['generate', '文生图'],
                      ['edit', '图生图']
                    ] as Array<[ImageChannelRole, string]>
                  ).map(([role, label]) => (
                    <label key={role} className="inline-flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={Boolean(channel.roles?.includes(role))}
                        onChange={() => onToggleChannelRole(channel, role)}
                        className="w-4 h-4 rounded accent-blue-600"
                      />
                      <span>{label}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                {renderTestButtons(channel)}
                {renderProbeResult(channel)}
              </div>
            </div>
          ))}
      </div>
    </div>
  )
}
