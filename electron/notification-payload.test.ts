import test from 'node:test'
import assert from 'node:assert/strict'
import { buildNotificationPayload } from './notification-payload'

test('sikeres valasz: az ugynok neve a cim, a chat neve a torzs', () => {
  const p = buildNotificationPayload({ name: 'Kutatas', lastFailedTurnAt: null, lastAssistantAt: 5 }, 'Marveen')
  assert.equal(p.title, 'Marveen')
  assert.equal(p.body, 'Valaszolt: Kutatas')
  assert.equal(p.isError, false)
})

test('hibas turn eseten mas torzs', () => {
  const p = buildNotificationPayload({ name: 'Kutatas', lastFailedTurnAt: 9, lastAssistantAt: 5 }, 'Marveen')
  assert.equal(p.isError, true)
  assert.equal(p.body, 'A futas hibaval vegzodott: Kutatas')
})

test('nevtelen ugynok eseten sem ures a cim', () => {
  const p = buildNotificationPayload({ name: 'Kutatas', lastFailedTurnAt: null, lastAssistantAt: 5 }, '')
  assert.equal(p.title, 'SwarmClaw')
})

test('hibas turn es valasz azonos pillanatban -> hibakent szamit (>= nem >)', () => {
  // A hiba es a valasz egyszerre erkezik (azonos ezredmasodperc): a turn
  // hibaval vegzodott, tehat isError legyen igaz. Ha a `failed >= assistant`
  // osszehasonlitas `failed > assistant`-ra mutalodik, ez a teszt megbukik
  // (isError false lenne) -- lasd `src/lib/chat/session-unread.test.ts`
  // ugyanezt a hataresetet a masik oldalon.
  const p = buildNotificationPayload({ name: 'Kutatas', lastFailedTurnAt: 5, lastAssistantAt: 5 }, 'Marveen')
  assert.equal(p.isError, true)
  assert.equal(p.body, 'A futas hibaval vegzodott: Kutatas')
})
