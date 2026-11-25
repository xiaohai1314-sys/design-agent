import React, { useEffect, useId, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import mermaid from 'mermaid'
import { Check, Copy } from 'lucide-react'

let mermaidInited = false
function ensureMermaid(): void {
  if (!mermaidInited) {
    mermaid.initialize({
      startOnLoad: false,
      theme: 'neutral',
      securityLevel: 'strict'
    })
    mermaidInited = true
  }
}

const MermaidDiagram: React.FC<{ chart: string }> = ({ chart }) => {
  const uid = useId().replace(/[:]/g, '_')
  const [svg, setSvg] = useState<string>('')
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ensureMermaid()
    mermaid
      .render(`mmd_${uid}_${Date.now()}`, chart)
      .then((res) => {
        if (!cancelled) {
          setSvg(res.svg)
          setErr(null)
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [chart, uid])

  if (err) {
    return (
      <pre className="p-3 rounded-xl bg-zinc-900 text-zinc-100 text-xs overflow-x-auto">
        {chart}
      </pre>
    )
  }

  return (
    <div
      className="my-2 p-3 rounded-xl border border-zinc-200 bg-white overflow-x-auto flex justify-center"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}

const CodeBlockWithCopy: React.FC<{ className?: string; children: React.ReactNode }> = ({
  className,
  children
}) => {
  const [copied, setCopied] = useState(false)
  const rawText = String(children ?? '').replace(/\n$/, '')
  const langMatch = /language-([a-z0-9_-]+)/i.exec(className ?? '')
  const lang = langMatch?.[1]?.toLowerCase() ?? ''

  if (lang === 'mermaid') {
    return <MermaidDiagram chart={rawText} />
  }

  const isInline = !className && !rawText.includes('\n')
  if (isInline) {
    return (
      <code className="px-1.5 py-0.5 rounded bg-zinc-100 text-zinc-800 font-mono text-[0.9em]">
        {children}
      </code>
    )
  }

  return (
    <div className="relative group my-2 rounded-xl overflow-hidden border border-zinc-800 bg-zinc-950">
      <div className="flex items-center justify-between px-3 py-1.5 bg-zinc-900 border-b border-zinc-800 text-[11px] text-zinc-400">
        <span className="font-mono">{lang || 'text'}</span>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(rawText)
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          }}
          className="inline-flex items-center gap-1 hover:text-white cursor-pointer"
        >
          {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
          <span>{copied ? '已复制' : '复制'}</span>
        </button>
      </div>
      <pre className="p-3 text-xs font-mono text-zinc-100 overflow-x-auto leading-relaxed m-0">
        <code>{rawText}</code>
      </pre>
    </div>
  )
}

export const MarkdownRenderer: React.FC<{ content: string }> = ({ content }) => {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      components={{
        code: ({ className, children }) => (
          <CodeBlockWithCopy className={className}>{children}</CodeBlockWithCopy>
        )
      }}
    >
      {content}
    </ReactMarkdown>
  )
}
