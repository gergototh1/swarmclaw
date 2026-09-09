'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useAppStore } from '@/stores/use-app-store'
import { listConversations } from '@/lib/conversation-list'
import { ConversationList } from '@/components/chat/conversation-list'
import { useMediaQuery } from '@/hooks/use-media-query'

/**
 * /chat with nothing chosen opens the most recent conversation.
 *
 * The layout's rail already lists them, so an empty main pane beside a full
 * list is a dead end -- the reader picked "Chat" because they want the one
 * they were last in.
 */
export default function ChatIndexPage() {
  const router = useRouter()
  const isDesktop = useMediaQuery('(min-width: 768px)')
  const sessions = useAppStore((s) => s.sessions)
  const loadSessions = useAppStore((s) => s.loadSessions)

  useEffect(() => { void loadSessions() }, [loadSessions])

  useEffect(() => {
    if (!isDesktop) return
    const newest = listConversations(sessions)[0]
    if (newest) router.replace(`/chat/${encodeURIComponent(newest.id)}`)
  }, [isDesktop, sessions, router])

  // A keskeny nézetben nincs oldalsáv, tehát a lista MAGA a lap.
  if (!isDesktop) return <ConversationList />
  return null
}
