import test from 'node:test'
import assert from 'node:assert/strict'
import { isVisibleAssistantMessage } from './visible-assistant-message'

const reply = { role: 'assistant' as const, text: 'Found three offers.', time: 1 }

test('a finished assistant reply with text is visible', () => {
  assert.equal(isVisibleAssistantMessage(reply), true)
})

test('null and undefined are not visible', () => {
  assert.equal(isVisibleAssistantMessage(null), false)
  assert.equal(isVisibleAssistantMessage(undefined), false)
})

test('a user message is not visible', () => {
  assert.equal(isVisibleAssistantMessage({ ...reply, role: 'user' }), false)
})

test('a partial save still streaming is not visible, even with text', () => {
  assert.equal(isVisibleAssistantMessage({ ...reply, streaming: true }), false)
})

test('a suppressed reply is not visible', () => {
  assert.equal(isVisibleAssistantMessage({ ...reply, suppressed: true }), false)
})

test('kinds other than chat and connector-delivery are not visible', () => {
  for (const kind of ['heartbeat', 'system', 'context-clear', 'extension-ui'] as const) {
    assert.equal(isVisibleAssistantMessage({ ...reply, kind }), false, kind)
  }
  assert.equal(isVisibleAssistantMessage({ ...reply, kind: 'chat' }), true)
  assert.equal(isVisibleAssistantMessage({ ...reply, kind: 'connector-delivery' }), true)
})

test('a reply with only whitespace and no media is not visible', () => {
  assert.equal(isVisibleAssistantMessage({ ...reply, text: '  \n\t ' }), false)
})

test('an image or an attached file counts as visible content without text', () => {
  assert.equal(isVisibleAssistantMessage({ ...reply, text: '', imageUrl: '/api/uploads/a.png' }), true)
  assert.equal(isVisibleAssistantMessage({ ...reply, text: '', imagePath: '/tmp/a.png' }), true)
  assert.equal(isVisibleAssistantMessage({ ...reply, text: '', attachedFiles: ['/tmp/report.pdf'] }), true)
  assert.equal(isVisibleAssistantMessage({ ...reply, text: '', attachedFiles: [] }), false)
})
