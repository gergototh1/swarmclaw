import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseChatListMode } from './chat-list-mode'

describe('parseChatListMode', () => {
  it('keeps the two known modes', () => {
    assert.equal(parseChatListMode('agents'), 'agents')
    assert.equal(parseChatListMode('conversations'), 'conversations')
  })
  it('falls back to conversations for anything else', () => {
    assert.equal(parseChatListMode(null), 'conversations')
    assert.equal(parseChatListMode(''), 'conversations')
    assert.equal(parseChatListMode('chat'), 'conversations')
  })
})
