/**
 * What a subscription does with events that arrive while nobody is looking.
 *
 * A background tab frame used to run every push handler — and most of those
 * handlers refetch a whole collection, so one server notification cost one
 * request per open tab. Skipping them is only safe if coming back is not
 * silent: the frame runs the handler once when it is shown again, however many
 * events it missed.
 */
export interface CatchUp {
  /** A push event arrived. Runs the handler when active; records a miss when not. */
  onEvent(active: boolean): void
  /** The frame's active state changed. Runs the handler once if anything was missed. */
  onActiveChange(active: boolean): void
}

export function createCatchUp(run: () => void): CatchUp {
  let missed = false
  return {
    onEvent(active) {
      if (active) {
        run()
        return
      }
      missed = true
    },
    onActiveChange(active) {
      if (!active || !missed) return
      missed = false
      run()
    },
  }
}
