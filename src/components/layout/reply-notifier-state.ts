import { sessionUnreadState, type SessionUnreadInput } from '@/lib/chat/session-unread'

/**
 * The sequencing that `reply-notifier.tsx` drives, pulled out so it can be
 * unit-tested without React, Zustand, or an Electron bridge.
 *
 * `seen` is a baseline map of `sessionId -> lastActivityAt`. It starts as
 * `null`, meaning "no baseline yet" -- distinct from an empty `Map`, which
 * would mean "baseline taken, and it was empty."  That distinction is the
 * whole point of this module: the caller's session store starts as `{}` and
 * is filled in later by an async load, so the FIRST call here often sees an
 * empty `sessions` list. If that empty call were allowed to set the
 * baseline, every session that shows up on the next call would look brand
 * new (nothing to compare against) and fire a notification for every
 * already-unread chat -- a notification burst on cold start. So: while
 * `seen` is `null`, an empty `sessions` list leaves it `null` and baselines
 * nothing. Do not "simplify" this by dropping the empty-list check.
 */

export interface ReplyNotifierSession extends SessionUnreadInput {
  id: string
}

export interface ReplyNotifierStep {
  seen: Map<string, number> | null
  /** ids of sessions that crossed from "not newly unread" to "newly unread" this step */
  fired: string[]
}

export function advanceReplyNotifierSeen(
  seen: Map<string, number> | null,
  sessions: ReplyNotifierSession[],
): ReplyNotifierStep {
  if (seen === null) {
    // See the module comment: do not baseline from an empty list, or the
    // next real population looks like a burst of brand-new activity.
    if (sessions.length === 0) return { seen: null, fired: [] }
    const baseline = new Map(sessions.map((s) => [s.id, sessionUnreadState(s).lastActivityAt]))
    return { seen: baseline, fired: [] }
  }

  const next = new Map(seen)
  const fired: string[] = []
  for (const session of sessions) {
    const state = sessionUnreadState(session)
    const previous = next.get(session.id) ?? 0
    next.set(session.id, state.lastActivityAt)
    if (state.lastActivityAt <= previous) continue
    if (!state.unread) continue
    fired.push(session.id)
  }
  return { seen: next, fired }
}
