'use client'

import { useSyncExternalStore } from 'react'
import { api } from '@/lib/app/api-client'
import { isFrameActive, subscribeFrameActive } from '@/lib/app/frame-active'
import { createCatchUp, type CatchUp } from '@/lib/app/ws-catch-up'
import { hmrSingleton } from '@/lib/shared-utils'
import { isWsConnected, offWsStateChange, onWsStateChange, subscribeWs, unsubscribeWs } from '@/lib/ws-client'
import { resolvePageOrder, resolvePageSection } from '@/lib/extension-page-nav'
import type { NavSectionId } from '@/lib/app/nav-sections'
import type { ExtensionPageDefinition } from '@/types/extension'

/** A page declared by an installed extension, tagged with the extension that owns it. */
export type ExtensionPage = ExtensionPageDefinition & { extensionId: string }

/**
 * The extension pages that belong in one rail section, in panel order.
 *
 * Sections are disjoint by construction — resolvePageSection returns exactly
 * one id per page, and falls back to 'work' rather than to nothing — so no page
 * can be rendered twice and none can fall out of the rail. That used to depend
 * on the caller only ever passing anchors from a hand-maintained list.
 */
export function pagesForSection(pages: ExtensionPage[], section: NavSectionId): ExtensionPage[] {
  return pages
    .filter((p) => resolvePageSection(p) === section)
    .sort((a, b) => resolvePageOrder(a) - resolvePageOrder(b) || a.label.localeCompare(b.label))
}

export interface ExtensionPagesState {
  pages: ExtensionPage[]
  /**
   * False only until the first fetch settles. An empty list and a list that has
   * not arrived yet are the same value, so anything that decides a page does not
   * exist (the `/x/<slug>` route, which would otherwise flash "no such page" on
   * every load) has to wait for this. The rail does not care: it renders nothing
   * either way. Stays true across later refreshes, so a websocket-driven reload
   * never blanks a page that is already mounted.
   */
  loaded: boolean
  /**
   * Why the last fetch failed, or `undefined` when it succeeded.
   *
   * Kept because `loaded` alone cannot tell "the server says no extension
   * contributes this page" from "nobody could ask the server". Reporting the
   * second as the first is actively misleading: the server restarting is exactly
   * what happens moments after an extension is installed, and the user standing
   * on that extension's page would be told it is not installed. Cleared by the
   * next successful fetch, so a transient failure does not stick.
   */
  error?: string
}

const EMPTY_STATE: ExtensionPagesState = { pages: [], loaded: false }

const EXTENSIONS_TOPIC = 'extensions'

/**
 * How often the page list is re-fetched while the websocket is down.
 *
 * Must stay equal to the `extensions` registration in
 * `components/layout/dashboard-shell.tsx` (`useWs('extensions', refreshExtensionState, 60_000)`).
 * The two are independent timers now — this hook keeps its own fetch, its own
 * `extensions` subscription and its own fallback timer in one module-level
 * singleton shared by every mounted caller, instead of riding `useWs`'s shared
 * per-topic interval — so nothing forces them to agree any more. They still
 * have to be read together: both are "how stale can `extensions`-derived state
 * get while the socket is down", and a mismatch here would just be a second,
 * unexplained answer to that question sitting next to the shell's.
 */
const PAGES_FALLBACK_MS = 60_000

interface SharedExtensionPages {
  state: ExtensionPagesState
  listeners: Set<() => void>
  refCount: number
  active: boolean
  catchUp: CatchUp | null
  wsHandler: (() => void) | null
  connHandler: (() => void) | null
  visibilityHandler: (() => void) | null
  offFrameActive: (() => void) | null
  fallbackTimer: ReturnType<typeof setInterval> | null
}

/**
 * One fetch, one `extensions` subscription and one fallback timer per window,
 * shared by every mounted `useExtensionPages`/`useExtensionPagesState` caller
 * (today: `tab-host.tsx` and both the desktop and mobile `sidebar-rail.tsx`
 * instances rendered by `dashboard-shell.tsx`). Before this, each instance ran
 * its own copy of all three, so one `notify('extensions')` or one fallback
 * tick cost one `GET /extensions/ui?type=pages` per mounted caller.
 *
 * Ref-counted rather than started at module load: the first subscriber turns
 * the machinery on, the last one to unmount turns it off, and `hmrSingleton`
 * keeps the whole thing across a Next.js HMR reload.
 */
const shared = hmrSingleton('useExtensionPages_shared', (): SharedExtensionPages => ({
  state: EMPTY_STATE,
  listeners: new Set(),
  refCount: 0,
  active: true,
  catchUp: null,
  wsHandler: null,
  connHandler: null,
  visibilityHandler: null,
  offFrameActive: null,
  fallbackTimer: null,
}))

