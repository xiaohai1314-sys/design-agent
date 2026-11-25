import React, { useEffect, useMemo, useState } from 'react'
import {
  ArrowLeft,
  ChevronDown,
  Compass,
  FileSpreadsheet,
  FileText,
  Paperclip,
  Presentation,
  Search,
  Send,
  Sparkles,
  Star,
  Upload,
  Wand2,
  X
} from 'lucide-react'
import clsx from 'clsx'
import type { AgentAttachment } from '@shared/protocol'
import {
  FEATURE_CATALOG,
  FEATURE_CATEGORIES,
  FEATURE_FORMS,
  composeFeatureSubmission,
  filterFeatures,
  getTodayWeekdayLabel,
  validateFeatureDraft,
  type FeatureCatalogItem,
  type FeatureFormDraft,
  type FeatureSubmission
} from '../features/taskForm/compose'

export interface ScenePresetParamDef {
  name: string
  options: string[]
  defaultValue: string
}

export interface SceneToolboxPreset {
  id: string
  category: string
  title: string
  desc: string
  prompt: string
  params: ScenePresetParamDef[]
}

export const TOOLBOX_PRESETS: SceneToolboxPreset[] = [
  {
    id: 'ai-scheme',
    category: '策划与方案',
    title: 'AI 空间方案策划',
    desc: '基于任务书、CAD 或现场资料完成功能分区、动线推敲与概念策划',
    prompt: '请帮我结合任务要求与本地资料，制定完整空间概念策划与平面动线布局方案。',
    params: [
      {
        name: '空间类型',
        options: ['茶室/会所', '商业展厅', '住宅客厅', '办公空间', '餐厅/咖啡'],
        defaultValue: '茶室/会所'
      },
      { name: '设计风格', options: ['新中式', '现代极简', '侘寂原木', '轻奢商业'], defaultValue: '新中式' },
      { name: '交付深度', options: ['概念策划', '深化清单', '汇报全案'], defaultValue: '概念策划' }
    ]
  },
  {
    id: 'ai-render',
    category: '效果图创作',
    title: '效果图生成 / 垫图精修',
    desc: '文生效果图或基于白模/手绘标注进行图生图局部改造与光影渲染',
    prompt: '请根据我指定的空间氛围与材质要求生成高清效果图，并支持后续圈选局部改图。',
    params: [
      {
        name: '出图阶段',
        options: ['文生概念图', '白模直出', '毛坯改造', '局部替换'],
        defaultValue: '文生概念图'
      },
      { name: '画幅比例', options: ['16:9 宽屏', '4:3 室内透视', '1:1 方图'], defaultValue: '16:9 宽屏' },
      { name: '光照时段', options: ['自然日光', '暖光夜景', '柔和漫射'], defaultValue: '自然日光' }
    ]
  },
  {
    id: 'cad-analysis',
    category: '图纸工程',
    title: 'CAD 图纸深度解析',
    desc: '提取 DWG/DXF 图层、图幅、门洞尺寸与轴网指标，配合右侧框选批注协同',
    prompt: '请读取工作区或附件中的 CAD 图纸，汇总空间功能指标、图层清单并排查尺寸与合规风险。',
    params: [
      {
        name: '关注重点',
        options: ['平面尺寸复核', '动线消防疏散', '无障碍设施核查', '家具与洁具布置'],
        defaultValue: '平面尺寸复核'
      },
      { name: '图元输出', options: ['结构化指标表', '批注修改清单'], defaultValue: '结构化指标表' }
    ]
  },
  {
    id: 'dcc-modeling',
    category: '三维联动',
    title: 'SketchUp / Blender 建模联动',
    desc: '通过本地 MCP 连接器直接驱动已打开的 SU/Blender/Rhino/3dsMax 生成模型体块',
    prompt: '请检查并连接本机三维建模连接器，按照目标尺度在当前场景构建基础墙体与空间体块。',
    params: [
      { name: '建模软件', options: ['SketchUp', 'Blender', 'Rhino', '3ds Max'], defaultValue: 'SketchUp' },
      { name: '精细程度', options: ['概念体块', '带家具软装', '渲染级材质灯光'], defaultValue: '概念体块' }
    ]
  },
  {
    id: 'ai-ppt',
    category: '汇报表达',
    title: '概念方案 PPT 策划生成',
    desc: '自动规划页面大纲、配齐概念意向图并生成可编辑 PPTX，支持工作台元素级局改',
    prompt: '请帮我策划并制作一套可编辑概念汇报 PPTX（16:9），图文混排并交付到成果区。',
    params: [
      { name: '汇报页数', options: ['8-10 页精简', '12-16 页完整', '20+ 页全案'], defaultValue: '12-16 页完整' },
      { name: '版式基调', options: ['素雅留白', '深色高级感', '东方园林温润'], defaultValue: '素雅留白' }
    ]
  },
  {
    id: 'reg-check',
    category: '合规依据',
    title: '建筑规范检索与合规核查',
    desc: '检索本地国标/地标条文库（支持 PDF/MD/JSON），输出带条号与适用条件的权威依据',
    prompt: '请严格阅读 regulation-consultation 技能并检索本地规范知识库，逐条核对以下强制要求：',
    params: [
      { name: '规范层级', options: ['国标+地方对比', '仅查强制性条文', '无障碍专项'], defaultValue: '国标+地方对比' }
    ]
  }
]

