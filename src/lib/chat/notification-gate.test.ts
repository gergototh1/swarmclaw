import test from 'node:test'
import assert from 'node:assert/strict'
import { shouldNotifyForReply } from './notification-gate'

const base = {
  globalEnabled: true,
  agentMuted: false,
  isActiveSession: false,
  windowFocused: false,
}

test('alapeset: nem aktiv chat, nincs fokusz -> ertesit', () => {
  assert.equal(shouldNotifyForReply(base), true)
})

test('globalisan kikapcsolva -> nem ertesit', () => {
  assert.equal(shouldNotifyForReply({ ...base, globalEnabled: false }), false)
})

test('ugynok nemitva -> nem ertesit', () => {
  assert.equal(shouldNotifyForReply({ ...base, agentMuted: true }), false)
})

test('aktiv chat ES fokusz -> nem ertesit', () => {
  assert.equal(shouldNotifyForReply({ ...base, isActiveSession: true, windowFocused: true }), false)
})

test('aktiv chat, de nincs fokusz -> ertesit', () => {
  assert.equal(shouldNotifyForReply({ ...base, isActiveSession: true, windowFocused: false }), true)
})

test('nem aktiv chat, de van fokusz -> ertesit', () => {
  assert.equal(shouldNotifyForReply({ ...base, isActiveSession: false, windowFocused: true }), true)
})
