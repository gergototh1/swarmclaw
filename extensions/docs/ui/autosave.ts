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
 *
 * SAVES ARE SINGLE-FLIGHT. `save` is a round trip, and a flush can now fire
 * while one is still in the air (the countdown finishes right as a flush
 * happens, or a flush happens right as the countdown finishes). Starting a
 * second request in that window used to send a save built on a version the
 * first request had not confirmed yet. Instead, a run that lands while a save
 * is in flight only records that another one is wanted; when the in-flight
 * save settles -- resolved or rejected, it does not matter which -- one more
 * run happens with the text as it is at that later moment, and it saves
 * nothing if that text already matches `saved()` by then.
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
  save: (md: string) => Promise<void>
}): Autosave {
  let timer: ReturnType<typeof setTimeout> | null = null
  let saving = false
  let runWanted = false

  const settle = () => {
    saving = false
    if (runWanted) {
      runWanted = false
      attempt()
    }
  }

  const attempt = () => {
    const md = opts.read()
    if (md === opts.saved()) return
    if (saving) { runWanted = true; return }
    saving = true
    opts.save(md).then(settle, settle)
  }

  const run = () => {
    timer = null
    attempt()
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
