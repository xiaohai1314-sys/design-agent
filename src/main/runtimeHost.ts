import { utilityProcess, type UtilityProcess } from 'electron'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { RuntimeInbound, RuntimeMcpServerSpec, RuntimeOutbound } from '@shared/protocol'

export class AgentRuntimeHost extends EventEmitter {
  private child: UtilityProcess | null = null
  private ready = false
  private queue: RuntimeInbound[] = []
  private disposing = false
  private pendingMcpChecks = new Map<
    string,
    (res: { ok: boolean; toolCount?: number; reason?: string }) => void
  >()

  constructor(
    private readonly options: {
      skillsRoot: string
      presetsRoot: string
      workspacesDir: string
      runtimeDir: string
    }
  ) {
    super()
  }

  ensureStarted(): void {
    if (this.child || this.disposing) return
    const runtimeEntry = join(__dirname, 'runtime.js')
    const proc = utilityProcess.fork(runtimeEntry, [], {
      serviceName: 'design-agent-runtime',
      stdio: 'pipe',
      env: {
        ...process.env,
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
        DESIGN_AGENT_SKILLS_ROOT: this.options.skillsRoot,
        DESIGN_AGENT_PRESETS_ROOT: this.options.presetsRoot,
        DESIGN_AGENT_WORKSPACES_DIR: this.options.workspacesDir,
        DESIGN_AGENT_RT_DIR: this.options.runtimeDir
      }
    })

    this.child = proc
    this.ready = false

    proc.stdout?.on('data', (chunk: Buffer) => {
      process.stdout.write(`[runtime] ${chunk.toString('utf8')}`)
    })
    proc.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(`[runtime:err] ${chunk.toString('utf8')}`)
    })

    proc.on('message', (data: unknown) => {
      const msg = data as RuntimeOutbound
      if (!msg || typeof msg !== 'object') return
      if (msg.type === 'ready') {
        this.ready = true
        while (this.queue.length > 0) {
          const next = this.queue.shift()!
          proc.postMessage(next)
        }
        return
      }
      if (msg.type === 'mcp_check_done') {
        const cb = this.pendingMcpChecks.get(msg.requestId)
        if (cb) {
          this.pendingMcpChecks.delete(msg.requestId)
          cb({ ok: msg.ok, toolCount: msg.toolCount, reason: msg.reason })
        }
        return
      }
      this.emit('outbound', msg)
    })

    proc.on('exit', (code) => {
      if (this.child === proc) {
        this.child = null
        this.ready = false
      }
      // 进程退出后，等待中的连接检测不会再有回音，直接以失败结束
      for (const [id, cb] of this.pendingMcpChecks) {
        this.pendingMcpChecks.delete(id)
        cb({ ok: false, reason: '智能体进程已退出' })
      }
      if (!this.disposing) {
        console.warn(`[main] agent-runtime exited with code ${code}, will respawn on next message.`)
        // R5：通知主进程把仍在运行中的任务标记为中断，避免界面一直停在“运行中”
        this.emit('crashed', code)
      }
    })
  }

  send(msg: RuntimeInbound): void {
    this.ensureStarted()
    if (this.child && this.ready) {
      this.child.postMessage(msg)
    } else {
      this.queue.push(msg)
    }
  }

  checkMcpServer(spec: RuntimeMcpServerSpec): Promise<{ ok: boolean; toolCount?: number; reason?: string }> {
    const requestId = randomUUID()
    return new Promise((resolveCheck) => {
      const timer = setTimeout(() => {
        this.pendingMcpChecks.delete(requestId)
        resolveCheck({ ok: false, reason: '检测连接超时' })
      }, 15000)
      this.pendingMcpChecks.set(requestId, (res) => {
        clearTimeout(timer)
        resolveCheck(res)
      })
      this.send({ type: 'mcp_check', requestId, server: spec })
    })
  }

  dispose(): void {
    this.disposing = true
    if (this.child) {
      this.child.kill()
      this.child = null
    }
  }
}
