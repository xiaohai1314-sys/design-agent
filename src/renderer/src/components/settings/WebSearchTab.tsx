import type { ModelSettingsState } from '@shared/ipc'

export interface WebSearchTabProps {
  draft: ModelSettingsState
  setDraft: (draft: ModelSettingsState) => void
}

/** 设置 → 联网搜索通道 */
export function WebSearchTab({ draft, setDraft }: WebSearchTabProps): React.JSX.Element {
  return (
    <div className="flex-1 p-6 space-y-4 overflow-y-auto text-xs">
      <div className="p-3.5 rounded-xl bg-sky-50/70 border border-sky-100 text-sky-900 leading-relaxed">
        挂载 <code className="font-mono">web_search</code>{' '}
        工具后，即使使用普通自定义大模型 API，智能体（及子任务）也可实时搜索最新材料工艺参数、设计案例或公开条文。默认使用免
        Key 的 DuckDuckGo 通道，也可按需切换为 Tavily 或博查（Bocha）API。
      </div>

      <label className="inline-flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={draft.webSearch?.enabled ?? true}
          onChange={(e) =>
            setDraft({
              ...draft,
              webSearch: {
                provider: draft.webSearch?.provider ?? 'duckduckgo',
                apiKey: draft.webSearch?.apiKey ?? '',
                enabled: e.target.checked
              }
            })
          }
          className="w-4 h-4 rounded accent-blue-600"
        />
        <span className="font-semibold text-zinc-900">启用联网搜索工具 (web_search)</span>
      </label>

      <div>
        <label className="block font-medium text-zinc-700 mb-1">搜索引擎通道</label>
        <select
          value={draft.webSearch?.provider ?? 'duckduckgo'}
          onChange={(e) =>
            setDraft({
              ...draft,
              webSearch: {
                enabled: draft.webSearch?.enabled ?? true,
                apiKey: draft.webSearch?.apiKey ?? '',
                provider: e.target.value as 'duckduckgo' | 'tavily' | 'bocha'
              }
            })
          }
          className="w-full px-3 py-2 rounded-lg border border-zinc-200 bg-white outline-none focus:border-blue-500"
        >
          <option value="duckduckgo">DuckDuckGo HTML（免费免 API Key）</option>
          <option value="tavily">Tavily Search API（需填写 API Key）</option>
          <option value="bocha">博查 Bocha AI Search（国内中文检索佳，需 Key）</option>
        </select>
      </div>

      {draft.webSearch?.provider && draft.webSearch.provider !== 'duckduckgo' && (
        <div>
          <label className="block font-medium text-zinc-700 mb-1">搜索服务 API Key</label>
          <input
            type="password"
            value={draft.webSearch.apiKey ?? ''}
            onChange={(e) =>
              setDraft({
                ...draft,
                webSearch: {
                  ...draft.webSearch!,
                  apiKey: e.target.value
                }
              })
            }
            placeholder="tvly-... / sk-..."
            className="w-full px-3 py-2 rounded-lg border border-zinc-200 font-mono outline-none focus:border-blue-500"
          />
        </div>
      )}
    </div>
  )
}
