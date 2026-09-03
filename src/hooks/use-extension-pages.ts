'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/app/api-client'
import { useWs } from '@/hooks/use-ws'
import { isWsConnected, offWsStateChange, onWsStateChange } from '@/lib/ws-client'
import { anchorPosition, isMountedAnchorPosition } from '@/lib/extension-page-nav'
import type { ExtensionPageDefinition } from '@/types/extension'

/** A page declared by an installed extension, tagged with the extension that owns it. */
export type ExtensionPage = ExtensionPageDefinition & { extensionId: string }

/**
 * Select the extension pages that belong in one nav slot.
 *
 * `view` is the built-in nav entry a page asked to sit after (an `AppView` value,
 * kept as a plain string here so extension positions never widen `AppView`), and
 * selects the pages anchored at exactly that view.
 *
 * Passing `null` selects the trailing slot, which takes every page that is not
 * anchored at one of `EXTENSION_NAV_ANCHORS`: pages with no position, pages that
 * asked for `end`, and pages whose anchor names a view the rail does not mount a
 * slot for (a typo, or a view that was later renamed). So a page can never fall
 * out of the rail entirely.
 *
 * The two slots only stay disjoint because the rail passes anchors from
 * `EXTENSION_NAV_ANCHORS` and nothing else, which `ExtensionPagesAfter`'s prop
 * type enforces.
 */
export function splitPagesByPosition(pages: ExtensionPage[], view: string | null): ExtensionPage[] {
  if (view === null) {
    return pages.filter((p) => !isMountedAnchorPosition(p.position))
  }
  const wanted = anchorPosition(view)
  return pages.filter((p) => p.position === wanted)
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
