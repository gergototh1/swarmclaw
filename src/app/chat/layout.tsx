'use client'

import { useParams, useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { SidebarPanelShell } from '@/components/layout/sidebar-panel-shell'
import { MainContent } from '@/components/layout/main-content'
import { ConversationList } from '@/components/chat/conversation-list'
import { AgentChatList } from '@/components/agents/agent-chat-list'
import { useAppStore } from '@/stores/use-app-store'
import { useNavigate } from '@/lib/app/navigation'
import { errorMessage } from '@/lib/shared-utils'

/**
 * The Chat page wears the agents layout: a 280px list beside the transcript.
 *
 * The list has two modes, toggled by the "Beszélgetések | Agentek" tabs in the
 * header: past conversations, or one row per agent showing its own thread.
 * Both land on the same transcript -- this layout renders one chat surface
 * regardless of which list the row came from.
 *
 * "New chat" sits here, over the list, where the Agents page puts "+ Agent" --
 * a list's own header is where you add to that list. It was in the transcript's
 * header, which is the one place you are certainly not looking when you want to
 * leave the conversation you are reading. The "+" itself follows the active
 * list: a new chat in Beszélgetések mode, a new agent in Agentek mode.
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
  const setMode = useAppStore((s) => s.setChatListMode)
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
        subtitle={mode === 'agents' ? 'Agentek, mindegyik a saját szálával' : 'Beszélgetések, legutóbbi elöl'}
        createLabel={mode === 'agents' ? 'Agent' : 'Chat'}
        onNew={() => { if (mode === 'agents') navigateTo('agents', 'new'); else void startNew() }}
        headerContent={
          <div className="flex gap-1 px-4 pb-2" role="tablist" aria-label="Chat lista">
            {([['conversations', 'Beszélgetések'], ['agents', 'Agentek']] as const).map(([value, label]) => (
              <button
                key={value}
                role="tab"
                aria-selected={mode === value}
                data-testid={`chat-list-mode-${value}`}
                onClick={() => setMode(value)}
                className={`px-3 py-1.5 rounded-sm text-[11px] font-600 cursor-pointer transition-all
                  ${mode === value ? 'bg-accent-soft text-accent-bright' : 'bg-transparent text-text-3 hover:text-text-2'}`}
                style={{ fontFamily: 'inherit' }}
              >
                {label}
              </button>
            ))}
          </div>
        }
      >
        {mode === 'agents' ? <AgentChatList inSidebar /> : <ConversationList activeId={activeId} />}
      </SidebarPanelShell>
      <MainContent>{children}</MainContent>
    </>
  )
}
