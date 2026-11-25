import React, { useMemo, useState } from 'react'
import {
  BookOpenCheck,
  Box,
  Check,
  ChevronDown,
  Compass,
  FolderOpen,
  Image as ImageIcon,
  Layers,
  MessageSquare,
  Presentation,
  RefreshCw,
  Search,
  Sparkles,
  Star,
  Upload,
  Wand2,
  X
} from 'lucide-react'
import clsx from 'clsx'
import type { McpConnectorInfo, RecentFileEntry, RegulationStatsResult } from '@shared/ipc'
import type { AgentAttachment } from '@shared/protocol'
import {
  FEATURE_CATALOG,
  FEATURE_CATEGORIES,
  FEATURE_FORMS,
  filterFeatures,
  getTodayWeekdayLabel,
  type FeatureCatalogItem
} from '../features/taskForm/compose'
import type { ComposerMode } from '../store/useWorkspaceStore'

export const MODE_TABS: Array<{
  id: ComposerMode
  label: string
  icon: React.FC<{ className?: string }>
}> = [
  { id: 'general', label: '通用', icon: MessageSquare },
  { id: 'image', label: '生图', icon: ImageIcon },
  { id: 'modeling', label: '建模', icon: Box },
  { id: 'report', label: '汇报', icon: Presentation },
  { id: 'regulation', label: '查规范', icon: BookOpenCheck }
]

export const MODE_HEADLINE: Record<ComposerMode, { title: string; subtitle: string }> = {
  general: {
    title: '有什么空间设计、图纸解析或三维建模任务？',
    subtitle: '支持多轮规划、CAD 框选批注、3D 视口打点、7 大设计软件 MCP 联动与本地规范核验'
  },
  image: {
    title: '描绘空间画面或上传底图，即刻出图',
    subtitle: '支持文生概念意向、白模直出效果图、局部涂抹改图与平立剖填彩（推荐 DeepSeek + 生图 API）'
  },
  modeling: {
    title: '有图纸和建模的需求尽管说，我来做',
    subtitle: '直连本机 SketchUp / 3ds Max / Rhino / Blender / MultiCAD，按尺度构建三维体块与构件'
  },
  report: {
    title: '把设计方案，整理成一份好 PPT',
    subtitle: '支持选择本机 .pptx/.potx 模板，自动生成图文混排可编辑汇报并在右侧工作台逐页微调'
  },
  regulation: {
    title: '国标、行标、地方规范一站查',
    subtitle: '优先检索本地规范知识库（PDF / MD / JSON），严格带条文号与原文依据回答'
  }
}

export const MODE_PLACEHOLDER: Record<ComposerMode, string> = {
  general: '给智能体发消息… (Enter 发送，Shift+Enter 换行)',
  image: '描述你想生成的空间画面、材质光影，或拖入 CAD / 白模底图开始出图…',
  modeling: '拖入图纸、参考图或模型，或直接描述要构建的空间尺度与三维体块…',
  report: '先选择下方或本地 PPTX 模板，然后描述汇报结构与内容，或点「帮我描述」…',
  regulation: '输入要查询的建筑/消防/无障碍/装修规范问题，如：建筑内部装修设计防火规范…'
}

export const ReportTemplateSlot: React.FC<{
  templateAtt?: AgentAttachment
  onPickTemplate: () => void
  onClearTemplate: () => void
  onHelperPrompt: () => void
}> = ({ templateAtt, onPickTemplate, onClearTemplate, onHelperPrompt }) => (
  <div className="flex items-center gap-2 mb-2 pb-2 border-b border-zinc-100 text-xs">
    {templateAtt ? (
      <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl bg-blue-50 border border-blue-200 text-blue-900">
        <Presentation className="w-3.5 h-3.5 text-blue-600 shrink-0" />
        <span className="max-w-52 truncate font-medium">{templateAtt.name}</span>
        <button
          type="button"
          onClick={onClearTemplate}
          className="text-blue-400 hover:text-blue-800 cursor-pointer"
          title="移除已选模板"
        >
          <X className="w-3 h-3" />
        </button>
      </div>
    ) : (
      <button
        type="button"
        onClick={onPickTemplate}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-dashed border-zinc-300 bg-zinc-50 text-zinc-500 hover:border-blue-400 hover:text-blue-600 cursor-pointer transition-colors"
      >
        <Presentation className="w-3.5 h-3.5" />
        <span>未选择模板（点此选本地 PPTX）</span>
      </button>
    )}

    <button
      type="button"
      onClick={onHelperPrompt}
      className="px-2.5 py-1 rounded-lg bg-zinc-100 hover:bg-zinc-200/80 text-[11px] text-zinc-700 cursor-pointer transition-colors"
    >
      帮我描述
    </button>
  </div>
)

