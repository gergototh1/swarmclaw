import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { AppNotification } from '@/types'
import { dedupeNotifications, NEEDS_YOU_NOTIFICATION_LIMIT } from './notification-dedup'

function makeNotification(overrides: Partial<AppNotification> & { id: string }): AppNotification {
  return {
    type: 'error',
    title: 'OpenClaw gateway unreachable: openclaw',
    message: undefined,
    read: false,
    createdAt: 1_000,
    ...overrides,
  }
}

describe('dedupeNotifications', () => {
  it('collapses records sharing a dedupKey into one row', () => {
    const notifications = [
      makeNotification({ id: 'a', dedupKey: 'openclaw-gw-down:agent-1', createdAt: 1_000 }),
      makeNotification({ id: 'b', dedupKey: 'openclaw-gw-down:agent-1', createdAt: 2_000 }),
      makeNotification({ id: 'c', dedupKey: 'openclaw-gw-down:agent-1', createdAt: 3_000 }),
    ]

    const rows = dedupeNotifications(notifications)
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.occurrenceCount, 3)
    // The most recently active record represents the group.
    assert.equal(rows[0]?.notification.id, 'c')
  })

  it('falls back to type+title+message when dedupKey is missing', () => {
    const notifications = [
      makeNotification({ id: 'a', dedupKey: undefined, title: 'Same title', message: 'Same message' }),
      makeNotification({ id: 'b', dedupKey: undefined, title: 'Same title', message: 'Same message' }),
      makeNotification({ id: 'c', dedupKey: undefined, title: 'Different title', message: 'Same message' }),
    ]

    const rows = dedupeNotifications(notifications)
    assert.equal(rows.length, 2)
  })

  it('sums each grouped record\'s own occurrenceCount rather than just counting records', () => {
    const notifications = [
      makeNotification({ id: 'a', dedupKey: 'k', occurrenceCount: 4 }),
      makeNotification({ id: 'b', dedupKey: 'k', occurrenceCount: 2 }),
    ]

    const rows = dedupeNotifications(notifications)
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.occurrenceCount, 6)
  })

  it('sorts distinct groups by most recent activity first', () => {
    const notifications = [
      makeNotification({ id: 'old', dedupKey: 'old-issue', createdAt: 1_000 }),
      makeNotification({ id: 'new', dedupKey: 'new-issue', createdAt: 5_000 }),
      makeNotification({ id: 'mid', dedupKey: 'mid-issue', createdAt: 3_000 }),
    ]

    const rows = dedupeNotifications(notifications)
    assert.deepEqual(rows.map((r) => r.notification.id), ['new', 'mid', 'old'])
  })

  it('caps at the default limit', () => {
    const notifications = Array.from({ length: NEEDS_YOU_NOTIFICATION_LIMIT + 5 }, (_, i) =>
      makeNotification({ id: `n${i}`, dedupKey: `issue-${i}`, createdAt: i }))

    const rows = dedupeNotifications(notifications)
    assert.equal(rows.length, NEEDS_YOU_NOTIFICATION_LIMIT)
  })

  it('respects a custom limit', () => {
    const notifications = Array.from({ length: 5 }, (_, i) =>
      makeNotification({ id: `n${i}`, dedupKey: `issue-${i}`, createdAt: i }))

    const rows = dedupeNotifications(notifications, 2)
    assert.equal(rows.length, 2)
  })

  it('returns an empty list for no notifications', () => {
    assert.deepEqual(dedupeNotifications([]), [])
  })
})
