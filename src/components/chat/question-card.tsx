'use client'

import { useState } from 'react'
import type { Message } from '@/types'
import { api } from '@/lib/app/api-client'
import { errorMessage } from '@/lib/shared-utils'
import {
  canSubmit,
  createDrafts,
  draftsToAnswers,
  setOther,
  toggleOption,
  type QuestionDraft,
} from '@/lib/chat/question-card-state'

interface Props {
  message: Message
  sessionId: string
}

const FOCUS_RING = 'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-bright/40'

function CheckIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}

export function QuestionCard({ message, sessionId }: Props) {
  const payload = message.question
  const state = message.questionState
  const [drafts, setDrafts] = useState<QuestionDraft[]>(() => (payload ? createDrafts(payload) : []))
  const [sending, setSending] = useState(false)
  // A `sending` a kérés végén lenullázódik, a napló viszont csak a szerver
  // válasza után billen `answered`-re. A kettő közötti résben a gomb újra
  // aktív lenne, és egy második kattintás ugyanarra a correlationId-ra már
  // 404-et kap — a user egy sikeres küldés után látna hibát. Ez a jelző tartja
  // zárva a rést, amíg a kártya meg nem kapja a lezárt állapotot.
  const [sent, setSent] = useState(false)
  const [error, setError] = useState('')

  if (!payload || !state) return null

  const updateDraft = (index: number, next: QuestionDraft) => {
    setDrafts((current) => current.map((draft, i) => (i === index ? next : draft)))
  }

  const submit = async () => {
    setSending(true)
    setError('')
    try {
      await api('POST', `/chats/${sessionId}/mailbox`, {
        action: 'answer',
        correlationId: state.correlationId,
        answers: draftsToAnswers(payload, drafts),
      })
      setSent(true)
    } catch (err: unknown) {
      setError(errorMessage(err))
    } finally {
      setSending(false)
    }
  }

  // Megválaszolt / megkerült állapot — nincs több interakció, csak a
  // döntés visszaolvasása (megválaszolt) vagy egy semleges, nem hiba-jellegű
  // sor (megkerülve).
  if (state.status !== 'pending') {
    if (state.status === 'superseded') {
      return (
        <div className="my-2 rounded-lg border border-line-subtle bg-surface/60 px-3.5 py-2.5">
          <p className="text-[12px] text-text-3 italic">Superseded — the conversation moved on.</p>
        </div>
      )
    }
    return (
      <div className="my-2 rounded-lg border border-line-subtle bg-surface/60 p-3.5">
        <div className="flex items-center gap-2 mb-2">
          <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-400">
            <CheckIcon />
          </span>
          <span className="text-[12px] font-600 text-text-3">Answered</span>
        </div>
        <div className="flex flex-col gap-1.5">
          {(state.answers || []).map((answer, index) => {
            const parts = [...answer.selected, ...(answer.other ? [answer.other] : [])]
            return (
              <div key={`${answer.question}-${index}`} className="text-[13px] text-text-2">
                <span className="font-600 text-text">{answer.header || answer.question}: </span>
                {parts.join(', ')}
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  // Elküldve, de a napló még nem billent át: a kártya nem hagyható interaktívan,
  // különben a második kattintás 404-et hoz egy sikeres küldés után.
  if (sent) {
    return (
      <div className="my-2 rounded-lg border border-line-subtle bg-surface/60 px-3.5 py-2.5">
        <p className="text-[12px] text-text-3 italic">Sent — waiting for confirmation…</p>
      </div>
    )
  }

  const ready = canSubmit(payload, drafts)

  return (
    <div className="my-2 rounded-lg border border-sky-500/20 bg-sky-500/[0.04] p-3.5">
      <div className="flex items-center gap-2 mb-2.5">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-sky-400 shrink-0">
          <circle cx="12" cy="12" r="10" />
          <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
          <path d="M12 17h.01" />
        </svg>
        <span className="text-[12px] font-600 text-sky-400">Question</span>
      </div>

      <div className="flex flex-col gap-3.5">
        {payload.questions.map((question, index) => {
          const draft = drafts[index] || { selected: [], other: '' }
          const multiSelect = question.multiSelect === true
          const hasOptions = question.options.length > 0

          return (
            <div key={`${question.question}-${index}`} className="flex flex-col gap-1.5">
              <div className="flex items-center gap-1.5 flex-wrap">
                {question.header && (
                  <span className="text-[10px] font-600 uppercase tracking-[0.04em] text-text-3">{question.header}</span>
                )}
                {hasOptions && (
                  <span className="text-[9px] font-600 uppercase tracking-[0.03em] text-text-3/70 px-1 py-px rounded-xs border border-line-subtle">
                    {multiSelect ? 'Select all that apply' : 'Select one'}
                  </span>
                )}
              </div>
              <span className="text-[13px] text-text">{question.question}</span>

              {hasOptions && (
                <div
                  role={multiSelect ? 'group' : 'radiogroup'}
                  aria-label={multiSelect ? 'Select all that apply' : 'Select one'}
                  className="flex flex-col gap-1.5"
                >
                  {question.options.map((option) => {
                    const checked = draft.selected.includes(option.label)
                    return (
                      <button
                        key={option.label}
                        type="button"
                        role={multiSelect ? 'checkbox' : 'radio'}
                        aria-checked={checked}
                        onClick={() => updateDraft(index, toggleOption(draft, option.label, multiSelect))}
                        className={`flex items-start gap-2 rounded-sm border px-2.5 py-1.5 text-left text-[12px] transition-colors cursor-pointer ${FOCUS_RING} ${
                          checked
                            ? 'border-emerald-500/40 bg-emerald-500/10 text-text'
                            : 'border-line-default bg-transparent text-text-2 hover:border-line-default hover:bg-layer-2'
                        }`}
                      >
                        <span
                          className={`mt-px flex h-3.5 w-3.5 shrink-0 items-center justify-center border ${multiSelect ? 'rounded-xs' : 'rounded-full'} ${
                            checked ? 'border-emerald-400 bg-emerald-400/25 text-emerald-300' : 'border-line-default text-transparent'
                          }`}
                        >
                          {checked && <CheckIcon />}
                        </span>
                        <span className="flex flex-col">
                          <span className="font-600">{option.label}</span>
                          {option.description && <span className="text-[11px] text-text-3">{option.description}</span>}
                        </span>
                      </button>
                    )
                  })}
                </div>
              )}

              <input
                type="text"
                value={draft.other}
                onChange={(e) => updateDraft(index, setOther(draft, e.target.value))}
                placeholder={hasOptions ? 'Other…' : 'Type your answer…'}
                className={`rounded-sm border border-line-default bg-transparent px-2.5 py-1.5 text-[12px] text-text placeholder:text-text-3 ${FOCUS_RING}`}
              />
            </div>
          )
        })}
      </div>

      {error && <p className="text-[12px] text-red-400 mt-2.5">{error}</p>}

      <div className="flex items-center gap-2.5 mt-3">
        <button
          type="button"
          disabled={sending || !ready}
          onClick={() => void submit()}
          title={!ready ? 'Answer every question before sending' : undefined}
          className={`px-3 py-1.5 rounded-sm border border-line-default bg-sky-500/10 text-[12px] font-600
            text-sky-400 cursor-pointer hover:bg-sky-500/20 transition-all disabled:opacity-40 disabled:cursor-not-allowed ${FOCUS_RING}`}
          style={{ fontFamily: 'inherit' }}
        >
          {sending ? 'Sending…' : 'Send'}
        </button>
        {!ready && !sending && <span className="text-[11px] text-text-3">Choose an answer for every question first.</span>}
      </div>
    </div>
  )
}
