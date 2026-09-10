import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { resolveConversationGroups, conversationTrailingText } from './conversation-list'
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
  // put every session's startOfToday in 1970 and filed every row under TODAY.
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
    assert.deepEqual(groups?.map((g) => g.label), ['TODAY'])
  })
})

describe('conversationTrailingText', () => {
  // When `now` is null (clock unresolved), a settled row must not render any
  // trailing text, which suppresses the separator. Error and working rows
  // always render their labels.

  it('returns empty string when now is null and dot is settled', () => {
    assert.equal(conversationTrailingText(null, 'none', 1_000_000), '')
  })

  it('returns error label even when now is null', () => {
    assert.equal(conversationTrailingText(null, 'error', 1_000_000), 'sikertelen válasz')
  })

  it('returns working label even when now is null', () => {
    assert.equal(conversationTrailingText(null, 'working', 1_000_000), 'dolgozik…')
  })

  it('returns unread label even when now is null', () => {
    assert.equal(conversationTrailingText(null, 'unread', 1_000_000), '')
  })

  it('returns time-ago when now is known and dot is settled', () => {
    const now = new Date(2026, 8, 10, 14, 0, 0).getTime()
    const at = new Date(2026, 8, 10, 13, 0, 0).getTime() // 1 hour ago
    const result = conversationTrailingText(now, 'none', at)
    assert.equal(result, '1 órája')
  })

  it('returns error label when now is known', () => {
    const now = new Date(2026, 8, 10, 14, 0, 0).getTime()
    assert.equal(conversationTrailingText(now, 'error', 1_000_000), 'sikertelen válasz')
  })

  it('returns working label when now is known', () => {
    const now = new Date(2026, 8, 10, 14, 0, 0).getTime()
    assert.equal(conversationTrailingText(now, 'working', 1_000_000), 'dolgozik…')
  })

  it('returns time-ago when lastActiveAt is undefined', () => {
    const now = new Date(2026, 8, 10, 14, 0, 0).getTime()
    assert.equal(conversationTrailingText(now, 'none', undefined), '')
  })
})
