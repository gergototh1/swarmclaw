'use client'

import { useCallback } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/stores/use-app-store'
import { useNavigate } from '@/lib/app/navigation'
import { errorMessage } from '@/lib/shared-utils'

/**
 * The two ways into a chat with a given agent. Both land on `/chat/:sessionId`;
 * they differ in which session and which list the Chat panel shows.
 */
export function useAgentChat() {
  const navigateTo = useNavigate()

  const openAgentThread = useCallback(async (agentId: string): Promise<string | null> => {
    const thread = await useAppStore.getState().ensureAgentThread(agentId)
    if (!thread) {
      toast.error('Couldn’t open the agent’s thread.', { description: 'Try again in a moment.' })
      return null
    }
    useAppStore.getState().setChatListMode('agents')
    navigateTo('conversations', thread.id)
    return thread.id
  }, [navigateTo])

  const startAgentChat = useCallback(async (agentId: string): Promise<string | null> => {
    try {
      const next = await useAppStore.getState().startNewChatWithAgent(agentId)
      if (!next) {
        toast.error('Couldn’t start a new chat with this agent.')
        return null
      }
      useAppStore.getState().setChatListMode('conversations')
      navigateTo('conversations', next.id)
      return next.id
    } catch (err) {
      toast.error(`Couldn’t start a new chat: ${errorMessage(err)}`)
      return null
    }
  }, [navigateTo])

  return { openAgentThread, startAgentChat }
}
