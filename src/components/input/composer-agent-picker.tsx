'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { toast } from 'sonner'
import { useAppStore } from '@/stores/use-app-store'
import { api } from '@/lib/app/api-client'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import type { Session } from '@/types'

/**
 * Who answers the next message, chosen from the composer.
 *
 * It sits beside Add rather than in the page header because that is where the
 * decision is made -- you notice the wrong agent while typing, not before.
 *
 * THE MENU IS IN A PORTAL, and that is not a preference. The composer shell is
 * `overflow-hidden` (it has to be: it draws the curved glass edge that every
 * control inside it is clipped to), so an absolutely positioned menu was cut
 * off at the shell's top edge -- the first entry sliced in half and the rest
 * gone. Anchored to the button's viewport rect from `document.body`, nothing
 * upstream can clip it.
 *
 * WHAT A SWITCH DOES, AND WHAT IT CANNOT DO. The conversation moves to the new
 * agent and the transcript stays: it is this app's record, and the page keeps
 * rendering it. What does not move is the agent's own memory of the thread. A
 * CLI agent holds the conversation inside its own runtime session and
 * SwarmClaw only keeps a handle to it; that handle belongs to the agent being
 * left, and a resumed CLI never re-reads a system prompt, so carrying it would
 * run the new agent wearing the old one's persona. The handle is therefore
 * dropped, and the new agent starts this thread fresh. The menu says so rather
 * than letting it be discovered.
 */

const MENU_WIDTH = 260
const MENU_MAX_HEIGHT = 320
const GAP = 8

export function ComposerAgentPicker({ sessionId }: { sessionId: string | null }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')
  const [rect, setRect] = useState<{ left: number; bottom: number } | null>(null)
  const buttonRef = useRef<HTMLButtonElement | null>(null)

  const agents = useAppStore((s) => s.agents)
  const currentAgentId = useAppStore((s) => s.currentAgentId)
  const updateSessionInStore = useAppStore((s) => s.updateSessionInStore)
  const setCurrentAgent = useAppStore((s) => s.setCurrentAgent)

  const agent = currentAgentId ? agents[currentAgentId] : undefined

  const place = useCallback(() => {
    const el = buttonRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    // Balra igazítva a gombhoz, de sosem lóg ki a nézetből.
    const left = Math.min(Math.max(8, r.left), window.innerWidth - MENU_WIDTH - 8)
    setRect({ left, bottom: window.innerHeight - r.top + GAP })
  }, [])

  useLayoutEffect(() => { if (open) place() }, [open, place])

  useEffect(() => {
    if (!open) return
    const onScrollOrResize = () => place()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('resize', onScrollOrResize)
    window.addEventListener('scroll', onScrollOrResize, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('resize', onScrollOrResize)
      window.removeEventListener('scroll', onScrollOrResize, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, place])

  async function pick(agentId: string) {
    setOpen(false)
    setQuery('')
    if (!sessionId || agentId === currentAgentId) return
    setBusy(true)
    try {
      const updated = await api<Session>('PUT', `/chats/${encodeURIComponent(sessionId)}`, { agentId })
      updateSessionInStore(updated)
      await setCurrentAgent(agentId)
      toast.success(`${agents[agentId]?.name ?? 'Az ügynök'} válaszol mostantól`)
    } catch {
      toast.error('Az ügynökváltás nem sikerült.')
    } finally {
      setBusy(false)
    }
  }

  if (!agent) return null

  const choices = Object.values(agents).filter((a) =>
    !a.trashedAt
    && a.id !== currentAgentId
    && (!query || a.name.toLowerCase().includes(query.toLowerCase())),
  )

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        disabled={busy || !sessionId}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Válaszoló ügynök: ${agent.name}. Váltás`}
        data-testid="composer-agent-picker"
        className="flex items-center gap-1.5 pl-1.5 pr-2.5 py-1.5 rounded-full border-none bg-transparent
          text-text-3 text-[12px] cursor-pointer hover:text-text-2 hover:bg-layer-2 transition-all duration-200
          disabled:opacity-50 disabled:cursor-not-allowed"
        style={{ fontFamily: 'inherit' }}
      >
        <AgentAvatar seed={agent.avatarSeed} avatarUrl={agent.avatarUrl} name={agent.name} size={18} />
        <span className="max-w-[120px] truncate">{agent.name}</span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && rect && typeof document !== 'undefined' && createPortal(
        <>
          <div className="fixed inset-0 z-[60]" onClick={() => setOpen(false)} />
          <div
            role="listbox"
            aria-label="Válassz ügynököt"
            data-testid="composer-agent-menu"
            className="fixed z-[61] rounded-md border border-line-default bg-raised shadow-[var(--overlay-shadow)] overflow-hidden"
            style={{ left: rect.left, bottom: rect.bottom, width: MENU_WIDTH, maxHeight: MENU_MAX_HEIGHT }}
          >
            <div className="p-2 border-b border-line-subtle">
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Ügynök keresése..."
                aria-label="Ügynök keresése"
                className="w-full px-2.5 py-1.5 text-[12px] bg-layer-1 rounded-sm border border-line-subtle
                  text-text placeholder:text-text-3 outline-none focus:border-border-focus"
                style={{ fontFamily: 'inherit' }}
              />
            </div>

            <div className="overflow-y-auto" style={{ maxHeight: MENU_MAX_HEIGHT - 104 }}>
              {choices.length === 0 && (
                <p className="px-3 py-3 text-[11px] text-text-3 text-center">Nincs másik ügynök</p>
              )}
              {choices.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  role="option"
                  aria-selected={false}
                  onClick={() => { void pick(a.id) }}
                  className="flex w-full items-center gap-2.5 px-3 py-2 text-left bg-transparent border-none
                    cursor-pointer hover:bg-layer-1 transition-colors"
                >
                  <AgentAvatar seed={a.avatarSeed} avatarUrl={a.avatarUrl} name={a.name} size={20} />
                  <span className="flex-1 min-w-0 truncate text-[12.5px] text-text">{a.name}</span>
                </button>
              ))}
            </div>

            <p className="px-3 py-2 border-t border-line-subtle text-[10px] leading-snug text-text-3">
              A váltás a következő üzenettől él. Az új ügynök ezt a szálat elölről kezdi — a
              korábbi üzeneteket te látod, ő nem.
            </p>
          </div>
        </>,
        document.body,
      )}
    </>
  )
}
