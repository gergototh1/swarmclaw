'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/app/api-client'
import { useWs } from '@/hooks/use-ws'
import { isWsConnected, offWsStateChange, onWsStateChange } from '@/lib/ws-client'
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

/**
 * How often the page list is re-fetched while the websocket is down.
 *
 * Must stay equal to the `extensions` registration in
 * `components/layout/dashboard-shell.tsx` (`useWs('extensions', refreshExtensionState, ...)`),
 * and not because whichever mounts first "wins" forever: `acquireFallback` in
 * `use-ws.ts` only early-returns while the topic's shared entry still exists,
 * and `releaseFallback` deletes that entry once its last handler leaves. The
 * `/x` route this hook backs renders inside `DashboardShell`'s children, so
 * effects run and tear down child-first — a single tab hide/show cycle drops
 * the `extensions` entry and lets this hook recreate it, making *this* value
 * the interval for the whole `extensions` topic, including the shell's own
 * extension-state refresh. A mismatch here silently overrides that other
 * registration's polling rate the moment a tab is hidden and shown again.
 */
const PAGES_FALLBACK_MS = 60_000

/** Pages contributed by installed extensions, refreshed when extensions change. */
export function useExtensionPagesState(): ExtensionPagesState {
  const [state, setState] = useState<ExtensionPagesState>({ pages: [], loaded: false })
  // Read inside the reconnect listener below without making it re-subscribe
  // on every fetch outcome.
  const errorRef = useRef(state.error)
  useEffect(() => { errorRef.current = state.error }, [state.error])

  const refresh = useCallback(() => {
    api<ExtensionPage[]>('GET', '/extensions/ui?type=pages')
      .then((list) => { setState({ pages: Array.isArray(list) ? list : [], loaded: true }) })
      // A failed fetch still counts as settled: retrying forever behind a spinner
      // hides the failure. The last known pages are kept so an already rendered
      // page does not blank, and the reason is kept so a caller can say what
      // actually went wrong instead of concluding the page does not exist.
      .catch((err: unknown) => {
        setState((prev) => ({
          pages: prev.pages,
          loaded: true,
          error: err instanceof Error ? err.message : String(err),
        }))
      })
  }, [])

  useEffect(() => { refresh() }, [refresh])
  useWs('extensions', refresh, PAGES_FALLBACK_MS)

  // A server restart reconnects the socket within seconds, long before the
  // fallback interval above would next tick. `ws-client`'s `onopen` only
  // notifies connection-state listeners and re-sends the subscribe frame — it
  // never pushes anything to topic handlers — so a fetch that failed while the
  // socket was down would otherwise sit failed until the next fallback tick or
  // an actual `extensions` push. Re-fetch here instead, as soon as the
  // connection comes back, whenever the last attempt is known to have failed.
  useEffect(() => {
    const onReconnect = () => {
      if (isWsConnected() && errorRef.current) refresh()
    }
    onWsStateChange(onReconnect)
    return () => offWsStateChange(onReconnect)
  }, [refresh])

  return state
}

/** Pages contributed by installed extensions, refreshed when extensions change. */
export function useExtensionPages(): ExtensionPage[] {
  return useExtensionPagesState().pages
}
