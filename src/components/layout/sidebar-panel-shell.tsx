'use client'

import type { ReactNode } from 'react'
import { useAppStore } from '@/stores/use-app-store'

/**
 * The one panel that opens beside the rail.
 *
 * Eleven route layouts already rendered through this; missions, chatrooms and
 * projects each built their own, which is why the column changed shape as you
 * moved between sections -- a subtitle here, a differently-shaped button
 * there, a title at a different weight. `subtitle` exists so the pages that
 * had one do not need a private panel to keep it.
 *
 * `headerContent` is the escape hatch and stays deliberately unopinionated:
 * agents puts two tab rows and a search field in it. What it must not carry is
 * a second title or a second primary action, because the main content area
 * already renders both -- see the note on the header below.
 */
interface SidebarPanelShellProps {
  title: string
  /** One line under the title. Sentence case, no trailing period. */
  subtitle?: string
  createLabel?: string
  onNew?: () => void
  headerContent?: ReactNode
  children: ReactNode
}

export function SidebarPanelShell({ title, subtitle, createLabel, onNew, headerContent, children }: SidebarPanelShellProps) {
  const sidebarOpen = useAppStore((s) => s.sidebarOpen)

  if (!sidebarOpen) return null

  return (
    <div
      className="w-[280px] shrink-0 bg-band border-r border-line-subtle flex flex-col h-full min-h-0 overflow-hidden touch-pan-y"
      style={{ animation: 'panel-in 0.3s var(--ease-spring)' }}
    >
      <div className="flex items-start gap-3 px-5 pt-5 pb-3 shrink-0">
        <div className="flex-1 min-w-0">
          <h2 className="font-display text-[14px] font-600 text-text-2 tracking-[-0.01em] truncate">{title}</h2>
          {subtitle && (
            <p className="mt-0.5 text-[11px] text-text-3 tracking-[-0.01em] truncate">{subtitle}</p>
          )}
        </div>
        {onNew && createLabel && (
          <button
            onClick={onNew}
            className="flex shrink-0 items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-600 text-accent-bright bg-accent-soft hover:bg-accent-bright/15 transition-all cursor-pointer"
            style={{ fontFamily: 'inherit' }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            {createLabel}
          </button>
        )}
      </div>
      {headerContent}
      {children}
    </div>
  )
}