const CATEGORY_STYLE: Record<string, { badge: string; icon: React.FC<{ className?: string }> }> = {
  策划: { badge: 'bg-sky-50 text-sky-700 border-sky-200/70', icon: Compass },
  概念方案: { badge: 'bg-indigo-50 text-indigo-700 border-indigo-200/70', icon: Sparkles },
  深化建模: { badge: 'bg-violet-50 text-violet-700 border-violet-200/70', icon: FileSpreadsheet },
  生图: { badge: 'bg-amber-50 text-amber-700 border-amber-200/70', icon: Wand2 },
  汇报: { badge: 'bg-emerald-50 text-emerald-700 border-emerald-200/70', icon: Presentation },
  施工: { badge: 'bg-orange-50 text-orange-700 border-orange-200/70', icon: FileText },
  评审: { badge: 'bg-rose-50 text-rose-700 border-rose-200/70', icon: FileText },
  检索: { badge: 'bg-teal-50 text-teal-700 border-teal-200/70', icon: Search }
}

export const FunctionToolChips: React.FC<{
  preset: SceneToolboxPreset
  paramValues: Record<string, string>
  onChangeParam: (name: string, val: string) => void
  onClear: () => void
}> = ({ preset, paramValues, onChangeParam, onClear }) => {
  const [openKey, setOpenKey] = useState<string | null>(null)

  return (
    <div className="flex items-center gap-1 flex-wrap py-1">
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-blue-600 text-white text-[11px] font-medium">
        <span>{preset.title}</span>
        <button
          type="button"
          onClick={onClear}
          title="退出场景工具"
          className="hover:text-blue-200 cursor-pointer"
        >
          <X className="w-3 h-3" />
        </button>
      </span>

      {preset.params.map((p) => {
        const cur = paramValues[p.name] || p.defaultValue
        const isOpen = openKey === p.name
        return (
          <div key={p.name} className="relative">
            <button
              type="button"
              onClick={() => setOpenKey(isOpen ? null : p.name)}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg border border-blue-200 bg-blue-50/70 text-[11px] text-blue-900 hover:bg-blue-100 cursor-pointer"
            >
              <span className="text-blue-500">{p.name}:</span>
              <span className="font-medium">{cur}</span>
              <ChevronDown className="w-3 h-3 text-blue-400" />
            </button>

            {isOpen && (
              <>
                <div className="fixed inset-0 z-30" onClick={() => setOpenKey(null)} />
                <div className="absolute left-0 bottom-7 z-40 min-w-32 rounded-xl border border-zinc-200 bg-white shadow-xl p-1 space-y-0.5">
                  {p.options.map((opt) => (
                    <button
                      key={opt}
                      type="button"
                      onClick={() => {
                        onChangeParam(p.name, opt)
                        setOpenKey(null)
                      }}
                      className={clsx(
                        'w-full px-2.5 py-1 rounded-lg text-left text-[11px] cursor-pointer',
                        cur === opt
                          ? 'bg-blue-50 text-blue-700 font-semibold'
                          : 'text-zinc-700 hover:bg-zinc-100'
                      )}
                    >
                      {opt}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )
      })}
    </div>
  )
}

interface ToolboxPanelProps {
  initialFeatureCode?: string | null
  onClearInitialFeature?: () => void
  onSubmitFeature: (submission: FeatureSubmission) => Promise<void>
  onFillComposer: (submission: FeatureSubmission) => Promise<void>
}

export const ToolboxPanel: React.FC<ToolboxPanelProps> = ({
  initialFeatureCode,
  onClearInitialFeature,
  onSubmitFeature,
  onFillComposer
}) => {
  const [category, setCategory] = useState<string>('全部')
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedFeature, setSelectedFeature] = useState<FeatureCatalogItem | null>(null)
  const [draft, setDraft] = useState<FeatureFormDraft>({ fields: {} })
  const [missingCodes, setMissingCodes] = useState<string[]>([])
  const [submitting, setSubmitting] = useState(false)

  const todayLabel = useMemo(() => getTodayWeekdayLabel(), [])

  useEffect(() => {
    if (!initialFeatureCode) return
    const found = FEATURE_CATALOG.find((f) => f.featureCode === initialFeatureCode)
    if (found) {
      setSelectedFeature(found)
      setDraft({ fields: {} })
      setMissingCodes([])
    }
    onClearInitialFeature?.()
  }, [initialFeatureCode, onClearInitialFeature])

  const openFeatureForm = (feature: FeatureCatalogItem): void => {
    setSelectedFeature(feature)
    setDraft({ fields: {} })
    setMissingCodes([])
  }

  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = { 全部: FEATURE_CATALOG.length, 推荐: 0 }
    for (const item of FEATURE_CATALOG) {
      if (item.recommendTab) counts['推荐'] = (counts['推荐'] ?? 0) + 1
      counts[item.category] = (counts[item.category] ?? 0) + 1
    }
    return counts
  }, [])

  const filtered = useMemo(
    () => filterFeatures(FEATURE_CATALOG, category, searchQuery),
    [category, searchQuery]
  )

  if (selectedFeature) {
    const fields = [...(FEATURE_FORMS[selectedFeature.featureCode]?.fields ?? [])].sort(
      (a, b) => a.order - b.order
    )
    const style = CATEGORY_STYLE[selectedFeature.category] ?? CATEGORY_STYLE['策划']
    const Icon = style.icon

    const updateFieldText = (code: string, text: string): void => {
      setDraft((prev) => ({
        fields: {
          ...prev.fields,
          [code]: {
            text,
            attachments: prev.fields[code]?.attachments ?? []
          }
        }
      }))
      setMissingCodes((prev) => prev.filter((c) => c !== code))
    }

    const pickFieldFiles = async (code: string): Promise<void> => {
      const picked = await window.zmo.agent.pickFiles()
      if (picked.length === 0) return
      setDraft((prev) => {
        const curFiles = prev.fields[code]?.attachments ?? []
        const seen = new Set(curFiles.map((a) => a.path))
        const nextFiles: AgentAttachment[] = [...curFiles, ...picked.filter((p) => !seen.has(p.path))]
        return {
          fields: {
            ...prev.fields,
            [code]: {
              text: prev.fields[code]?.text ?? '',
              attachments: nextFiles
            }
          }
        }
      })
      setMissingCodes((prev) => prev.filter((c) => c !== code))
    }

    const removeFieldFile = (code: string, path: string): void => {
      setDraft((prev) => {
        const cur = prev.fields[code]
        if (!cur) return prev
        return {
          fields: {
            ...prev.fields,
            [code]: {
              ...cur,
              attachments: cur.attachments.filter((a) => a.path !== path)
            }
          }
        }
      })
    }

    const handleFormAction = async (mode: 'submit' | 'fill'): Promise<void> => {
      const missing = validateFeatureDraft(fields, draft)
      if (missing.length > 0) {
        setMissingCodes(missing)
        return
      }
      const submission = composeFeatureSubmission(selectedFeature, fields, draft)
      setSubmitting(true)
      try {
        if (mode === 'submit') {
          await onSubmitFeature(submission)
        } else {
          await onFillComposer(submission)
        }
      } finally {
        setSubmitting(false)
      }
    }

    return (
      <div className="flex-1 overflow-y-auto px-6 py-6 bg-white">
        <div className="max-w-3xl mx-auto space-y-5">
          <button
            type="button"
            onClick={() => setSelectedFeature(null)}
            className="inline-flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-900 cursor-pointer"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>返回 43 项任务目录</span>
          </button>

          <div className="rounded-2xl border border-zinc-200 bg-zinc-50/70 p-4 flex items-start justify-between gap-4">
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <span className={clsx('px-2 py-0.5 rounded-md border text-[11px] font-medium', style.badge)}>
                  {selectedFeature.category}
                </span>
                <span className="text-[11px] font-mono text-zinc-400">
                  {selectedFeature.featureCode}
                </span>
                {selectedFeature.todayRecommend === todayLabel && (
                  <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-amber-100 text-[10px] font-medium text-amber-800">
                    <Star className="w-2.5 h-2.5 fill-amber-500 text-amber-500" />
                    今日推荐
                  </span>
                )}
              </div>
              <h2 className="text-base font-semibold text-zinc-900">{selectedFeature.title}</h2>
              <p className="text-xs text-zinc-600 leading-relaxed">{selectedFeature.description}</p>
            </div>
            <div className="w-10 h-10 rounded-xl bg-white border border-zinc-200 flex items-center justify-center shrink-0">
              <Icon className="w-5 h-5 text-blue-600" />
            </div>
          </div>

          <div className="space-y-4">
            {fields.map((field) => {
              const fd = draft.fields[field.code] ?? { text: '', attachments: [] }
              const isMissing = missingCodes.includes(field.code)
              return (
                <div
                  key={field.code}
                  className={clsx(
                    'rounded-2xl border p-4 space-y-2.5 transition-colors bg-white',
                    isMissing ? 'border-rose-400 bg-rose-50/20' : 'border-zinc-200'
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <label className="text-xs font-semibold text-zinc-900 flex items-center gap-1.5">
                      <span>{field.label}</span>
                      {field.required ? (
                        <span className="text-rose-500 font-normal text-[11px]">* 必填</span>
                      ) : (
                        <span className="text-zinc-400 font-normal text-[11px]">(选填)</span>
                      )}
                    </label>
                    <span className="text-[10px] text-zinc-400">
                      {field.widget === 'file'
                        ? '上传图纸/图片/文档'
                        : field.widget === 'textFile'
                          ? '文字说明或附件二选一（也可同时提供）'
                          : '文字要求'}
                    </span>
                  </div>

                  {field.widget !== 'file' && (
                    <textarea
                      rows={field.required ? 3 : 2}
                      value={fd.text}
                      onChange={(e) => updateFieldText(field.code, e.target.value)}
                      placeholder={field.placeholder || `请输入${field.label}…`}
                      className="w-full rounded-xl border border-zinc-200 bg-zinc-50/50 px-3 py-2 text-xs text-zinc-900 placeholder:text-zinc-400 focus:bg-white focus:border-blue-500 outline-none resize-y leading-relaxed"
                    />
                  )}

                  {field.widget !== 'text' && (
                    <div className="space-y-2">
                      <button
                        type="button"
                        onClick={() => void pickFieldFiles(field.code)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-dashed border-zinc-300 bg-zinc-50 hover:bg-zinc-100 hover:border-zinc-400 text-xs text-zinc-700 cursor-pointer transition-colors"
                      >
                        <Upload className="w-3.5 h-3.5 text-blue-600" />
                        <span>选择本机文件 / 图纸 / 图片…</span>
                      </button>

                      {fd.attachments.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                          {fd.attachments.map((att) => (
                            <span
                              key={att.path}
                              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-zinc-200 bg-zinc-50 text-[11px] text-zinc-800"
                            >
                              <Paperclip className="w-3 h-3 text-zinc-400" />
                              <span className="max-w-52 truncate">{att.name}</span>
                              <button
                                type="button"
                                onClick={() => removeFieldFile(field.code, att.path)}
                                className="text-zinc-400 hover:text-rose-600 cursor-pointer"
                              >
                                <X className="w-3 h-3" />
                              </button>
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {isMissing && (
                    <div className="text-[11px] text-rose-600">
                      {field.widget === 'file'
                        ? `请先上传「${field.label}」相关文件`
                        : field.widget === 'textFile'
                          ? `请填写说明文字或上传「${field.label}」附件`
                          : `请填写「${field.label}」`}
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          <div className="flex items-center justify-end gap-2.5 pt-2 pb-6">
            <button
              type="button"
              disabled={submitting}
              onClick={() => void handleFormAction('fill')}
              className="px-4 py-2 rounded-xl border border-zinc-200 bg-white text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 cursor-pointer"
            >
              填入对话输入框微调
            </button>
            <button
              type="button"
              disabled={submitting}
              onClick={() => void handleFormAction('submit')}
              className="inline-flex items-center gap-1.5 px-5 py-2 rounded-xl bg-zinc-900 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50 cursor-pointer"
            >
              <Send className="w-3.5 h-3.5" />
              <span>{submitting ? '创建并发送中…' : '创建新任务并立即执行'}</span>
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto px-6 py-6 bg-white">
      <div className="max-w-5xl mx-auto space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold text-zinc-900">
              AI 空间设计任务目录（{FEATURE_CATALOG.length} 项专业工作流）
            </h1>
            <p className="text-xs text-zinc-500 mt-0.5">
              按建筑/室内/景观全阶段划分 8 大品类，选中任务卡片后填写结构化表单即可一键发起分析、出图、建模或汇报
            </p>
          </div>

          <div className="relative w-full sm:w-72 shrink-0">
            <Search className="w-3.5 h-3.5 text-zinc-400 absolute left-3 top-2.5" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索任务或别名（如：白模、CAD、规范）"
              className="w-full pl-8 pr-7 py-2 rounded-xl border border-zinc-200 bg-zinc-50/70 focus:bg-white focus:border-blue-500 text-xs outline-none"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="absolute right-2.5 top-2.5 text-zinc-400 hover:text-zinc-700 cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* 8 大分类 + 推荐页签 */}
        <div className="flex items-center gap-1.5 flex-wrap">
          {FEATURE_CATEGORIES.map((cat) => {
            const active = category === cat
            return (
              <button
                key={cat}
                type="button"
                onClick={() => setCategory(cat)}
                className={clsx(
                  'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors cursor-pointer border',
                  active
                    ? 'bg-zinc-900 text-white border-zinc-900'
                    : 'bg-white text-zinc-600 border-zinc-200 hover:border-zinc-300 hover:text-zinc-900'
                )}
              >
                <span>{cat}</span>
                <span
                  className={clsx(
                    'text-[10px] tabular-nums',
                    active ? 'text-zinc-300' : 'text-zinc-400'
                  )}
                >
                  {categoryCounts[cat] ?? 0}
                </span>
              </button>
            )
          })}
        </div>

        {/* 43 任务卡片网格 */}
        {filtered.length === 0 ? (
          <div className="py-16 text-center text-xs text-zinc-400 border border-dashed border-zinc-200 rounded-2xl">
            未找到匹配「{searchQuery}」的任务卡片，请尝试更换关键词或切换到「全部」。
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3.5 pb-6">
            {filtered.map((item) => {
              const style = CATEGORY_STYLE[item.category] ?? CATEGORY_STYLE['策划']
              const Icon = style.icon
              const fieldCount = FEATURE_FORMS[item.featureCode]?.fields?.length ?? 0
              const reqCount =
                FEATURE_FORMS[item.featureCode]?.fields?.filter((f) => f.required).length ?? 0
              const isToday = item.todayRecommend === todayLabel
              return (
                <button
                  key={item.featureCode}
                  type="button"
                  onClick={() => openFeatureForm(item)}
                  className="group p-4 rounded-2xl border border-zinc-200/90 bg-white text-left hover:border-blue-400 hover:shadow-md transition-all cursor-pointer flex flex-col gap-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5">
                      <span
                        className={clsx(
                          'px-2 py-0.5 rounded-md border text-[10px] font-medium',
                          style.badge
                        )}
                      >
                        {item.category}
                      </span>
                      <span className="text-[10px] font-mono text-zinc-400">
                        {item.featureCode}
                      </span>
                    </div>
                    <div className="flex items-center gap-1">
                      {isToday && (
                        <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-amber-50 text-[10px] font-medium text-amber-700 border border-amber-200/60">
                          <Star className="w-2.5 h-2.5 fill-amber-500 text-amber-500" />
                          今日
                        </span>
                      )}
                      <Icon className="w-4 h-4 text-zinc-400 group-hover:text-blue-600 transition-colors" />
                    </div>
                  </div>

                  <div className="text-[13px] font-semibold text-zinc-900 group-hover:text-blue-600 transition-colors">
                    {item.title}
                  </div>
                  <p className="text-[11px] text-zinc-500 leading-relaxed flex-1 line-clamp-2">
                    {item.description}
                  </p>

                  <div className="flex items-center justify-between gap-2 pt-1.5 border-t border-zinc-100">
                    <div className="flex flex-wrap gap-1 min-w-0">
                      {item.searchAlias.slice(0, 2).map((alias) => (
                        <span
                          key={alias}
                          className="px-1.5 py-0.5 rounded bg-zinc-100 text-[10px] text-zinc-500 truncate max-w-24"
                        >
                          {alias}
                        </span>
                      ))}
                    </div>
                    <span className="text-[10px] text-zinc-400 shrink-0">
                      {reqCount}/{fieldCount} 项必填
                    </span>
                  </div>
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
