import { hmrSingleton } from '@/lib/shared-utils'

/**
 * Whether this window is the tab the reader is looking at.
 *
 * A tab is a same-origin iframe inside a visible window, so its own
 * `document.visibilityState` is always `visible` — the browser cannot tell it
 * that the host is showing a different tab. The host sends an `active` message
 * instead, and this is where that lands; `usePageActive` folds it into the
 * answer every data hook already asks for.
 *
 * Defaults to active, so a plain window, the host window, and a frame whose
 * host never says anything all behave exactly as before.
 */
const state = hmrSingleton('frameActive_state', () => ({
  active: true,
  listeners: new Set<() => void>(),
}))

export function isFrameActive(): boolean {
  return state.active
}

export function setFrameActive(active: boolean): void {
  if (state.active === active) return
  state.active = active
  for (const listener of state.listeners) listener()
}

export function subscribeFrameActive(listener: () => void): () => void {
  state.listeners.add(listener)
  return () => { state.listeners.delete(listener) }
}
