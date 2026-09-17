'use client'

import { useParams, useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { SidebarPanelShell } from '@/components/layout/sidebar-panel-shell'
import { MainContent } from '@/components/layout/main-content'
import { ConversationList } from '@/components/chat/conversation-list'
import { AgentChatList } from '@/components/agents/agent-chat-list'
import { ChatListModeToggle } from '@/components/chat/chat-list-mode-toggle'
import { useAppStore } from '@/stores/use-app-store'
import { useNavigate } from '@/lib/app/navigation'
import { errorMessage } from '@/lib/shared-utils'

/**
 * The Chat page wears the agents layout: a 280px list beside the transcript.
 *
 * The list has two modes, toggled by the "Conversations | Agents" tabs in the
 * header: past conversations, or one row per agent showing its own thread.
 * Both land on the same transcript -- this layout renders one chat surface
 * regardless of which list the row came from.
 *
 * "New chat" sits here, over the list, where the Agents page puts "+ Agent" --
 * a list's own header is where you add to that list. It was in the transcript's
 * header, which is the one place you are certainly not looking when you want to
 * leave the conversation you are reading. The "+" itself follows the active
 * list: a new chat in Conversations mode, a new agent in Agents mode.
 *
 * WHICH agent a new chat starts with is not asked here. The new conversation
 * inherits the one you are in, and the composer's picker changes it -- one
 * chooser, not two that can disagree.
 */
export default function ChatLayout({ children }: { children: React.ReactNode }) {
  const params = useParams<{ id?: string }>()
  const router = useRouter()
  const startNewChatSession = useAppStore((s) => s.startNewChatSession)
  const mode = useAppStore((s) => s.chatListMode)
  const navigateTo = useNavigate()
  const activeId = params?.id ? decodeURIComponent(params.id) : null

  async function startNew() {
    try {
      const next = await startNewChatSession()
      if (!next) {
        toast.error('Előbb nyiss meg egy beszélgetést, hogy legyen kivel folytatni.')
        return
      }
      router.push(`/chat/${encodeURIComponent(next.id)}`)
    } catch (err) {
      toast.error(`Nem sikerült új beszélgetést nyitni: ${errorMessage(err)}`)
    }
  }

  return (
    <>
      <SidebarPanelShell
        title="Chat"
        subtitle={mode === 'agents' ? 'Agents, each with its own thread' : 'Conversations, most recent first'}
        createLabel={mode === 'agents' ? 'Agent' : 'Chat'}
        onNew={() => { if (mode === 'agents') navigateTo('agents', 'new'); else void startNew() }}
        headerContent={<ChatListModeToggle className="px-4 pb-2" />}
      >
        {mode === 'agents' ? <AgentChatList /> : <ConversationList activeId={activeId} />}
      </SidebarPanelShell>
      <MainContent>{children}</MainContent>
    </>
  )
}
