import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { buildSessionListSummary, getSessionMessageCount } from './session-summary'
import type { Session } from '@/types'

function session(over: Partial<Session>): Session {
  return {
    id: 's', name: 'n', cwd: '/tmp', user: 'u', provider: 'claude-cli', model: '',
    claudeSessionId: null, messages: [], createdAt: 0, lastActiveAt: 0,
    ...over,
  } as Session
}

describe('buildSessionListSummary', () => {
  it('reports the count the record carries, not the length of the stripped array', () => {
    // A `messages` a session_messages táblába költözött, tehát a tárolt
    // rekordon üres. Amíg ez a hossz volt a forrás, a listázó végpont MINDEN
    // szálra 0-t mondott -- arra is, amiben 199 üzenet van.
    const summary = buildSessionListSummary(session({ messageCount: 199, messages: [] }))
    assert.equal(summary.messageCount, 199)
  })

  it('empties the messages array it was given', () => {
    const summary = buildSessionListSummary(session({
      messageCount: 2,
      messages: [{ role: 'user', text: 'a', time: 1 }, { role: 'assistant', text: 'b', time: 2 }],
    }))
    assert.deepEqual(summary.messages, [], 'a lista-válasz nem viszi a törzset')
    assert.equal(summary.messageCount, 2)
  })

  it('falls back to the array when no count is stored', () => {
    // Migráció előtti rekord: ott a tömb az egyetlen forrás.
    assert.equal(getSessionMessageCount(session({ messages: [{ role: 'user', text: 'a', time: 1 }] })), 1)
  })
})
