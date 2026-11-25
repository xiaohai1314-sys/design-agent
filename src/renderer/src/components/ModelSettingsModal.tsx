import React, { useEffect, useState } from 'react'
import {
  Activity,
  BookMarked,
  Check,
  Eye,
  EyeOff,
  FolderOpen,
  Globe,
  Image as ImageIcon,
  Import,
  KeyRound,
  LoaderCircle,
  Plus,
  Search,
  Settings2,
  Trash2,
  X
} from 'lucide-react'
import clsx from 'clsx'
import type { AppGeneralSettings, CcSwitchCandidate, ModelSettingsState } from '@shared/ipc'
import type { ModelProviderProfile } from '@shared/protocol'
import {
  candidateToProfile,
  ccCandidateProfileId,
  filterActiveRecognizedCandidates,
  useWorkspaceStore
} from '../store/useWorkspaceStore'

interface ProbeResultState {
  status: 'testing' | 'ok' | 'fail'
  latencyMs?: number
  message?: string
}

interface ModelSettingsModalProps {
  open: boolean
  settings: ModelSettingsState | null
  generalSettings?: AppGeneralSettings | null
  onClose: () => void
  onSave: (next: ModelSettingsState) => Promise<void>
  onSaveGeneral?: (next: AppGeneralSettings) => Promise<void>
}

