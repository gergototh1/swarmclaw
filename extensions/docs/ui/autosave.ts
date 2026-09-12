/**
 * Debounced saving that can be flushed.
 *
 * The editor used to clear its pending timer on unmount, which threw away the
 * last `delayMs` of typing whenever the reader switched documents or left the
 * page. `flushPending` is the other half: when the editor goes away with an
 * edit still waiting, the edit is saved now instead.
 *
 * `read` and `saved` are asked at the moment of saving, not when the edit was
 * scheduled, so a save that lands in between is taken into account and an
 * unchanged document is never rewritten.
 */

export interface Autosave {
  /** An edit happened: (re)start the countdown. */
  schedule(): void
  /** Save now if an edit is still waiting on the countdown; otherwise do nothing. */
  flushPending(): void
  /** Drop a waiting edit without saving it. */
  cancel(): void
}

export function createAutosave(opts: {
  delayMs: number
  read: () => string
  saved: () => string
  save: (md: string) => void
}): Autosave {
  let timer: ReturnType<typeof setTimeout> | null = null

  const run = () => {
    timer = null
    const md = opts.read()
    if (md !== opts.saved()) opts.save(md)
  }

  return {
    schedule() {
      if (timer) clearTimeout(timer)
      timer = setTimeout(run, opts.delayMs)
    },
    flushPending() {
      if (!timer) return
      clearTimeout(timer)
      run()
    },
    cancel() {
      if (timer) clearTimeout(timer)
      timer = null
    },
  }
}
