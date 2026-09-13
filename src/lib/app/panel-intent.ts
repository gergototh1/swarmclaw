import { resolveSidebarActiveView } from '@/lib/app/navigation'
import type { PanelIntent } from '@/lib/app/tab-protocol'
import { FULL_WIDTH_VIEWS, isPanelSidebarView } from '@/lib/app/view-constants'
import type { AppView } from '@/types'

/**
 * What a rail click on `view` does to the side panel.
 *
 * A view with a panel toggles it (a second click on the view you are on
 * collapses it), a full-width view closes it, and anything else opens it. The
 * rail applies this to its own store in a plain window, and hands it to the
 * active tab in the tab host, where the panel renders inside the frame.
 */
export function panelIntentForView(view: AppView): PanelIntent {
  if (isPanelSidebarView(view)) return 'toggle'
  if (FULL_WIDTH_VIEWS.has(view)) return 'close'
  return 'open'
}

/** Whether the panel is open after `intent`, clicked while standing on `currentView`. */
export function sidebarOpenAfter(
  intent: PanelIntent,
  opts: { currentView: AppView | null; targetView: AppView | null; sidebarOpen: boolean },
): boolean {
  if (intent === 'toggle') return !(opts.currentView !== null && opts.currentView === opts.targetView && opts.sidebarOpen)
  return intent === 'open'
}

/** `sidebarOpenAfter` for a tab: both views are read from the paths the tab is on and is going to. */
export function sidebarOpenForNavigate(intent: PanelIntent, currentPathname: string, targetHref: string, sidebarOpen: boolean): boolean {
  const targetPathname = targetHref.split(/[?#]/)[0] || '/'
  return sidebarOpenAfter(intent, {
    currentView: resolveSidebarActiveView(currentPathname),
    targetView: resolveSidebarActiveView(targetPathname),
    sidebarOpen,
  })
}
