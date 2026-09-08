'use client'

import { useState } from 'react'
import { useChatroomStore } from '@/stores/use-chatroom-store'
import { ChatroomList } from '@/components/chatrooms/chatroom-list'
import { ChatroomView } from '@/components/chatrooms/chatroom-view'
import { MainContent } from '@/components/layout/main-content'
import { SidebarPanelShell } from '@/components/layout/sidebar-panel-shell'

export default function ChatroomsPage() {
  const [viewMode, setViewMode] = useState<'chatrooms' | 'sessions'>('chatrooms')

  return (
    <MainContent>
      <div className="flex-1 flex h-full min-w-0">
        <SidebarPanelShell
          title={viewMode === 'sessions' ? 'Sessions' : 'Chatrooms'}
          createLabel={viewMode === 'chatrooms' ? 'New' : undefined}
          onNew={viewMode === 'chatrooms' ? () => {
            useChatroomStore.getState().setEditingChatroomId(null)
            useChatroomStore.getState().setChatroomSheetOpen(true)
          } : undefined}
          headerContent={
            <div className="flex items-center gap-1 px-5 pb-2 shrink-0">
              {(['chatrooms', 'sessions'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setViewMode(mode)}
                  data-active={viewMode === mode || undefined}
                  className="rounded-full border-none px-3 py-1.5 text-[11px] font-600 capitalize cursor-pointer transition-all focus-visible:ring-1 focus-visible:ring-accent-bright/50
                    data-[active]:bg-accent-soft data-[active]:text-accent-bright
                    bg-transparent text-text-3 hover:text-text-2 hover:bg-layer-2"
                >
                  {mode}
                </button>
              ))}
            </div>
          }
        >
          <ChatroomList viewMode={viewMode} />
        </SidebarPanelShell>
        <ChatroomView />
      </div>
    </MainContent>
  )
}
