import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { conversationTitle, isConversation, listConversations } from './conversation-list'
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
