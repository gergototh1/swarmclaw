import test from 'node:test'
import assert from 'node:assert/strict'
import { buildNotificationPayload } from './notification-payload'

test('sikeres valasz: az ugynok neve a cim, a valasz kivonata a torzs', () => {
  const p = buildNotificationPayload(
    { name: 'Kutatas', lastFailedTurnAt: null, lastAssistantAt: 5, lastMessageText: 'Megtalaltam a harom legjobb ajanlatot.' },
    'Marveen',
  )
  assert.equal(p.title, 'Marveen')
  assert.equal(p.body, 'Megtalaltam a harom legjobb ajanlatot.')
  assert.equal(p.isError, false)
})

test('tobbsoros/tobb szokozos valasz egyetlen sorba tomorul', () => {
  const p = buildNotificationPayload(
    { name: 'Kutatas', lastFailedTurnAt: null, lastAssistantAt: 5, lastMessageText: 'Elso sor.\n\n  Masodik   sor.\t\tHarmadik.' },
    'Marveen',
  )
  assert.equal(p.body, 'Elso sor. Masodik sor. Harmadik.')
})

test('tul hosszu valasz levagva, három ponttal', () => {
  const longText = 'a'.repeat(200)
  const p = buildNotificationPayload(
    { name: 'Kutatas', lastFailedTurnAt: null, lastAssistantAt: 5, lastMessageText: longText },
    'Marveen',
  )
  assert.ok(p.body.length < longText.length)
  assert.ok(p.body.endsWith('…'))
  assert.ok(p.body.startsWith('a'.repeat(50)))
})

test('hianyzo vagy ures valaszszoveg eseten a chat neve a tartalek', () => {
  const missing = buildNotificationPayload({ name: 'Kutatas', lastFailedTurnAt: null, lastAssistantAt: 5, lastMessageText: null }, 'Marveen')
  assert.equal(missing.body, 'Kutatas')

  const blank = buildNotificationPayload(
    { name: 'Kutatas', lastFailedTurnAt: null, lastAssistantAt: 5, lastMessageText: '   \n  ' },
    'Marveen',
  )
  assert.equal(blank.body, 'Kutatas')
})

test('hibas turn eseten mas torzs, meg akkor is ha van valaszkivonat', () => {
  // Egy hibaval vegzodott turn utan is maradhat egy korabbi `lastMessageText`
  // a session-on -- a hibauzenetnek ekkor sem szabad valaszkent olvasodnia.
  const p = buildNotificationPayload(
    { name: 'Kutatas', lastFailedTurnAt: 9, lastAssistantAt: 5, lastMessageText: 'Ez egy korabbi sikeres valasz szovege.' },
    'Marveen',
  )
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
