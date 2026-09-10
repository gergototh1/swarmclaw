'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAppStore } from '@/stores/use-app-store'
import { useWs } from '@/hooks/use-ws'
import { useNow } from '@/hooks/use-now'
import { useWindowFocused } from '@/hooks/use-window-focused'
import { READ_GRACE_MS } from '@/stores/slices/data-slice'
import { SearchInput } from '@/components/ui/search-input'
import { conversationTitle, groupConversationsByAge, listConversations, type ConversationGroup } from '@/lib/conversation-list'
import { conversationRowState } from './conversation-row-state'
import { conversationDot } from './conversation-dot'
import type { Session } from '@/types'

/**
 * The Chat page's rail: the same 280px column the agent list fills, asking the
 * other question.
 *
 * The agent list answers "who am I talking to"; this answers "what was I
 * talking about". Nothing here is a second way to reach an agent -- a row is a
 * CONVERSATION, and two conversations with the same agent are two rows, which
 * is the whole reason this page exists.
 *
 * The shapes are the agent list's, deliberately: same row padding, same
 * selected treatment, same 11px chips. A reader moving between the two pages
 * should be moving between two lists of the same thing, not between two
 * designs.
 */

/** Coarse ages, because "which afternoon" is what a reader is actually placing. */
function ago(now: number | null, at: number | undefined): string {
  if (!now || !at) return ''
  const mins = Math.floor((now - at) / 60_000)
  if (mins < 1) return 'most'
  if (mins < 60) return `${mins} perce`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} órája`
  const days = Math.floor(hours / 24)
  if (days === 1) return 'tegnap'
  if (days < 7) return `${days} napja`
  return new Date(at).toLocaleDateString('hu-HU', { month: 'short', day: 'numeric' })
}

/**
 * Buckets the rows by calendar age, or says "not yet" instead of guessing.
 *
 * `now` starts `null` until `useNow()`'s first `requestAnimationFrame` tick,
 * and a backgrounded or inactive tab can delay that tick indefinitely --
 * this is not "one frame". Substituting 0 for an unknown `now` would put
 * every session's `startOfToday` in 1970, so every row would satisfy
 * `at >= startOfToday` and file under MÁRA regardless of its real age. So:
 * no `now`, no buckets. The caller falls back to the flat, unheaded row list
 * it already has -- the same "not hydrated yet" state `ago()` shows via its
 * blank timestamp -- until a real `now` arrives.
 */
export function resolveConversationGroups(rows: Session[], now: number | null): ConversationGroup[] | null {
  return now == null ? null : groupConversationsByAge(rows, now)
}

/**
 * Komputes the trailing text that follows the agent name separator (·).
 *
 * Returns one of: an error label ('sikertelen válasz'), a working label
 * ('dolgozik…'), or a time-ago string from `ago(now, at)`. When `now` is
 * null, returns an empty string for settled rows (no error, not working),
 * which suppresses the separator.
 */
export function conversationTrailingText(now: number | null, dot: ReturnType<typeof conversationDot>, at: number | undefined): string {
  if (dot === 'error') return 'sikertelen válasz'
  if (dot === 'working') return 'dolgozik…'
  return ago(now, at)
}

export function ConversationList({ activeId }: { activeId?: string | null }) {
  const router = useRouter()
  const now = useNow()
  const sessions = useAppStore((s) => s.sessions)
  const agents = useAppStore((s) => s.agents)
  const loadSessions = useAppStore((s) => s.loadSessions)
  const loadAgents = useAppStore((s) => s.loadAgents)
  const markChatRead = useAppStore((s) => s.markChatRead)
  const [search, setSearch] = useState('')
  const windowFocused = useWindowFocused()

  useEffect(() => { void loadSessions(); void loadAgents() }, [loadSessions, loadAgents])
  useWs('sessions', loadSessions, 15_000)
  useWs('runs', loadSessions, 5_000)

  // Az aktiv chat akkor lesz olvasott, ha az ablak is fokuszban van.
  useEffect(() => {
    if (!activeId) return
    if (!windowFocused) return
    void markChatRead(activeId)
  }, [activeId, windowFocused, markChatRead])

  // Fokuszvesztes utan `READ_GRACE_MS`-ig meg olvasottnak szamit: enelkul
  // minden ablakvaltas hamis olvasatlant szulne. A lejartakor UJRA megnezzuk a
  // fokuszt -- ha kozben visszatert, jeloljunk; ha nem, ne.
  useEffect(() => {
    if (!activeId) return
    if (windowFocused) return
    const timer = setTimeout(() => {
      if (document.hasFocus()) void markChatRead(activeId)
    }, READ_GRACE_MS)
    return () => clearTimeout(timer)
  }, [activeId, windowFocused, markChatRead])

  const rows = useMemo(() => {
    const all = listConversations(sessions)
    const q = search.trim().toLowerCase()
    if (!q) return all
    return all.filter((s) => {
      const agentName = (s.agentId && agents[s.agentId]?.name) || ''
      return conversationTitle(s, agentName).toLowerCase().includes(q)
        || agentName.toLowerCase().includes(q)
    })
  }, [sessions, agents, search])

  // `null` until `now` is known -- see resolveConversationGroups' doc comment.
  const groups = useMemo(() => resolveConversationGroups(rows, now), [rows, now])

  function renderRow(s: Session) {
    const agent = s.agentId ? agents[s.agentId] : undefined
    const isActive = s.id === activeId
    const { unread, isError, working } = conversationRowState(s)
    const dot = conversationDot({ unread, isError, working })
    const trailingText = conversationTrailingText(now, dot, s.lastActiveAt)
    return (
      <div
        key={s.id}
        role="button"
        tabIndex={0}
        data-testid="conversation-row"
        data-session-id={s.id}
        aria-label={`Beszélgetés megnyitása: ${conversationTitle(s, agent?.name || '')}`}
        onClick={() => router.push(`/chat/${encodeURIComponent(s.id)}`)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            router.push(`/chat/${encodeURIComponent(s.id)}`)
          }
        }}
        className={`group/row w-full text-left py-3 px-4 rounded-md cursor-pointer transition-all duration-150 border-none
          ${isActive ? 'bg-accent-soft/80 border border-accent-bright/20' : 'bg-transparent hover:bg-layer-1'}`}
      >
        <div className="flex items-start gap-2.5">
          {/* A pont az avatar pozícióját örökli, és akkor is helyet
              foglal, ha nincs jelzés -- különben a címek elcsúsznának
              egymáshoz képest soronként. */}
          <div className="shrink-0 w-1.5 flex justify-center mt-[7px]">
            {dot !== 'none' && (
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  dot === 'error' ? 'bg-red-500'
                    : dot === 'working' ? 'bg-amber-400 animate-pulse'
                    : 'bg-accent-bright'
                }`}
                data-testid={dot === 'working' ? 'row-working' : 'row-unread'}
                title={
                  dot === 'error' ? 'Sikertelen válasz'
                    : dot === 'working' ? 'Az ügynök dolgozik'
                    : 'Olvasatlan üzenet'
                }
              />
            )}
          </div>
          <div className="flex flex-col flex-1 min-w-0">
            <span className="font-display text-[13.5px] font-600 text-text tracking-[-0.01em] line-clamp-2">
              {conversationTitle(s, agent?.name || 'Beszélgetés')}
            </span>
            <span className="mt-0.5 flex items-center gap-1.5 text-[10px] text-text-3">
              <span className="truncate">{agent?.name || 'ismeretlen ügynök'}</span>
              {trailingText && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className={`shrink-0 ${dot === 'error' ? 'text-red-400' : dot === 'working' ? 'text-amber-400' : ''}`}>
                    {trailingText}
                  </span>
                </>
              )}
            </span>
          </div>
        </div>
      </div>
    )
  }

  if (rows.length === 0 && !search) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 px-8 text-center text-text-3">
        <p className="font-display text-[15px] font-600 text-text-2">Még nincs beszélgetés</p>
        <p className="text-[13px]">Kezdj egyet bármelyik ügynökkel az Agents oldalon, és itt fog megjelenni.</p>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto" data-testid="conversation-list">
      <div className="px-4 py-2.5">
        <SearchInput
          size="sm"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onClear={() => setSearch('')}
          placeholder="Keresés a beszélgetésekben..."
          aria-label="Keresés a beszélgetésekben"
          data-testid="conversation-search"
        />
      </div>

      {rows.length === 0 && (
        <p className="px-5 py-3 text-[13px] text-text-3">Nincs találat.</p>
      )}

      <div className="flex flex-col px-2 pb-4">
        {groups === null
          ? rows.map((s) => renderRow(s))
          : groups.map((group) => (
              <div key={group.label} className="flex flex-col gap-0.5">
                <div className="sticky top-0 z-10 bg-surface/95 backdrop-blur-sm px-4 pt-4 pb-1.5">
                  <span className="text-[10px] font-600 tracking-[0.06em] text-text-3">
                    {group.label}
                  </span>
                </div>
                {group.sessions.map((s) => renderRow(s))}
              </div>
            ))}
      </div>
    </div>
  )
}