/**
 * Same question `usePageActive` answers, asked outside a component: this
 * module-level singleton has one lifecycle shared by every caller, not one
 * per mounted hook, so it reads the same underlying signals
 * (`document.visibilityState` and the tab-frame flag from `frame-active.ts`)
 * directly instead of going through the hook.
 */
function isActiveNow(): boolean {
  if (typeof document === 'undefined') return true
  return document.visibilityState === 'visible' && isFrameActive()
}

function notifyListeners(): void {
  for (const listener of shared.listeners) listener()
}

function setState(next: ExtensionPagesState): void {
  shared.state = next
  notifyListeners()
}

function refresh(): void {
  api<ExtensionPage[]>('GET', '/extensions/ui?type=pages')
    .then((list) => { setState({ pages: Array.isArray(list) ? list : [], loaded: true }) })
    // A failed fetch still counts as settled: retrying forever behind a spinner
    // hides the failure. The last known pages are kept so an already rendered
    // page does not blank, and the reason is kept so a caller can say what
    // actually went wrong instead of concluding the page does not exist.
    .catch((err: unknown) => {
      setState({
        pages: shared.state.pages,
        loaded: true,
        error: err instanceof Error ? err.message : String(err),
      })
    })
}

function stopFallback(): void {
  if (!shared.fallbackTimer) return
  clearInterval(shared.fallbackTimer)
  shared.fallbackTimer = null
}

/** Fallback polling only runs while active and disconnected — same gate `useWs` applies. */
function syncFallback(): void {
  const shouldPoll = shared.active && !isWsConnected()
  if (shouldPoll && !shared.fallbackTimer) {
    shared.fallbackTimer = setInterval(refresh, PAGES_FALLBACK_MS)
  } else if (!shouldPoll) {
    stopFallback()
  }
}

function onConnStateChange(): void {
  syncFallback()
  // A server restart reconnects the socket within seconds, long before the
  // fallback interval would next tick. Re-fetch as soon as the connection
  // comes back, whenever the last attempt is known to have failed.
  if (isWsConnected() && shared.state.error) refresh()
}

function applyActive(next: boolean): void {
  const becameActive = !shared.active && next
  shared.active = next
  // Mirrors `useWs`'s own `stale` computation: a reactivation right after the
  // frame's own socket was closed (idle-socket.ts) cannot trust "nothing was
  // missed" bookkeeping, because no push event could have arrived to be
  // recorded as missed while there was no socket to receive it on.
  const stale = becameActive && !isWsConnected()
  shared.catchUp?.onActiveChange(next, stale)
  syncFallback()
}

function start(): void {
  shared.active = isActiveNow()
  shared.catchUp = createCatchUp(refresh)
  refresh()

  shared.wsHandler = () => shared.catchUp?.onEvent(shared.active)
  subscribeWs(EXTENSIONS_TOPIC, shared.wsHandler)

  shared.connHandler = onConnStateChange
  onWsStateChange(shared.connHandler)

  shared.visibilityHandler = () => applyActive(isActiveNow())
  document.addEventListener('visibilitychange', shared.visibilityHandler)
  shared.offFrameActive = subscribeFrameActive(() => applyActive(isActiveNow()))

  syncFallback()
}

function stop(): void {
  if (shared.wsHandler) { unsubscribeWs(EXTENSIONS_TOPIC, shared.wsHandler); shared.wsHandler = null }
  if (shared.connHandler) { offWsStateChange(shared.connHandler); shared.connHandler = null }
  if (shared.visibilityHandler) { document.removeEventListener('visibilitychange', shared.visibilityHandler); shared.visibilityHandler = null }
  if (shared.offFrameActive) { shared.offFrameActive(); shared.offFrameActive = null }
  stopFallback()
  shared.catchUp = null
}

function subscribe(listener: () => void): () => void {
  shared.listeners.add(listener)
  shared.refCount += 1
  if (shared.refCount === 1) start()
  return () => {
    shared.listeners.delete(listener)
    shared.refCount = Math.max(0, shared.refCount - 1)
    if (shared.refCount === 0) stop()
  }
}

function getSnapshot(): ExtensionPagesState {
  return shared.state
}

function getServerSnapshot(): ExtensionPagesState {
  return EMPTY_STATE
}

/** Pages contributed by installed extensions, refreshed when extensions change. */
export function useExtensionPagesState(): ExtensionPagesState {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}

/** Pages contributed by installed extensions, refreshed when extensions change. */
export function useExtensionPages(): ExtensionPage[] {
  return useExtensionPagesState().pages
}
