import React, { useRef, useState } from 'react'
import { ArrowRight, Check, ChevronLeft, ChevronRight, Pencil } from 'lucide-react'
import clsx from 'clsx'
import type { AskAnswer, AskQuestion } from '@shared/protocol'

interface ClarifyCardProps {
  questions: AskQuestion[]
  interaction?: 'host-readiness'
  onSubmit: (answers: AskAnswer[]) => void
}

function setAt<T>(arr: T[], i: number, val: T): T[] {
  return arr.map((x, j) => (j === i ? val : x))
}

/** 100% 对齐原版 TaskDetail/ClarifyCard/index.tsx 多题翻页、单选直通、多选勾选、自由补充与跳过逻辑 */
export const ClarifyCard: React.FC<ClarifyCardProps> = ({
  questions,
  interaction,
  onSubmit
}) => {
  const total = questions.length
  const [pageIndex, setPageIndex] = useState(0)
  const [single, setSingle] = useState<(string | null)[]>(() => questions.map(() => null))
  const [multi, setMulti] = useState<string[][]>(() => questions.map(() => []))
  const [custom, setCustom] = useState<string[]>(() => questions.map(() => ''))
  const answersRef = useRef<AskAnswer[]>(
    questions.map((q) => ({ question: q.question, selected: [] }))
  )
  const finishedRef = useRef(false)

  const waitingForHost = interaction === 'host-readiness'
  const q = questions[pageIndex]
  if (!q) return null

  const isLast = pageIndex === total - 1
  const hasCustom = custom[pageIndex].trim().length > 0
  const canSubmit = hasCustom || (q.type === 'multi_select' && multi[pageIndex].length > 0)

  const buildAnswer = (i: number): AskAnswer => {
    const question = questions[i].question
    const text = custom[i].trim()
    if (text) {
      return { question, selected: [], text }
    }
    if (questions[i].type === 'single_select') {
      const s = single[i]
      return { question, selected: s ? [s] : [] }
    }
    return { question, selected: multi[i] }
  }

  const complete = (answer: AskAnswer): void => {
    if (finishedRef.current) return
    answersRef.current[pageIndex] = answer
    if (isLast) {
      finishedRef.current = true
      onSubmit([...answersRef.current])
    } else {
      setPageIndex(pageIndex + 1)
    }
  }

  const skip = (): void => {
    setCustom((c) => setAt(c, pageIndex, ''))
    setSingle((s) => setAt(s, pageIndex, null))
    setMulti((m) => setAt(m, pageIndex, []))
    complete({ question: q.question, selected: [] })
  }

  const pickSingle = (opt: string): void => {
    if (hasCustom) return
    setSingle((s) => setAt(s, pageIndex, opt))
    complete({ question: q.question, selected: [opt] })
  }

  const toggleMulti = (opt: string): void => {
    if (hasCustom) return
    setMulti((m) => {
      const cur = m[pageIndex]
      return setAt(
        m,
        pageIndex,
        cur.includes(opt) ? cur.filter((x) => x !== opt) : [...cur, opt]
      )
    })
  }

  return (
    <div className="px-4 pb-2.5">
      <div className="rounded-2xl border border-blue-200 bg-white shadow-md p-4">
        <div className="flex items-center justify-between gap-2 mb-3">
          <div className="flex items-center gap-2">
            <span className="px-2 py-0.5 rounded-md bg-blue-50 text-blue-700 text-[11px] font-semibold">
              {q.type === 'multi_select' ? '多选澄清' : '需求澄清'}
            </span>
            <h4 className="text-sm font-semibold text-zinc-900">{q.question}</h4>
          </div>

          {total > 1 && (
            <div className="flex items-center gap-1 text-xs text-zinc-500 shrink-0">
              <button
                type="button"
                disabled={pageIndex === 0}
                onClick={() => setPageIndex((p) => Math.max(0, p - 1))}
                className="p-1 rounded hover:bg-zinc-100 disabled:opacity-30 cursor-pointer"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
              </button>
              <span className="tabular-nums">
                {pageIndex + 1}/{total}
              </span>
              <button
                type="button"
                disabled={isLast}
                onClick={() => setPageIndex((p) => Math.min(total - 1, p + 1))}
                className="p-1 rounded hover:bg-zinc-100 disabled:opacity-30 cursor-pointer"
              >
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>

        <div className="grid gap-2 mb-3">
          {q.options.map((opt, idx) => {
            const isSelected =
              q.type === 'single_select'
                ? single[pageIndex] === opt
                : multi[pageIndex].includes(opt)

            return (
              <button
                key={idx}
                type="button"
                disabled={hasCustom}
                onClick={() => (q.type === 'single_select' ? pickSingle(opt) : toggleMulti(opt))}
                className={clsx(
                  'flex items-center gap-3 px-3.5 py-2.5 rounded-xl border text-left text-xs transition-all cursor-pointer',
                  hasCustom && 'opacity-45 cursor-not-allowed',
                  isSelected
                    ? 'border-blue-600 bg-blue-50/70 text-blue-900 font-medium'
                    : 'border-zinc-200 bg-zinc-50/60 hover:bg-zinc-100/80 text-zinc-800'
                )}
              >
                {q.type === 'multi_select' ? (
                  <span
                    className={clsx(
                      'w-4 h-4 rounded flex items-center justify-center border shrink-0',
                      isSelected ? 'bg-blue-600 border-blue-600 text-white' : 'border-zinc-300 bg-white'
                    )}
                  >
                    {isSelected && <Check className="w-3 h-3" />}
                  </span>
                ) : (
                  <span className="w-5 h-5 rounded-md bg-white border border-zinc-200 text-[11px] text-zinc-500 flex items-center justify-center font-mono shrink-0">
                    {idx + 1}
                  </span>
                )}
                <span className="flex-1">{opt}</span>
                {q.type === 'single_select' && (
                  <ArrowRight className="w-3.5 h-3.5 text-zinc-400" />
                )}
              </button>
            )
          })}
        </div>

        {!waitingForHost && (
          <div className="flex items-center gap-2 pt-2 border-t border-zinc-100">
            <div className="flex-1 flex items-center gap-2 px-3 py-1.5 rounded-lg border border-zinc-200 bg-zinc-50 focus-within:bg-white focus-within:border-blue-500">
              <Pencil className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
              <input
                type="text"
                value={custom[pageIndex]}
                onChange={(e) => setCustom((c) => setAt(c, pageIndex, e.target.value))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && canSubmit) {
                    e.preventDefault()
                    complete(buildAnswer(pageIndex))
                  }
                }}
                placeholder="或直接输入其他具体要求…"
                className="w-full bg-transparent text-xs text-zinc-800 outline-none"
              />
            </div>

            <button
              type="button"
              onClick={skip}
              className="px-3 py-1.5 rounded-lg text-xs text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 cursor-pointer transition-colors"
            >
              跳过
            </button>

            {(q.type === 'multi_select' || hasCustom) && (
              <button
                type="button"
                disabled={!canSubmit}
                onClick={() => complete(buildAnswer(pageIndex))}
                className="px-3.5 py-1.5 rounded-lg text-xs font-medium bg-zinc-900 text-white hover:bg-zinc-800 disabled:opacity-40 cursor-pointer transition-colors"
              >
                {isLast ? '确认提交' : '下一题'}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
