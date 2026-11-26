import { useEffect, useMemo, useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  Download,
  FolderOpen,
  Pause,
  Play,
  RotateCw,
  Trash2,
  X
} from 'lucide-react'
import type { DownloadTask } from '@shared/protocol'

const api = () => window.designAgent.downloads

function formatBytes(n: number): string {
  if (!n) return '—'
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${n} B`
}

const STATUS_LABEL: Record<DownloadTask['status'], string> = {
  queued: '排队中',
  downloading: '下载中',
  paused: '已暂停',
  success: '已完成',
  error: '失败'
}

export function DownloadCenter({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [tasks, setTasks] = useState<DownloadTask[]>([])
  const [adding, setAdding] = useState(false)
  const [url, setUrl] = useState('')
  const [dir, setDir] = useState('')
  const [fileName, setFileName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    void api().list().then((list) => {
      if (alive) setTasks(list)
    })
    const off = api().onChanged((list) => setTasks(list))
    return () => {
      alive = false
      off()
    }
  }, [])

  const activeCount = useMemo(
    () => tasks.filter((t) => t.status === 'downloading' || t.status === 'queued').length,
    [tasks]
  )

  const pickDir = async (): Promise<void> => {
    const picked = await api().pickDir()
    if (picked) setDir(picked)
  }

  const submit = async (): Promise<void> => {
    setError('')
    if (!/^https?:\/\//i.test(url.trim())) {
      setError('请填写 http / https 开头的下载地址')
      return
    }
    if (!dir.trim()) {
      setError('请先选择保存目录')
      return
    }
    setBusy(true)
    try {
      setTasks(await api().start({ url: url.trim(), destDir: dir.trim(), fileName: fileName.trim() || undefined }))
      setUrl('')
      setFileName('')
      setAdding(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/30 p-6 select-text">
      <div className="w-[720px] max-h-[80vh] flex flex-col rounded-2xl bg-white shadow-xl border border-zinc-200 overflow-hidden">
        <header className="flex items-center justify-between px-5 py-3 border-b border-zinc-200">
          <div className="flex items-center gap-2">
            <Download className="w-4 h-4 text-blue-600" />
            <h2 className="text-sm font-medium text-zinc-900">下载中心</h2>
            {activeCount > 0 && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-700">
                {activeCount} 个进行中
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setAdding((v) => !v)}
              className="px-2.5 py-1 rounded-lg text-[11px] bg-zinc-900 text-white hover:bg-zinc-700 cursor-pointer"
            >
              新建下载
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-1 rounded text-zinc-400 hover:text-zinc-800 hover:bg-zinc-100 cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </header>

        {adding && (
          <div className="px-5 py-3 border-b border-zinc-200 bg-zinc-50 space-y-2">
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="下载地址（http / https）"
              className="w-full px-2.5 py-1.5 rounded-lg border border-zinc-200 text-[11px] outline-none focus:border-zinc-400"
            />
            <div className="flex gap-2">
              <input
                value={dir}
                onChange={(e) => setDir(e.target.value)}
                placeholder="保存目录"
                className="flex-1 px-2.5 py-1.5 rounded-lg border border-zinc-200 text-[11px] outline-none focus:border-zinc-400"
              />
              <button
                type="button"
                onClick={() => void pickDir()}
                className="px-2.5 py-1.5 rounded-lg border border-zinc-200 text-[11px] text-zinc-600 hover:bg-white cursor-pointer"
              >
                选择目录
              </button>
            </div>
            <input
              value={fileName}
              onChange={(e) => setFileName(e.target.value)}
              placeholder="文件名（可选，默认从地址推导）"
              className="w-full px-2.5 py-1.5 rounded-lg border border-zinc-200 text-[11px] outline-none focus:border-zinc-400"
            />
            {error && <p className="text-[11px] text-red-600">{error}</p>}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setAdding(false)}
                className="px-2.5 py-1 rounded-lg text-[11px] text-zinc-600 hover:bg-zinc-200/60 cursor-pointer"
              >
                取消
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void submit()}
                className="px-3 py-1 rounded-lg text-[11px] bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50 cursor-pointer"
              >
                开始下载
              </button>
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto">
          {tasks.length === 0 ? (
            <div className="py-16 text-center text-[11px] text-zinc-400">
              还没有下载任务。点右上角「新建下载」添加一个地址。
            </div>
          ) : (
            <ul className="divide-y divide-zinc-100">
              {tasks.map((t) => {
                const ratio = t.totalBytes > 0 ? Math.min(1, t.receivedBytes / t.totalBytes) : 0
                return (
                  <li key={t.id} className="px-5 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          {t.status === 'success' && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />}
                          {t.status === 'error' && <AlertCircle className="w-3.5 h-3.5 text-red-600 shrink-0" />}
                          <span className="text-xs text-zinc-800 truncate">{t.name}</span>
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-100 text-zinc-500 shrink-0">
                            {STATUS_LABEL[t.status]}
                          </span>
                        </div>
                        <p className="mt-0.5 text-[10px] text-zinc-400 truncate" title={t.url}>
                          {t.url}
                        </p>
                        {t.status !== 'success' && (
                          <div className="mt-1.5 h-1 rounded-full bg-zinc-100 overflow-hidden">
                            <div
                              className={
                                t.status === 'error'
                                  ? 'h-full bg-red-400'
                                  : 'h-full bg-blue-500 transition-[width] duration-300'
                              }
                              style={{ width: `${Math.round(ratio * 100)}%` }}
                            />
                          </div>
                        )}
                        <p className="mt-1 text-[10px] text-zinc-400">
                          {formatBytes(t.receivedBytes)} / {formatBytes(t.totalBytes)}
                          {t.status === 'downloading' && t.speedBps > 0 && ` · ${formatBytes(t.speedBps)}/s`}
                          {t.error && ` · ${t.error}`}
                        </p>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        {t.status === 'downloading' && (
                          <IconButton title="暂停" onClick={() => void api().pause(t.id).then(setTasks)}>
                            <Pause className="w-3.5 h-3.5" />
                          </IconButton>
                        )}
                        {(t.status === 'paused' || t.status === 'error') && (
                          <IconButton
                            title={t.status === 'error' ? '重试' : '继续'}
                            onClick={() => void api().resume(t.id).then(setTasks)}
                          >
                            {t.status === 'error' ? <RotateCw className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                          </IconButton>
                        )}
                        {t.status === 'success' && (
                          <>
                            <IconButton title="打开文件" onClick={() => void api().openFile(t.id)}>
                              <Download className="w-3.5 h-3.5" />
                            </IconButton>
                            <IconButton title="在文件夹中显示" onClick={() => void api().openFolder(t.id)}>
                              <FolderOpen className="w-3.5 h-3.5" />
                            </IconButton>
                          </>
                        )}
                        <IconButton title="移除" onClick={() => void api().remove(t.id).then(setTasks)}>
                          <Trash2 className="w-3.5 h-3.5" />
                        </IconButton>
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}

function IconButton({
  title,
  onClick,
  children
}: {
  title: string
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-900 hover:bg-zinc-100 cursor-pointer"
    >
      {children}
    </button>
  )
}
