'use client'

import { useSyncExternalStore } from 'react'
import { api } from '@/lib/app/api-client'
import {
  createExtensionPagesStore,
  type ExtensionPage,
  type ExtensionPagesState,
} from '@/lib/app/extension-pages-store'
import { isFrameActive, subscribeFrameActive } from '@/lib/app/frame-active'
import { hadSocketGap } from '@/lib/app/socket-gap'
import { hmrSingleton } from '@/lib/shared-utils'
import { isWsConnected, offWsStateChange, onWsStateChange, subscribeWs, unsubscribeWs } from '@/lib/ws-client'
import { resolvePageOrder, resolvePageSection } from '@/lib/extension-page-nav'
import type { NavSectionId } from '@/lib/app/nav-sections'

export type { ExtensionPage, ExtensionPagesState }

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

const EXTENSIONS_TOPIC = 'extensions'

/**
 * How often the page list is re-fetched while the websocket is down.
 *
 * Must stay equal to the `extensions` registration in
 * `components/layout/dashboard-shell.tsx` (`useWs('extensions', refreshExtensionState, 60_000)`).
 * The two are independent timers — this hook keeps its own fetch, its own
 * `extensions` subscription and its own fallback timer in one window-level
 * store shared by every mounted caller, instead of riding `useWs`'s shared
 * per-topic interval — so nothing in the running code forces them to agree.
 * `use-extension-pages.test.ts` is what does; both numbers answer the same
 * question ("how stale can `extensions`-derived state get while the socket is
 * down") and a mismatch would just be a second, unexplained answer to it.
 */
export const PAGES_FALLBACK_MS = 60_000

/**
 * Same question `usePageActive` answers, asked outside a component: this store
 * has one lifecycle shared by every caller, not one per mounted hook, so it
 * reads the same underlying signals (`document.visibilityState` and the
 * tab-frame flag from `frame-active.ts`) directly instead of going through the
 * hook.
 */
function isActiveNow(): boolean {
  if (typeof document === 'undefined') return true
  return document.visibilityState === 'visible' && isFrameActive()
}

/** `hmrSingleton` so a Next.js hot reload does not leave a second store behind. */
const store = hmrSingleton('useExtensionPages_store', () => createExtensionPagesStore({
  fetchPages: () => api<ExtensionPage[]>('GET', '/extensions/ui?type=pages'),
  subscribeEvents: (onEvent) => {
    subscribeWs(EXTENSIONS_TOPIC, onEvent)
    return () => unsubscribeWs(EXTENSIONS_TOPIC, onEvent)
  },
  subscribeConnection: (onChange) => {
    onWsStateChange(onChange)
    return () => offWsStateChange(onChange)
  },
  isConnected: isWsConnected,
  subscribeActive: (onChange) => {
    document.addEventListener('visibilitychange', onChange)
    const offFrameActive = subscribeFrameActive(onChange)
    return () => {
      document.removeEventListener('visibilitychange', onChange)
      offFrameActive()
    }
  },
  isActive: isActiveNow,
  hadSocketGap,
  fallbackMs: PAGES_FALLBACK_MS,
}))

/** Pages contributed by installed extensions, refreshed when extensions change. */
export function useExtensionPagesState(): ExtensionPagesState {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot)
}

/** Pages contributed by installed extensions, refreshed when extensions change. */
export function useExtensionPages(): ExtensionPage[] {
  return useExtensionPagesState().pages
}
