import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { HumanMessage } from '@langchain/core/messages'
import type { CcSwitchCandidate } from '@shared/ipc'
import type { AnthropicAuthStyle, ModelProviderProfile } from '@shared/protocol'
import { createChatModel } from '../runtime/modelFactory'

export function maskSecret(raw: string): string {
  const s = raw.trim()
  if (!s) return '未配置 Key'
  if (s.length <= 10) return `${s.slice(0, 2)}***${s.slice(-2)}`
  return `${s.slice(0, 6)}...${s.slice(-4)}`
}

/**
 * 轻量解析 TOML 中顶级字段及 [model_providers.<name>] 块里的常用连接字段（无第三方依赖）。
 */
export function parseCodexTomlConfig(rawToml: string): {
  model?: string
  modelProvider?: string
  baseUrl?: string
  wireApi?: string
  bearerToken?: string
} {
  let section = ''
  let model: string | undefined
  let modelProvider: string | undefined
  const providerBlocks: Record<
    string,
    { baseUrl?: string; wireApi?: string; bearerToken?: string }
  > = {}

  const stripQuotes = (v: string): string => {
    const trimmed = v.trim()
    if (
      (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ) {
      return trimmed.slice(1, -1)
    }
    return trimmed
  }

  for (const line of rawToml.split(/\r?\n/)) {
    const s = line.trim()
    if (!s || s.startsWith('#')) continue
    const secMatch = /^\[([^\]]+)\]$/.exec(s)
    if (secMatch) {
      section = secMatch[1].trim()
      continue
    }
    const eqIdx = s.indexOf('=')
    if (eqIdx <= 0) continue
    const key = s.slice(0, eqIdx).trim()
    const val = stripQuotes(s.slice(eqIdx + 1))

    if (!section) {
      if (key === 'model') model = val
      else if (key === 'model_provider') modelProvider = val
    } else if (section.startsWith('model_providers.')) {
      const pName = section.slice('model_providers.'.length).replace(/^["']|["']$/g, '')
      providerBlocks[pName] = providerBlocks[pName] ?? {}
      if (key === 'base_url') providerBlocks[pName].baseUrl = val
      else if (key === 'wire_api') providerBlocks[pName].wireApi = val
      else if (key === 'experimental_bearer_token') providerBlocks[pName].bearerToken = val
    }
  }

  const targetBlock =
    (modelProvider && providerBlocks[modelProvider]) ||
    Object.values(providerBlocks)[0] ||
    {}

  return {
    model,
    modelProvider,
    baseUrl: targetBlock.baseUrl,
    wireApi: targetBlock.wireApi,
    bearerToken: targetBlock.bearerToken
  }
}

function detectAnthropicAuthStyle(
  env: Record<string, string>,
  cfg?: Record<string, unknown>
): AnthropicAuthStyle {
  if ((env.ANTHROPIC_AUTH_TOKEN || '').trim()) return 'bearer'
  if ((env.ANTHROPIC_API_KEY || String(cfg?.apiKey || '')).trim()) return 'x-api-key'
  return 'auto'
}

function readLiveClaudeCandidate(): CcSwitchCandidate | null {
  const settingsPath = join(homedir(), '.claude', 'settings.json')
  if (!existsSync(settingsPath)) return null
  try {
    const raw = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      model?: string
      env?: Record<string, string>
    }
    const env = raw.env ?? {}
    const baseUrl = (env.ANTHROPIC_BASE_URL || env.ANTHROPIC_API_URL || '').trim()
    const apiKey = (env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || '').trim()
    const model = (env.ANTHROPIC_MODEL || raw.model || '').trim()
    if (!baseUrl && !apiKey) return null
    return {
      uid: 'live:claude',
      source: 'claude-live',
      appType: 'claude (当前生效)',
      name: 'Claude Code 当前激活配置',
      protocol: 'anthropic',
      authStyle: detectAnthropicAuthStyle(env),
      baseUrl: baseUrl || 'https://api.anthropic.com',
      apiKey,
      maskedKey: maskSecret(apiKey),
      model,
      isCurrent: true,
      isHealthy: true
    }
  } catch {
    return null
  }
}

function readLiveCodexCandidate(): CcSwitchCandidate | null {
  const codexDir = join(homedir(), '.codex')
  const configPath = join(codexDir, 'config.toml')
  const authPath = join(codexDir, 'auth.json')
  if (!existsSync(configPath) && !existsSync(authPath)) return null
  try {
    const parsed = existsSync(configPath)
      ? parseCodexTomlConfig(readFileSync(configPath, 'utf8'))
      : {}
    let authKey = parsed.bearerToken || ''
    if (!authKey && existsSync(authPath)) {
      const auth = JSON.parse(readFileSync(authPath, 'utf8')) as Record<string, string>
      authKey = (auth.OPENAI_API_KEY || auth.token || '').trim()
    }
    if (!parsed.baseUrl && !authKey) return null
    return {
      uid: 'live:codex',
      source: 'codex-live',
      appType: 'codex (当前生效)',
      name: 'Codex 当前激活配置',
      protocol: 'openai',
      baseUrl: parsed.baseUrl || 'https://api.openai.com/v1',
      apiKey: authKey,
      maskedKey: maskSecret(authKey),
      model: parsed.model || 'gpt-4o',
      isCurrent: true,
      isHealthy: true,
      useResponsesApi: parsed.wireApi === 'responses'
    }
  } catch {
    return null
  }
}

interface RawDbRow {
  id: string
  app_type: string
  name: string
  settings_config: string
  meta?: string | null
  website_url?: string | null
  is_current: number
  is_healthy?: number | null
  last_error?: string | null
}

interface CatalogModelEntry {
  model: string
  contextWindow?: number
}

function collectExtraCatalogModels(
  cfg: Record<string, unknown>,
  meta: Record<string, unknown>
): CatalogModelEntry[] {
  const out: CatalogModelEntry[] = []
  const seen = new Set<string>()
  const push = (modelName: unknown, ctxWin?: unknown): void => {
    const m = typeof modelName === 'string' ? modelName.trim() : ''
    if (!m || seen.has(m)) return
    seen.add(m)
    const cw = typeof ctxWin === 'number' && Number.isFinite(ctxWin) && ctxWin >= 8192 ? ctxWin : undefined
    out.push({ model: m, ...(cw ? { contextWindow: cw } : {}) })
  }

  const catalog = cfg.modelCatalog as
    | { models?: Array<{ model?: unknown; id?: unknown; displayName?: unknown; contextWindow?: unknown }>; autoReviewModel?: unknown }
    | undefined
  if (catalog && Array.isArray(catalog.models)) {
    for (const item of catalog.models) {
      if (!item || typeof item !== 'object') continue
      push(item.model ?? item.id ?? item.displayName, item.contextWindow)
    }
  }
  if (catalog?.autoReviewModel) {
    push(catalog.autoReviewModel)
  }

  const routes = meta.claudeDesktopModelRoutes as Record<string, { model?: unknown }> | undefined
  if (routes && typeof routes === 'object') {
    for (const r of Object.values(routes)) {
      if (r && typeof r === 'object') push(r.model)
    }
  }
  return out
}

export function parseCcSwitchRow(row: RawDbRow): CcSwitchCandidate[] {
  let cfg: Record<string, unknown> = {}
  try {
    cfg = JSON.parse(row.settings_config || '{}') as Record<string, unknown>
  } catch {
    return []
  }

  let meta: Record<string, unknown> = {}
  if (typeof row.meta === 'string' && row.meta.trim()) {
    try {
      meta = JSON.parse(row.meta) as Record<string, unknown>
    } catch {
      meta = {}
    }
  }

  const appLower = row.app_type.toLowerCase()
  const isHealthy = row.is_healthy === null || row.is_healthy === undefined ? null : row.is_healthy === 1
  const catalogEntries = collectExtraCatalogModels(cfg, meta)

  const buildVariants = (base: Omit<CcSwitchCandidate, 'uid' | 'model'> & { primaryModel: string }): CcSwitchCandidate[] => {
    const primary = base.primaryModel.trim()
    const matchedPrimaryCtx = catalogEntries.find((e) => e.model === primary)?.contextWindow
    const result: CcSwitchCandidate[] = [
      {
        uid: `ccswitch:${row.app_type}:${row.id}`,
        source: base.source,
        appType: base.appType,
        name: base.name,
        protocol: base.protocol,
        baseUrl: base.baseUrl,
        apiKey: base.apiKey,
        maskedKey: base.maskedKey,
        model: primary,
      isCurrent: base.isCurrent,
        isHealthy: base.isHealthy,
        lastError: base.lastError,
        ...(base.authStyle ? { authStyle: base.authStyle } : {}),
        ...(base.useResponsesApi !== undefined ? { useResponsesApi: base.useResponsesApi } : {}),
        ...(matchedPrimaryCtx ? { contextWindowTokens: matchedPrimaryCtx } : {})
      }
    ]
    for (const extra of catalogEntries) {
      if (extra.model === primary) continue
      result.push({
        uid: `ccswitch:${row.app_type}:${row.id}:${extra.model}`,
        source: base.source,
        appType: base.appType,
        name: base.name,
        protocol: base.protocol,
        baseUrl: base.baseUrl,
        apiKey: base.apiKey,
        maskedKey: base.maskedKey,
        model: extra.model,
        isCurrent: base.isCurrent,
        isHealthy: base.isHealthy,
        lastError: base.lastError,
        ...(base.authStyle ? { authStyle: base.authStyle } : {}),
        ...(base.useResponsesApi !== undefined ? { useResponsesApi: base.useResponsesApi } : {}),
        ...(extra.contextWindow ? { contextWindowTokens: extra.contextWindow } : {})
      })
    }
    return result
  }

  if (appLower.includes('claude')) {
    const env = (cfg.env ?? {}) as Record<string, string>
    const baseUrl = (env.ANTHROPIC_BASE_URL || env.ANTHROPIC_API_URL || String(cfg.baseUrl || '')).trim()
    const apiKey = (env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || String(cfg.apiKey || '')).trim()
    const primaryModel = (
      env.ANTHROPIC_MODEL ||
      env.ANTHROPIC_DEFAULT_SONNET_MODEL ||
      String(cfg.model || catalogEntries[0]?.model || '')
    ).trim()
    if (!baseUrl && !apiKey) return []
    return buildVariants({
      source: 'ccswitch-db',
      appType: row.app_type,
      name: row.name,
      protocol: 'anthropic',
      authStyle: detectAnthropicAuthStyle(env, cfg),
      baseUrl: baseUrl || 'https://api.anthropic.com',
      apiKey,
      maskedKey: maskSecret(apiKey),
      primaryModel,
      isCurrent: row.is_current === 1,
      isHealthy,
      lastError: row.last_error || undefined
    })
  }

  if (appLower.includes('codex')) {
    const auth = (cfg.auth ?? {}) as Record<string, string>
    const parsedToml =
      typeof cfg.config === 'string' ? parseCodexTomlConfig(cfg.config) : {}
    const apiKey = (auth.OPENAI_API_KEY || parsedToml.bearerToken || '').trim()
    const baseUrl = (parsedToml.baseUrl || String(cfg.baseUrl || '')).trim()
    const primaryModel = (parsedToml.model || catalogEntries[0]?.model || 'gpt-4o').trim()
    if (!baseUrl && !apiKey) return []
    const apiFormat = typeof meta.apiFormat === 'string' ? meta.apiFormat : ''
    const useResponsesApi =
      apiFormat === 'openai_chat'
        ? false
        : apiFormat === 'openai_responses'
          ? true
          : parsedToml.wireApi === 'responses'
    return buildVariants({
      source: 'ccswitch-db',
      appType: row.app_type,
      name: row.name,
      protocol: 'openai',
      baseUrl: baseUrl || 'https://api.openai.com/v1',
      apiKey,
      maskedKey: maskSecret(apiKey),
      primaryModel,
      isCurrent: row.is_current === 1,
      isHealthy,
      lastError: row.last_error || undefined,
      useResponsesApi
    })
  }

  // Gemini / OpenCode / 其他节点
  const env = (cfg.env ?? {}) as Record<string, string>
  const baseUrl = (
    env.OPENAI_BASE_URL ||
    env.GEMINI_API_BASE_URL ||
    env.GOOGLE_GEMINI_BASE_URL ||
    String(cfg.baseUrl || cfg.apiUrl || '')
  ).trim()
  const apiKey = (
    env.OPENAI_API_KEY ||
    env.GEMINI_API_KEY ||
    String(cfg.apiKey || '')
  ).trim()
  const primaryModel = (
    env.OPENAI_MODEL ||
    env.GEMINI_MODEL ||
    String(cfg.model || catalogEntries[0]?.model || 'gemini-2.5-pro')
  ).trim()
  if (!baseUrl && !apiKey) return []

  return buildVariants({
    source: 'ccswitch-db',
    appType: row.app_type,
    name: row.name,
    protocol: 'openai',
    baseUrl: baseUrl || 'https://api.openai.com/v1',
    apiKey,
    maskedKey: maskSecret(apiKey),
    primaryModel,
    isCurrent: row.is_current === 1,
    isHealthy,
    lastError: row.last_error || undefined
  })
}

async function queryCcSwitchDbRowsViaNodeSqlite(dbPath: string): Promise<RawDbRow[] | null> {
  try {
    // Electron 35 (Node 22+) 内置 node:sqlite，零子进程开销且不受 Windows stdout 编码影响
    const { createRequire } = await import('node:module')
    const req = createRequire(__filename)
    const sqliteMod = req('node:sqlite') as {
      DatabaseSync?: new (path: string, opts?: { readOnly?: boolean }) => {
        prepare: (sql: string) => { all: () => RawDbRow[] }
        close: () => void
      }
    }
    if (!sqliteMod?.DatabaseSync) return null
    const db = new sqliteMod.DatabaseSync(dbPath, { readOnly: true })
    try {
      try {
        return db
          .prepare(
            `SELECT p.id, p.app_type, p.name, p.settings_config, p.meta, p.website_url, p.is_current,
                    h.is_healthy, h.last_error
             FROM providers p
             LEFT JOIN provider_health h ON p.id = h.provider_id AND p.app_type = h.app_type
             ORDER BY p.is_current DESC, p.sort_index ASC, p.created_at DESC`
          )
          .all()
      } catch {
        return db
          .prepare(
            `SELECT id, app_type, name, settings_config, NULL AS meta, website_url, is_current, NULL AS is_healthy, NULL AS last_error
             FROM providers
             ORDER BY is_current DESC, sort_index ASC, created_at DESC`
          )
          .all()
      }
    } finally {
      db.close()
    }
  } catch {
    return null
  }
}

async function queryCcSwitchDbRows(dbPath: string, pythonExe: string): Promise<RawDbRow[]> {
  if (!existsSync(dbPath)) return []

  const nodeRows = await queryCcSwitchDbRowsViaNodeSqlite(dbPath)
  if (nodeRows) return nodeRows

  const pyScript = `
import json, sqlite3, sys
db = sys.argv[1]
try:
    conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=5.0)
except Exception:
    conn = sqlite3.connect(db, timeout=5.0)
cur = conn.cursor()
try:
    rows = cur.execute("""
        SELECT p.id, p.app_type, p.name, p.settings_config, p.meta, p.website_url, p.is_current,
               h.is_healthy, h.last_error
        FROM providers p
        LEFT JOIN provider_health h ON p.id = h.provider_id AND p.app_type = h.app_type
        ORDER BY p.is_current DESC, p.sort_index ASC, p.created_at DESC
    """).fetchall()
except Exception:
    rows = cur.execute("""
        SELECT id, app_type, name, settings_config, NULL, website_url, is_current, NULL, NULL
        FROM providers
        ORDER BY is_current DESC, sort_index ASC, created_at DESC
    """).fetchall()
out = [
    {
        "id": r[0], "app_type": r[1], "name": r[2], "settings_config": r[3],
        "meta": r[4], "website_url": r[5], "is_current": r[6], "is_healthy": r[7], "last_error": r[8]
    }
    for r in rows
]
print(json.dumps(out, ensure_ascii=True))
`
  const runPy = (exe: string): Promise<RawDbRow[]> =>
    new Promise<RawDbRow[]>((resolveRows, rejectRows) => {
      execFile(
        exe,
        ['-c', pyScript, dbPath],
        {
          timeout: 6000,
          windowsHide: true,
          maxBuffer: 8 * 1024 * 1024,
          env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
        },
        (err, stdout, stderr) => {
          if (err) {
            rejectRows(new Error(String(stderr || err.message)))
            return
          }
          try {
            resolveRows(JSON.parse(stdout) as RawDbRow[])
          } catch (parseErr) {
            rejectRows(parseErr instanceof Error ? parseErr : new Error(String(parseErr)))
          }
        }
      )
    })

  try {
    return await runPy(pythonExe)
  } catch (firstErr) {
    if (pythonExe !== 'python') {
      try {
        return await runPy('python')
      } catch {
        // throw original error below
      }
    }
    throw firstErr
  }
}

export async function discoverCcSwitchCandidates(
  pythonExe: string
): Promise<{ candidates: CcSwitchCandidate[]; error?: string }> {
  const candidates: CcSwitchCandidate[] = []

  const liveClaude = readLiveClaudeCandidate()
  if (liveClaude) candidates.push(liveClaude)

  const liveCodex = readLiveCodexCandidate()
  if (liveCodex) candidates.push(liveCodex)

  const dbPath = join(homedir(), '.cc-switch', 'cc-switch.db')
  let dbError: string | undefined
  if (existsSync(dbPath)) {
    try {
      const rows = await queryCcSwitchDbRows(dbPath, pythonExe)
      for (const row of rows) {
        candidates.push(...parseCcSwitchRow(row))
      }
    } catch (err) {
      dbError = `读取 cc-switch.db 失败：${err instanceof Error ? err.message : String(err)}`
    }
  }

  return { candidates, ...(dbError ? { error: dbError } : {}) }
}

export async function testModelProfileConnection(
  profile: ModelProviderProfile
): Promise<{
  ok: boolean
  latencyMs: number
  detail?: string
  error?: string
  resolvedBaseUrl?: string
  resolvedUseResponsesApi?: boolean
  resolvedAuthStyle?: AnthropicAuthStyle
}> {
  const started = Date.now()
  const invokeOnce = async (candidate: ModelProviderProfile): Promise<string> => {
    const model = createChatModel({ ...candidate, maxOutputTokens: 64 }, { thinking: false })
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15000)
    try {
      const res = await model.invoke([new HumanMessage('Reply with OK only.')], {
        signal: controller.signal
      })
      return typeof res.content === 'string'
        ? res.content.trim()
        : JSON.stringify(res.content).slice(0, 80)
    } finally {
      clearTimeout(timer)
    }
  }

  try {
    const rawText = await invokeOnce(profile)
    const latencyMs = Date.now() - started
    return {
      ok: true,
      latencyMs,
      detail: rawText ? `响应：${rawText.slice(0, 60)}` : '握手成功'
    }
  } catch (err) {
    const firstMsg = err instanceof Error ? err.message : String(err)
    const is404 = /\b404\b|not found/i.test(firstMsg)

    // Codex / 反代配置常省略 /v1 后缀或仅开放 /chat/completions；遇到 404 时自动探测标准兼容路径
    if (is404 && profile.protocol === 'openai') {
      const cleanBase = profile.baseUrl.trim().replace(/\/+$/, '') || 'https://api.openai.com/v1'
      const hasVersionSuffix = /\/v\d+$/i.test(cleanBase)
      const useResp = Boolean(profile.useResponsesApi)
      const fallbacks: Array<{ baseUrl: string; useResponsesApi: boolean }> = []
      if (!hasVersionSuffix) {
        fallbacks.push({ baseUrl: `${cleanBase}/v1`, useResponsesApi: useResp })
        fallbacks.push({ baseUrl: `${cleanBase}/v1`, useResponsesApi: !useResp })
      }
      fallbacks.push({ baseUrl: cleanBase, useResponsesApi: !useResp })

      for (const fb of fallbacks) {
        try {
          const rawText = await invokeOnce({
            ...profile,
            baseUrl: fb.baseUrl,
            useResponsesApi: fb.useResponsesApi
          })
          const latencyMs = Date.now() - started
          const modeLabel = fb.useResponsesApi ? 'Responses API' : 'Chat Completions'
          return {
            ok: true,
            latencyMs,
            detail: `${rawText ? `响应：${rawText.slice(0, 40)}` : '握手成功'}（已自动适配 ${fb.baseUrl} · ${modeLabel}）`,
            resolvedBaseUrl: fb.baseUrl,
            resolvedUseResponsesApi: fb.useResponsesApi
          }
        } catch {
          // continue trying remaining OpenAI route shapes
        }
      }

      const latencyMs = Date.now() - started
      return {
        ok: false,
        latencyMs,
        error: `404 未找到 OpenAI 兼容接口（已依次尝试 ${cleanBase} 与 /v1 下的 /responses、/chat/completions 均返回 404）。请确认本地代理已启动且提供 OpenAI 接口，或确认该端点的真实路径。`
      }
    }

    // Anthropic 中转若严格区分 Bearer 与 x-api-key（401/403），自动切换鉴权头试探
    const isAuthErr = /\b40[13]\b|unauthorized|authentication|invalid.*key|x-api-key|bearer/i.test(
      firstMsg
    )
    if (isAuthErr && profile.protocol === 'anthropic') {
      const currentStyle: AnthropicAuthStyle = profile.authStyle ?? 'auto'
      const candidateStyles: AnthropicAuthStyle[] = (
        ['bearer', 'x-api-key', 'auto'] as AnthropicAuthStyle[]
      ).filter((s) => s !== currentStyle)

      for (const altStyle of candidateStyles) {
        try {
          const rawText = await invokeOnce({ ...profile, authStyle: altStyle })
          const latencyMs = Date.now() - started
          const styleLabel =
            altStyle === 'bearer'
              ? 'Authorization: Bearer'
              : altStyle === 'x-api-key'
                ? 'x-api-key'
                : 'Bearer + x-api-key'
          return {
            ok: true,
            latencyMs,
            detail: `${rawText ? `响应：${rawText.slice(0, 40)}` : '握手成功'}（已自动适配 ${styleLabel}）`,
            resolvedAuthStyle: altStyle
          }
        } catch {
          // try remaining auth style
        }
      }
    }

    const latencyMs = Date.now() - started
    return {
      ok: false,
      latencyMs,
      error: firstMsg.slice(0, 220)
    }
  }
}
