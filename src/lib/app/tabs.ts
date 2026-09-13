import { z } from 'zod'

/**
 * The tab model, as pure transitions.
 *
 * A tab is what the reader would get back after a reload: a URL and, for an
 * extension page, the raw title the page last reported. The live iframe is not
 * part of it -- the host decides which tabs have one (`liveTabIds`), and a tab
 * without one is restored from its URL when it is activated.
 *
 * Every transition returns the same object when nothing changed, so a store
 * can skip writing and re-rendering.
 */

export interface Tab {
  id: string
  url: string
  title: string | null
}

export interface TabsState {
  tabs: Tab[]
  activeId: string
  /** Tab ids, most recently used first. */
  lastUsed: string[]
  /** Closed tabs, most recently closed first. */
  closed: Tab[]
}

export const HOME_URL = '/home'
export const MAX_LIVE_FRAMES = 6
export const CLOSED_TABS_CAP = 10
/** Tabs in the strip. Stored state is refused beyond this, so the strip never grows past it either. */
export const MAX_TABS = 200

/**
 * A tab id. `crypto.randomUUID` exists only in a secure context, and the app is
 * reached over plain http on LAN addresses, where it is undefined.
 */
export function newTabId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

function touch(lastUsed: readonly string[], id: string): string[] {
  return [id, ...lastUsed.filter((x) => x !== id)]
}

export function initialTabsState(newId: () => string, url: string = HOME_URL): TabsState {
  const tab: Tab = { id: newId(), url, title: null }
  return { tabs: [tab], activeId: tab.id, lastUsed: [tab.id], closed: [] }
}

/**
 * Adds a tab after `afterId` (default: the active tab). At `MAX_TABS` nothing
 * is added: a tab already on that URL is activated instead, if activating was
 * asked for, and otherwise the state is returned unchanged.
 */
export function openTab(state: TabsState, tab: Tab, opts: { activate?: boolean; afterId?: string } = {}): TabsState {
  if (state.tabs.length >= MAX_TABS) {
    const same = state.tabs.find((t) => t.url === tab.url)
    return same && opts.activate !== false ? activateTab(state, same.id) : state
  }
  const anchor = state.tabs.findIndex((t) => t.id === (opts.afterId ?? state.activeId))
  const tabs = [...state.tabs]
  tabs.splice(anchor === -1 ? tabs.length : anchor + 1, 0, tab)
  if (opts.activate === false) return { ...state, tabs, lastUsed: [...state.lastUsed, tab.id] }
  return { ...state, tabs, activeId: tab.id, lastUsed: touch(state.lastUsed, tab.id) }
}

export function activateTab(state: TabsState, id: string): TabsState {
  if (!state.tabs.some((t) => t.id === id)) return state
  if (state.activeId === id && state.lastUsed[0] === id) return state
  return { ...state, activeId: id, lastUsed: touch(state.lastUsed, id) }
}

export function closeTab(state: TabsState, id: string, newId: () => string): TabsState {
  const index = state.tabs.findIndex((t) => t.id === id)
  if (index === -1) return state
  const closed = [state.tabs[index], ...state.closed].slice(0, CLOSED_TABS_CAP)
  const tabs = state.tabs.filter((t) => t.id !== id)
  const lastUsed = state.lastUsed.filter((x) => x !== id)
  if (tabs.length === 0) {
    const home: Tab = { id: newId(), url: HOME_URL, title: null }
    return { tabs: [home], activeId: home.id, lastUsed: [home.id], closed }
  }
  if (state.activeId !== id) return { ...state, tabs, lastUsed, closed }
  const next = tabs[Math.min(index, tabs.length - 1)]
  return { tabs, activeId: next.id, lastUsed: touch(lastUsed, next.id), closed }
}

export function reopenClosedTab(state: TabsState): TabsState {
  const [tab, ...closed] = state.closed
  // At the cap the tab would not fit; it stays on the stack for later.
  if (!tab || state.tabs.length >= MAX_TABS) return state
  return openTab({ ...state, closed }, tab)
}

export function moveTab(state: TabsState, id: string, toIndex: number): TabsState {
  const from = state.tabs.findIndex((t) => t.id === id)
  if (from === -1) return state
  const tabs = [...state.tabs]
  const [tab] = tabs.splice(from, 1)
  const to = Math.max(0, Math.min(toIndex, tabs.length))
  if (to === from) return state
  tabs.splice(to, 0, tab)
  return { ...state, tabs }
}

export function setTabUrl(state: TabsState, id: string, url: string): TabsState {
  const tab = state.tabs.find((t) => t.id === id)
  if (!tab || tab.url === url) return state
  return { ...state, tabs: state.tabs.map((t) => (t.id === id ? { ...t, url } : t)) }
}

export function setTabTitle(state: TabsState, id: string, title: string | null): TabsState {
  const tab = state.tabs.find((t) => t.id === id)
  if (!tab || tab.title === title) return state
  return { ...state, tabs: state.tabs.map((t) => (t.id === id ? { ...t, title } : t)) }
}

/** 1–8 by position; 9 is the last tab, as in browsers. */
export function activateByPosition(state: TabsState, position: number): TabsState {
  const tab = position === 9 ? state.tabs[state.tabs.length - 1] : state.tabs[position - 1]
  return tab ? activateTab(state, tab.id) : state
}

export function activateRelative(state: TabsState, delta: 1 | -1): TabsState {
  const index = state.tabs.findIndex((t) => t.id === state.activeId)
  const next = state.tabs[(index + delta + state.tabs.length) % state.tabs.length]
  return activateTab(state, next.id)
}

/** The tabs that keep a live frame: the most recently used, active first. */
export function liveTabIds(state: TabsState, cap: number = MAX_LIVE_FRAMES): string[] {
  const known = new Set(state.tabs.map((t) => t.id))
  const ordered = touch(state.lastUsed.filter((id) => known.has(id)), state.activeId)
  return ordered.slice(0, cap)
}

/** The host loaded at `url`: that tab if one is already there, else a new tab for it. */
export function landOnUrl(state: TabsState, url: string, newId: () => string): TabsState {
  const match = state.tabs.find((t) => t.url === url)
  if (match) return activateTab(state, match.id)
  return openTab(state, { id: newId(), url, title: null })
}

const appUrl = z.string().regex(/^\/(?!\/)/)
const tabSchema = z.object({ id: z.string().min(1), url: appUrl, title: z.string().nullable() })
const stateSchema = z.object({
  tabs: z.array(tabSchema).min(1).max(MAX_TABS),
  activeId: z.string(),
  lastUsed: z.array(z.string()).max(200),
  closed: z.array(tabSchema).max(50),
})

export function tabsStateFromStorage(raw: unknown): TabsState | null {
  const parsed = stateSchema.safeParse(raw)
  if (!parsed.success) return null
  const { tabs, activeId, lastUsed, closed } = parsed.data
  if (!tabs.some((t) => t.id === activeId)) return null
  const known = new Set(tabs.map((t) => t.id))
  // Check for duplicate tab ids
  if (known.size !== tabs.length) return null
  // De-duplicate lastUsed while preserving order (keep first occurrence)
  const seen = new Set<string>()
  const deduplicatedLastUsed: string[] = []
  for (const id of lastUsed) {
    if (!seen.has(id) && known.has(id)) {
      seen.add(id)
      deduplicatedLastUsed.push(id)
    }
  }
  return { tabs, activeId, lastUsed: deduplicatedLastUsed, closed: closed.slice(0, CLOSED_TABS_CAP) }
}
