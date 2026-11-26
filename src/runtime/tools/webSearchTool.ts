import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import type { WebSearchConfig, WebSearchResultItem, WebSearchToolData } from '@shared/protocol'

function stripHtmlTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

async function searchDuckDuckGo(query: string, signal: AbortSignal): Promise<WebSearchResultItem[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
  const resp = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
    },
    signal
  })
  if (!resp.ok) throw new Error(`DuckDuckGo 返回 HTTP ${resp.status}`)
  const html = await resp.text()
  const results: WebSearchResultItem[] = []
  const blockRe =
    /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|span)>)?/gi
  let m: RegExpExecArray | null
  while ((m = blockRe.exec(html)) !== null && results.length < 6) {
    let rawUrl = m[1] ?? ''
    const uddg = /[?&]uddg=([^&]+)/.exec(rawUrl)
    if (uddg) rawUrl = decodeURIComponent(uddg[1])
    const title = stripHtmlTags(m[2] ?? '')
    const snippet = stripHtmlTags(m[3] ?? '')
    if (title && rawUrl.startsWith('http')) {
      results.push({ title, url: rawUrl, snippet })
    }
  }
  return results
}

async function searchTavily(
  query: string,
  apiKey: string,
  signal: AbortSignal
): Promise<WebSearchResultItem[]> {
  const resp = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: apiKey, query, max_results: 6, include_answer: false }),
    signal
  })
  if (!resp.ok) throw new Error(`Tavily API 返回 HTTP ${resp.status}`)
  const data = (await resp.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string }>
  }
  return (data.results ?? []).slice(0, 6).map((r) => ({
    title: r.title ?? r.url ?? '搜索结果',
    url: r.url ?? '',
    snippet: (r.content ?? '').slice(0, 360)
  }))
}

async function searchBocha(
  query: string,
  apiKey: string,
  signal: AbortSignal
): Promise<WebSearchResultItem[]> {
  const resp = await fetch('https://api.bochaai.com/v1/web-search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({ query, summary: true, count: 6 }),
    signal
  })
  if (!resp.ok) throw new Error(`博查 API 返回 HTTP ${resp.status}`)
  const data = (await resp.json()) as {
    data?: { webPages?: { value?: Array<{ name?: string; url?: string; snippet?: string }> } }
  }
  return (data.data?.webPages?.value ?? []).slice(0, 6).map((r) => ({
    title: r.name ?? r.url ?? '搜索结果',
    url: r.url ?? '',
    snippet: (r.snippet ?? '').slice(0, 360)
  }))
}

/** 按配置执行一次联网检索（web_search 工具与 search_inspiration 的联网兜底共用同一实现） */
export async function runWebSearch(params: {
  config?: WebSearchConfig
  query: string
  signal: AbortSignal
}): Promise<{ provider: string; results: WebSearchResultItem[] }> {
  const provider = params.config?.provider ?? 'duckduckgo'
  const apiKey = params.config?.apiKey?.trim() ?? ''
  let results: WebSearchResultItem[] = []
  if (provider === 'tavily' && apiKey) {
    results = await searchTavily(params.query, apiKey, params.signal)
  } else if (provider === 'bocha' && apiKey) {
    results = await searchBocha(params.query, apiKey, params.signal)
  } else {
    results = await searchDuckDuckGo(params.query, params.signal)
  }
  return { provider, results }
}

export function createWebSearchTool(params: {
  config?: WebSearchConfig
  signal: AbortSignal
  recordToolData: (toolCallId: string, data: WebSearchToolData) => void
}): DynamicStructuredTool | null {
  if (params.config && params.config.enabled === false) return null
  const provider = params.config?.provider ?? 'duckduckgo'

  return new DynamicStructuredTool({
    name: 'web_search',
    description:
      '互联网实时检索工具：查询公开设计规范更新、施工材料工艺参数、品牌尺寸或行业参考资料，返回可核验的网页标题、URL 与摘要。',
    schema: z.object({
      query: z.string().min(1).describe('精准的联网搜索关键词')
    }),
    func: async ({ query }, runManager) => {
      const callId =
        (runManager as unknown as { configurable?: { toolCallId?: string } })?.configurable?.toolCallId ??
        `web_${Date.now()}`

      const { results } = await runWebSearch({
        config: params.config,
        query,
        signal: params.signal
      })

      params.recordToolData(callId, {
        kind: 'web_search',
        query,
        provider,
        results
      })

      if (results.length === 0) {
        return `联网检索未返回直接结果（检索词：${query}）。请尝试更换关键词或提示用户确认具体参数。`
      }

      return JSON.stringify({ query, provider, results }, null, 2)
    }
  })
}
