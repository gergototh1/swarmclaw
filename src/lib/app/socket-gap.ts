import { hmrSingleton } from '@/lib/shared-utils'

/**
 * Whether this frame went without a WebSocket while it was in the background.
 *
 * A background tab frame closes its socket after a grace period (idle-socket.ts)
 * and opens a new one when it is shown again. Everything that skips push
 * handlers while inactive then has a hole in its bookkeeping: "nothing was
 * missed" is only trustworthy if there was a socket to miss something on. So the
 * reconnect itself is recorded here, and a subscription coming back to life asks
 * this instead of trying to infer it.
 *
 * Inferring it does not work. `isWsConnected()` right after a reactivation looks
 * like the answer — the replacement socket cannot have finished opening yet — but
 * the host's `active` message is not a discrete event, so React is free to slice
 * the resulting render, and `ws.onopen` can land in the middle of it. The reader
 * would then see a connected socket, conclude nothing was closed, and skip the
 * one refresh the frame actually needed.
 *
 * The flag is sticky on purpose: every subscription in the frame reads it on the
 * same reactivation, and each one needs the same answer. It is cleared when the
 * frame goes into the background again, which is when the next gap can start.
 */
const state = hmrSingleton('socketGap_state', () => ({ reopened: false }))

/** This frame's socket was opened again after an idle close. */
export function markSocketReopened(): void {
  state.reopened = true
}

/** The frame went into the background: whatever gap it had is answered for. */
export function markFrameDeactivated(): void {
  state.reopened = false
}

/** Was this frame's socket closed while it was away, and opened again since? */
export function hadSocketGap(): boolean {
  return state.reopened
}
