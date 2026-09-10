import test from 'node:test'
import assert from 'node:assert/strict'
import { advanceReplyNotifierSeen } from './reply-notifier-state'
import type { Session, Sessions } from '@/types'

function session(over: Partial<Session> & { id: string }): Session {
  return {
    name: 'Sidekick', cwd: '/tmp', user: 'user', provider: 'claude-cli', model: '',
    claudeSessionId: null, messages: [], createdAt: 0, messageCount: 1,
    lastAssistantAt: 0, lastReadAt: 0,
    ...over,
  } as Session
}

function bySessions(...sessions: Session[]): Sessions {
  const map: Sessions = {}
  for (const s of sessions) map[s.id] = s
  return map
}

/**
 * Reproduces the app's actual two-render pattern: `sessions` starts as `{}`
 * (no persist middleware -- see `session-slice.ts`) and is filled in later,
 * asynchronously, by `loadSessions()`. The first call here sees an EMPTY
 * list; the second sees the real one, already containing unread activity.
 * Without the empty-list guard in `advanceReplyNotifierSeen`, the first call
 * would baseline against nothing and the second call would treat every
 * session's existing activity as brand new -- a notification burst on cold
 * start.
 */
test('cold start: baselining against an empty first render fires nothing on the real population', () => {
  const a = session({ id: 'a', lastAssistantAt: 100, lastReadAt: 0 })
  const b = session({ id: 'b', lastAssistantAt: 200, lastReadAt: 0 })

  // First render: the store has not loaded sessions yet.
  const first = advanceReplyNotifierSeen(null, {})
  assert.equal(first.seen, null, 'an empty first render must not take a baseline')
  assert.deepEqual(first.fired, [])

  // Second render: loadSessions() has resolved, both chats are already unread.
  const second = advanceReplyNotifierSeen(first.seen, bySessions(a, b))
  assert.deepEqual(second.fired, [], 'already-unread chats seen for the first time must not fire')
  assert.ok(second.seen, 'a baseline must exist once real sessions arrived')

  // A subsequent NEW reply on top of that baseline must fire -- otherwise
  // the fix above could trivially be "never notify".
  const bWithNewReply = session({ id: 'b', lastAssistantAt: 250, lastReadAt: 0 })
  const third = advanceReplyNotifierSeen(second.seen, bySessions(a, bWithNewReply))
  assert.deepEqual(third.fired, ['b'])
})

test('a chat that was already read at baseline time stays silent even once real data lands', () => {
  const readChat = session({ id: 'c', lastAssistantAt: 100, lastReadAt: 100 })

  const first = advanceReplyNotifierSeen(null, {})
  const second = advanceReplyNotifierSeen(first.seen, bySessions(readChat))
  assert.deepEqual(second.fired, [])
})

test('baseline is taken as soon as a non-empty list is seen, not only on the very first call', () => {
  const a = session({ id: 'a', lastAssistantAt: 100, lastReadAt: 0 })
  const step = advanceReplyNotifierSeen(null, bySessions(a))
  assert.ok(step.seen)
  assert.equal(step.seen?.get('a'), 100)
  assert.deepEqual(step.fired, [])
})

/**
 * The three session kinds `listConversations` (`src/lib/conversation-list.ts`)
 * leaves off the Chat page must never fire a desktop notification either --
 * see that module's header comment for why the filter has to be shared
 * rather than reimplemented here. An ordinary conversation alongside them
 * must still fire, so the fix can't be "filter everything out."
 */
test('a scheduled/task run never fires, even as its activity advances', () => {
  const run = session({ id: 'run', name: '[Task] Signal Scout: [Sched]', messageCount: 99, lastAssistantAt: 100, lastReadAt: 0 })

  const first = advanceReplyNotifierSeen(null, {})
  const second = advanceReplyNotifierSeen(first.seen, bySessions(run))
  assert.deepEqual(second.fired, [])

  const advanced = session({ ...run, lastAssistantAt: 200 })
  const third = advanceReplyNotifierSeen(second.seen, bySessions(advanced))
  assert.deepEqual(third.fired, [], 'a task run must not fire even once its own activity advances')
})

test('a chatroom half-session never fires, even as its activity advances', () => {
  const room = session({ id: 'chatroom-de6a7849-default', messageCount: 28, lastAssistantAt: 100, lastReadAt: 0 })

  const first = advanceReplyNotifierSeen(null, {})
  const second = advanceReplyNotifierSeen(first.seen, bySessions(room))
  assert.deepEqual(second.fired, [])

  const advanced = session({ ...room, lastAssistantAt: 200 })
  const third = advanceReplyNotifierSeen(second.seen, bySessions(advanced))
  assert.deepEqual(third.fired, [], 'a chatroom half-session must not fire even once its own activity advances')
})

test('an empty session never fires, even once timestamps move', () => {
  const empty = session({ id: 'empty', messageCount: 0, lastAssistantAt: 100, lastReadAt: 0 })

  const first = advanceReplyNotifierSeen(null, {})
  const second = advanceReplyNotifierSeen(first.seen, bySessions(empty))
  assert.deepEqual(second.fired, [])

  const advanced = session({ ...empty, lastAssistantAt: 200 })
  const third = advanceReplyNotifierSeen(second.seen, bySessions(advanced))
  assert.deepEqual(third.fired, [], 'an empty session must not fire even once its timestamp moves')
})

test('an ordinary conversation still fires alongside excluded sessions', () => {
  const run = session({ id: 'run', name: '[Task] x: y', messageCount: 99, lastAssistantAt: 100, lastReadAt: 0 })
  const room = session({ id: 'chatroom-abc-default', messageCount: 5, lastAssistantAt: 100, lastReadAt: 0 })
  const empty = session({ id: 'empty', messageCount: 0, lastAssistantAt: 100, lastReadAt: 0 })
  const chat = session({ id: 'chat', messageCount: 3, lastAssistantAt: 100, lastReadAt: 0 })

  const first = advanceReplyNotifierSeen(null, {})
  const second = advanceReplyNotifierSeen(first.seen, bySessions(run, room, empty, chat))
  assert.deepEqual(second.fired, [], 'already-unread at baseline time must not fire yet')

  const chatReplied = session({ ...chat, lastAssistantAt: 300 })
  const runAdvanced = session({ ...run, lastAssistantAt: 300 })
  const third = advanceReplyNotifierSeen(second.seen, bySessions(runAdvanced, room, empty, chatReplied))
  assert.deepEqual(third.fired, ['chat'], 'only the real conversation may fire')
})
