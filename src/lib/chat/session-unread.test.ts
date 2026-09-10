import test from 'node:test'
import assert from 'node:assert/strict'
import type { Session } from '@/types'
import { sessionUnreadState, selectUnreadSessions, selectVisibleUnreadSessions } from './session-unread'

function makeSession(overrides: Partial<Session> & { id: string }): Session {
  return {
    name: 'Test Session',
    user: 'default',
    messages: [],
    createdAt: 1,
    updatedAt: 1,
    lastActiveAt: 1,
    provider: 'openai',
    model: 'gpt-test',
    ...overrides,
  } as Session
}

test('minden ures -> nincs olvasatlan', () => {
  assert.deepEqual(sessionUnreadState({}), { unread: false, isError: false, lastActivityAt: 0 })
})

test('valasz a legutobbi olvasas utan -> olvasatlan', () => {
  const s = sessionUnreadState({ lastAssistantAt: 200, lastReadAt: 100 })
  assert.equal(s.unread, true)
  assert.equal(s.isError, false)
})

test('egyenloseg nem olvasatlan', () => {
  assert.equal(sessionUnreadState({ lastAssistantAt: 100, lastReadAt: 100 }).unread, false)
})

test('hibas turn a valasz utan -> olvasatlan, hibakent', () => {
  const s = sessionUnreadState({ lastAssistantAt: 150, lastFailedTurnAt: 200, lastReadAt: 100 })
  assert.equal(s.unread, true)
  assert.equal(s.isError, true)
})

test('hibas turn a valasz elott -> olvasatlan, de nem hibakent', () => {
  const s = sessionUnreadState({ lastAssistantAt: 200, lastFailedTurnAt: 150, lastReadAt: 100 })
  assert.equal(s.unread, true)
  assert.equal(s.isError, false)
})

test('mar olvasott hibas turn nem olvasatlan', () => {
  assert.equal(sessionUnreadState({ lastFailedTurnAt: 100, lastReadAt: 200 }).unread, false)
})

test('hianyzo lastReadAt nullakent szamit', () => {
  assert.equal(sessionUnreadState({ lastAssistantAt: 1 }).unread, true)
})

test('hibas turn es valasz azonos pillanatban -> hibakent szamit (M1: >= nem >)', () => {
  // A hiba es a valasz egyszerre erkezik (azonos ezredmasodperc). Ez a hiba
  // oldalan dontendo el: a turn hibaval vegzodott, tehat isError legyen igaz.
  // Ha a `failed >= assistant` osszehasonlitas `failed > assistant`-ra
  // mutalodik, ez a teszt megbukik (isError false lenne).
  const s = sessionUnreadState({ lastAssistantAt: 200, lastFailedTurnAt: 200, lastReadAt: 100 })
  assert.equal(s.unread, true)
  assert.equal(s.isError, true)
})

test('nincs valodi hibas turn -> nem hibakent szamit, meg akkor sem, ha a keplet olvasatlant ad (M2: a "failed > 0" or dontő)', () => {
  // Sem `lastAssistantAt`, sem `lastFailedTurnAt` nincs beallitva (mindketto
  // 0-kent szamit), tehat nem tortent semmilyen esemeny. A `lastReadAt` itt
  // szandekosan negativ, hogy `lastActivityAt (0) > lastReadAt` igaz legyen,
  // es unread=true adodjon `failed=assistant=0` mellett is -- ez az egyetlen
  // mod annak bizonyitasara, hogy az `&& failed > 0` felteles tenylegesen
  // szamit: nelkule `failed >= assistant` (0 >= 0) magaban hibakent jelolne
  // ezt, holott sosem volt hibas turn.
  const s = sessionUnreadState({ lastReadAt: -100 })
  assert.equal(s.unread, true)
  assert.equal(s.isError, false)
})

test('selectUnreadSessions - ures record -> ures tomb', () => {
  assert.deepEqual(selectUnreadSessions({}), [])
})

test('selectUnreadSessions - csak olvasott session -> kiszurt', () => {
  const sessions = {
    sess1: { lastAssistantAt: 100, lastReadAt: 100 },
  }
  assert.deepEqual(selectUnreadSessions(sessions), [])
})

test('selectUnreadSessions - olvasatlan session -> benne van', () => {
  const sessions = {
    sess1: { lastAssistantAt: 200, lastReadAt: 100 },
  }
  const result = selectUnreadSessions(sessions)
  assert.equal(result.length, 1)
  assert.equal(result[0].session.lastAssistantAt, 200)
  assert.equal(result[0].unread.unread, true)
})

test('selectUnreadSessions - tobb session, legujabbak elore rendezve', () => {
  const sessions = {
    sess1: { lastAssistantAt: 100, lastReadAt: 50 },
    sess2: { lastAssistantAt: 300, lastReadAt: 50 },
    sess3: { lastAssistantAt: 200, lastReadAt: 50 },
  }
  const result = selectUnreadSessions(sessions)
  assert.equal(result.length, 3)
  assert.equal(result[0].session.lastAssistantAt, 300)
  assert.equal(result[1].session.lastAssistantAt, 200)
  assert.equal(result[2].session.lastAssistantAt, 100)
})

test('selectVisibleUnreadSessions - masik felhasznalo olvasatlan sessionje nem lathato', () => {
  const sessions: Record<string, Session> = {
    mine: makeSession({ id: 'mine', user: 'alice', lastAssistantAt: 200, lastReadAt: 100 }),
    theirs: makeSession({ id: 'theirs', user: 'bob', lastAssistantAt: 200, lastReadAt: 100 }),
  }
  const result = selectVisibleUnreadSessions(sessions, 'alice', { localhost: false })
  assert.deepEqual(result.map((r) => r.session.id), ['mine'])
})

test('selectVisibleUnreadSessions - rendszer-tulajdonu session mindenkinek lathato', () => {
  const sessions: Record<string, Session> = {
    system: makeSession({ id: 'system', user: 'system', lastAssistantAt: 200, lastReadAt: 100 }),
  }
  const result = selectVisibleUnreadSessions(sessions, 'alice', { localhost: false })
  assert.deepEqual(result.map((r) => r.session.id), ['system'])
})

test('selectVisibleUnreadSessions - gazdatlan session mindenkinek lathato', () => {
  const sessions: Record<string, Session> = {
    unowned: makeSession({ id: 'unowned', user: '', lastAssistantAt: 200, lastReadAt: 100 }),
  }
  const result = selectVisibleUnreadSessions(sessions, 'alice', { localhost: false })
  assert.deepEqual(result.map((r) => r.session.id), ['unowned'])
})

test('selectVisibleUnreadSessions - a lathatosagi szures a rangsorolas elott fut, tobb felhasznalo kozott', () => {
  const sessions: Record<string, Session> = {
    aliceOld: makeSession({ id: 'aliceOld', user: 'alice', lastAssistantAt: 150, lastReadAt: 100 }),
    bobNew: makeSession({ id: 'bobNew', user: 'bob', lastAssistantAt: 900, lastReadAt: 100 }),
    aliceNew: makeSession({ id: 'aliceNew', user: 'alice', lastAssistantAt: 300, lastReadAt: 100 }),
  }
  const result = selectVisibleUnreadSessions(sessions, 'alice', { localhost: false })
  assert.deepEqual(result.map((r) => r.session.id), ['aliceNew', 'aliceOld'])
})
