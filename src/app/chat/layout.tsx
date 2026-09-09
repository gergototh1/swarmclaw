'use client'

import { useParams, useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { SidebarPanelShell } from '@/components/layout/sidebar-panel-shell'
import { MainContent } from '@/components/layout/main-content'
import { ConversationList } from '@/components/chat/conversation-list'
import { useAppStore } from '@/stores/use-app-store'
import { errorMessage } from '@/lib/shared-utils'

/**
 * The Chat page wears the agents layout: a 280px list beside the transcript.
 *
 * "New chat" sits here, over the list, where the Agents page puts "+ Agent" --
 * a list's own header is where you add to that list. It was in the transcript's
 * header, which is the one place you are certainly not looking when you want to
 * leave the conversation you are reading.
 *
 * WHICH agent it starts with is not asked here. The new conversation inherits
 * the one you are in, and the composer's picker changes it -- one chooser, not
 * two that can disagree.
 */
export default function ChatLayout({ children }: { children: React.ReactNode }) {
  const params = useParams<{ id?: string }>()
  const router = useRouter()
  const startNewChatSession = useAppStore((s) => s.startNewChatSession)
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
        subtitle="Beszélgetések, legutóbbi elöl"
        createLabel="Chat"
        onNew={() => { void startNew() }}
      >
        <ConversationList activeId={activeId} />
      </SidebarPanelShell>
      <MainContent>{children}</MainContent>
    </>
  )
}
