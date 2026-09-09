'use client'

import { useParams } from 'next/navigation'
import { SidebarPanelShell } from '@/components/layout/sidebar-panel-shell'
import { MainContent } from '@/components/layout/main-content'
import { ConversationList } from '@/components/chat/conversation-list'

/**
 * The Chat page wears the agents layout: a 280px list beside the transcript.
 *
 * It carries no "new" action. A conversation belongs to an agent, and the
 * composer's agent picker is where that is chosen -- putting a second chooser
 * in this header would ask the same question in two places and let them
 * disagree.
 */
export default function ChatLayout({ children }: { children: React.ReactNode }) {
  const params = useParams<{ id?: string }>()
  const activeId = params?.id ? decodeURIComponent(params.id) : null

  return (
    <>
      <SidebarPanelShell title="Chat" subtitle="Beszélgetések, legutóbbi elöl">
        <ConversationList activeId={activeId} />
      </SidebarPanelShell>
      <MainContent>{children}</MainContent>
    </>
  )
}
