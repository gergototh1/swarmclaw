'use client'

import { useAppStore } from '@/stores/use-app-store'

/**
 * The section's title and its create action, rendered ONLY when the panel
 * beside the rail is hidden.
 *
 * Six pages carried a byte-identical copy of the panel's header inline, so
 * with the panel open you saw "Schedules / + Schedule" twice, side by side,
 * about eighty pixels apart. That reads as a bug even when you cannot say
 * which of the two is wrong, and it was the loudest thing making these
 * surfaces feel unfinished.
 *
 * Deleting the inline copy would have been wrong, which is why it survived
 * six pages of review: with the panel collapsed, the main content is the only
 * place a title or a create button can live, and removing them would take the
 * action away entirely at the moment the user has the most screen for it.
 *
 * So this is the exact inverse of SidebarPanelShell's own guard. Exactly one
 * of the two renders, always. If that invariant is ever broken it will be by
 * someone changing one guard and not the other, which is why both read the
 * same single store field rather than each keeping its own idea of the state.
 */
interface PageHeaderProps {
  title: string
  /** Label after the plus. "Schedule", not "New schedule" -- the icon says new. */
  createLabel?: string
  onNew?: () => void
}

export function PageHeader({ title, createLabel, onNew }: PageHeaderProps) {
  const sidebarOpen = useAppStore((s) => s.sidebarOpen)

  // The panel is showing this already. See the note above: this is the inverse
  // of the `if (!sidebarOpen) return null` in SidebarPanelShell.
  if (sidebarOpen) return null

  return (
    <div className="flex items-center px-6 pt-5 pb-3 shrink-0">
      <h2 className="font-display text-[14px] font-600 text-text-2 tracking-[-0.01em] flex-1">
        {title}
      </h2>
      {onNew && createLabel && (
        <button
          onClick={onNew}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-600 text-accent-bright bg-accent-soft hover:bg-accent-bright/15 transition-all cursor-pointer"
          style={{ fontFamily: 'inherit' }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          {createLabel}
        </button>
      )}
    </div>
  )
}
