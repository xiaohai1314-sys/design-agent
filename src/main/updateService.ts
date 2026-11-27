// 自动更新：查版本、按用户确认下载、退出后安装。
// main 进程持有唯一状态，界面通过 updates:changed 拿快照。
import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateInfo, ProgressInfo } from 'electron-updater'
import type { UpdateState } from '@shared/protocol'

const AUTO_CHECK_DELAY_MS = 15_000

/** electron-updater 的 releaseNotes 可能是字符串，也可能是按版本拆的数组 */
function notesToText(info: UpdateInfo): string | undefined {
  const notes = info.releaseNotes
  if (!notes) return undefined
  if (typeof notes === 'string') return notes.trim() || undefined
  const text = notes
    .map((n) => (typeof n === 'string' ? n : n.note ?? ''))
    .join('\n')
    .trim()
  return text || undefined
}

export class UpdateService {
  private state: UpdateState
  private readonly listeners = new Set<(state: UpdateState) => void>()
  private autoCheckTimer: NodeJS.Timeout | null = null
  /** 启动时那次自动检查：失败不弹错，用户没主动要 */
  private silentCheck = false
  private wired = false

  constructor() {
    this.state = {
      status: app.isPackaged ? 'idle' : 'disabled',
      currentVersion: app.getVersion()
    }
    if (!app.isPackaged) return
    this.wire()
  }

  private wire(): void {
    // 不在后台偷偷拉：安装包几百 MB，等用户点
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = true

    autoUpdater.on('checking-for-update', () => this.set({ status: 'checking', error: undefined }))
    autoUpdater.on('update-available', (info) => {
      this.silentCheck = false
      this.set({
        status: 'available',
        version: info.version,
        releaseNotes: notesToText(info),
        error: undefined
      })
    })
    autoUpdater.on('update-not-available', () => {
      this.silentCheck = false
      this.set({ status: 'up-to-date', version: undefined, error: undefined })
    })
    autoUpdater.on('download-progress', (p: ProgressInfo) =>
      this.set({
        status: 'downloading',
        percent: p.percent,
        bytesPerSecond: p.bytesPerSecond,
        transferred: p.transferred,
        total: p.total
      })
    )
    autoUpdater.on('update-downloaded', (info) =>
      this.set({ status: 'downloaded', version: info.version, percent: 100, error: undefined })
    )
    autoUpdater.on('error', (err) => {
      if (this.silentCheck) {
        this.silentCheck = false
        this.set({ status: 'idle', error: undefined })
        return
      }
      this.set({ status: 'error', error: err?.message ?? String(err) })
    })
    this.wired = true
  }

  private set(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch }
    const snapshot = this.getState()
    for (const cb of this.listeners) {
      try {
        cb(snapshot)
      } catch {
        // 单个监听器出错不影响其他窗口
      }
    }
  }

  getState(): UpdateState {
    return { ...this.state }
  }

  onChange(cb: (state: UpdateState) => void): () => void {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  async check(options: { silent?: boolean } = {}): Promise<UpdateState> {
    if (!this.wired) return this.getState()
    if (this.state.status === 'downloading') return this.getState()
    // 用局部变量判断：error 事件可能先把 silentCheck 清掉，catch 里再读就变成 false 了
    const silent = options.silent === true
    this.silentCheck = silent
    try {
      await autoUpdater.checkForUpdates()
    } catch (error) {
      if (silent) {
        this.silentCheck = false
        this.set({ status: 'idle', error: undefined })
      } else {
        this.set({ status: 'error', error: error instanceof Error ? error.message : String(error) })
      }
    }
    return this.getState()
  }

  async download(): Promise<UpdateState> {
    if (!this.wired || this.state.status !== 'available') return this.getState()
    this.set({ status: 'downloading', percent: 0, transferred: 0, error: undefined })
    try {
      await autoUpdater.downloadUpdate()
    } catch (error) {
      this.set({ status: 'error', error: error instanceof Error ? error.message : String(error) })
    }
    return this.getState()
  }

  install(): void {
    if (!this.wired || this.state.status !== 'downloaded') return
    // 第二个参数为 true：装完直接拉起新版本
    autoUpdater.quitAndInstall(false, true)
  }

  /** 启动后延迟一会儿再查，别和窗口创建抢带宽和主线程 */
  startAutoCheck(delayMs = AUTO_CHECK_DELAY_MS): void {
    if (!this.wired || this.autoCheckTimer) return
    this.autoCheckTimer = setTimeout(() => {
      this.autoCheckTimer = null
      void this.check({ silent: true })
    }, delayMs)
    this.autoCheckTimer.unref?.()
  }

  dispose(): void {
    if (this.autoCheckTimer) {
      clearTimeout(this.autoCheckTimer)
      this.autoCheckTimer = null
    }
    this.listeners.clear()
  }
}
