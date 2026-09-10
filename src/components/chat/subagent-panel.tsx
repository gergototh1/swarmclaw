'use client'

import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/app/api-client'
import { useWs } from '@/hooks/use-ws'
import { MessageBubble } from './message-bubble'
import type { Message, Session } from '@/types'

/**
 * A figyelmeztetés, amit a futó gyerek-beszélgetés inputja fölé írunk.
 *
 * Futó jobba írva a subagent kap egy sort a queue-jába, miközben a szülő
 * ügynök a `handle.promise`-ra vár -- az eredmény más lesz, mint amit a szülő
 * kért. Ezt nem tiltjuk (a felhasználó kifejezetten kérte, hogy tudjon
 * beleírni), de nem is hallgatjuk el.
 */
export function subagentPanelWarning(running: boolean, parentName: string | null): string | null {
  if (!running) return null
  const who = parentName?.trim() || 'A szülő ügynök'
  return `${who} erre a futásra vár — amit írsz, megváltoztatja, amit visszakap.`
}

interface PanelFrame {
  sessionId: string
  agentName: string
}

export function SubagentPanel({
  sessionId,
  agentName,
  parentName,
  onClose,
}: {
  sessionId: string
  agentName: string
  parentName: string | null
  onClose: () => void
}) {
  /*
   * A breadcrumb a panelen BELÜL él, nem egy második panelben.
   *
   * Egy subagent maga is spawnolhat, és panel a panelben elveszítené az
   * olvasót. A verem itt egy sima tömb: a fejléc a lánc, a `‹` visszalép
   * egyet, az `✕` az egészet bezárja.
   */
  const [stack, setStack] = useState<PanelFrame[]>([{ sessionId, agentName }])
  const frame = stack[stack.length - 1]

  const [messages, setMessages] = useState<Message[]>([])
  const [session, setSession] = useState<Session | null>(null)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)

  const load = useCallback(async () => {
    /*
     * A /messages `limit` nelkul CSUPASZ tombot ad vissza, nem { messages }
     * burkot (route.ts:37-38). A generikus `api<T>` igy pontosan Message[].
     */
    const [msgs, sess] = await Promise.all([
      api<Message[]>('GET', `/chats/${encodeURIComponent(frame.sessionId)}/messages`),
      api<Session>('GET', `/chats/${encodeURIComponent(frame.sessionId)}`),
    ])
    setMessages(Array.isArray(msgs) ? msgs : [])
    setSession(sess || null)
  }, [frame.sessionId])

  useEffect(() => { void load() }, [load])
  useWs('messages', load, 4_000)
  useWs('runs', load, 4_000)

  const running = session?.active === true
  const warning = subagentPanelWarning(running, parentName)

  const send = async () => {
    const text = draft.trim()
    if (!text || sending) return
    setSending(true)
    try {
      await api('POST', `/chats/${encodeURIComponent(frame.sessionId)}/chat`, { message: text })
      setDraft('')
      await load()
    } finally {
      setSending(false)
    }
  }

  const stop = async () => {
    await api('POST', `/chats/${encodeURIComponent(frame.sessionId)}/stop`, {})
    await load()
  }

  return (
    <div
      /*
       * A fejléc alatt kezdődik, nem a viewport tetején. A ChatHeader
       * `min-h-[64px]`, és mindkét törésponton ott van (`chat-area.tsx`
       * desktop és mobil ágon is rendereli) -- `top-0`-val a panel ráült
       * volna, és a szülő chat címe eltűnt volna alóla, miközben a panel
       * saját fejléce pont ugyanoda került.
       */
      className="fixed right-0 top-[64px] bottom-0 w-full md:w-[440px] lg:w-[520px] z-40 flex flex-col bg-surface border-l border-line-default"
      data-testid="subagent-panel"
      role="complementary"
      aria-label={`${frame.agentName} subagent beszélgetése`}
    >
      <div className="flex items-center gap-2 px-4 py-3 border-b border-line-subtle shrink-0">
        {stack.length > 1 && (
          <button
            type="button"
            onClick={() => setStack((s) => s.slice(0, -1))}
            className="text-[12px] text-text-3 hover:text-text-2 bg-transparent border-none cursor-pointer px-1"
            title="Vissza"
          >
            ‹
          </button>
        )}
        <span className="flex-1 min-w-0 truncate text-[13px] font-600 text-text">
          {stack.map((f) => f.agentName).join(' / ')}
          <span className="text-text-3 font-400"> · subagent</span>
        </span>
        {running && (
          <button
            type="button"
            onClick={() => void stop()}
            className="text-[11px] text-amber-400 hover:text-amber-300 bg-transparent border border-amber-500/20 rounded-xs cursor-pointer px-2 py-0.5"
          >
            ■ Leállít
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          className="text-[14px] text-text-3 hover:text-text bg-transparent border-none cursor-pointer px-1"
          title="Bezárás"
        >
          ✕
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 flex flex-col gap-4">
        {/*
          * A MessageBubble-t hasznaljuk, nem sajat renderelest.
          *
          * A store-bol csak `currentUser`-t es `setPreviewContent`-et olvas
          * (`message-bubble.tsx:341,343`), es egyik sem session-fuggo -- a
          * tobbit a `message` propbol veszi. Igy a panel ingyen kapja a
          * markdownt, a kodblokkokat, a tool-esemenyeket es a csatolmanyokat,
          * es automatikusan orokli az 1-3. task letisztitasat. Kezi
          * renderelessel egy fejleszto-subagent valasza -- ami csupa kod --
          * nyers szovegkent allna itt.
          */}
        {messages.map((msg, i) => (
          <MessageBubble
            key={`${frame.sessionId}-${i}`}
            message={msg}
            assistantName={frame.agentName}
            agentName={frame.agentName}
            onOpenSubagent={(childId, childName) => setStack((prev) => [...prev, { sessionId: childId, agentName: childName }])}
          />
        ))}
        {running && (
          <div className="text-[12px] text-amber-400 flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
            dolgozik…
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-line-subtle px-4 py-3">
        {warning && (
          <p className="mb-2 text-[11px] text-amber-400/80 leading-snug">{warning}</p>
        )}
        <div className="flex gap-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() } }}
            placeholder={`Írj a(z) ${frame.agentName} ügynöknek…`}
            className="flex-1 min-w-0 bg-layer-1 border border-line-subtle rounded-md px-3 py-2 text-[13px] text-text outline-none focus:border-line-strong"
          />
          <button
            type="button"
            onClick={() => void send()}
            disabled={sending || !draft.trim()}
            className="shrink-0 px-3 py-2 rounded-md bg-accent-soft text-accent-bright text-[12px] font-600 border-none cursor-pointer disabled:opacity-40 disabled:cursor-default"
          >
            Küldés
          </button>
        </div>
      </div>
    </div>
  )
}
