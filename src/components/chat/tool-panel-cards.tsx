'use client'

import { useChatStore } from '@/stores/use-chat-store'
import { toolPanelRefKey, type ToolPanelRef } from '@/lib/chat/tool-panel-refs'

/**
 * One card per thing the message's tools produced that an extension can open.
 *
 * Outside the tool-events section on purpose: that section is collapsed by
 * default, and a doc the agent wrote is the result of the turn, not one of its
 * steps.
 */
export function ToolPanelCards({ refs }: { refs: ToolPanelRef[] }) {
  const setPreviewContent = useChatStore((s) => s.setPreviewContent)
  if (refs.length === 0) return null
  return (
    <div className="mt-2 flex flex-col gap-1.5 max-w-[85%] md:max-w-[72%]" data-testid="tool-panel-cards">
      {refs.map((ref) => (
        <button
          key={toolPanelRefKey(ref)}
          type="button"
          onClick={() => setPreviewContent({ type: 'extension', title: ref.title, ref })}
          className="flex items-center gap-2.5 rounded-md border border-line-subtle bg-surface px-3 py-2 text-left
            hover:border-line-default hover:bg-layer-1 transition-colors cursor-pointer"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-text-3 shrink-0" aria-hidden="true">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
          <span className="text-[13px] text-text truncate flex-1">{ref.title}</span>
          <span className="text-[11px] font-600 text-accent-bright shrink-0">Open</span>
        </button>
      ))}
    </div>
  )
}
