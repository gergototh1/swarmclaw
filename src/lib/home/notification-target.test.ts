import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { AppNotification } from '@/types'
import { notificationHref } from './notification-target'

function notif(over: Partial<AppNotification>): AppNotification {
  return { id: 'n1', type: 'error', title: 't', read: false, createdAt: 0, ...over }
}

describe('notificationHref', () => {
  it('prefers an explicit actionUrl', () => {
    assert.equal(notificationHref(notif({ actionUrl: '/providers', entityType: 'agent', entityId: 'a1' })), '/providers')
  })

  it('builds an agent link from the entity fields', () => {
    assert.equal(notificationHref(notif({ entityType: 'agent', entityId: 'a1' })), '/agents/a1')
  })

  it('builds a session link on the chat route, not /sessions', () => {
    assert.equal(notificationHref(notif({ entityType: 'session', entityId: 's1' })), '/chat/s1')
  })

  it('encodes an id that would otherwise break the path', () => {
    assert.equal(notificationHref(notif({ entityType: 'agent', entityId: 'a/b' })), '/agents/a%2Fb')
  })

  it('returns null for an entity kind with no route of its own', () => {
    assert.equal(notificationHref(notif({ entityType: 'task', entityId: 't1' })), null)
  })

  it('returns null when there is nothing to link to', () => {
    assert.equal(notificationHref(notif({})), null)
  })

  it('ignores a blank actionUrl rather than navigating nowhere', () => {
    assert.equal(notificationHref(notif({ actionUrl: '   ' })), null)
  })
})
