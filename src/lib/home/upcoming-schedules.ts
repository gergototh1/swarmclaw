import type { Schedule } from '@/types'

export const NEXT_24H_MS = 24 * 60 * 60 * 1000

/**
 * Schedules due in the next 24 hours, soonest first, capped to `limit`.
 *
 * `now` is passed in rather than read internally (`Date.now()`) so the
 * function stays pure — the caller (`TierLive`) supplies a value from
 * component state instead of computing it inside a `useMemo`, which
 * `react-hooks/purity` rejects because `Date.now()` is non-deterministic
 * between renders.
 *
 * A schedule with no `nextRunAt`, or one already in the past, is excluded —
 * this list is "what's coming," not a status board of stale schedules.
 */
export function selectUpcomingSchedules(
  schedules: Record<string, Schedule>,
  now: number,
  limit = 5,
): Schedule[] {
  return Object.values(schedules)
    .filter((s) => typeof s.nextRunAt === 'number' && s.nextRunAt > now && s.nextRunAt - now <= NEXT_24H_MS)
    .sort((a, b) => (a.nextRunAt ?? 0) - (b.nextRunAt ?? 0))
    .slice(0, limit)
}
