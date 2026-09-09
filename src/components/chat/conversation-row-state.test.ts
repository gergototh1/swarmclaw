import test from 'node:test'
import assert from 'node:assert/strict'
import { conversationRowState } from './conversation-row-state'

test('semmi sem tortent -> se olvasatlan, se dolgozik', () => {
  assert.deepEqual(conversationRowState({}), { unread: false, isError: false, working: false })
})

test('olvasatlan valasz', () => {
  const s = conversationRowState({ lastAssistantAt: 200, lastReadAt: 100 })
  assert.equal(s.unread, true)
  assert.equal(s.isError, false)
})

test('hibas turn -> olvasatlan, hibakent', () => {
  const s = conversationRowState({ lastAssistantAt: 100, lastFailedTurnAt: 200, lastReadAt: 50 })
  assert.equal(s.unread, true)
  assert.equal(s.isError, true)
})

test('active -> dolgozik', () => {
  assert.equal(conversationRowState({ active: true }).working, true)
})

test('a dolgozik fuggetlen az olvasatlantol: egyszerre is igaz lehet', () => {
  const s = conversationRowState({ active: true, lastAssistantAt: 200, lastReadAt: 100 })
  assert.equal(s.working, true)
  assert.equal(s.unread, true)
})

test('active hianyzik vagy false -> nem dolgozik', () => {
  assert.equal(conversationRowState({ active: false }).working, false)
  assert.equal(conversationRowState({}).working, false)
})
