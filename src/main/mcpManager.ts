import { execFile } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { MCP_CONNECTOR_LABELS, MCP_CONNECTOR_REQUIREMENTS } from '@shared/mcp'
import type { McpConnectorInfo } from '@shared/ipc'
import type { RuntimeMcpServerSpec } from '@shared/protocol'

const HOST_PROCESS_NAMES: Record<string, string[]> = {
  sketchup: ['SketchUp.exe'],
  blender: ['blender.exe'],
  multicad: ['acad.exe', 'zwcad.exe', 'gcad.exe', 'bricscad.exe'],
  '3dsmax': ['3dsmax.exe'],
  rhino: ['Rhino.exe'],
  photoshop: ['Photoshop.exe'],
  'computer-use': []
}

interface RawMcpManifestServer {
  description?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  resolver?: string
  enabled?: boolean
}

export class McpConnectorManager {
  private readonly prefsPath: string
  private readonly localMcpRoot: string | null
  private readonly pythonExe: string
  private readonly nodeExe: string

  constructor(userDataDir: string, bundledResourcesDir: string) {
    this.prefsPath = join(userDataDir, 'mcp-preferences.json')
    mkdirSync(dirname(this.prefsPath), { recursive: true })

    const appData = process.env.APPDATA ?? ''

    // 1. 优先使用项目独立内置的 resources/mcp，回退 AppData
    const bundledMcp = join(bundledResourcesDir, 'mcp')
    const appDataMcp = join(appData, '@design-agent', 'agent-desktop', 'agent-runtime', 'mcp')
    this.localMcpRoot = existsSync(bundledMcp) ? bundledMcp : existsSync(appDataMcp) ? appDataMcp : null

    // 2. 优先使用项目独立内置的 resources/runtime，回退 AppData 或系统环境
    const rtCandidatesPy = [
      join(bundledResourcesDir, 'runtime', 'python', 'python.exe'),
      join(appData, '@design-agent', 'agent-desktop', 'agent-runtime', 'python', 'python.exe'),
      join(appData, '@design-agent', 'agent-desktop', 'agent-runtime', 'runtime', 'python', 'python.exe')
    ]
    this.pythonExe = rtCandidatesPy.find((p) => existsSync(p)) ?? 'python'

    const rtCandidatesNode = [
      join(bundledResourcesDir, 'runtime', 'node', 'node.exe'),
      join(appData, '@design-agent', 'agent-desktop', 'agent-runtime', 'node', 'node.exe'),
      join(appData, '@design-agent', 'agent-desktop', 'agent-runtime', 'runtime', 'node', 'node.exe')
    ]
    this.nodeExe = rtCandidatesNode.find((p) => existsSync(p)) ?? process.execPath
  }

  private loadUserPrefs(): Record<string, boolean> {
    try {
      if (!existsSync(this.prefsPath)) return {}
      return JSON.parse(readFileSync(this.prefsPath, 'utf8')) as Record<string, boolean>
    } catch {
      return {}
    }
  }

  private saveUserPrefs(prefs: Record<string, boolean>): void {
    writeFileSync(this.prefsPath, JSON.stringify(prefs, null, 2), 'utf8')
  }

  private loadManifestServers(): Record<string, RawMcpManifestServer> {
    if (!this.localMcpRoot) return {}
    const manifestFile = join(this.localMcpRoot, 'mcp.json')
    if (!existsSync(manifestFile)) return {}
    try {
      const parsed = JSON.parse(readFileSync(manifestFile, 'utf8')) as {
        servers?: Record<string, RawMcpManifestServer>
      }
      return parsed.servers ?? {}
    } catch {
      return {}
    }
  }

