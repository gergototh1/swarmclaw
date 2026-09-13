import { hmrSingleton } from '@/lib/shared-utils'

export interface TabNavigator {
  navigateActive(href: string): void
  openInNewTab(href: string, opts?: { activate?: boolean }): void
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
export function routeLinkClick(e: ClickLike, href: string): 'active' | 'background' | false {
  const navigator = slot.current
  if (!navigator) return false
  e.preventDefault()
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) {
    navigator.openInNewTab(href, { activate: false })
    return 'background'
  }
  navigator.navigateActive(href)
  return 'active'
}

export function navigateInActiveTab(href: string): boolean {
  const navigator = slot.current
  if (!navigator) return false
  navigator.navigateActive(href)
  return true
}
