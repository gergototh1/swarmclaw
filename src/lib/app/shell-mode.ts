import { TAB_WINDOW_NAME_PREFIX } from '@/lib/app/tab-protocol'

export type ShellMode = 'host' | 'tab' | 'plain'

export interface WindowLike {
  name: string
  parent: unknown
  self: unknown
}

/** The tab id of a frame the tab host created; null for any other window. */
export function tabIdFromWindow(win: WindowLike | undefined): string | null {
  if (!win || win.parent === win.self || !win.name.startsWith(TAB_WINDOW_NAME_PREFIX)) return null
  return win.name.slice(TAB_WINDOW_NAME_PREFIX.length) || null
}

/**
 * How this window renders the app.
 *
 * `tab`: a frame the host named -- only the route's content, whatever the width,
 * since the host decided. `host`: the top window at desktop width with tabs on.
 * `plain`: everything else, including a window framed by something that is not
 * the host, which must never start a tab host of its own.
 */
export function detectShellMode(win: WindowLike | undefined, opts: { isDesktop: boolean; tabsEnabled: boolean }): ShellMode {
  if (!win) return 'plain'
  if (tabIdFromWindow(win)) return 'tab'
  if (win.parent !== win.self) return 'plain'
  return opts.isDesktop && opts.tabsEnabled ? 'host' : 'plain'
}
