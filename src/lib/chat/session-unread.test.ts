import test from 'node:test'
import assert from 'node:assert/strict'
import { sessionUnreadState } from './session-unread'

test('minden ures -> nincs olvasatlan', () => {
  assert.deepEqual(sessionUnreadState({}), { unread: false, isError: false, lastActivityAt: 0 })
})

test('valasz a legutobbi olvasas utan -> olvasatlan', () => {
  const s = sessionUnreadState({ lastAssistantAt: 200, lastReadAt: 100 })
  assert.equal(s.unread, true)
  assert.equal(s.isError, false)
})

test('egyenloseg nem olvasatlan', () => {
  assert.equal(sessionUnreadState({ lastAssistantAt: 100, lastReadAt: 100 }).unread, false)
})

test('hibas turn a valasz utan -> olvasatlan, hibakent', () => {
  const s = sessionUnreadState({ lastAssistantAt: 150, lastFailedTurnAt: 200, lastReadAt: 100 })
  assert.equal(s.unread, true)
  assert.equal(s.isError, true)
})

test('hibas turn a valasz elott -> olvasatlan, de nem hibakent', () => {
  const s = sessionUnreadState({ lastAssistantAt: 200, lastFailedTurnAt: 150, lastReadAt: 100 })
  assert.equal(s.unread, true)
  assert.equal(s.isError, false)
})

test('mar olvasott hibas turn nem olvasatlan', () => {
  assert.equal(sessionUnreadState({ lastFailedTurnAt: 100, lastReadAt: 200 }).unread, false)
})

test('hianyzo lastReadAt nullakent szamit', () => {
  assert.equal(sessionUnreadState({ lastAssistantAt: 1 }).unread, true)
})
