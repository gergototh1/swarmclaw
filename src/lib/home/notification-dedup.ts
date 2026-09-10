import type { AppNotification } from '@/types'
import { getNotificationActivityAt, getNotificationOccurrenceCount } from '@/lib/notifications/notification-utils'

export interface DedupedNotificationRow {
  /** The most recently active record in the group — used for title/message/id. */
  notification: AppNotification
  /** Sum of every grouped record's own occurrence count (each record already
   *  carries `occurrenceCount` for repeats collapsed server-side by
   *  `dedupKey`; several *concurrent* unread records with the same key or the
   *  same copy still reach the client separately, so this adds a second,
   *  client-side layer of collapsing on top). */
  occurrenceCount: number
}

/**
 * Tier 1's "Needs you" promotes unlinked `error` notifications so an error
 * can't hide behind Tier 3's collapse (see pulse-partition.ts). But several
 * producers can fire the same underlying problem — one row per agent sharing
 * a gateway, one row per failed poll before the first is marked read — and
 * `dedupKey` only merges repeats into a single stored record when they hit
 * storage one at a time. Concurrent unread records with the same key (or no
 * key but identical copy) still reach the client as separate rows. This
 * collapses those here, at render time, so "Needs you" shows one row with an
 * occurrence badge instead of a wall of duplicates.
 */
function groupKey(notification: AppNotification): string {
  return notification.dedupKey || `${notification.type}:${notification.title}:${notification.message ?? ''}`
}

/**
 * How many distinct notification issues "Needs you" will ever show at once.
 * Each row already carries an occurrence badge for repeats within its own
 * group, so this caps *distinct* problems, not raw volume. Three is enough to
 * signal "something is actually wrong" without turning the tier back into an
 * inventory — the same "decision, not inventory" principle the rest of the
 * rebuild follows. Anything beyond the cap is still visible one click away,
 * in the notification centre.
 */
export const NEEDS_YOU_NOTIFICATION_LIMIT = 3

export function dedupeNotifications(
  notifications: readonly AppNotification[],
  limit = NEEDS_YOU_NOTIFICATION_LIMIT,
): DedupedNotificationRow[] {
  const groups = new Map<string, AppNotification[]>()
  for (const notification of notifications) {
    const key = groupKey(notification)
    const existing = groups.get(key)
    if (existing) existing.push(notification)
    else groups.set(key, [notification])
  }

  const rows: DedupedNotificationRow[] = Array.from(groups.values()).map((records) => {
    const latest = records.reduce((a, b) => (getNotificationActivityAt(b) > getNotificationActivityAt(a) ? b : a))
    const occurrenceCount = records.reduce((sum, record) => sum + getNotificationOccurrenceCount(record), 0)
    return { notification: latest, occurrenceCount }
  })

  rows.sort((a, b) => getNotificationActivityAt(b.notification) - getNotificationActivityAt(a.notification))
  return rows.slice(0, limit)
}
