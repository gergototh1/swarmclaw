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
  /**
   * The frame's active state changed. Runs the handler once if anything was
   * missed, or if `stale` says the caller cannot trust "nothing missed" on its
   * own — e.g. the frame's own socket (Task 4's idle-socket) was still
   * disconnected at the moment of reactivation, so no push event could have
   * arrived to be recorded as a miss in the first place. This is the single
   * place that decides whether reactivation gets a refresh, so a caller with
   * more than one reason to refresh (a missed event *and* a stale socket)
   * still gets exactly one `run()`, not two.
   */
  onActiveChange(active: boolean, stale?: boolean): void
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
    onActiveChange(active, stale = false) {
      if (!active || (!missed && !stale)) return
      missed = false
      run()
    },
  }
}
