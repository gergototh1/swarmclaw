'use client'

import { useAppStore } from '@/stores/use-app-store'

/**
 * The "Conversations | Agents" switch over the Chat list. Rendered in the
 * list panel's header on desktop and above the list itself on a narrow
 * screen, where the list is the whole page -- without it there a phone
 * would stay in whichever mode it was last left in.
 */
export function ChatListModeToggle({ className = '' }: { className?: string }) {
  const mode = useAppStore((s) => s.chatListMode)
  const setMode = useAppStore((s) => s.setChatListMode)
  return (
    <div className={`flex gap-1 ${className}`} role="tablist" aria-label="Chat list">
      {([['conversations', 'Conversations'], ['agents', 'Agents']] as const).map(([value, label]) => (
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
  )
}
