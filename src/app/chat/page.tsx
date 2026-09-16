'use client'

import { useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { useAppStore } from '@/stores/use-app-store'
import { listConversations } from '@/lib/conversation-list'
import { ConversationList } from '@/components/chat/conversation-list'
import { AgentChatList } from '@/components/agents/agent-chat-list'
import { useMediaQuery } from '@/hooks/use-media-query'
import { useAgentChat } from '@/hooks/use-agent-chat'

/**
 * /chat with nothing chosen opens the most recent conversation.
 *
 * The layout's rail already lists them, so an empty main pane beside a full
 * list is a dead end -- the reader picked "Chat" because they want the one
 * they were last in. In Beszélgetések mode that's the newest conversation; in
 * Agentek mode, or when there is no conversation yet, it's the default
 * agent's own thread.
 */
export default function ChatIndexPage() {
  const router = useRouter()
  const isDesktop = useMediaQuery('(min-width: 768px)')
  const sessions = useAppStore((s) => s.sessions)
  const loadSessions = useAppStore((s) => s.loadSessions)
  const mode = useAppStore((s) => s.chatListMode)
  const agents = useAppStore((s) => s.agents)
  const defaultAgentId = useAppStore((s) => s.appSettings.defaultAgentId)
  const { openAgentThread } = useAgentChat()
  const opened = useRef(false)

  useEffect(() => { void loadSessions() }, [loadSessions])

  useEffect(() => {
    if (!isDesktop || opened.current) return
    const newest = listConversations(sessions)[0]
    if (mode === 'conversations' && newest) {
      opened.current = true
      router.replace(`/chat/${encodeURIComponent(newest.id)}`)
      return
    }
    const agentId = defaultAgentId && agents[defaultAgentId] ? defaultAgentId : Object.keys(agents)[0]
    if (!agentId) return
    opened.current = true
    void openAgentThread(agentId)
  }, [isDesktop, sessions, router, mode, agents, defaultAgentId, openAgentThread])

  // A keskeny nézetben nincs oldalsáv, tehát a lista MAGA a lap.
  if (!isDesktop) return mode === 'agents' ? <AgentChatList /> : <ConversationList />
  return null
}
