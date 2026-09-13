import { TAB_WINDOW_NAME_PREFIX } from '@/lib/app/tab-protocol'

export type ShellMode = 'host' | 'tab' | 'plain'

export interface WindowLike {
  name: string
  parent: WindowLike
  self: unknown
  location: { origin: string }
}

/**
 * The tab id of a frame the tab host created; null for any other window.
 *
 * A foreign page could embed the app in an iframe named `sc-tab:x` to make
 * this return a tab id it does not own -- the frame still only posts to and
 * accepts messages from its own origin, but a real tab must also have a
 * same-origin parent, so that is checked here too. Reading a cross-origin
 * parent's `location.origin` throws in a browser; treat that the same as a
 * mismatched origin -- not a tab.
 */
export function tabIdFromWindow(win: WindowLike | undefined): string | null {
  if (!win || win.parent === win.self || !win.name.startsWith(TAB_WINDOW_NAME_PREFIX)) return null
  let parentOrigin: string
  try {
    parentOrigin = win.parent.location.origin
  } catch {
    return null
  }
  if (parentOrigin !== win.location.origin) return null
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

/**
 * The mode to render, given the one last shown (null before any) and the one
 * detected now. Host mode, once shown, holds until the page reloads: leaving it
 * unmounts every tab frame at once, with no chance to flush, so narrowing the
 * window or switching tabs off in settings would drop unsaved edits in all of
 * them. The switch takes effect on the next load instead.
 */
export function nextShellMode(previous: ShellMode | null, detected: ShellMode): ShellMode {
  return previous === 'host' ? 'host' : detected
}