  private async queryRunningProcesses(): Promise<Set<string>> {
    if (process.platform !== 'win32') return new Set()
    return await new Promise<Set<string>>((resolveSet) => {
      execFile(
        'tasklist.exe',
        ['/NH', '/FO', 'CSV'],
        { timeout: 5000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout) => {
          if (err || !stdout) {
            resolveSet(new Set())
            return
          }
          const names = new Set<string>()
          for (const line of stdout.split(/\r?\n/)) {
            const m = /^"([^"]+)"/.exec(line.trim())
            if (m) names.add(m[1].toLowerCase())
          }
          resolveSet(names)
        }
      )
    })
  }

  /** 对齐原版 agent-runtime npt()：探测本机 Rhino Yak 包里的 rhino-mcp-router.exe */
  private findRhinoRouterExe(): string | null {
    const appData = process.env.APPDATA ?? ''
    if (!appData) return null
    const pkgRoot = join(appData, 'McNeel', 'Rhinoceros', 'packages')
    const arch = process.arch === 'arm64' ? 'win-arm64' : 'win-x64'
    for (const ver of ['9.0', '8.0']) {
      const platformDir = join(pkgRoot, ver, 'Rhino-MCP-Platform')
      if (!existsSync(platformDir)) continue
      try {
        const versions = readdirSync(platformDir).sort((a, b) =>
          b.localeCompare(a, undefined, { numeric: true })
        )
        for (const pv of versions) {
          const exe = join(platformDir, pv, 'router', arch, 'rhino-mcp-router.exe')
          if (existsSync(exe)) return exe
        }
      } catch {
        // ignore
      }
    }
    return null
  }

  /** 对齐原版 agent-runtime QAr()：探测本机 computer-use/cua-driver.exe */
  private findComputerUseExe(): string | null {
    if (!this.localMcpRoot) return null
    const exe = join(this.localMcpRoot, 'computer-use', 'cua-driver.exe')
    return existsSync(exe) ? exe : null
  }

  resolveServerSpec(name: string): RuntimeMcpServerSpec | null {
    const manifest = this.loadManifestServers()
    const raw = manifest[name]
    const label = MCP_CONNECTOR_LABELS[name] ?? name
    const description = raw?.description ?? `${label} 本地建模与设计软件连接器`

    if (name === 'rhino') {
      const routerExe = this.findRhinoRouterExe()
      if (!routerExe) return null
      return {
        name,
        label,
        description,
        command: routerExe,
        args: []
      }
    }

    if (name === 'computer-use') {
      const driverExe = this.findComputerUseExe()
      if (!driverExe) return null
      return {
        name,
        label,
        description,
        command: driverExe,
        args: ['mcp'],
        env: { CUA_DRIVER_EMBEDDED: '1' }
      }
    }

    if (!this.localMcpRoot || !raw || !raw.command) return null
    const selfDir = join(this.localMcpRoot, name)
    if (!existsSync(selfDir)) return null

    const expandVars = (str: string): string =>
      str
        .replace(/\$\{MCP_PYTHON\}/g, this.pythonExe)
        .replace(/\$\{MCP_NODE\}/g, this.nodeExe)
        .replace(/\$\{SELF\}/g, selfDir)

    const command = expandVars(raw.command)
    const args = (raw.args ?? []).map(expandVars)
    const env: Record<string, string> = {}
    if (command === process.execPath) {
      env.ELECTRON_RUN_AS_NODE = '1'
    }
    for (const [k, v] of Object.entries(raw.env ?? {})) {
      env[k] = expandVars(v)
    }
    // 连接器自带的 pywin32 是便携布局，win32/lib 与 pywin32_system32 不在默认搜索路径上
    if (command === this.pythonExe) {
      const pyLib = join(selfDir, 'lib')
      const win32Lib = join(pyLib, 'win32', 'lib')
      const pywin32Sys = join(pyLib, 'pywin32_system32')
      if (existsSync(win32Lib)) {
        env.PYTHONPATH = [env.PYTHONPATH, win32Lib].filter(Boolean).join(';')
      }
      if (existsSync(pywin32Sys)) {
        env.PATH = [pywin32Sys, env.PATH ?? process.env.PATH ?? ''].filter(Boolean).join(';')
      }
    }

    return {
      name,
      label,
      description,
      command,
      args,
      env
    }
  }

  private getBlenderAddonDirs(): string[] {
    const appData = process.env.APPDATA ?? ''
    const base = join(appData, 'Blender Foundation', 'Blender')
    if (!existsSync(base)) return []
    try {
      return readdirSync(base, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => ({ name: d.name, ver: parseFloat(d.name) }))
        .filter((x) => Number.isFinite(x.ver) && x.ver >= 3.0)
        .map((x) => join(base, x.name, 'scripts', 'addons'))
    } catch {
      return []
    }
  }

  private get3dsMaxPluginTarget(): string | null {
    const appData = process.env.APPDATA ?? ''
    if (!appData) return null
    return join(appData, 'Autodesk', 'ApplicationPlugins', '3dsmax-mcp')
  }

  private findRhinoYakExe(): string | null {
    const candidates = [
      join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Rhino 8', 'System', 'yak.exe'),
      join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Rhino 9 WIP', 'System', 'yak.exe')
    ]
    return candidates.find((p) => existsSync(p)) ?? null
  }

  private checkPluginInstalled(name: string): { canInstall: boolean; installed: boolean } {
    if (name === 'blender') {
      const dirs = this.getBlenderAddonDirs()
      const hasSource = Boolean(
        this.localMcpRoot &&
          existsSync(join(this.localMcpRoot, 'blender', 'lib', 'blender_mcp', 'bundled', 'addon.py'))
      )
      return {
        canInstall: hasSource && dirs.length > 0,
        installed: dirs.some((d) => existsSync(join(d, 'blender_mcp.py')))
      }
    }
    if (name === '3dsmax') {
      const target = this.get3dsMaxPluginTarget()
      const hasSource = Boolean(
        this.localMcpRoot &&
          existsSync(join(this.localMcpRoot, '3dsmax', 'lib', 'maxmcp', 'bundle'))
      )
      return {
        canInstall: hasSource && Boolean(target),
        installed: Boolean(target && existsSync(join(target, 'PackageContents.xml')))
      }
    }
    if (name === 'rhino') {
      return {
        canInstall: Boolean(this.findRhinoYakExe()),
        installed: Boolean(this.findRhinoRouterExe())
      }
    }
    if (name === 'sketchup') {
      const appData = process.env.APPDATA ?? ''
      const suBase = join(appData, 'SketchUp')
      let found = false
      if (existsSync(suBase)) {
        try {
          for (const d of readdirSync(suBase)) {
            if (existsSync(join(suBase, d, 'SketchUp', 'Plugins', 'su_mcp.rb'))) {
              found = true
            }
          }
        } catch {
          // ignore
        }
      }
      return { canInstall: false, installed: found }
    }
    return { canInstall: false, installed: true }
  }

  /** 对齐原版 main/index.js 宿主插件铺设逻辑：一键将 Blender / 3dsMax / Rhino 插件装入宿主目录 */
  async installPlugin(name: string): Promise<{ ok: boolean; message: string }> {
    try {
      if (name === 'blender') {
        if (!this.localMcpRoot) return { ok: false, message: '缺少内置 blender 连接器文件' }
        const src = join(this.localMcpRoot, 'blender', 'lib', 'blender_mcp', 'bundled', 'addon.py')
        if (!existsSync(src)) return { ok: false, message: '未找到 blender_mcp 插件源码 addon.py' }
        const dirs = this.getBlenderAddonDirs()
        if (dirs.length === 0) {
          return {
            ok: false,
            message: '未检测到 Blender 3.0+ 配置目录（请先安装并至少启动过一次 Blender）'
          }
        }
        for (const d of dirs) {
          mkdirSync(d, { recursive: true })
          cpSync(src, join(d, 'blender_mcp.py'), { force: true })
        }
        return {
          ok: true,
          message: `已将 blender_mcp.py 安装到 ${dirs.length} 个 Blender 插件目录。请在 Blender「编辑 → 偏好设置 → 插件」搜索并勾选启用。`
        }
      }

      if (name === '3dsmax') {
        if (!this.localMcpRoot) return { ok: false, message: '缺少内置 3dsmax 连接器文件' }
        const srcDir = join(this.localMcpRoot, '3dsmax', 'lib', 'maxmcp', 'bundle')
        if (!existsSync(srcDir)) return { ok: false, message: '未找到 3dsmax 插件 bundle 目录' }
        const targetDir = this.get3dsMaxPluginTarget()
        if (!targetDir) return { ok: false, message: '无法确定 Autodesk ApplicationPlugins 目录' }
        // M5：只清理确实是本插件包的目录，避免误删用户放在同名目录里的其他文件
        if (existsSync(targetDir)) {
          const isOurBundle =
            existsSync(join(targetDir, 'PackageContents.xml')) ||
            existsSync(join(targetDir, 'PackageContents.xml.in')) ||
            readdirSync(targetDir).length === 0
          if (!isOurBundle) {
            return { ok: false, message: `目标目录 ${targetDir} 已存在且不是 3dsmax-mcp 插件包，为避免误删已停止安装，请手动检查。` }
          }
          rmSync(targetDir, { recursive: true, force: true })
        }
        mkdirSync(targetDir, { recursive: true })
        cpSync(srcDir, targetDir, { recursive: true, force: true })
        const xmlIn = join(targetDir, 'PackageContents.xml.in')
        const xmlOut = join(targetDir, 'PackageContents.xml')
        if (existsSync(xmlIn) && !existsSync(xmlOut)) {
          const tpl = readFileSync(xmlIn, 'utf8').replace(/@VERSION@/g, '1.7.6')
          writeFileSync(xmlOut, tpl, 'utf8')
        }
        return {
          ok: true,
          message: `已将 3dsmax-mcp 插件包铺设至 ${targetDir}，重启 3ds Max 后自动生效。`
        }
      }

      if (name === 'rhino') {
        const yak = this.findRhinoYakExe()
        if (!yak) {
          return {
            ok: false,
            message: '未在默认路径找到 Rhino 8+ 的 yak.exe，请手动在 Rhino 内运行 PackageManager 安装 Rhino-MCP-Platform。'
          }
        }
        await new Promise<void>((res, rej) => {
          execFile(
            yak,
            ['install', 'Rhino-MCP-Platform'],
            { cwd: dirname(yak), timeout: 120000, windowsHide: true },
            (err, _out, stderr) => {
              if (err) rej(new Error(String(stderr || err.message)))
              else res()
            }
          )
        })
        return { ok: true, message: '已通过 Rhino Yak 安装 Rhino-MCP-Platform 插件。' }
      }

      return { ok: false, message: `${MCP_CONNECTOR_LABELS[name] ?? name} 当前无需自动安装或需在宿主内手动启用扩展` }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  }

  async listConnectors(): Promise<McpConnectorInfo[]> {
    const prefs = this.loadUserPrefs()
    const manifest = this.loadManifestServers()
    const runningSet = await this.queryRunningProcesses()
    const orderedKeys = ['sketchup', 'multicad', 'blender', '3dsmax', 'rhino', 'photoshop', 'computer-use']

    return orderedKeys.map((name) => {
      const label = MCP_CONNECTOR_LABELS[name] ?? name
      const requirement = MCP_CONNECTOR_REQUIREMENTS[name] ?? ''
      const spec = this.resolveServerSpec(name)
      const raw = manifest[name]
      const available = Boolean(spec)
      const pluginState = this.checkPluginInstalled(name)

      const hostExes = HOST_PROCESS_NAMES[name] ?? []
      const hostRunning =
        hostExes.length === 0 ? available : hostExes.some((exe) => runningSet.has(exe.toLowerCase()))

      const enabled = prefs[name] ?? false
      let statusText = '连接器未就绪'
      if (available) {
        if (hostExes.length === 0) statusText = '桌面无障碍驱动已就绪'
        else if (hostRunning) statusText = `${label} 正在运行`
        else statusText = `${label} 未启动（调用时自动连接或拉起）`
      } else if (name === 'rhino') {
        statusText = '未检测到 Rhino-MCP-Platform（可点右侧安装）'
      }

      return {
        name,
        label,
        requirement,
        description: raw?.description ?? `${label} 本地建模与设计软件连接器`,
        enabled: available && enabled,
        available,
        hostRunning,
        canInstallPlugin: pluginState.canInstall,
        pluginInstalled: pluginState.installed,
        statusText
      }
    })
  }

  async setEnabled(name: string, enabled: boolean): Promise<McpConnectorInfo[]> {
    const prefs = this.loadUserPrefs()
    prefs[name] = enabled
    this.saveUserPrefs(prefs)
    return this.listConnectors()
  }

  getEnabledSpecs(): RuntimeMcpServerSpec[] {
    const prefs = this.loadUserPrefs()
    const specs: RuntimeMcpServerSpec[] = []
    for (const [name, on] of Object.entries(prefs)) {
      if (!on) continue
      const spec = this.resolveServerSpec(name)
      if (spec) specs.push(spec)
    }
    return specs
  }

  async getEnabledSpecsWithHostState(): Promise<RuntimeMcpServerSpec[]> {
    const prefs = this.loadUserPrefs()
    const runningSet = await this.queryRunningProcesses()
    const specs: RuntimeMcpServerSpec[] = []
    for (const [name, on] of Object.entries(prefs)) {
      if (!on) continue
      const spec = this.resolveServerSpec(name)
      if (!spec) continue
      const label = MCP_CONNECTOR_LABELS[name] ?? name
      const pluginState = this.checkPluginInstalled(name)
      const hostExes = HOST_PROCESS_NAMES[name] ?? []
      const hostRunning =
        hostExes.length === 0 ? true : hostExes.some((exe) => runningSet.has(exe.toLowerCase()))

      let hostState: RuntimeMcpServerSpec['hostState']
      if (!pluginState.installed) {
        hostState = {
          state: 'plugin-missing',
          hostRunning,
          pluginInstalled: false,
          reason: `${label} 宿主插件未安装或未启用`
        }
      } else if (!hostRunning) {
        hostState = {
          state: 'host-not-running',
          hostRunning: false,
          pluginInstalled: true,
          reason: `${label} 宿主软件尚未启动`
        }
      } else {
        hostState = {
          state: 'ready',
          hostRunning: true,
          pluginInstalled: true
        }
      }

      specs.push({ ...spec, hostState })
    }
    return specs
  }
}
