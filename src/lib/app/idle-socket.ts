/**
 * Closes a frame's own WebSocket after it has sat in the background for a
 * while, and reopens it the moment the frame is shown again.
 *
 * Flicking between two tabs must not churn the connection, so going inactive
 * only *starts* a grace-period timer — the socket is worth keeping for a few
 * seconds of "I'll be right back". Only a timer that actually fires closes
 * it; coming back before then just cancels the timer and leaves the socket
 * exactly as it was, connected the whole time. Timers are injected so this is
 * testable without real time.
 */
export interface IdleSocketOptions {
  graceMs: number
  connect: () => void
  disconnect: () => void
  setTimer?: (fn: () => void, ms: number) => number
  clearTimer?: (id: number) => void
}

export interface IdleSocket {
  /** The frame's active state changed. */
  setActive(active: boolean): void
  /** Cancels a pending grace timer. Leaves the socket connected or not, as it is. */
  dispose(): void
}

export function createIdleSocket(options: IdleSocketOptions): IdleSocket {
  const { graceMs, connect, disconnect } = options
  const setTimer = options.setTimer ?? ((fn, ms) => window.setTimeout(fn, ms))
  const clearTimer = options.clearTimer ?? ((id) => window.clearTimeout(id))

  let timer: number | null = null
  let disconnected = false

  const cancelTimer = () => {
    if (timer === null) return
    clearTimer(timer)
    timer = null
  }

  return {
    setActive(active) {
      if (active) {
        cancelTimer()
        if (disconnected) {
          disconnected = false
          connect()
        }
        return
      }
      // Already waiting out the grace period, or already disconnected: a
      // repeated `setActive(false)` (e.g. re-applying the same host message)
      // must not start a second timer or disconnect twice.
      if (timer !== null || disconnected) return
      timer = setTimer(() => {
        timer = null
        disconnected = true
        disconnect()
      }, graceMs)
    },
    dispose() {
      cancelTimer()
    },
  }
}
