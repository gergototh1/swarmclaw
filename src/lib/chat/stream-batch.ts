/**
 * Coalesces the patches a stream produces into at most one state write per window.
 *
 * A streamed answer arrives as many small chunks, and each one used to write the
 * store — so the live bubble re-rendered (and re-parsed its markdown) per chunk.
 * The reader cannot see more than the display refreshes, so a window of a few
 * tens of milliseconds is invisible to them and removes most of the work.
 *
 * The first patch is applied straight away: the first token must appear without
 * delay. Timers are injected so the behaviour is testable without real time.
 */
export interface StreamBatch<T extends object> {
  /** Merge a patch into the current window, applying it at once if the window is closed. */
  push(patch: Partial<T>): void
  /** Apply whatever is pending right now (use before any event that must not be reordered). */
  flush(): void
  /** Drop the pending patch and the timer. */
  dispose(): void
}

export interface StreamBatchOptions<T extends object> {
  intervalMs: number
  apply: (patch: Partial<T>) => void
  setTimer?: (fn: () => void, ms: number) => number
  clearTimer?: (id: number) => void
}

export function createStreamBatch<T extends object>(options: StreamBatchOptions<T>): StreamBatch<T> {
  const { intervalMs, apply } = options
  const setTimer = options.setTimer ?? ((fn, ms) => window.setTimeout(fn, ms))
  const clearTimer = options.clearTimer ?? ((id) => window.clearTimeout(id))

  let pending: Partial<T> | null = null
  let timer: number | null = null

  const applyPending = () => {
    timer = null
    if (!pending) return
    const patch = pending
    pending = null
    apply(patch)
    // Another window opens only when the stream pushes again; an idle stream keeps no timer.
  }

  return {
    push(patch) {
      if (timer === null) {
        apply(patch)
        timer = setTimer(applyPending, intervalMs)
        return
      }
      pending = pending ? { ...pending, ...patch } : { ...patch }
    },
    flush() {
      if (timer !== null) {
        clearTimer(timer)
        timer = null
      }
      if (!pending) return
      const patch = pending
      pending = null
      apply(patch)
    },
    dispose() {
      if (timer !== null) clearTimer(timer)
      timer = null
      pending = null
    },
  }
}