export const ModelSettingsModal: React.FC<ModelSettingsModalProps> = ({
  open,
  settings,
  generalSettings,
  onClose,
  onSave,
  onSaveGeneral
}) => {
  const recognizedCandidates = useWorkspaceStore((s) => s.ccSwitchCandidates)
  const refreshRecognizedCandidates = useWorkspaceStore((s) => s.refreshCcSwitchCandidates)
  const [tab, setTab] = useState<'llm' | 'image' | 'regulation' | 'web' | 'desktop'>('llm')
  const [draft, setDraft] = useState<ModelSettingsState | null>(null)
  const [genDraft, setGenDraft] = useState<AppGeneralSettings>({
    closeToTray: false,
    desktopNotifications: true
  })
  const [selectedId, setSelectedId] = useState<string>('')
  const [showKey, setShowKey] = useState(false)
  const [showImgKey, setShowImgKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [profileProbe, setProfileProbe] = useState<ProbeResultState | null>(null)

  // CC Switch / Claude / Codex 选择导入弹窗状态
  const [ccPickerOpen, setCcPickerOpen] = useState(false)
  const [ccLoading, setCcLoading] = useState(false)
  const [ccError, setCcError] = useState<string | null>(null)
  const [ccCandidates, setCcCandidates] = useState<CcSwitchCandidate[]>([])
  const [ccChecked, setCcChecked] = useState<Record<string, boolean>>({})
  const [ccSearch, setCcSearch] = useState('')
  const [ccProbes, setCcProbes] = useState<Record<string, ProbeResultState>>({})

  useEffect(() => {
    if (open && settings) {
      setDraft(structuredClone(settings))
      setSelectedId(settings.activeProfileId || settings.profiles[0]?.id || '')
      setProfileProbe(null)
      void refreshRecognizedCandidates()
    }
    if (open && generalSettings) {
      setGenDraft({ ...generalSettings })
    }
  }, [open, settings, generalSettings])

  useEffect(() => {
    setProfileProbe(null)
  }, [selectedId])

  if (!open || !draft) return null

  const current = draft.profiles.find((p) => p.id === selectedId) ?? draft.profiles[0]

  const openCcSwitchPicker = async (): Promise<void> => {
    setCcPickerOpen(true)
    setCcLoading(true)
    setCcError(null)
    setCcProbes({})
    setCcSearch('')
    try {
      const res = await window.zmo.models.discoverCcSwitch()
      setCcCandidates(res.candidates)
      if (res.error) setCcError(res.error)
      // 默认只预勾选「当前正在使用且无已知故障」的配置，避免把失效中转全倒进来
      const initialChecked: Record<string, boolean> = {}
      for (const c of res.candidates) {
        if (c.isCurrent && c.isHealthy !== false && c.apiKey.trim()) {
          initialChecked[c.uid] = true
        }
      }
      setCcChecked(initialChecked)
    } catch (err) {
      setCcError(err instanceof Error ? err.message : String(err))
    } finally {
      setCcLoading(false)
    }
  }

  const probeCandidate = async (c: CcSwitchCandidate): Promise<void> => {
    setCcProbes((prev) => ({ ...prev, [c.uid]: { status: 'testing' } }))
    const res = await window.zmo.models.testConnection(candidateToProfile(c))
    if (
      res.ok &&
      (res.resolvedBaseUrl !== undefined ||
        res.resolvedUseResponsesApi !== undefined ||
        res.resolvedAuthStyle !== undefined)
    ) {
      setCcCandidates((prev) =>
        prev.map((item) =>
          item.uid === c.uid
            ? {
                ...item,
                ...(res.resolvedBaseUrl !== undefined ? { baseUrl: res.resolvedBaseUrl } : {}),
                ...(res.resolvedUseResponsesApi !== undefined
                  ? { useResponsesApi: res.resolvedUseResponsesApi }
                  : {}),
                ...(res.resolvedAuthStyle !== undefined
                  ? { authStyle: res.resolvedAuthStyle }
                  : {})
              }
            : item
        )
      )
    }
    setCcProbes((prev) => ({
      ...prev,
      [c.uid]: res.ok
        ? { status: 'ok', latencyMs: res.latencyMs, message: res.detail }
        : { status: 'fail', latencyMs: res.latencyMs, message: res.error }
    }))
  }

  const probeCheckedCandidates = async (): Promise<void> => {
    const targets = ccCandidates.filter((c) => ccChecked[c.uid])
    for (let i = 0; i < targets.length; i += 3) {
      await Promise.all(targets.slice(i, i + 3).map((c) => probeCandidate(c)))
    }
  }

  const confirmImportCcSwitch = (): void => {
    const picked = ccCandidates.filter((c) => ccChecked[c.uid])
    if (picked.length === 0) return

    const nextProfiles = [...draft.profiles]
    let firstImportedId = ''

    for (const c of picked) {
      const generatedId = ccCandidateProfileId(c.uid)
      const matchIdx = nextProfiles.findIndex(
        (p) =>
          p.id === generatedId ||
          (p.label === c.name && p.baseUrl.replace(/\/+$/, '') === c.baseUrl.replace(/\/+$/, ''))
      )
      if (matchIdx >= 0) {
        const updated = candidateToProfile(c, nextProfiles[matchIdx].id)
        nextProfiles[matchIdx] = { ...nextProfiles[matchIdx], ...updated }
        if (!firstImportedId) firstImportedId = nextProfiles[matchIdx].id
      } else {
        const created = candidateToProfile(c)
        nextProfiles.push(created)
        if (!firstImportedId) firstImportedId = created.id
      }
    }

    setDraft({
      ...draft,
      activeProfileId: firstImportedId || draft.activeProfileId,
      profiles: nextProfiles
    })
    if (firstImportedId) setSelectedId(firstImportedId)
    setCcPickerOpen(false)
  }

  const testCurrentProfile = async (): Promise<void> => {
    if (!current) return
    setProfileProbe({ status: 'testing' })
    const res = await window.zmo.models.testConnection(current)
    if (
      res.ok &&
      (res.resolvedBaseUrl !== undefined ||
        res.resolvedUseResponsesApi !== undefined ||
        res.resolvedAuthStyle !== undefined)
    ) {
      updateCurrent({
        ...(res.resolvedBaseUrl !== undefined ? { baseUrl: res.resolvedBaseUrl } : {}),
        ...(res.resolvedUseResponsesApi !== undefined
          ? { useResponsesApi: res.resolvedUseResponsesApi }
          : {}),
        ...(res.resolvedAuthStyle !== undefined ? { authStyle: res.resolvedAuthStyle } : {})
      })
    }
    setProfileProbe(
      res.ok
        ? { status: 'ok', latencyMs: res.latencyMs, message: res.detail }
        : { status: 'fail', latencyMs: res.latencyMs, message: res.error }
    )
  }

  const updateCurrent = (patch: Partial<ModelProviderProfile>): void => {
    if (!current) return
    setDraft({
      ...draft,
      profiles: draft.profiles.map((p) => (p.id === current.id ? { ...p, ...patch } : p))
    })
  }

  const updateImageGen = (patch: Partial<ModelSettingsState['imageGen']>): void => {
    setDraft({
      ...draft,
      imageGen: {
        ...draft.imageGen,
        ...patch
      }
    })
  }

  const addNewProfile = (): void => {
    const id = `custom_${Date.now()}`
    const item: ModelProviderProfile = {
      id,
      label: '自定义 OpenAI 兼容渠道',
      protocol: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '',
      model: 'gpt-4o',
      subagentModel: '',
      supportsThinking: true,
      maxOutputTokens: 16384
    }
    setDraft({
      ...draft,
      activeProfileId: id,
      profiles: [...draft.profiles, item]
    })
    setSelectedId(id)
  }

  const removeCurrent = (): void => {
    if (!current) return
    const rest = draft.profiles.filter((p) => p.id !== current.id)
    const nextActive =
      draft.activeProfileId === current.id ? (rest[0]?.id ?? '') : draft.activeProfileId
    setDraft({
      ...draft,
      activeProfileId: nextActive,
      profiles: rest
    })
    setSelectedId(rest[0]?.id ?? '')
  }

  const handlePickRegulationFolder = async (): Promise<void> => {
    const folder = await window.zmo.agent.pickFolder()
    if (folder) {
      setDraft({ ...draft, regulation: { folderPath: folder } })
    }
  }

  const handleSave = async (): Promise<void> => {
    setSaving(true)
    try {
      await onSave(draft)
      if (onSaveGeneral) await onSaveGeneral(genDraft)
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-[2px] p-4">
      <div className="w-full max-w-3xl rounded-2xl bg-white border border-zinc-200 shadow-2xl overflow-hidden flex flex-col max-h-[88vh]">
        <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-200">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setTab('llm')}
              className={clsx(
                'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer transition-colors',
                tab === 'llm' ? 'bg-zinc-900 text-white' : 'text-zinc-600 hover:bg-zinc-100'
              )}
            >
              <KeyRound className="w-3.5 h-3.5" />
              <span>大模型 API 渠道</span>
            </button>
            <button
              type="button"
              onClick={() => setTab('image')}
              className={clsx(
                'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer transition-colors',
                tab === 'image' ? 'bg-zinc-900 text-white' : 'text-zinc-600 hover:bg-zinc-100'
              )}
            >
              <ImageIcon className="w-3.5 h-3.5" />
              <span>效果图 / 图生图 API</span>
            </button>
            <button
              type="button"
              onClick={() => setTab('regulation')}
              className={clsx(
                'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer transition-colors',
                tab === 'regulation' ? 'bg-zinc-900 text-white' : 'text-zinc-600 hover:bg-zinc-100'
              )}
            >
              <BookMarked className="w-3.5 h-3.5" />
              <span>本地规范知识库</span>
            </button>
            <button
              type="button"
              onClick={() => setTab('web')}
              className={clsx(
                'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer transition-colors',
                tab === 'web' ? 'bg-zinc-900 text-white' : 'text-zinc-600 hover:bg-zinc-100'
              )}
            >
              <Globe className="w-3.5 h-3.5" />
              <span>联网检索</span>
            </button>
            <button
              type="button"
              onClick={() => setTab('desktop')}
              className={clsx(
                'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer transition-colors',
                tab === 'desktop' ? 'bg-zinc-900 text-white' : 'text-zinc-600 hover:bg-zinc-100'
              )}
            >
              <Settings2 className="w-3.5 h-3.5" />
              <span>桌面与通知</span>
            </button>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {tab === 'llm' ? (
          <div className="flex flex-1 min-h-0">
            <div className="w-56 border-r border-zinc-200 bg-zinc-50/70 p-3 flex flex-col gap-1.5 overflow-y-auto">
              {draft.profiles.map((p) => {
                const isSelected = p.id === current?.id
                const isActive = p.id === draft.activeProfileId
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setSelectedId(p.id)}
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
                onClick={addNewProfile}
                className="mt-2 flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl border border-dashed border-zinc-300 text-xs text-zinc-600 hover:border-zinc-400 hover:text-zinc-900 cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>新增 API 渠道</span>
              </button>

              <button
                type="button"
                onClick={() => void openCcSwitchPicker()}
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
                      onClick={() => void testCurrentProfile()}
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
                      onClick={removeCurrent}
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
                      onChange={(e) => updateCurrent({ label: e.target.value })}
                      className="w-full px-3 py-2 rounded-lg border border-zinc-200 focus:border-blue-500 outline-none"
                    />
                  </div>
                  <div>
                    <label className="block font-medium text-zinc-700 mb-1">接口协议类型</label>
                    <select
                      value={current.protocol}
                      onChange={(e) =>
                        updateCurrent({ protocol: e.target.value as 'openai' | 'anthropic' })
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
                    onChange={(e) => updateCurrent({ baseUrl: e.target.value })}
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
                      onChange={(e) => updateCurrent({ apiKey: e.target.value })}
                      placeholder="sk-..."
                      className="w-full pl-3 pr-9 py-2 rounded-lg border border-zinc-200 font-mono focus:border-blue-500 outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => setShowKey(!showKey)}
                      className="absolute right-2.5 text-zinc-400 hover:text-zinc-700 cursor-pointer"
                    >
                      {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block font-medium text-zinc-700 mb-1">
                      主控模型名 (Model ID)
                    </label>
                    <input
                      type="text"
                      value={current.model}
                      onChange={(e) => updateCurrent({ model: e.target.value })}
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
                      onChange={(e) => updateCurrent({ subagentModel: e.target.value })}
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
                        updateCurrent({ maxOutputTokens: Number(e.target.value) || 16384 })
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
                        updateCurrent({ contextWindowTokens: Number(e.target.value) || 64000 })
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
                      onChange={(e) => updateCurrent({ supportsThinking: e.target.checked })}
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
                          onChange={(e) => updateCurrent({ enablePromptCache: e.target.checked })}
                          className="rounded border-zinc-300 text-blue-600"
                        />
                        <span className="text-zinc-700">启用 Prompt Caching (cache_control)</span>
                      </label>
                      <label className="inline-flex items-center gap-2">
                        <span className="text-zinc-600">鉴权请求头:</span>
                        <select
                          value={current.authStyle ?? 'auto'}
                          onChange={(e) =>
                            updateCurrent({
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
                        onChange={(e) => updateCurrent({ useResponsesApi: e.target.checked })}
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
                    onClick={() => void openCcSwitchPicker()}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-blue-600 text-white font-medium hover:bg-blue-700 cursor-pointer transition-colors"
                  >
                    <Import className="w-3.5 h-3.5" />
                    <span>从 CC Switch 选择导入</span>
                  </button>
                  <button
                    type="button"
                    onClick={addNewProfile}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl border border-zinc-200 bg-white text-zinc-800 font-medium hover:bg-zinc-50 cursor-pointer transition-colors"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>手动新增渠道</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : tab === 'image' ? (
          <div className="flex-1 p-6 space-y-4 overflow-y-auto text-xs">
            <div className="p-3.5 rounded-xl bg-amber-50/80 border border-amber-200/80 text-amber-950 leading-relaxed">
              如果你当前的主对话模型（例如 <strong>DeepSeek / Claude / gemini-4-hydrogen</strong>）本身不出图，可直接复用你已选择的模型渠道，或从下方 CC Switch 识别到的生图模型（如{' '}
              <code className="font-mono">gemini-nano-banana-2.1</code>）一键填入并开启生图 API；若主模型自身已支持生图（如直接选用生图模型），不配此处也能直接生图。
            </div>

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
                        draft.imageGen.baseUrl.replace(/\/+$/, '') ===
                          p.baseUrl.replace(/\/+$/, '')
                      return (
                        <button
                          key={`img_prof_${p.id}`}
                          type="button"
                          onClick={() =>
                            updateImageGen({
                              enabled: true,
                              baseUrl: p.baseUrl,
                              apiKey: p.apiKey,
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

                  {filterActiveRecognizedCandidates(recognizedCandidates, draft.profiles).map(
                    (c) => {
                      const isSameImg =
                        draft.imageGen.enabled &&
                        draft.imageGen.model === c.model &&
                        draft.imageGen.baseUrl.replace(/\/+$/, '') ===
                          c.baseUrl.replace(/\/+$/, '')
                      return (
                        <button
                          key={`img_cc_${c.uid}`}
                          type="button"
                          onClick={() =>
                            updateImageGen({
                              enabled: true,
                              baseUrl: c.baseUrl,
                              apiKey: c.apiKey,
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
                    }
                  )}
                </div>
              </div>
            )}

            <div className="flex items-center justify-between gap-3">
              <label className="inline-flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={draft.imageGen.enabled}
                  onChange={(e) => updateImageGen({ enabled: e.target.checked })}
                  className="w-4 h-4 rounded accent-blue-600"
                />
                <span className="font-semibold text-zinc-900">
                  启用独立的生图 / 图生图 API
                </span>
              </label>

              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() =>
                    updateImageGen({
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
                    updateImageGen({
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
                  onChange={(e) => updateImageGen({ baseUrl: e.target.value })}
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
                    onChange={(e) => updateImageGen({ apiKey: e.target.value })}
                    placeholder="sk-..."
                    className="w-full pl-3 pr-9 py-2 rounded-lg border border-zinc-200 font-mono outline-none focus:border-blue-500"
                  />
                  <button
                    type="button"
                    onClick={() => setShowImgKey(!showImgKey)}
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
                  onChange={(e) => updateImageGen({ model: e.target.value })}
                  placeholder="Kwai-Kolors/Kolors / gpt-image-1 / gemini-2.5-flash-image"
                  className="w-full px-3 py-2 rounded-lg border border-zinc-200 font-mono outline-none focus:border-blue-500"
                />
              </div>

              <div>
                <label className="block font-medium text-zinc-700 mb-1">
                  图生图 / 改图模型 (可选)
                </label>
                <input
                  type="text"
                  value={draft.imageGen.editModel ?? ''}
                  onChange={(e) => updateImageGen({ editModel: e.target.value })}
                  placeholder="留空则沿用文生图模型"
                  className="w-full px-3 py-2 rounded-lg border border-zinc-200 font-mono outline-none focus:border-blue-500"
                />
              </div>

              <div>
                <label className="block font-medium text-zinc-700 mb-1">默认出图分辨率</label>
                <select
                  value={draft.imageGen.defaultSize ?? '1024x1024'}
                  onChange={(e) => updateImageGen({ defaultSize: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg border border-zinc-200 bg-white font-mono outline-none focus:border-blue-500"
                >
                  <option value="1024x1024">1024x1024（方图）</option>
                  <option value="1536x1024">1536x1024（横幅 3:2）</option>
                  <option value="1024x1536">1024x1536（竖幅 2:3）</option>
                  <option value="1792x1024">1792x1024（宽屏 16:9）</option>
                </select>
              </div>
            </div>
          </div>
        ) : tab === 'regulation' ? (
          <div className="flex-1 p-6 space-y-4 overflow-y-auto text-xs">
            <div className="p-3.5 rounded-xl bg-emerald-50/70 border border-emerald-100 text-emerald-900 leading-relaxed">
              内置 <code className="font-mono">retrieve_regulation_chunks</code> 工具会检索您本机目录中的规范文档（支持{' '}
              <code className="font-mono">.pdf</code>、<code className="font-mono">.md</code>、<code className="font-mono">.txt</code> 及结构化{' '}
              <code className="font-mono">.json</code>），完全离线私有。已默认附带一份无障碍设计规范示例库。
            </div>

            <div>
              <label className="block font-medium text-zinc-700 mb-1.5">本地建筑规范库目录</label>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={draft.regulation?.folderPath ?? ''}
                  onChange={(e) =>
                    setDraft({ ...draft, regulation: { folderPath: e.target.value } })
                  }
                  className="flex-1 px-3 py-2 rounded-lg border border-zinc-200 font-mono focus:border-blue-500 outline-none"
                />
                <button
                  type="button"
                  onClick={() => void handlePickRegulationFolder()}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-zinc-300 bg-white hover:bg-zinc-50 text-zinc-700 cursor-pointer"
                >
                  <FolderOpen className="w-3.5 h-3.5" />
                  <span>浏览文件夹</span>
                </button>
              </div>
            </div>
          </div>
        ) : tab === 'web' ? (
          <div className="flex-1 p-6 space-y-4 overflow-y-auto text-xs">
            <div className="p-3.5 rounded-xl bg-sky-50/70 border border-sky-100 text-sky-900 leading-relaxed">
              挂载 <code className="font-mono">web_search</code> 工具后，即使使用普通自定义大模型 API，智能体（及子任务）也可实时搜索最新材料工艺参数、设计案例或公开条文。默认使用免 Key 的 DuckDuckGo 通道，也可按需切换为 Tavily 或博查（Bocha）API。
            </div>

            <label className="inline-flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={draft.webSearch?.enabled ?? true}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    webSearch: {
                      provider: draft.webSearch?.provider ?? 'duckduckgo',
                      apiKey: draft.webSearch?.apiKey ?? '',
                      enabled: e.target.checked
                    }
                  })
                }
                className="w-4 h-4 rounded accent-blue-600"
              />
              <span className="font-semibold text-zinc-900">启用联网搜索工具 (web_search)</span>
            </label>

            <div>
              <label className="block font-medium text-zinc-700 mb-1">搜索引擎通道</label>
              <select
                value={draft.webSearch?.provider ?? 'duckduckgo'}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    webSearch: {
                      enabled: draft.webSearch?.enabled ?? true,
                      apiKey: draft.webSearch?.apiKey ?? '',
                      provider: e.target.value as 'duckduckgo' | 'tavily' | 'bocha'
                    }
                  })
                }
                className="w-full px-3 py-2 rounded-lg border border-zinc-200 bg-white outline-none focus:border-blue-500"
              >
                <option value="duckduckgo">DuckDuckGo HTML（免费免 API Key）</option>
                <option value="tavily">Tavily Search API（需填写 API Key）</option>
                <option value="bocha">博查 Bocha AI Search（国内中文检索佳，需 Key）</option>
              </select>
            </div>

            {draft.webSearch?.provider && draft.webSearch.provider !== 'duckduckgo' && (
              <div>
                <label className="block font-medium text-zinc-700 mb-1">搜索服务 API Key</label>
                <input
                  type="password"
                  value={draft.webSearch.apiKey ?? ''}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      webSearch: {
                        ...draft.webSearch!,
                        apiKey: e.target.value
                      }
                    })
                  }
                  placeholder="tvly-... / sk-..."
                  className="w-full px-3 py-2 rounded-lg border border-zinc-200 font-mono outline-none focus:border-blue-500"
                />
              </div>
            )}
          </div>
        ) : (
          <div className="flex-1 p-6 space-y-4 overflow-y-auto text-xs">
            <div className="p-3.5 rounded-xl bg-zinc-100 border border-zinc-200 text-zinc-700 leading-relaxed">
              配置后台长任务完成后是否弹出 Windows 系统通知，以及点击右上角关闭按钮时是最小化到系统托盘还是直接退出程序。
            </div>

            <label className="flex items-start gap-2.5 cursor-pointer p-3 rounded-xl border border-zinc-200 hover:bg-zinc-50">
              <input
                type="checkbox"
                checked={genDraft.desktopNotifications}
                onChange={(e) =>
                  setGenDraft({ ...genDraft, desktopNotifications: e.target.checked })
                }
                className="w-4 h-4 mt-0.5 rounded accent-blue-600"
              />
              <div>
                <div className="font-semibold text-zinc-900">启用后台任务桌面系统通知</div>
                <div className="text-zinc-500 mt-0.5">
                  窗口处于最小化或未聚焦状态时，当智能体完成任务或等待您审批/回答提问，弹出 Windows 通知提醒。
                </div>
              </div>
            </label>

            <label className="flex items-start gap-2.5 cursor-pointer p-3 rounded-xl border border-zinc-200 hover:bg-zinc-50">
              <input
                type="checkbox"
                checked={genDraft.closeToTray}
                onChange={(e) => setGenDraft({ ...genDraft, closeToTray: e.target.checked })}
                className="w-4 h-4 mt-0.5 rounded accent-blue-600"
              />
              <div>
                <div className="font-semibold text-zinc-900">关闭主窗口时隐藏到系统托盘</div>
                <div className="text-zinc-500 mt-0.5">
                  点击右上角「×」不中断正在运行的任务，可在右下角托盘图标右键菜单彻底退出。
                </div>
              </div>
            </label>
          </div>
        )}

        <div className="flex items-center justify-end gap-2.5 px-5 py-3 border-t border-zinc-200 bg-zinc-50">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg text-xs font-medium border border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-100 cursor-pointer"
          >
            取消
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => void handleSave()}
            className="px-4 py-1.5 rounded-lg text-xs font-medium bg-zinc-900 text-white hover:bg-zinc-800 disabled:opacity-50 cursor-pointer"
          >
            {saving ? '保存中…' : '保存并应用'}
          </button>
        </div>

        {ccPickerOpen && (
          <div className="absolute inset-0 z-10 bg-black/45 flex items-center justify-center p-4">
            <div className="w-full max-w-2xl max-h-[82vh] rounded-2xl bg-white border border-zinc-200 shadow-2xl flex flex-col overflow-hidden text-xs">
              <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-200 bg-zinc-50">
                <div>
                  <h3 className="text-sm font-semibold text-zinc-900">
                    从 CC Switch / Claude / Codex 选择导入节点
                  </h3>
                  <p className="text-[11px] text-zinc-500 mt-0.5">
                    仅读取本机配置（绝不修改原库）；可先「测活」筛掉失效中转，再勾选需要的节点导入。
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setCcPickerOpen(false)}
                  className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-700 hover:bg-zinc-200/60 cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="px-4 py-2.5 border-b border-zinc-200 flex flex-wrap items-center gap-2">
                <div className="relative flex-1 min-w-44">
                  <Search className="w-3.5 h-3.5 text-zinc-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={ccSearch}
                    onChange={(e) => setCcSearch(e.target.value)}
                    placeholder="搜索节点名、地址、模型（如 gemini / wb / custom）"
                    className="w-full pl-8 pr-3 py-1.5 rounded-lg border border-zinc-200 outline-none focus:border-blue-500"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => {
                    const next: Record<string, boolean> = {}
                    for (const c of ccCandidates) {
                      if (c.isCurrent) next[c.uid] = true
                    }
                    setCcChecked(next)
                  }}
                  className="px-2.5 py-1.5 rounded-lg border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50 cursor-pointer"
                >
                  仅选当前激活
                </button>
                <button
                  type="button"
                  onClick={() => setCcChecked({})}
                  className="px-2.5 py-1.5 rounded-lg border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50 cursor-pointer"
                >
                  清空选择
                </button>
                <button
                  type="button"
                  disabled={Object.values(ccChecked).filter(Boolean).length === 0}
                  onClick={() => void probeCheckedCandidates()}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 disabled:opacity-40 cursor-pointer"
                >
                  <Activity className="w-3.5 h-3.5" />
                  <span>测活已勾选项</span>
                </button>
              </div>

              {ccError && (
                <div className="mx-4 mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
                  {ccError}
                </div>
              )}

              <div className="flex-1 overflow-y-auto p-4 space-y-2">
                {ccLoading ? (
                  <div className="py-12 flex items-center justify-center gap-2 text-zinc-500">
                    <LoaderCircle className="w-4 h-4 animate-spin text-blue-600" />
                    <span>正在扫描本机 CC Switch / Claude / Codex 节点…</span>
                  </div>
                ) : ccCandidates.length === 0 ? (
                  <div className="py-12 text-center text-zinc-500">
                    未在当前用户目录下检测到 CC Switch、Claude Code 或 Codex 配置。
                  </div>
                ) : (
                  ccCandidates
                    .filter((c) => {
                      const q = ccSearch.trim().toLowerCase()
                      if (!q) return true
                      return (
                        c.name.toLowerCase().includes(q) ||
                        c.baseUrl.toLowerCase().includes(q) ||
                        c.model.toLowerCase().includes(q) ||
                        c.appType.toLowerCase().includes(q)
                      )
                    })
                    .map((c) => {
                      const checked = Boolean(ccChecked[c.uid])
                      const probe = ccProbes[c.uid]
                      const alreadyAdded = draft.profiles.some(
                        (p) =>
                          p.id === `cc_${c.uid.replace(/[^a-zA-Z0-9_-]/g, '_')}` ||
                          (p.label === c.name &&
                            p.baseUrl.replace(/\/+$/, '') === c.baseUrl.replace(/\/+$/, ''))
                      )
                      return (
                        <div
                          key={c.uid}
                          className={clsx(
                            'rounded-xl border p-3 transition-colors flex items-start gap-3',
                            checked
                              ? 'border-blue-400 bg-blue-50/40'
                              : 'border-zinc-200 bg-white hover:border-zinc-300'
                          )}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) =>
                              setCcChecked((prev) => ({ ...prev, [c.uid]: e.target.checked }))
                            }
                            className="mt-1 w-4 h-4 rounded accent-blue-600 cursor-pointer shrink-0"
                          />
                          <div className="min-w-0 flex-1 space-y-1">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="font-semibold text-zinc-900">{c.name}</span>
                              <span className="px-1.5 py-0.5 rounded bg-zinc-100 text-[10px] text-zinc-600 font-mono">
                                {c.appType}
                              </span>
                              <span className="px-1.5 py-0.5 rounded bg-slate-100 text-[10px] text-slate-700">
                                {c.protocol === 'anthropic' ? 'Anthropic' : 'OpenAI 兼容'}
                              </span>
                              {c.isCurrent && (
                                <span className="px-1.5 py-0.5 rounded bg-emerald-100 text-[10px] font-medium text-emerald-700">
                                  当前正在用
                                </span>
                              )}
                              {c.isHealthy === false && (
                                <span
                                  className="px-1.5 py-0.5 rounded bg-rose-100 text-[10px] text-rose-700"
                                  title={c.lastError || 'CC Switch 记录近期存在失败'}
                                >
                                  历史失败
                                </span>
                              )}
                              {alreadyAdded && (
                                <span className="px-1.5 py-0.5 rounded bg-amber-100 text-[10px] text-amber-800">
                                  列表已有
                                </span>
                              )}
                            </div>
                            <div className="text-[11px] font-mono text-zinc-500 truncate" title={c.baseUrl}>
                              {c.baseUrl} · {c.model} · Key: {c.maskedKey}
                            </div>
                            {probe && probe.status !== 'testing' && (
                              <div
                                className={clsx(
                                  'text-[11px]',
                                  probe.status === 'ok' ? 'text-emerald-700' : 'text-rose-600'
                                )}
                              >
                                {probe.status === 'ok'
                                  ? `✅ 可用 (${probe.latencyMs}ms)${probe.message ? ` · ${probe.message}` : ''}`
                                  : `❌ 不可用 (${probe.latencyMs}ms)：${probe.message || '连接失败'}`}
                              </div>
                            )}
                          </div>
                          <button
                            type="button"
                            disabled={probe?.status === 'testing'}
                            onClick={() => void probeCandidate(c)}
                            className="shrink-0 px-2.5 py-1 rounded-lg border border-zinc-200 bg-white text-[11px] text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 cursor-pointer"
                          >
                            {probe?.status === 'testing' ? '测活中…' : '测活'}
                          </button>
                        </div>
                      )
                    })
                )}
              </div>

              <div className="px-4 py-3 border-t border-zinc-200 bg-zinc-50 flex items-center justify-between">
                <span className="text-zinc-500">
                  共扫描到 {ccCandidates.length} 个配置，已勾选{' '}
                  <strong className="text-zinc-900">
                    {Object.values(ccChecked).filter(Boolean).length}
                  </strong>{' '}
                  个
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setCcPickerOpen(false)}
                    className="px-3.5 py-1.5 rounded-lg border border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-100 cursor-pointer"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    disabled={Object.values(ccChecked).filter(Boolean).length === 0}
                    onClick={confirmImportCcSwitch}
                    className="px-4 py-1.5 rounded-lg bg-zinc-900 text-white font-medium hover:bg-zinc-800 disabled:opacity-40 cursor-pointer"
                  >
                    确认导入所选 ({Object.values(ccChecked).filter(Boolean).length})
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
