import type { PanelIntent } from '@/lib/app/tab-protocol'
import { hmrSingleton } from '@/lib/shared-utils'

export interface NavigateOptions {
  /** What the active tab does with its side panel; see `PanelIntent`. */
  panel?: PanelIntent
}

export interface TabNavigator {
  navigateActive(href: string, opts?: NavigateOptions): void
  openInNewTab(href: string, opts?: { activate?: boolean }): void
  /**
   * Moves keyboard focus into the active tab's frame, unless something in the
   * host window (a dialog, a sheet) already holds it.
   */
  focusActive(): void
}

export interface ClickLike {
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  button: number
  preventDefault(): void
}

const slot = hmrSingleton('tabNavigation_slot', () => ({ current: null as TabNavigator | null }))

/** Set by the tab host while it is mounted; null everywhere else, including inside a tab. */
export function setTabNavigator(navigator: TabNavigator | null): void {
  slot.current = navigator
}

export function getTabNavigator(): TabNavigator | null {
  return slot.current
}

/**
 * A link click in the host's own chrome (the rail): into the active tab, or a
 * background tab for a modified or middle click. Says which it did, so a
 * caller can skip its own click handling for a background tab (the active tab
 * did not move); false, leaving the link alone, when there is no host.
 */
export function routeLinkClick(e: ClickLike, href: string, opts: NavigateOptions = {}): 'active' | 'background' | false {
  const navigator = slot.current
  if (!navigator) return false
  e.preventDefault()
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) {
    navigator.openInNewTab(href, { activate: false })
    return 'background'
  }
  navigator.navigateActive(href, opts)
  return 'active'
}

export function navigateInActiveTab(href: string, opts: NavigateOptions = {}): boolean {
  const navigator = slot.current
  if (!navigator) return false
  navigator.navigateActive(href, opts)
  return true
}

/** Focus back into the active tab, in the tab host; false (and nothing moves) everywhere else. */
export function focusActiveTab(): boolean {
  const navigator = slot.current
  if (!navigator) return false
  navigator.focusActive()
  return true
}
