'use client'

import { useEffect } from 'react'
import { useParams } from 'next/navigation'
import { useAppStore } from '@/stores/use-app-store'
import { ChatArea } from '@/components/chat/chat-area'

/**
 * One conversation, opened by its session id.
 *
 * `activeSessionIdOverride` already existed for exactly this: it wins over the
 * agent-derived session in `selectActiveSessionId`, so ChatArea needs no
 * changes to render a conversation the reader picked rather than the newest
 * one its agent happens to hold. `currentAgentId` is set alongside it because
 * everything else on the page -- the header, the composer, the tool list --
 * reads the agent, not the session.
 */
export default function ConversationPage() {
  const { id } = useParams<{ id: string }>()
  const sessions = useAppStore((s) => s.sessions)
  const setActiveSessionIdOverride = useAppStore((s) => s.setActiveSessionIdOverride)
  const setCurrentAgent = useAppStore((s) => s.setCurrentAgent)

  const sessionId = id ? decodeURIComponent(id) : null
  const agentId = sessionId ? sessions[sessionId]?.agentId : null

  /*
   * THE AGENT FIRST, THEN THE OVERRIDE, AND IN THAT ORDER ONLY.
   *
   * `setCurrentAgent` clears `activeSessionIdOverride` on every path it takes
   * (agent-slice.ts) -- it is how the Agents page drops back to an agent's own
   * newest thread. Setting the override first therefore erased it a tick
   * later, and the page rendered the agent's latest session instead of the one
   * in the URL: the rail highlighted "Terv: WebMCP" while the transcript beside
   * it was a scheduled run.
   */
  useEffect(() => {
    if (!sessionId) return
    let cancelled = false
    void (async () => {
      if (agentId) await setCurrentAgent(agentId)
      if (!cancelled) setActiveSessionIdOverride(sessionId)
    })()
    // Elengedés kilépéskor, különben az Agents oldal is ezt a szálat mutatná.
    return () => { cancelled = true; setActiveSessionIdOverride(null) }
  }, [sessionId, agentId, setActiveSessionIdOverride, setCurrentAgent])

  return (
    <div className="flex-1 flex h-full min-h-0 min-w-0">
      <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
        <ChatArea key={sessionId} />
      </div>
    </div>
  )
}
