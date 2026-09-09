'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/stores/use-app-store'
import { api } from '@/lib/app/api-client'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { TransferAgentPicker } from '@/components/chat/transfer-agent-picker'
import type { Session } from '@/types'

/**
 * Who answers the next message, chosen from the composer.
 *
 * It sits beside Add rather than in the page header because that is where the
 * decision is made -- you notice the wrong agent while typing, not before.
 *
 * WHAT A SWITCH DOES, AND WHAT IT CANNOT DO. The conversation moves to the new
 * agent and the transcript stays: it is this app's record, and the page keeps
 * rendering it. What does not move is the agent's own memory of the thread. A
 * CLI agent holds the conversation inside its own runtime session and
 * SwarmClaw only keeps a handle to it; that handle belongs to the agent being
 * left, and a resumed CLI never re-reads a system prompt, so carrying it would
 * run the new agent wearing the old one's persona. The handle is therefore
 * dropped, and the new agent starts this thread fresh. The picker says so
 * rather than letting it be discovered.
 */
export function ComposerAgentPicker({ sessionId }: { sessionId: string | null }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const agents = useAppStore((s) => s.agents)
  const currentAgentId = useAppStore((s) => s.currentAgentId)
  const updateSessionInStore = useAppStore((s) => s.updateSessionInStore)
  const setCurrentAgent = useAppStore((s) => s.setCurrentAgent)

  const agent = currentAgentId ? agents[currentAgentId] : undefined

  async function pick(agentId: string) {
    setOpen(false)
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

  return (
    <div className="relative">
      <button
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

      {open && (
        <>
          <TransferAgentPicker
            excludeIds={currentAgentId ? [currentAgentId] : []}
            onSelect={(id) => { void pick(id) }}
            onClose={() => setOpen(false)}
          />
          <p className="absolute left-0 bottom-full mb-[218px] z-50 w-[220px] px-3 py-2 rounded-sm
            bg-surface/80 backdrop-blur-xl border border-line-default text-[10px] leading-snug text-text-3">
            A váltás a következő üzenettől él. Az új ügynök ezt a szálat elölről kezdi — a korábbi
            üzeneteket te látod, ő nem.
          </p>
        </>
      )}
    </div>
  )
}
