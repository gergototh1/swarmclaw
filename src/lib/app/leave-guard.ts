import { hmrSingleton } from '@/lib/shared-utils'

/**
 * One page at a time may hold edits that navigating away would lose -- today
 * the agent editor. It registers a guard; in-app navigation asks the guard
 * before leaving, and the guard decides (usually via a ConfirmDialog) whether
 * to call `proceed`. Browser back/forward is not covered; reload and close are
 * covered by the page's own `beforeunload`.
 */
export type LeaveGuard = (proceed: () => void) => void

const slot = hmrSingleton('leaveGuard_slot', () => ({ guard: null as LeaveGuard | null }))

export function setLeaveGuard(guard: LeaveGuard | null): () => void {
  slot.guard = guard
  return () => {
    if (slot.guard === guard) slot.guard = null
  }
}

export function hasLeaveGuard(): boolean {
  return slot.guard !== null
}

export function requestLeave(proceed: () => void): void {
  if (slot.guard) slot.guard(proceed)
  else proceed()
}
