import { FolderOpen, Import, LoaderCircle, Search } from 'lucide-react'
import clsx from 'clsx'
import type { ClipModelStatus, InspirationRebuildResult } from '@shared/protocol'
import type { ModelSettingsState } from '@shared/ipc'

export interface RegulationTabProps {
  draft: ModelSettingsState
  setDraft: (draft: ModelSettingsState) => void
  clipStatus: ClipModelStatus | null
  clipDownloading: boolean
  clipDownloadPct: number
  clipError: string | null
  rebuilding: boolean
  rebuildProgress: string
  rebuildResult: InspirationRebuildResult | null
  onPickRegulationFolder: () => void
  onPickInspirationFolder: () => void
  onPickClipModelDir: () => void
  onDownloadClipModel: () => void
  onRebuildIndex: () => void
}

/** 设置 → 本地规范知识库 / 灵感素材库 / 向量模型 */
export function RegulationTab({
  draft,
  setDraft,
  clipStatus,
  clipDownloading,
  clipDownloadPct,
  clipError,
  rebuilding,
  rebuildProgress,
  rebuildResult,
  onPickRegulationFolder,
  onPickInspirationFolder,
  onPickClipModelDir,
  onDownloadClipModel,
  onRebuildIndex
}: RegulationTabProps): React.JSX.Element {
  return (
    <div className="flex-1 p-6 space-y-4 overflow-y-auto text-xs">
      <div className="p-3.5 rounded-xl bg-emerald-50/70 border border-emerald-100 text-emerald-900 leading-relaxed">
        内置 <code className="font-mono">retrieve_regulation_chunks</code> 工具会检索您本机目录中的规范文档（支持{' '}
        <code className="font-mono">.pdf</code>、<code className="font-mono">.md</code>、
        <code className="font-mono">.txt</code> 及结构化 <code className="font-mono">.json</code>
        ），完全离线私有。已默认附带一份无障碍设计规范示例库。
      </div>

      <div>
        <label className="block font-medium text-zinc-700 mb-1.5">本地建筑规范库目录</label>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={draft.regulation?.folderPath ?? ''}
            onChange={(e) => setDraft({ ...draft, regulation: { folderPath: e.target.value } })}
            className="flex-1 px-3 py-2 rounded-lg border border-zinc-200 font-mono focus:border-blue-500 outline-none"
          />
          <button
            type="button"
            onClick={onPickRegulationFolder}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-zinc-300 bg-white hover:bg-zinc-50 text-zinc-700 cursor-pointer"
          >
            <FolderOpen className="w-3.5 h-3.5" />
            <span>浏览文件夹</span>
          </button>
        </div>
      </div>

      <div className="p-3.5 rounded-xl bg-violet-50/70 border border-violet-100 text-violet-900 leading-relaxed">
        内置 <code className="font-mono">search_inspiration</code> 工具（任务「搜索」）会检索该目录中的{' '}
        <code className="font-mono">inspiration-index.json</code> 统一索引：建筑参考图与生图配方、3D
        模型/贴图/HDRI 素材，本地不足时自动联网补充。索引只引用文件路径，素材本体不搬动。
      </div>

      <div>
        <label className="block font-medium text-zinc-700 mb-1.5">本地灵感 / 素材库目录</label>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={draft.inspiration?.folderPath ?? ''}
            onChange={(e) =>
              setDraft({
                ...draft,
                inspiration: { ...draft.inspiration, folderPath: e.target.value }
              })
            }
            className="flex-1 px-3 py-2 rounded-lg border border-zinc-200 font-mono focus:border-blue-500 outline-none"
          />
          <button
            type="button"
            onClick={onPickInspirationFolder}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-zinc-300 bg-white hover:bg-zinc-50 text-zinc-700 cursor-pointer"
          >
            <FolderOpen className="w-3.5 h-3.5" />
            <span>浏览文件夹</span>
          </button>
        </div>
      </div>

      <div className="p-3.5 rounded-xl border border-zinc-200 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <span className="font-semibold text-zinc-900">本地向量模型（语义检索 / 以图搜图）</span>
          <span className="text-zinc-500">
            {clipDownloading
              ? `下载中 ${clipDownloadPct}%`
              : clipStatus?.state === 'ready'
                ? `✅ 已就绪（${(clipStatus.sizeBytes / 1048576).toFixed(0)} MB）`
                : clipStatus?.state === 'downloading'
                  ? '下载中…'
                  : '未下载'}
          </span>
        </div>
        <p className="text-zinc-500 leading-relaxed">
          Chinese-CLIP ViT-B/16（约 377 MB，MIT 许可）不随安装包分发：首次使用时从 HuggingFace
          下载到下方目录，之后完全离线。模型就绪后「重建索引」会把图文向量写入索引，
          <code className="font-mono">search_inspiration</code>{' '}
          即可换说法语义召回、按参考图找相近图；未下载时检索自动退化为纯关键词，不影响使用。
        </p>
        <div>
          <label className="block font-medium text-zinc-700 mb-1.5">向量模型目录</label>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={draft.inspiration?.clipModelDir ?? ''}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  inspiration: { ...draft.inspiration, clipModelDir: e.target.value }
                })
              }
              className="flex-1 px-3 py-2 rounded-lg border border-zinc-200 font-mono focus:border-blue-500 outline-none"
            />
            <button
              type="button"
              onClick={onPickClipModelDir}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-zinc-300 bg-white hover:bg-zinc-50 text-zinc-700 cursor-pointer"
            >
              <FolderOpen className="w-3.5 h-3.5" />
              <span>浏览文件夹</span>
            </button>
          </div>
        </div>
        {clipDownloading && (
          <div className="h-1.5 rounded-full bg-zinc-100 overflow-hidden">
            <div
              className="h-full bg-violet-500 transition-all"
              style={{ width: `${clipDownloadPct}%` }}
            />
          </div>
        )}
        {clipError && (
          <div className="rounded-lg px-3 py-2 border bg-rose-50 border-rose-200 text-rose-800">
            ❌ 模型下载失败：{clipError}
          </div>
        )}
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={clipDownloading || clipStatus?.state === 'ready'}
            onClick={onDownloadClipModel}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-zinc-300 bg-white hover:bg-zinc-50 text-zinc-700 disabled:opacity-50 cursor-pointer"
          >
            {clipDownloading ? (
              <LoaderCircle className="w-3.5 h-3.5 animate-spin text-violet-600" />
            ) : (
              <Import className="w-3.5 h-3.5 text-violet-600" />
            )}
            <span>{clipDownloading ? '下载中…' : '下载向量模型'}</span>
          </button>
          <button
            type="button"
            disabled={rebuilding || !draft.inspiration?.folderPath?.trim()}
            onClick={onRebuildIndex}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-zinc-300 bg-white hover:bg-zinc-50 text-zinc-700 disabled:opacity-50 cursor-pointer"
          >
            {rebuilding ? (
              <LoaderCircle className="w-3.5 h-3.5 animate-spin text-violet-600" />
            ) : (
              <Search className="w-3.5 h-3.5 text-violet-600" />
            )}
            <span>{rebuilding ? '重建中…' : '重建索引'}</span>
          </button>
          {rebuilding && rebuildProgress && (
            <span className="text-zinc-500">{rebuildProgress}</span>
          )}
        </div>
        {rebuildResult && (
          <div
            className={clsx(
              'rounded-lg px-3 py-2 border',
              rebuildResult.ok
                ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                : 'bg-rose-50 border-rose-200 text-rose-800'
            )}
          >
            {rebuildResult.ok
              ? `✅ 索引已重建：共 ${rebuildResult.recordCount} 条（配方 ${rebuildResult.recipeCount} / 素材 ${rebuildResult.assetCount}），文本向量 ${rebuildResult.textVectorCount}、图像向量 ${rebuildResult.imageVectorCount}，耗时 ${(rebuildResult.elapsedMs / 1000).toFixed(1)}s${rebuildResult.vectorsComputed ? '' : `；未算向量：${rebuildResult.error ?? '模型未就绪'}`}${rebuildResult.errorCount > 0 ? `；另有 ${rebuildResult.errorCount} 条文件错误（详见索引服务日志）` : ''}`
              : `❌ 重建失败：${rebuildResult.error ?? '未知错误'}`}
          </div>
        )}
      </div>
    </div>
  )
}
