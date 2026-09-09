import test from 'node:test'
import assert from 'node:assert/strict'
import { advanceReplyNotifierSeen, type ReplyNotifierSession } from './reply-notifier-state'

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
  const a: ReplyNotifierSession = { id: 'a', lastAssistantAt: 100, lastReadAt: 0 }
  const b: ReplyNotifierSession = { id: 'b', lastAssistantAt: 200, lastReadAt: 0 }

  // First render: the store has not loaded sessions yet.
  const first = advanceReplyNotifierSeen(null, [])
  assert.equal(first.seen, null, 'an empty first render must not take a baseline')
  assert.deepEqual(first.fired, [])

  // Second render: loadSessions() has resolved, both chats are already unread.
  const second = advanceReplyNotifierSeen(first.seen, [a, b])
  assert.deepEqual(second.fired, [], 'already-unread chats seen for the first time must not fire')
  assert.ok(second.seen, 'a baseline must exist once real sessions arrived')

  // A subsequent NEW reply on top of that baseline must fire -- otherwise
  // the fix above could trivially be "never notify".
  const bWithNewReply: ReplyNotifierSession = { id: 'b', lastAssistantAt: 250, lastReadAt: 0 }
  const third = advanceReplyNotifierSeen(second.seen, [a, bWithNewReply])
  assert.deepEqual(third.fired, ['b'])
})

test('a chat that was already read at baseline time stays silent even once real data lands', () => {
  const readChat: ReplyNotifierSession = { id: 'c', lastAssistantAt: 100, lastReadAt: 100 }

  const first = advanceReplyNotifierSeen(null, [])
  const second = advanceReplyNotifierSeen(first.seen, [readChat])
  assert.deepEqual(second.fired, [])
})

test('baseline is taken as soon as a non-empty list is seen, not only on the very first call', () => {
  const a: ReplyNotifierSession = { id: 'a', lastAssistantAt: 100, lastReadAt: 0 }
  const step = advanceReplyNotifierSeen(null, [a])
  assert.ok(step.seen)
  assert.equal(step.seen?.get('a'), 100)
  assert.deepEqual(step.fired, [])
})
