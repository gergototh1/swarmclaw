import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { conversationTitle, groupConversationsByAge, isConversation, listConversations } from './conversation-list'
import { resolveChatroomSyntheticSessionId } from './chatroom-sessions'
import type { Session, Sessions } from '@/types'

function session(over: Partial<Session> & { id: string }): Session {
  return {
    name: 'Sidekick', cwd: '/tmp', user: 'user', provider: 'claude-cli', model: '',
    claudeSessionId: null, messages: [], createdAt: 0, lastActiveAt: 0,
    ...over,
  } as Session
}

describe('what the Chat page lists', () => {
  it('keeps a conversation somebody had', () => {
    assert.equal(isConversation(session({ id: 'a', name: 'Ezeket a doksikat nézd át', messageCount: 2 })), true)
  })

  it('leaves out a scheduled run', () => {
    // A pipeline `[Task] <ügynök>: <feladat>` néven nyitja (task-session.ts).
    // Ezek a legnagyobb szálak: 199 és 181 üzenet a tipikus 2-8 mellett.
    assert.equal(isConversation(session({ id: 'b', name: '[Task] Signal Scout: [Sched]', messageCount: 199 })), false)
  })

  it('leaves out a chatroom half', () => {
    const id = resolveChatroomSyntheticSessionId('de6a7849', 'default')
    assert.equal(isConversation(session({ id, name: 'Chatroom session for Sidekick', messageCount: 28 })), false)
  })

  it('leaves out a session nobody has written in', () => {
    assert.equal(isConversation(session({ id: 'd', name: 'Sidekick', messageCount: 0 })), false)
  })

  it('falls back to the last-message summary when no count came through', () => {
    // A listázó végpont valódi számot ad (listChatsForApi), de egy máshonnan
    // érkező session-objektumon nem feltétlenül van rajta.
    assert.equal(isConversation(session({ id: 'e', messageCount: 0, lastMessageSummary: { role: 'user', text: 'szia', time: 1 } })), true)
  })

  it('orders by last activity, newest first', () => {
    const sessions: Sessions = {
      old: session({ id: 'old', messageCount: 1, lastActiveAt: 10 }),
      newest: session({ id: 'newest', messageCount: 1, lastActiveAt: 30 }),
      mid: session({ id: 'mid', messageCount: 1, lastActiveAt: 20 }),
      run: session({ id: 'run', name: '[Task] x: y', messageCount: 99, lastActiveAt: 40 }),
    }
    assert.deepEqual(listConversations(sessions).map((s) => s.id), ['newest', 'mid', 'old'])
  })
})

describe('conversationTitle', () => {
  it('uses the session name when it says something', () => {
    assert.equal(conversationTitle(session({ id: 'a', name: 'Morvai ajánlat' }), 'Sidekick'), 'Morvai ajánlat')
  })

  it('falls back past the placeholder name', () => {
    // A "New Chat" négy külön szálon áll ebben az installban; négy azonos sor
    // nem mond semmit arról, melyiket keresed.
    const s = session({ id: 'b', name: 'New Chat', lastMessageSummary: { role: 'user', text: 'mi az ára?\nmásodik sor', time: 0 } })
    assert.equal(conversationTitle(s, 'Sidekick'), 'mi az ára?')
  })

  it('falls back to the agent when there is nothing else', () => {
    assert.equal(conversationTitle(session({ id: 'c', name: '' }), 'Ügyfélkezelő'), 'Ügyfélkezelő')
  })
})

describe('groupConversationsByAge', () => {
  // 2026-09-10 csütörtök, 14:00 helyi idő.
  const now = new Date(2026, 8, 10, 14, 0, 0).getTime()
  const at = (d: Date) => d.getTime()

  it('puts anything from today under MÁRA, down to one minute past midnight', () => {
    const groups = groupConversationsByAge([
      session({ id: 'a', messageCount: 1, lastActiveAt: at(new Date(2026, 8, 10, 0, 1)) }),
    ], now)
    assert.deepEqual(groups.map((g) => g.label), ['MÁRA'])
  })

  it('puts one minute earlier under TEGNAP', () => {
    const groups = groupConversationsByAge([
      session({ id: 'a', messageCount: 1, lastActiveAt: at(new Date(2026, 8, 9, 23, 59)) }),
    ], now)
    assert.deepEqual(groups.map((g) => g.label), ['TEGNAP'])
  })

  it('separates this week, this month and older', () => {
    // now = 2026-09-10 (Thursday), so this week's Monday is 2026-09-07.
    const groups = groupConversationsByAge([
      session({ id: 'w', messageCount: 1, lastActiveAt: at(new Date(2026, 8, 8, 10, 0)) }),
      session({ id: 'm', messageCount: 1, lastActiveAt: at(new Date(2026, 8, 3, 10, 0)) }),
      session({ id: 'o', messageCount: 1, lastActiveAt: at(new Date(2026, 5, 1, 10, 0)) }),
    ], now)
    assert.deepEqual(groups.map((g) => g.label), ['EZEN A HÉTEN', 'EZ A HÓNAP', 'RÉGEBBI'])
  })

  it('leaves an empty bucket out entirely', () => {
    const groups = groupConversationsByAge([
      session({ id: 'a', messageCount: 1, lastActiveAt: now }),
    ], now)
    assert.equal(groups.length, 1)
    assert.equal(groups[0].label, 'MÁRA')
  })

  it('keeps the newest-first order inside a bucket', () => {
    const groups = groupConversationsByAge([
      session({ id: 'older', messageCount: 1, lastActiveAt: at(new Date(2026, 8, 10, 9, 0)) }),
      session({ id: 'newer', messageCount: 1, lastActiveAt: at(new Date(2026, 8, 10, 13, 0)) }),
    ], now)
    assert.deepEqual(groups[0].sessions.map((s) => s.id), ['newer', 'older'])
  })

  it('files a session with no activity timestamp under RÉGEBBI instead of dropping it', () => {
    const groups = groupConversationsByAge([
      session({ id: 'ghost', messageCount: 1, lastActiveAt: 0 }),
    ], now)
    assert.deepEqual(groups.map((g) => g.label), ['RÉGEBBI'])
  })
})