const MCP_BADGE_THEME: Record<
  string,
  { bg: string; short: string; fg: string }
> = {
  sketchup: {
    bg: 'bg-gradient-to-br from-rose-500 to-red-600',
    short: 'SU',
    fg: 'text-white'
  },
  multicad: {
    bg: 'bg-gradient-to-br from-red-500 to-rose-700',
    short: 'CAD',
    fg: 'text-white'
  },
  blender: {
    bg: 'bg-gradient-to-br from-orange-400 to-amber-600',
    short: 'BL',
    fg: 'text-white'
  },
  '3dsmax': {
    bg: 'bg-gradient-to-br from-teal-500 to-cyan-700',
    short: '3D',
    fg: 'text-white'
  },
  rhino: {
    bg: 'bg-gradient-to-br from-zinc-700 to-zinc-900',
    short: 'RH',
    fg: 'text-white'
  },
  photoshop: {
    bg: 'bg-[#001e36]',
    short: 'Ps',
    fg: 'text-[#31a8ff]'
  }
}

export const ModelingMcpStrip: React.FC<{
  connectors: McpConnectorInfo[]
  onToggle: (name: string, enabled: boolean) => void
}> = ({ connectors, onToggle }) => {
  const [menuOpen, setMenuOpen] = useState(false)
  const modelingConns = connectors.filter((c) => c.name !== 'computer-use')
  if (modelingConns.length === 0) return null
  const enabledConns = modelingConns.filter((c) => c.enabled)

  return (
    <div className="relative flex items-center gap-1.5 shrink-0 flex-nowrap">
      {/* 重叠横排圆标栈（对齐 znzmo 单行视觉，悬停微展便于直点切换） */}
      <div className="group/mcp flex items-center -space-x-1.5 hover:space-x-1 transition-all duration-150 shrink-0 flex-nowrap py-0.5">
        {modelingConns.map((conn) => {
          const theme = MCP_BADGE_THEME[conn.name] ?? {
            bg: 'bg-zinc-600',
            short: conn.label.slice(0, 2).toUpperCase(),
            fg: 'text-white'
          }
          return (
            <button
              key={conn.name}
              type="button"
              onClick={() => onToggle(conn.name, !conn.enabled)}
              title={`${conn.label}（${conn.enabled ? '已连接，点击关闭' : '未启用，点击开启'}）`}
              className={clsx(
                'relative w-6 h-6 rounded-full flex items-center justify-center text-[9px] font-bold tracking-tight transition-all cursor-pointer shrink-0 select-none',
                theme.bg,
                theme.fg,
                conn.enabled
                  ? 'ring-2 ring-emerald-500 ring-offset-1 opacity-100 z-10 scale-105 shadow-xs'
                  : 'ring-2 ring-white opacity-60 grayscale-[35%] hover:opacity-100 hover:grayscale-0 hover:scale-110 hover:z-20'
              )}
            >
              <span>{theme.short}</span>
              {conn.enabled && (
                <span className="absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full bg-emerald-500 ring-1 ring-white" />
              )}
            </button>
          )
        })}
      </div>

      <button
        type="button"
        onClick={() => setMenuOpen((v) => !v)}
        title="查看或切换三维建模 / CAD 连接器"
        className={clsx(
          'inline-flex items-center gap-1 px-2 py-1 rounded-full text-[11px] transition-colors cursor-pointer whitespace-nowrap shrink-0',
          enabledConns.length > 0
            ? 'bg-emerald-50 text-emerald-700 border border-emerald-200 font-medium hover:bg-emerald-100/80'
            : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800'
        )}
      >
        <span>
          {enabledConns.length === 1
            ? enabledConns[0].label.replace(/连接器|MCP/g, '').trim()
            : enabledConns.length > 1
              ? `已连 ${enabledConns.length} 项`
              : '连接软件'}
        </span>
        <ChevronDown className="w-3 h-3 opacity-70" />
      </button>

      {menuOpen && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setMenuOpen(false)} />
          <div className="absolute left-0 bottom-9 z-40 w-60 rounded-2xl border border-zinc-200 bg-white shadow-xl p-1.5 space-y-0.5 text-xs">
            <div className="px-2.5 py-1 text-[10px] font-medium text-zinc-400">
              本机建模 / CAD 软件连接器（点击开关）
            </div>
            {modelingConns.map((conn) => {
              const theme = MCP_BADGE_THEME[conn.name] ?? {
                bg: 'bg-zinc-600',
                short: conn.label.slice(0, 2).toUpperCase(),
                fg: 'text-white'
              }
              return (
                <button
                  key={conn.name}
                  type="button"
                  onClick={() => onToggle(conn.name, !conn.enabled)}
                  className="w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-xl hover:bg-zinc-100 cursor-pointer transition-colors"
                >
                  <span className="flex items-center gap-2 min-w-0">
                    <span
                      className={clsx(
                        'w-5 h-5 rounded-full flex items-center justify-center text-[8px] font-bold shrink-0',
                        theme.bg,
                        theme.fg
                      )}
                    >
                      {theme.short}
                    </span>
                    <span className="truncate text-zinc-800">{conn.label}</span>
                  </span>
                  <span
                    className={clsx(
                      'inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full shrink-0',
                      conn.enabled
                        ? 'bg-emerald-50 text-emerald-700 font-medium'
                        : 'text-zinc-400'
                    )}
                  >
                    {conn.enabled && <Check className="w-2.5 h-2.5" />}
                    <span>{conn.enabled ? '已启用' : '关闭'}</span>
                  </span>
                </button>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

export const RegulationScopeStrip: React.FC<{
  scope: 'comprehensive' | 'retrieve' | 'qa'
  onChange: (scope: 'comprehensive' | 'retrieve' | 'qa') => void
}> = ({ scope, onChange }) => {
  const items: Array<{ id: 'comprehensive' | 'retrieve' | 'qa'; label: string }> = [
    { id: 'comprehensive', label: '综合' },
    { id: 'retrieve', label: '规范检索' },
    { id: 'qa', label: 'AI规范问答' }
  ]
  return (
    <div className="flex items-center gap-1">
      {items.map((it) => (
        <button
          key={it.id}
          type="button"
          onClick={() => onChange(it.id)}
          className={clsx(
            'px-2.5 py-1 rounded-full text-[11px] border transition-colors cursor-pointer',
            scope === it.id
              ? 'bg-zinc-900 text-white border-zinc-900 font-medium'
              : 'bg-white text-zinc-600 border-zinc-200 hover:border-zinc-300'
          )}
        >
          {it.label}
        </button>
      ))}
    </div>
  )
}

const REG_PRESET_POOL = [
  { mode: '规范检索', q: '建筑防火通用规范 GB 55037 关于疏散楼梯间净宽和梯段最小净宽的要求' },
  { mode: '规范检索', q: '建筑内部装修设计防火规范 GB 50222 对公共建筑墙面及吊顶燃烧性能等级的规定' },
  { mode: '规范检索', q: '住宅项目规范 GB 55038-2025 关于厨房、卫生间最小使用面积和净高的规定' },
  { mode: '综合', q: '多层办公建筑的袋形走道最大长度、疏散门开启方向和无障碍卫生间轮椅回转直径是多少？' },
  { mode: '综合', q: '餐饮店厨房与就餐区装修材料的燃烧性能等级（A/B1/B2）有哪些强制性要求？' },
  { mode: '综合', q: '无障碍建筑与室内设计中坡道最大坡度、扶手高度及抓杆安装尺寸的标准要求' },
  { mode: '规范检索', q: '民用建筑工程室内环境污染控制标准对甲醛、TVOC 等限量指标与验收条件要求' },
  { mode: 'AI规范问答', q: '老旧商业建筑改造做室内公共空间时，消防审核重点核查哪几类平面和材料条文？' },
  { mode: '综合', q: '中小学教学楼走廊净宽、栏杆安全高度及防攀爬构造的强制条文要求' }
]

const MODELING_PILLS = [
  { label: '图片转 CAD', code: 'B3.1', prompt: '请根据我上传的户型图/平面图提取轴网与空间尺寸并转化为规范 CAD/DXF 平面图：' },
  { label: '组件复刻', code: 'B3.5', prompt: '请根据参考图在已连接的建模软件中构建精细家具/构件三维模型：' },
  { label: '照图建模', code: 'B3.6', prompt: '请根据我的参考图与空间尺寸，在已连接的三维建模软件中还原空间建筑结构与主要体块：' },
  { label: '局部改模型', code: 'B3.10', prompt: '请结合当前建模场景或局部修改需求，对三维模型进行局部精细调整与替换：' }
]

export interface QuickPresetSceneConfig {
  id: string
  targetHost?: string
  params: Array<{ name: string; options: string[]; defaultValue: string }>
  values: Record<string, string>
}

const LIVING_ROOM_PRESET_PACKS: Array<{
  title: string
  styleLabel: string
  dimsLabel: string
  desc: string
  prompt: string
  presetScene: QuickPresetSceneConfig
}> = [
  {
    title: '现代极简 · 住宅客厅',
    styleLabel: '现代极简',
    dimsLabel: '4800×6400×2900',
    desc: 'L型布艺沙发+岩板木格栅电视墙+双眼皮吊顶灯槽+阳台推拉门',
    prompt:
      '请使用预置参数化建模包 living-room-modeling-v1 在 SketchUp 中直接生成一套现代极简风格住宅客厅三维精模（4800×6400×2900mm，含硬装吊顶、家具软装与主视角场景）。',
    presetScene: {
      id: 'living-room-modeling-v1',
      targetHost: 'sketchup',
      params: [
        { name: '预置包', options: ['living-room-modeling-v1'], defaultValue: 'living-room-modeling-v1' },
        { name: '建模软件', options: ['SketchUp'], defaultValue: 'SketchUp' },
        { name: '风格', options: ['现代极简', '新中式', '侘寂原木', '轻奢商业'], defaultValue: '现代极简' },
        { name: '尺寸规格', options: ['4800×6400×2900', '5200×7000×3000', '4500×6000×2800'], defaultValue: '4800×6400×2900' }
      ],
      values: {
        预置包: 'living-room-modeling-v1',
        建模软件: 'SketchUp',
        风格: '现代极简',
        尺寸规格: '4800×6400×2900'
      }
    }
  },
  {
    title: '新中式 · 禅意客厅',
    styleLabel: '新中式',
    dimsLabel: '5200×7000×3000',
    desc: '胡桃木实木格栅+素白肌理漆+山水意境挂画+大尺度客厅组团',
    prompt:
      '请使用预置参数化建模包 living-room-modeling-v1 在 SketchUp 中直接生成一套新中式风格住宅客厅三维模型（5200×7000×3000mm，胡桃木格栅背景与禅意软装）。',
    presetScene: {
      id: 'living-room-modeling-v1',
      targetHost: 'sketchup',
      params: [
        { name: '预置包', options: ['living-room-modeling-v1'], defaultValue: 'living-room-modeling-v1' },
        { name: '建模软件', options: ['SketchUp'], defaultValue: 'SketchUp' },
        { name: '风格', options: ['现代极简', '新中式', '侘寂原木', '轻奢商业'], defaultValue: '新中式' },
        { name: '尺寸规格', options: ['4800×6400×2900', '5200×7000×3000', '4500×6000×2800'], defaultValue: '5200×7000×3000' }
      ],
      values: {
        预置包: 'living-room-modeling-v1',
        建模软件: 'SketchUp',
        风格: '新中式',
        尺寸规格: '5200×7000×3000'
      }
    }
  },
  {
    title: '侘寂原木 · 温润起居室',
    styleLabel: '侘寂原木',
    dimsLabel: '4500×6000×2800',
    desc: '暖米微水泥肌理+原木橡木护墙与地板+亚麻织物+景观阳台',
    prompt:
      '请使用预置参数化建模包 living-room-modeling-v1 在 SketchUp 中直接生成一套侘寂原木风格客厅三维模型（4500×6000×2800mm，原木地板与亚麻布艺沙发组合）。',
    presetScene: {
      id: 'living-room-modeling-v1',
      targetHost: 'sketchup',
      params: [
        { name: '预置包', options: ['living-room-modeling-v1'], defaultValue: 'living-room-modeling-v1' },
        { name: '建模软件', options: ['SketchUp'], defaultValue: 'SketchUp' },
        { name: '风格', options: ['现代极简', '新中式', '侘寂原木', '轻奢商业'], defaultValue: '侘寂原木' },
        { name: '尺寸规格', options: ['4800×6400×2900', '5200×7000×3000', '4500×6000×2800'], defaultValue: '4500×6000×2800' }
      ],
      values: {
        预置包: 'living-room-modeling-v1',
        建模软件: 'SketchUp',
        风格: '侘寂原木',
        尺寸规格: '4500×6000×2800'
      }
    }
  }
]

const REPORT_STYLE_TABS = ['全部', '素雅留白', '深色高级感', '东方园林', '商业全案']

export const ModeEcosystemPanel: React.FC<{
  mode: ComposerMode
  quickScenes: Array<{ title: string; desc: string; prompt: string; featureCode?: string }>
  recentFiles: RecentFileEntry[]
  regulationStats: RegulationStatsResult | null
  onOpenCatalogFeature: (code: string) => void
  onOpenAllToolbox: () => void
  onQuickPrompt: (
    prompt: string,
    toolTitle?: string,
    autoSend?: boolean,
    presetScene?: QuickPresetSceneConfig
  ) => void
  onPickTemplate: () => void
  onSelectLocalTemplate: (file: RecentFileEntry) => void
  onOpenRegulationSettings: () => void
  onRefreshRegulationStats: () => void
}> = ({
  mode,
  quickScenes,
  recentFiles,
  regulationStats,
  onOpenCatalogFeature,
  onOpenAllToolbox,
  onQuickPrompt,
  onPickTemplate,
  onSelectLocalTemplate,
  onOpenRegulationSettings,
  onRefreshRegulationStats
}) => {
  const [imgCat, setImgCat] = useState<string>('生图')
  const [imgSearch, setImgSearch] = useState('')
  const [reportTab, setReportTab] = useState('全部')
  const [regSeed, setRegSeed] = useState(0)

  const todayLabel = useMemo(() => getTodayWeekdayLabel(), [])
  const imageModeFeatures = useMemo(
    () => filterFeatures(FEATURE_CATALOG, imgCat, imgSearch),
    [imgCat, imgSearch]
  )
  const reportFeatures = useMemo(
    () => FEATURE_CATALOG.filter((f) => f.category === '汇报'),
    []
  )
  const localPptTemplates = useMemo(
    () => recentFiles.filter((f) => /\.(pptx|potx)$/i.test(f.name)),
    [recentFiles]
  )
  const regCards = useMemo(() => {
    const out: typeof REG_PRESET_POOL = []
    for (let i = 0; i < 6; i++) {
      out.push(REG_PRESET_POOL[(regSeed + i) % REG_PRESET_POOL.length])
    }
    return out
  }, [regSeed])

  if (mode === 'general') {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {quickScenes.map((sc, i) => (
            <button
              key={i}
              type="button"
              onClick={() =>
                sc.featureCode
                  ? onOpenCatalogFeature(sc.featureCode)
                  : onQuickPrompt(sc.prompt, sc.title, false)
              }
              className="group p-4 rounded-2xl border border-zinc-200/90 bg-white text-left hover:border-blue-400 hover:shadow-sm transition-all cursor-pointer space-y-1.5"
            >
              <div className="flex items-center justify-between text-xs font-semibold text-zinc-900 group-hover:text-blue-600">
                <span className="inline-flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5 text-blue-600" />
                  <span>{sc.title}</span>
                </span>
                <span className="text-[10px] text-zinc-400 font-normal">打开表单 →</span>
              </div>
              <p className="text-[11px] text-zinc-500 leading-relaxed">{sc.desc}</p>
            </button>
          ))}
        </div>
        <div className="flex justify-center">
          <button
            type="button"
            onClick={onOpenAllToolbox}
            className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full border border-zinc-200 bg-white hover:border-blue-400 hover:text-blue-600 text-xs font-medium text-zinc-600 transition-colors cursor-pointer"
          >
            <Layers className="w-3.5 h-3.5" />
            <span>浏览全部 {FEATURE_CATALOG.length} 项专业设计工作流与表单 →</span>
          </button>
        </div>
      </div>
    )
  }

  if (mode === 'image') {
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-1 flex-wrap">
            {FEATURE_CATEGORIES.filter((c) => c !== '全部').map((cat) => (
              <button
                key={cat}
                type="button"
                onClick={() => setImgCat(cat)}
                className={clsx(
                  'px-2.5 py-1 rounded-full text-xs transition-colors cursor-pointer',
                  imgCat === cat
                    ? 'bg-zinc-900 text-white font-medium'
                    : 'text-zinc-600 hover:bg-zinc-100'
                )}
              >
                {cat}
              </button>
            ))}
          </div>
          <div className="relative w-44">
            <Search className="w-3.5 h-3.5 text-zinc-400 absolute left-2.5 top-2" />
            <input
              type="text"
              value={imgSearch}
              onChange={(e) => setImgSearch(e.target.value)}
              placeholder="搜索生图或工作流…"
              className="w-full pl-8 pr-2.5 py-1.5 rounded-full border border-zinc-200 bg-white text-[11px] outline-none focus:border-blue-500"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
          {imageModeFeatures.map((item: FeatureCatalogItem) => {
            const isToday = item.todayRecommend === todayLabel
            const reqCount = FEATURE_FORMS[item.featureCode]?.fields?.filter((f) => f.required).length ?? 0
            return (
              <button
                key={item.featureCode}
                type="button"
                onClick={() => onOpenCatalogFeature(item.featureCode)}
                className="group p-3.5 rounded-2xl border border-zinc-200/90 bg-white text-left hover:border-blue-400 hover:shadow-sm transition-all cursor-pointer flex flex-col gap-1.5"
              >
                <div className="flex items-center justify-between text-[10px]">
                  <span className="px-2 py-0.5 rounded bg-amber-50 text-amber-700 font-medium">
                    {item.category} · {item.featureCode}
                  </span>
                  {isToday ? (
                    <span className="inline-flex items-center gap-0.5 text-amber-600 font-medium">
                      <Star className="w-2.5 h-2.5 fill-amber-500" />
                      今日推荐
                    </span>
                  ) : (
                    <span className="text-zinc-400">{reqCount} 项必填</span>
                  )}
                </div>
                <div className="text-[13px] font-semibold text-zinc-900 group-hover:text-blue-600">
                  {item.title}
                </div>
                <p className="text-[11px] text-zinc-500 leading-relaxed line-clamp-2">
                  {item.description}
                </p>
              </button>
            )
          })}
        </div>
      </div>
    )
  }

  if (mode === 'modeling') {
    const recommendedCodes = ['B3.1', 'B3.5', 'B3.6', 'B3.10']
    const modelingCards = recommendedCodes
      .map((code) => FEATURE_CATALOG.find((f) => f.featureCode === code))
      .filter((x): x is FeatureCatalogItem => Boolean(x))
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-center gap-2 flex-wrap">
          {MODELING_PILLS.map((pill) => (
            <button
              key={pill.code}
              type="button"
              onClick={() => onQuickPrompt(pill.prompt, pill.label, false)}
              className="px-3.5 py-1.5 rounded-full border border-zinc-200 bg-white hover:border-blue-400 hover:text-blue-600 text-xs text-zinc-700 cursor-pointer transition-colors"
            >
              {pill.label}
            </button>
          ))}
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between px-0.5">
            <span className="text-[11px] font-medium text-zinc-500">
              预置参数化建模包（极速直出 SketchUp · 确定性 Ruby 工程，无需现写几何代码）
            </span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 font-medium">
              已就绪 · living-room-modeling-v1
            </span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
            {LIVING_ROOM_PRESET_PACKS.map((pack) => (
              <button
                key={pack.title}
                type="button"
                onClick={() => onQuickPrompt(pack.prompt, '照图建模', false, pack.presetScene)}
                className="group p-3.5 rounded-2xl border border-emerald-200/80 bg-emerald-50/30 text-left hover:border-emerald-400 hover:bg-white hover:shadow-sm transition-all cursor-pointer space-y-1.5"
              >
                <div className="flex items-center justify-between text-[10px]">
                  <span className="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 font-medium">
                    SketchUp · {pack.styleLabel}
                  </span>
                  <span className="text-zinc-400 font-mono">{pack.dimsLabel}</span>
                </div>
                <div className="text-xs font-semibold text-zinc-900 group-hover:text-emerald-700">
                  {pack.title}
                </div>
                <p className="text-[11px] text-zinc-500 line-clamp-2 leading-relaxed">{pack.desc}</p>
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <div className="text-[11px] font-medium text-zinc-400 px-0.5">
            常用建模场景（点击展开结构化参数表单）
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
            {modelingCards.map((card) => (
              <button
                key={card.featureCode}
                type="button"
                onClick={() => onOpenCatalogFeature(card.featureCode)}
                className="group p-3.5 rounded-2xl border border-zinc-200/90 bg-white text-left hover:border-blue-400 hover:shadow-sm transition-all cursor-pointer space-y-1.5"
              >
                <div className="flex items-center justify-between text-[10px]">
                  <span className="px-1.5 py-0.5 rounded bg-violet-50 text-violet-700 font-medium">
                    {card.featureCode === 'B3.1' ? '2D / CAD' : '3D / MCP'}
                  </span>
                  <Box className="w-3.5 h-3.5 text-zinc-400 group-hover:text-blue-600" />
                </div>
                <div className="text-xs font-semibold text-zinc-900 group-hover:text-blue-600">
                  {card.title}
                </div>
                <p className="text-[11px] text-zinc-500 line-clamp-2 leading-relaxed">
                  {card.description}
                </p>
              </button>
            ))}
          </div>
        </div>
      </div>
    )
  }

  if (mode === 'report') {
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-1.5 flex-wrap">
            {REPORT_STYLE_TABS.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setReportTab(t)}
                className={clsx(
                  'px-2.5 py-1 rounded-full text-xs cursor-pointer transition-colors',
                  reportTab === t
                    ? 'bg-zinc-900 text-white font-medium'
                    : 'text-zinc-600 hover:bg-zinc-100'
                )}
              >
                {t}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={onPickTemplate}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-zinc-200 bg-white hover:border-blue-400 text-xs font-medium text-zinc-700 cursor-pointer"
          >
            <Upload className="w-3.5 h-3.5 text-blue-600" />
            <span>本地模板 (.pptx/.potx)</span>
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
          <button
            type="button"
            onClick={onPickTemplate}
            className="p-4 rounded-2xl border border-dashed border-zinc-300 bg-zinc-50/70 hover:bg-blue-50/40 hover:border-blue-400 text-center flex flex-col items-center justify-center gap-1.5 cursor-pointer transition-colors min-h-24"
          >
            <Upload className="w-4 h-4 text-blue-600" />
            <span className="text-xs font-medium text-zinc-800">选择本机 PPTX / POTX 模板</span>
            <span className="text-[10px] text-zinc-400">基于自有母版风格生成汇报文件</span>
          </button>

          {localPptTemplates.slice(0, 2).map((tpl) => (
            <button
              key={tpl.path}
              type="button"
              onClick={() => onSelectLocalTemplate(tpl)}
              className="group p-3.5 rounded-2xl border border-zinc-200 bg-white hover:border-blue-400 text-left flex flex-col justify-between gap-1.5 cursor-pointer min-h-24"
            >
              <span className="px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 text-[10px] font-medium w-fit">
                最近使用模板
              </span>
              <div className="text-xs font-semibold text-zinc-900 truncate group-hover:text-blue-600">
                {tpl.name}
              </div>
              <div className="text-[10px] text-zinc-400 truncate">{tpl.path}</div>
            </button>
          ))}

          {reportFeatures.map((rf) => (
            <button
              key={rf.featureCode}
              type="button"
              onClick={() => onOpenCatalogFeature(rf.featureCode)}
              className="group p-3.5 rounded-2xl border border-zinc-200 bg-white hover:border-blue-400 text-left flex flex-col gap-1.5 cursor-pointer min-h-24"
            >
              <div className="flex items-center justify-between text-[10px]">
                <span className="px-2 py-0.5 rounded bg-indigo-50 text-indigo-700 font-medium">
                  汇报工作流 · {rf.featureCode}
                </span>
                <Presentation className="w-3.5 h-3.5 text-zinc-400 group-hover:text-blue-600" />
              </div>
              <div className="text-xs font-semibold text-zinc-900 group-hover:text-blue-600">
                {rf.title}
              </div>
              <p className="text-[11px] text-zinc-500 line-clamp-2 leading-relaxed">
                {rf.description}
              </p>
            </button>
          ))}
        </div>
      </div>
    )
  }

  // regulation mode
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="flex items-center justify-between text-xs">
          <span className="font-medium text-zinc-700">试试这样问</span>
          <button
            type="button"
            onClick={() => setRegSeed((s) => (s + 3) % REG_PRESET_POOL.length)}
            className="inline-flex items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-900 cursor-pointer"
          >
            <RefreshCw className="w-3 h-3" />
            <span>换一换</span>
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
          {regCards.map((rc, i) => (
            <button
              key={i}
              type="button"
              onClick={() => onQuickPrompt(rc.q, '建筑规范检索与合规核查', false)}
              className="group p-3 rounded-xl border border-zinc-200/80 bg-zinc-50/70 hover:bg-white hover:border-blue-400 text-left cursor-pointer transition-all space-y-1"
            >
              <div className="text-[10px] text-zinc-400 font-medium">{rc.mode}</div>
              <div className="text-[11px] text-zinc-800 leading-relaxed line-clamp-2 group-hover:text-blue-600">
                {rc.q}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* 真实本地规范知识库统计卡片（只展示本机实际存在的文件与索引条文数） */}
      <div className="rounded-2xl border border-zinc-200 bg-zinc-50/60 p-4 space-y-2.5">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2 text-xs font-semibold text-zinc-900">
            <Compass className="w-4 h-4 text-teal-600" />
            <span>本地规范知识库</span>
          </div>
          <div className="flex items-center gap-2">
            {regulationStats?.folderPath && (
              <button
                type="button"
                onClick={() => void window.zmo.shell.openPath(regulationStats.folderPath)}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-zinc-200 bg-white text-[11px] text-zinc-700 hover:bg-zinc-50 cursor-pointer"
              >
                <FolderOpen className="w-3 h-3" />
                <span>打开规范目录</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                onOpenRegulationSettings()
                onRefreshRegulationStats()
              }}
              className="px-2.5 py-1 rounded-lg border border-zinc-200 bg-white text-[11px] text-blue-600 hover:bg-blue-50 cursor-pointer"
            >
              设置目录
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs">
          <div className="rounded-xl bg-white border border-zinc-200/70 px-3 py-2">
            <div className="text-[10px] text-zinc-400">本地规范文件数</div>
            <div className="text-base font-semibold text-zinc-900 tabular-nums mt-0.5">
              {regulationStats?.fileCount ?? 0} 份
            </div>
          </div>
          <div className="rounded-xl bg-white border border-zinc-200/70 px-3 py-2">
            <div className="text-[10px] text-zinc-400">已收录 JSON 条文 / 文档</div>
            <div className="text-base font-semibold text-zinc-900 tabular-nums mt-0.5">
              {regulationStats?.chunkCount ?? 0} 项
            </div>
          </div>
          <div className="rounded-xl bg-white border border-zinc-200/70 px-3 py-2 col-span-2 sm:col-span-1">
            <div className="text-[10px] text-zinc-400">支持本地扩展格式</div>
            <div className="text-[11px] text-zinc-700 font-mono mt-1">.json / .md / .txt / .pdf</div>
          </div>
        </div>

        {regulationStats && regulationStats.sampleFiles.length > 0 && (
          <div className="flex flex-wrap gap-1.5 pt-0.5">
            {regulationStats.sampleFiles.map((fname) => (
              <span
                key={fname}
                className="px-2 py-0.5 rounded-md bg-white border border-zinc-200 text-[10px] text-zinc-600"
              >
                {fname}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
