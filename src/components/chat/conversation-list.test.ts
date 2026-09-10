import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { resolveConversationGroups } from './conversation-list'
import type { Session } from '@/types'

function session(over: Partial<Session> & { id: string }): Session {
  return {
    name: 'Sidekick', cwd: '/tmp', user: 'user', provider: 'claude-cli', model: '',
    claudeSessionId: null, messages: [], createdAt: 0, lastActiveAt: 0,
    ...over,
  } as Session
}

describe('resolveConversationGroups', () => {
  // `now` starts null until useNow()'s first requestAnimationFrame tick, which
  // a backgrounded or inactive tab can delay indefinitely. `now ?? 0` used to
  // paper over that by handing groupConversationsByAge an epoch-0 `now`, which
  // put every session's startOfToday in 1970 and filed every row under MÁRA.
  it('does not fabricate buckets from an unknown now', () => {
    const rows = [
      session({ id: 'old', messageCount: 1, lastActiveAt: 1 }),
      session({ id: 'new', messageCount: 1, lastActiveAt: Date.now() }),
    ]
    assert.equal(resolveConversationGroups(rows, null), null)
  })

  it('buckets once now is known', () => {
    const now = new Date(2026, 8, 10, 14, 0, 0).getTime()
    const rows = [session({ id: 'a', messageCount: 1, lastActiveAt: now })]
    const groups = resolveConversationGroups(rows, now)
    assert.notEqual(groups, null)
    assert.deepEqual(groups?.map((g) => g.label), ['MÁRA'])
  })
})
