import { createCatchUp, type CatchUp } from './ws-catch-up'
import type { ExtensionPageDefinition } from '@/types/extension'

/** A page declared by an installed extension, tagged with the extension that owns it. */
export type ExtensionPage = ExtensionPageDefinition & { extensionId: string }

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

export const EMPTY_EXTENSION_PAGES: ExtensionPagesState = { pages: [], loaded: false }

/**
 * Everything the store talks to, injected rather than imported, so the whole
 * machinery below — ref-counting, catch-up, the fallback timer — can be driven
 * from a test without a browser, a socket or a server.
 */
export interface ExtensionPagesStoreDeps {
  /** One `GET /extensions/ui?type=pages`. */
  fetchPages: () => Promise<ExtensionPage[]>
  /** Push notifications on the `extensions` topic. Returns an unsubscribe. */
  subscribeEvents: (onEvent: () => void) => () => void
  /** Socket connect/disconnect notifications. Returns an unsubscribe. */
  subscribeConnection: (onChange: () => void) => () => void
  isConnected: () => boolean
  /**
   * Anything that changes whether this window is the one on screen — the
   * document's visibility and the tab frame's own flag are two separate
   * sources, and both land here. Returns an unsubscribe.
   */
  subscribeActive: (onChange: () => void) => () => void
  isActive: () => boolean
  /** Whether this frame's socket was closed while it was in the background. */
  hadSocketGap: () => boolean
  /** How often to re-fetch while the socket is down. */
  fallbackMs: number
  setTimer?: (fn: () => void, ms: number) => number
  clearTimer?: (id: number) => void
}

/** The `useSyncExternalStore` triple, plus nothing else — the rest is internal. */
export interface ExtensionPagesStore {
  subscribe(listener: () => void): () => void
  getSnapshot(): ExtensionPagesState
  getServerSnapshot(): ExtensionPagesState
}

/**
 * One fetch, one `extensions` subscription and one fallback timer per window,
 * shared by every mounted `useExtensionPages`/`useExtensionPagesState` caller
 * (today: `tab-host.tsx`, `command-palette.tsx`, the `/x/<slug>` route and both
 * the desktop and mobile `sidebar-rail.tsx` instances). Before this, each
 * instance ran its own copy of all three, so one `notify('extensions')` or one
 * fallback tick cost one `GET /extensions/ui?type=pages` per mounted caller.
 *
 * The subscriber set is the ref count: the first listener turns the machinery
 * on and the last one to go turns it off. Nothing else counts subscribers, so
 * there is no second number to keep in step with it.
 *
 * What survives a stop is the data. A remount re-fetches immediately, and until
 * that lands the last known pages — `loaded` included — are still the last thing
 * the server said, which is a better answer for the `/x/<slug>` route than
 * "no such page".
 */
export function createExtensionPagesStore(deps: ExtensionPagesStoreDeps): ExtensionPagesStore {
  const setTimer = deps.setTimer ?? ((fn, ms) => window.setInterval(fn, ms))
  const clearTimer = deps.clearTimer ?? ((id) => window.clearInterval(id))

  const listeners = new Set<() => void>()
  let state: ExtensionPagesState = EMPTY_EXTENSION_PAGES
  let active = true
  let catchUp: CatchUp | null = null
  let offEvents: (() => void) | null = null
  let offConnection: (() => void) | null = null
  let offActive: (() => void) | null = null
  let fallbackTimer: number | null = null

  function setState(next: ExtensionPagesState): void {
    state = next
    for (const listener of listeners) listener()
  }

  function refresh(): boolean {
    deps.fetchPages()
      .then((list) => { setState({ pages: Array.isArray(list) ? list : [], loaded: true }) })
      // A failed fetch still counts as settled: retrying forever behind a
      // spinner hides the failure. The last known pages are kept so an already
      // rendered page does not blank, and the reason is kept so a caller can say
      // what actually went wrong instead of concluding the page does not exist.
      .catch((err: unknown) => {
        setState({
          pages: state.pages,
          loaded: true,
          error: err instanceof Error ? err.message : String(err),
        })
      })
    return true
  }

  function stopFallback(): void {
    if (fallbackTimer === null) return
    clearTimer(fallbackTimer)
    fallbackTimer = null
  }

  /** Fallback polling only runs while active and disconnected — same gate `useWs` applies. */
  function syncFallback(): void {
    const shouldPoll = active && !deps.isConnected()
    if (shouldPoll && fallbackTimer === null) {
      fallbackTimer = setTimer(refresh, deps.fallbackMs)
    } else if (!shouldPoll) {
      stopFallback()
    }
  }

  function onConnectionChange(): void {
    syncFallback()
    // A server restart reconnects the socket within seconds, long before the
    // fallback interval would next tick. Re-fetch as soon as the connection
    // comes back, whenever the last attempt is known to have failed.
    if (deps.isConnected() && state.error) refresh()
  }

  function onActiveChange(): void {
    const next = deps.isActive()
    const becameActive = !active && next
    active = next
    // Same rule `useWs` applies: a reactivation after this frame's socket was
    // closed in the background cannot trust "nothing was missed", because there
    // was no socket for anything to arrive on. Both sources of the active
    // signal call this, and only the one that sees the transition asks for the
    // refresh, so a double fire still costs one fetch.
    catchUp?.onActiveChange(next, becameActive && deps.hadSocketGap())
    syncFallback()
  }

  function start(): void {
    active = deps.isActive()
    catchUp = createCatchUp(refresh)
    refresh()
    offEvents = deps.subscribeEvents(() => catchUp?.onEvent(active))
    offConnection = deps.subscribeConnection(onConnectionChange)
    offActive = deps.subscribeActive(onActiveChange)
    syncFallback()
  }

  function stop(): void {
    offEvents?.(); offEvents = null
    offConnection?.(); offConnection = null
    offActive?.(); offActive = null
    stopFallback()
    catchUp = null
  }

  return {
    subscribe(listener) {
      listeners.add(listener)
      if (listeners.size === 1) start()
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) stop()
      }
    },
    getSnapshot: () => state,
    // One frozen object for the whole life of the store: `useSyncExternalStore`
    // compares snapshots by identity, and a fresh `{ pages: [], loaded: false }`
    // per call would re-render forever during hydration.
    getServerSnapshot: () => EMPTY_EXTENSION_PAGES,
  }
}
