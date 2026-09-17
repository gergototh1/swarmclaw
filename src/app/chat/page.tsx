'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAppStore } from '@/stores/use-app-store'
import { listConversations } from '@/lib/conversation-list'
import { ConversationList } from '@/components/chat/conversation-list'
import { AgentChatList } from '@/components/agents/agent-chat-list'
import { useMediaQuery } from '@/hooks/use-media-query'
import { ChatListModeToggle } from '@/components/chat/chat-list-mode-toggle'
import { toast } from 'sonner'

/**
 * /chat with nothing chosen opens the most recent conversation.
 *
 * The layout's rail already lists them, so an empty main pane beside a full
 * list is a dead end -- the reader picked "Chat" because they want the one
 * they were last in. In Beszélgetések mode that's the newest conversation; in
 * Agentek mode, or when there is no conversation yet, it's the default
 * agent's own thread.
 *
 * Both are a `replace`, so Back leaves /chat instead of landing here again,
 * and neither changes the list mode the reader chose. Nothing is decided
 * before the session list has loaded: on a cold load an empty store would
 * otherwise send every Beszélgetések reader to the agent thread.
 */
export default function ChatIndexPage() {
  const router = useRouter()
  const isDesktop = useMediaQuery('(min-width: 768px)')
  const sessions = useAppStore((s) => s.sessions)
  const loadSessions = useAppStore((s) => s.loadSessions)
  const ensureAgentThread = useAppStore((s) => s.ensureAgentThread)
  const mode = useAppStore((s) => s.chatListMode)
  const agents = useAppStore((s) => s.agents)
  const defaultAgentId = useAppStore((s) => s.appSettings.defaultAgentId)
  const [sessionsLoaded, setSessionsLoaded] = useState(false)
  const opened = useRef(false)
  // The thread lookup is async; a reader who picked something meanwhile keeps it.
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    let live = true
    loadSessions()
      .catch(() => { /* the list shows its own state; the redirect still decides */ })
      .finally(() => { if (live) setSessionsLoaded(true) })
    return () => { live = false }
  }, [loadSessions])

  useEffect(() => {
    if (!isDesktop || !sessionsLoaded || opened.current) return
    const newest = listConversations(sessions)[0]
    if (mode === 'conversations' && newest) {
      opened.current = true
      router.replace(`/chat/${encodeURIComponent(newest.id)}`)
      return
    }
    const agentId = defaultAgentId && agents[defaultAgentId] ? defaultAgentId : Object.keys(agents)[0]
    if (!agentId) return
    opened.current = true
    void ensureAgentThread(agentId).then((thread) => {
      if (!mounted.current) return
      if (!thread) {
        toast.error('Nem sikerült megnyitni az agent szálát.', { description: 'Válassz egyet a listából, vagy próbáld újra egy perc múlva.' })
        return
      }
      router.replace(`/chat/${encodeURIComponent(thread.id)}`)
    })
  }, [isDesktop, sessionsLoaded, sessions, router, mode, agents, defaultAgentId, ensureAgentThread])

  // A keskeny nézetben nincs oldalsáv, tehát a lista MAGA a lap -- a
  // módváltó is ide kerül, különben a telefon abban a módban ragadna.
  if (!isDesktop) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <ChatListModeToggle className="shrink-0 px-4 pt-3 pb-2" />
        <div className="flex min-h-0 flex-1 flex-col">
          {mode === 'agents' ? <AgentChatList /> : <ConversationList />}
        </div>
      </div>
    )
  }
  return null
}
