'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
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

/**
 * Igaz, ha egy `load()` hívás eredménye még ahhoz a framehez tartozik, ami
 * jelenleg a verem tetején van.
 *
 * A panel breadcrumb-verme lehetővé teszi, hogy a felhasználó egy beágyazott
 * subagentet megnyisson (frame B), majd a `‹`-vel visszalépjen a szülőre
 * (frame A) MIELŐTT B lekérése lefutna. Ha B válasza ekkor még alkalmazásra
 * kerülne, A fejléce alatt B üzenetei jelennének meg. Minden `load()` hívás
 * lezáráskor ezt ellenőrzi, és eldobja magát, ha időközben elavult.
 */
export function isCurrentPanelFrame(requestedSessionId: string, activeSessionId: string): boolean {
  return requestedSessionId === activeSessionId
}

/**
 * Felhasználó-olvasható hibaszöveg egy `load`/`send`/`stop` híváshoz.
 *
 * A panelnek nincs hova jelentenie a hibát -- önálló felület, így a hibát
 * magában a panelben kell megjeleníteni, nem console.error-ba nyelni.
 */
export function describeSubagentPanelError(action: 'load' | 'send' | 'stop', err: unknown): string {
  const detail = err instanceof Error && err.message.trim() ? err.message.trim() : 'ismeretlen hiba'
  if (action === 'load') return `Nem sikerült betölteni a beszélgetést: ${detail}`
  if (action === 'send') return `Nem sikerült elküldeni az üzenetet: ${detail}`
  return `Nem sikerült leállítani a subagentet: ${detail}`
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
  const [error, setError] = useState<string | null>(null)

  // A verem tetején lévő frame session id-ja, mindig friss -- ezt nézi meg
  // egy `load()` hívás lezáráskor, hogy még mindig neki szól-e a válasz.
  const activeSessionIdRef = useRef(frame.sessionId)
  useEffect(() => {
    activeSessionIdRef.current = frame.sessionId
  }, [frame.sessionId])

  const load = useCallback(async () => {
    const targetSessionId = frame.sessionId
    try {
      /*
       * A /messages `limit` nelkul CSUPASZ tombot ad vissza, nem { messages }
       * burkot (route.ts:37-38). A generikus `api<T>` igy pontosan Message[].
       */
      const [msgs, sess] = await Promise.all([
        api<Message[]>('GET', `/chats/${encodeURIComponent(targetSessionId)}/messages`),
        api<Session>('GET', `/chats/${encodeURIComponent(targetSessionId)}`),
      ])
      if (!isCurrentPanelFrame(targetSessionId, activeSessionIdRef.current)) return
      setMessages(Array.isArray(msgs) ? msgs : [])
      setSession(sess || null)
      setError(null)
    } catch (err) {
      if (!isCurrentPanelFrame(targetSessionId, activeSessionIdRef.current)) return
      setError(describeSubagentPanelError('load', err))
    }
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
      setError(null)
      await load()
    } catch (err) {
      // A draft NEM ürül ki -- a felhasználó újra tudja próbálni ugyanazzal a szöveggel.
      setError(describeSubagentPanelError('send', err))
    } finally {
      setSending(false)
    }
  }

  const stop = async () => {
    try {
      await api('POST', `/chats/${encodeURIComponent(frame.sessionId)}/stop`, {})
      setError(null)
      await load()
    } catch (err) {
      setError(describeSubagentPanelError('stop', err))
    }
  }

  return (
    <div
      /*
       * Ugyanaz a hasáb, mint az InspectorPanel (a fogaskerék "Settings"
       * panelje): `w-[420px] shrink-0 border-l ... h-full`, a chat-area
       * testvéreként a külső flex-sorban. Ettől nem lebeg a chat fölött --
       * helyet foglal, és a szülő transzkript ÉS composer mellé szorul, nem
       * alá. Korábban `fixed` volt, és emiatt kellett előbb a fejlécet, majd
       * a composert külön kikerülnie; egy beépülő oszlopnak egyiket sem kell.
       *
       * `md` alatt viszont nincs hova szorulni, ott marad a teljes szélességű
       * borítás -- ezért vált `fixed`-ről `static`-ra a törésponton.
       */
      className="fixed inset-y-0 right-0 z-40 w-full md:static md:inset-auto md:z-auto md:w-[420px] shrink-0 flex flex-col h-full overflow-hidden border-l border-line-subtle bg-bg fade-up-delay"
      data-testid="subagent-panel"
      role="complementary"
      aria-label={`${frame.agentName} subagent beszélgetése`}
    >
      <div className="flex items-center gap-2 px-4 pt-4 pb-3 border-b border-line-subtle shrink-0 bg-layer-1">
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
        {/* Ugyanaz a záró gomb, mint az InspectorPanelé -- ez a panel arra
            a helyre és arra a szerepre ül, tehát ne egy másik ✕ legyen. */}
        <button
          type="button"
          onClick={onClose}
          className="p-1.5 rounded-sm text-text-3/50 hover:text-text-3 bg-transparent border-none cursor-pointer transition-all hover:bg-layer-2"
          title="Bezárás"
          aria-label="Subagent panel bezárása"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {error && (
        <div
          className="flex items-center gap-2 px-4 py-2 text-[11.5px] text-rose-400 bg-rose-500/5 border-b border-rose-500/15 shrink-0"
          role="alert"
        >
          <span className="flex-1 min-w-0">{error}</span>
          <button
            type="button"
            onClick={() => void load()}
            className="shrink-0 text-[11px] font-600 text-rose-300 hover:text-rose-200 bg-transparent border-none cursor-pointer underline decoration-current/30"
          >
            Újra
          </button>
        </div>
      )}

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
            aria-label="Üzenet küldése"
            title="Üzenet küldése"
            className={`w-9 h-9 rounded-lg border-none flex items-center justify-center
              shrink-0 cursor-pointer transition-all duration-250 disabled:opacity-60
              ${draft.trim()
                ? 'bg-accent-bright text-accent-fg active:scale-90'
                : 'bg-layer-2 text-text-3 pointer-events-none'}`}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="12" y1="19" x2="12" y2="5" />
              <polyline points="5 12 12 5 19 12" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  )
}
