import React, { useEffect, useState } from 'react'
import { LlmTab } from './settings/LlmTab'
import { ImageGenTab } from './settings/ImageGenTab'
import { CcSwitchImportDialog } from './settings/CcSwitchImportDialog'
import { RegulationTab } from './settings/RegulationTab'
import { WebSearchTab } from './settings/WebSearchTab'
import { DesktopTab } from './settings/DesktopTab'
import type { ImageProbeState, ProbeResultState } from './settings/types'
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
import type {
  ClipModelStatus,
  ImageChannelProtocol,
  ImageChannelRole,
  ImageChannelTestLevel,
  ImageChannelTestResult,
  ImageGenChannel,
  InspirationRebuildResult,
  ModelProviderProfile
} from '@shared/protocol'
import { normalizeImageGenConfig } from '@shared/imageChannels'
import {
  candidateToProfile,
  ccCandidateProfileId,
  filterActiveRecognizedCandidates,
  useWorkspaceStore
} from '../store/useWorkspaceStore'

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
  const [imageProbes, setImageProbes] = useState<Record<string, ImageProbeState>>({})
  const [saveProbeWarnings, setSaveProbeWarnings] = useState<string[]>([])
  const [clipStatus, setClipStatus] = useState<ClipModelStatus | null>(null)
  const [clipDownloading, setClipDownloading] = useState(false)
  const [clipDownloadPct, setClipDownloadPct] = useState(0)
  const [clipError, setClipError] = useState<string | null>(null)
  const [rebuilding, setRebuilding] = useState(false)
  const [rebuildProgress, setRebuildProgress] = useState('')
  const [rebuildResult, setRebuildResult] = useState<InspirationRebuildResult | null>(null)

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
      setImageProbes({})
      setSaveProbeWarnings([])
      void refreshRecognizedCandidates()
    }
    if (open && generalSettings) {
      setGenDraft({ ...generalSettings })
    }
  }, [open, settings, generalSettings])

  useEffect(() => {
    setProfileProbe(null)
  }, [selectedId])

  // 向量模型状态：打开设置或模型目录变化时刷新（下载中状态由主进程如实回传）
  const clipDirForStatus = draft?.inspiration?.clipModelDir?.trim() ?? ''
  useEffect(() => {
    if (!open || tab !== 'regulation' || !clipDirForStatus) {
      if (!clipDirForStatus) setClipStatus(null)
      return
    }
    let cancelled = false
    void window.designAgent.models
      .getClipModelStatus(clipDirForStatus)
      .then((s) => {
        if (!cancelled) setClipStatus(s)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [open, tab, clipDirForStatus])

  if (!open || !draft) return null

  const current = draft.profiles.find((p) => p.id === selectedId) ?? draft.profiles[0]

  const openCcSwitchPicker = async (): Promise<void> => {
    setCcPickerOpen(true)
    setCcLoading(true)
    setCcError(null)
    setCcProbes({})
    setCcSearch('')
    try {
      const res = await window.designAgent.models.discoverCcSwitch()
      setCcCandidates(res.candidates)
      if (res.error) setCcError(res.error)
      // 默认只预勾选「当前正在使用且无已知故障」的配置，避免把失效中转全倒进来
      const initialChecked: Record<string, boolean> = {}
      for (const c of res.candidates) {
        if (c.isCurrent && c.isHealthy !== false && c.hasKey) {
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
    const res = await window.designAgent.models.testConnection(candidateToProfile(c))
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
    const res = await window.designAgent.models.testConnection(current)
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

  const clearImageProbe = (channelId: string): void => {
    setImageProbes((prev) => {
      if (!(channelId in prev)) return prev
      const next = { ...prev }
      delete next[channelId]
      return next
    })
  }

  const updateImageGen = (patch: Partial<ModelSettingsState['imageGen']>): void => {
    // 平铺字段即主渠道字段：改动后清掉主渠道的旧测试结果，避免误导
    const primaryId = imageChannelsOf(draft.imageGen)[0]?.id
    if (primaryId) clearImageProbe(primaryId)
    // 平铺字段与 channels[0]（主渠道）互为镜像，统一经 normalize 保持一致
    setDraft({
      ...draft,
      imageGen: normalizeImageGenConfig({ ...draft.imageGen, ...patch })
    })
  }

  const imageChannelsOf = (img: ModelSettingsState['imageGen']): ImageGenChannel[] =>
    normalizeImageGenConfig(img).channels ?? []

  const updateChannels = (channels: ImageGenChannel[]): void => {
    setDraft({
      ...draft,
      imageGen: normalizeImageGenConfig({ ...draft.imageGen, channels })
    })
  }

  const updateChannel = (id: string, patch: Partial<ImageGenChannel>): void => {
    clearImageProbe(id)
    updateChannels(
      imageChannelsOf(draft.imageGen).map((c) => (c.id === id ? { ...c, ...patch } : c))
    )
  }

  const toImageProbeState = (res: ImageChannelTestResult): ImageProbeState => ({
    status: res.ok ? (res.warning ? 'warn' : 'ok') : res.warning ? 'warn' : 'fail',
    level: res.level,
    latencyMs: res.latencyMs,
    message: res.ok
      ? [res.detail, res.warning].filter(Boolean).join('；')
      : (res.warning ?? res.error)
  })

  const probeImageChannel = async (
    channel: ImageGenChannel,
    level: ImageChannelTestLevel
  ): Promise<void> => {
    setImageProbes((prev) => ({ ...prev, [channel.id]: { status: 'testing', level } }))
    try {
      const res = await window.designAgent.models.testImageChannel(channel, level)
      setImageProbes((prev) => ({ ...prev, [channel.id]: toImageProbeState(res) }))
    } catch (err) {
      setImageProbes((prev) => ({
        ...prev,
        [channel.id]: {
          status: 'fail',
          level,
          message: err instanceof Error ? err.message : String(err)
        }
      }))
    }
  }

  const renderImageTestButtons = (channel: ImageGenChannel): React.ReactNode => {
    const probe = imageProbes[channel.id]
    const testing = probe?.status === 'testing'
    return (
      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          disabled={testing}
          onClick={() => void probeImageChannel(channel, 'probe')}
          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 cursor-pointer"
        >
          {testing && probe.level === 'probe' ? (
            <LoaderCircle className="w-3.5 h-3.5 animate-spin text-blue-600" />
          ) : (
            <Activity className="w-3.5 h-3.5 text-blue-600" />
          )}
          <span>{testing && probe.level === 'probe' ? '测试中…' : '测试'}</span>
        </button>
        <button
          type="button"
          disabled={testing}
          onClick={() => void probeImageChannel(channel, 'generate')}
          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 cursor-pointer"
        >
          {testing && probe.level === 'generate' ? (
            <LoaderCircle className="w-3.5 h-3.5 animate-spin text-blue-600" />
          ) : (
            <ImageIcon className="w-3.5 h-3.5 text-blue-600" />
          )}
          <span>{testing && probe.level === 'generate' ? '出图测试中…' : '真实出图测试'}</span>
        </button>
        <span className="text-[10px] text-zinc-400">
          「测试」为免费探活；「真实出图测试」会实际生成一张图、消耗一次出图调用
        </span>
      </div>
    )
  }

  const renderImageProbeResult = (channel: ImageGenChannel): React.ReactNode => {
    const probe = imageProbes[channel.id]
    if (!probe || probe.status === 'testing') return null
    const levelLabel = probe.level === 'generate' ? '真实出图测试' : '探活'
    return (
      <div
        className={clsx(
          'rounded-lg px-3 py-2 text-[11px] border leading-relaxed',
          probe.status === 'ok'
            ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
            : probe.status === 'warn'
              ? 'bg-amber-50 border-amber-200 text-amber-800'
              : 'bg-rose-50 border-rose-200 text-rose-800'
        )}
      >
        {probe.status === 'ok'
          ? `✅ ${levelLabel}通过`
          : probe.status === 'warn'
            ? `⚠️ ${levelLabel}未完全通过`
            : `❌ ${levelLabel}失败`}
        {probe.latencyMs !== undefined ? ` (${probe.latencyMs}ms)` : ''}
        {probe.message ? `：${probe.message}` : ''}
      </div>
    )
  }

  const addImageChannel = (): void => {
    const channels = imageChannelsOf(draft.imageGen)
    updateChannels([
      ...channels,
      {
        id: `channel-${Date.now().toString(36)}`,
        name: `备用渠道 ${channels.length}`,
        enabled: true,
        baseUrl: '',
        apiKey: '',
        model: '',
        editModel: '',
        protocol: 'auto' as ImageChannelProtocol,
        defaultSize: '1024x1024'
      }
    ])
  }

  const removeImageChannel = (id: string): void => {
    updateChannels(imageChannelsOf(draft.imageGen).filter((c) => c.id !== id))
  }

  const moveImageChannel = (id: string, dir: -1 | 1): void => {
    const channels = [...imageChannelsOf(draft.imageGen)]
    const idx = channels.findIndex((c) => c.id === id)
    const target = idx + dir
    // 下标 0 是主渠道（与平铺字段镜像），位置固定，备用渠道只在 1..n 之间排序
    if (idx < 1 || target < 1 || target >= channels.length) return
    const [moved] = channels.splice(idx, 1)
    channels.splice(target, 0, moved)
    updateChannels(channels)
  }

  const toggleChannelRole = (channel: ImageGenChannel, role: ImageChannelRole): void => {
    const roles = channel.roles ?? []
    updateChannel(channel.id, {
      roles: roles.includes(role) ? roles.filter((r) => r !== role) : [...roles, role]
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
    const folder = await window.designAgent.agent.pickFolder('model-settings')
    if (folder) {
      setDraft({ ...draft, regulation: { folderPath: folder } })
    }
  }

  const handlePickInspirationFolder = async (): Promise<void> => {
    const folder = await window.designAgent.agent.pickFolder('model-settings')
    if (folder) {
      setDraft({ ...draft, inspiration: { ...draft.inspiration, folderPath: folder } })
    }
  }

  const handlePickClipModelDir = async (): Promise<void> => {
    const folder = await window.designAgent.agent.pickFolder('model-settings')
    if (folder) {
      setDraft({ ...draft, inspiration: { ...draft.inspiration, clipModelDir: folder } })
    }
  }

  const handleDownloadClipModel = async (): Promise<void> => {
    const dir = draft?.inspiration?.clipModelDir?.trim()
    if (!dir || clipDownloading) return
    setClipDownloading(true)
    setClipDownloadPct(0)
    setClipError(null)
    const off = window.designAgent.models.onClipModelDownloadProgress((p) =>
      setClipDownloadPct(Math.round(p.overallRatio * 100))
    )
    try {
      const status = await window.designAgent.models.downloadClipModel(dir)
      setClipStatus(status)
    } catch (err) {
      setClipError(err instanceof Error ? err.message : String(err))
    } finally {
      off()
      setClipDownloading(false)
    }
  }

  const handleRebuildInspirationIndex = async (): Promise<void> => {
    const folder = draft?.inspiration?.folderPath?.trim()
    if (!folder || rebuilding) return
    setRebuilding(true)
    setRebuildResult(null)
    setRebuildProgress('正在扫描…')
    const phaseZh: Record<string, string> = {
      scan: '扫描素材',
      'text-vectors': '计算文本向量',
      'image-vectors': '计算图像向量',
      write: '写入索引'
    }
    const off = window.designAgent.models.onInspirationRebuildProgress((p) =>
      setRebuildProgress(
        p.total > 0 ? `${phaseZh[p.phase] ?? p.phase} ${p.done}/${p.total}` : (phaseZh[p.phase] ?? p.phase)
      )
    )
    try {
      const res = await window.designAgent.models.rebuildInspirationIndex({
        folder,
        clipModelDir: draft?.inspiration?.clipModelDir
      })
      setRebuildResult(res)
    } catch (err) {
      setRebuildResult({
        ok: false,
        folder,
        recordCount: 0,
        recipeCount: 0,
        assetCount: 0,
        textVectorCount: 0,
        imageVectorCount: 0,
        vectorsComputed: false,
        errors: [],
        errorCount: 0,
        elapsedMs: 0,
        error: err instanceof Error ? err.message : String(err)
      })
    } finally {
      off()
      setRebuilding(false)
      setRebuildProgress('')
    }
  }

  /**
   * 保存后对所有已启用的生图渠道做一遍轻量探活，返回需要提示用户的告警文案。
   * 只提示、不阻断：设置在探活前已经落盘生效；中转 /models 接口本身不可靠，
   * 探活未通过不等于出图不可用，因此不因探活失败回滚或拦下保存。
   */
  const probeEnabledImageChannelsOnSave = async (
    imageGen: ModelSettingsState['imageGen']
  ): Promise<string[]> => {
    if (!imageGen.enabled) return []
    const targets = imageChannelsOf(imageGen).filter((c) => c.enabled && c.apiKey.trim())
    if (targets.length === 0) return []
    const warnings: string[] = []
    await Promise.all(
      targets.map(async (channel) => {
        try {
          const res = await window.designAgent.models.testImageChannel(channel, 'probe')
          setImageProbes((prev) => ({ ...prev, [channel.id]: toImageProbeState(res) }))
          if (!res.ok) {
            warnings.push(`${channel.name}：${res.warning ?? res.error ?? '探活未通过'}`)
          } else if (res.warning) {
            warnings.push(`${channel.name}：${res.warning}`)
          }
        } catch (err) {
          warnings.push(
            `${channel.name}：探活请求异常（${err instanceof Error ? err.message : String(err)}）`
          )
        }
      })
    )
    return warnings
  }

  const handleSave = async (): Promise<void> => {
    setSaving(true)
    setSaveProbeWarnings([])
    try {
      await onSave(draft)
      if (onSaveGeneral) await onSaveGeneral(genDraft)
      const warnings = await probeEnabledImageChannelsOnSave(draft.imageGen)
      if (warnings.length > 0) {
        // 设置已保存生效；停留在生图页签展示告警，由用户看完后手动关闭
        setSaveProbeWarnings(warnings)
        setTab('image')
        return
      }
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
          <LlmTab
            draft={draft}
            setDraft={setDraft}
            selectedId={selectedId}
            onSelectProfile={setSelectedId}
            showKey={showKey}
            onToggleShowKey={() => setShowKey(!showKey)}
            profileProbe={profileProbe}
            onTestProfile={() => void testCurrentProfile()}
            onAddProfile={addNewProfile}
            onRemoveProfile={removeCurrent}
            onUpdateProfile={updateCurrent}
            onOpenCcSwitchPicker={() => void openCcSwitchPicker()}
          />
        ) : tab === 'image' ? (
          <ImageGenTab
            draft={draft}
            current={current}
            showImgKey={showImgKey}
            onToggleShowImgKey={() => setShowImgKey(!showImgKey)}
            saveProbeWarnings={saveProbeWarnings}
            recognizedCandidates={recognizedCandidates}
            onUpdateImageGen={updateImageGen}
            onUpdateChannel={updateChannel}
            onAddChannel={addImageChannel}
            onMoveChannel={moveImageChannel}
            onRemoveChannel={removeImageChannel}
            onToggleChannelRole={toggleChannelRole}
            renderTestButtons={renderImageTestButtons}
            renderProbeResult={renderImageProbeResult}
          />
        ) : tab === 'regulation' ? (
          <RegulationTab
            draft={draft}
            setDraft={setDraft}
            clipStatus={clipStatus}
            clipDownloading={clipDownloading}
            clipDownloadPct={clipDownloadPct}
            clipError={clipError}
            rebuilding={rebuilding}
            rebuildProgress={rebuildProgress}
            rebuildResult={rebuildResult}
            onPickRegulationFolder={() => void handlePickRegulationFolder()}
            onPickInspirationFolder={() => void handlePickInspirationFolder()}
            onPickClipModelDir={() => void handlePickClipModelDir()}
            onDownloadClipModel={() => void handleDownloadClipModel()}
            onRebuildIndex={() => void handleRebuildInspirationIndex()}
          />
        ) : tab === 'web' ? (
          <WebSearchTab draft={draft} setDraft={setDraft} />
        ) : (
          <DesktopTab genDraft={genDraft} setGenDraft={setGenDraft} />
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
          <CcSwitchImportDialog
            candidates={ccCandidates}
            checked={ccChecked}
            setChecked={setCcChecked}
            search={ccSearch}
            onSearchChange={setCcSearch}
            error={ccError}
            loading={ccLoading}
            probes={ccProbes}
            profiles={draft.profiles}
            onClose={() => setCcPickerOpen(false)}
            onProbeCandidate={(c) => void probeCandidate(c)}
            onProbeChecked={() => void probeCheckedCandidates()}
            onConfirm={confirmImportCcSwitch}
          />
        )}
      </div>
    </div>
  )
}
