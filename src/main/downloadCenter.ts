import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { once } from 'node:events'
import { basename, dirname, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { DownloadStartRequest, DownloadTask } from '../shared/protocol'

const EMIT_INTERVAL = 300
const SPEED_WINDOW = 1000

/**
 * 下载中心：任务队列、断点续传、暂停/恢复、速度统计与持久化。
 * 只负责本地文件落盘，不做鉴权——调用方（主进程 handler）负责校验目标目录。
 */
export class DownloadCenter {
  private readonly tasks = new Map<string, DownloadTask>()
  private readonly aborts = new Map<string, AbortController>()
  private readonly listeners = new Set<(tasks: DownloadTask[]) => void>()
  private emitTimer: NodeJS.Timeout | null = null

  constructor(private readonly storePath: string) {
    this.restore()
  }

  onChange(cb: (tasks: DownloadTask[]) => void): () => void {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  list(): DownloadTask[] {
    return [...this.tasks.values()].sort((a, b) => b.createdAt - a.createdAt)
  }

  get(id: string): DownloadTask | undefined {
    return this.tasks.get(id)
  }

  start(req: DownloadStartRequest): DownloadTask[] {
    const url = (req.url ?? '').trim()
    if (!/^https?:\/\//i.test(url)) throw new Error('只支持 http / https 地址')
    const destDir = (req.destDir ?? '').trim()
    if (!destDir) throw new Error('未指定保存目录')
    mkdirSync(destDir, { recursive: true })

    const wanted = (req.fileName ?? '').trim() || deriveName(url)
    const destPath = uniquePath(destDir, wanted)
    const task: DownloadTask = {
      id: randomUUID(),
      name: basename(destPath),
      url,
      destPath,
      totalBytes: 0,
      receivedBytes: 0,
      speedBps: 0,
      status: 'queued',
      createdAt: Date.now()
    }
    this.tasks.set(task.id, task)
    this.emit()
    void this.run(task)
    return this.list()
  }

  pause(id: string): DownloadTask[] {
    const task = this.tasks.get(id)
    if (!task || task.status !== 'downloading') return this.list()
    this.aborts.get(id)?.abort()
    return this.list()
  }

  resume(id: string): DownloadTask[] {
    const task = this.tasks.get(id)
    if (!task) return this.list()
    if (task.status !== 'paused' && task.status !== 'error') return this.list()
    task.status = 'queued'
    task.error = undefined
    this.emit()
    void this.run(task)
    return this.list()
  }

  remove(id: string): DownloadTask[] {
    const task = this.tasks.get(id)
    if (!task) return this.list()
    this.aborts.get(id)?.abort()
    this.tasks.delete(id)
    try {
      rmSync(`${task.destPath}.part`, { force: true })
    } catch {
      // 忽略：可能已经被清理
    }
    this.emit()
    return this.list()
  }

  private async run(task: DownloadTask): Promise<void> {
    const part = `${task.destPath}.part`
    const ctrl = new AbortController()
    this.aborts.set(task.id, ctrl)
    task.status = 'downloading'
    task.error = undefined
    this.emit()

    let file: ReturnType<typeof createWriteStream> | null = null
    try {
      let offset = existsSync(part) ? statSync(part).size : 0
      const res = await fetch(task.url, {
        signal: ctrl.signal,
        redirect: 'follow',
        headers: offset > 0 ? { Range: `bytes=${offset}-` } : undefined
      })

      // 416：本地已有完整文件，直接进入收尾
      if (res.status === 416) {
        renameSync(part, task.destPath)
        this.finish(task)
        return
      }
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} ${res.statusText}`)

      // 服务端不支持续传时会退回 200，这时必须从头写
      if (offset > 0 && res.status !== 206) offset = 0
      const length = Number(res.headers.get('content-length') ?? 0)
      task.totalBytes = offset + length
      task.receivedBytes = offset

      file = createWriteStream(part, { flags: offset > 0 ? 'a' : 'w' })
      let lastTick = Date.now()
      let lastBytes = task.receivedBytes

      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        if (!file.write(chunk)) await once(file, 'drain')
        task.receivedBytes += chunk.length
        const now = Date.now()
        if (now - lastTick >= SPEED_WINDOW) {
          task.speedBps = Math.round(((task.receivedBytes - lastBytes) * 1000) / (now - lastTick))
          lastTick = now
          lastBytes = task.receivedBytes
        }
        this.emitThrottled()
      }

      await new Promise<void>((resolve, reject) => file!.end((err?: Error | null) => (err ? reject(err) : resolve())))
      file = null
      renameSync(part, task.destPath)
      this.finish(task)
    } catch (err) {
      if (file) {
        await new Promise<void>((resolve) => file!.close(() => resolve()))
      }
      if (ctrl.signal.aborted) {
        task.status = 'paused'
      } else {
        task.status = 'error'
        task.error = err instanceof Error ? err.message : String(err)
      }
    } finally {
      this.aborts.delete(task.id)
      task.speedBps = 0
      this.emit()
    }
  }

  private finish(task: DownloadTask): void {
    task.status = 'success'
    task.totalBytes = task.receivedBytes
    task.finishedAt = Date.now()
    task.error = undefined
  }

  private emitThrottled(): void {
    if (this.emitTimer) return
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null
      this.emit()
    }, EMIT_INTERVAL)
  }

  private emit(): void {
    const snapshot = this.list()
    for (const cb of this.listeners) {
      try {
        cb(snapshot)
      } catch {
        // 单个监听器出错不影响其他监听器
      }
    }
    this.persist(snapshot)
  }

  private persist(tasks: DownloadTask[]): void {
    try {
      mkdirSync(dirname(this.storePath), { recursive: true })
      writeFileSync(this.storePath, JSON.stringify(tasks, null, 2), 'utf8')
    } catch {
      // 持久化失败不应打断下载
    }
  }

  private restore(): void {
    if (!existsSync(this.storePath)) return
    try {
      const raw = JSON.parse(readFileSync(this.storePath, 'utf8')) as DownloadTask[]
      for (const t of raw) {
        // 上次退出时还在跑的，恢复成已暂停，由用户决定是否继续
        const status = t.status === 'downloading' || t.status === 'queued' ? 'paused' : t.status
        this.tasks.set(t.id, { ...t, status, speedBps: 0 })
      }
    } catch {
      // 文件损坏就当作空列表
    }
  }
}

function deriveName(url: string): string {
  try {
    const path = new URL(url).pathname
    const base = decodeURIComponent(basename(path))
    return base && base !== '/' ? base : `download-${Date.now()}`
  } catch {
    return `download-${Date.now()}`
  }
}

function uniquePath(dir: string, name: string): string {
  const ext = extname(name)
  const stem = name.slice(0, name.length - ext.length)
  let candidate = join(dir, name)
  let i = 1
  while (existsSync(candidate) || existsSync(`${candidate}.part`)) {
    candidate = join(dir, `${stem} (${i})${ext}`)
    i += 1
  }
  return candidate
}
