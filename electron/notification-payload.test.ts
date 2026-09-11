import test from 'node:test'
import assert from 'node:assert/strict'
import { buildNotificationPayload, stripMarkdown } from './notification-payload'

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
  const longText = 'a'.repeat(300)
  const p = buildNotificationPayload(
    { name: 'Kutatas', lastFailedTurnAt: null, lastAssistantAt: 5, lastMessageText: longText },
    'Marveen',
  )
  assert.equal(p.body, `${'a'.repeat(200)}…`)
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
  assert.equal(p.body, 'Run failed: Kutatas')
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
  assert.equal(p.body, 'Run failed: Kutatas')
})

test('markdown marks are stripped from the excerpt', () => {
  const p = buildNotificationPayload(
    {
      name: 'Kutatas',
      lastFailedTurnAt: null,
      lastAssistantAt: 5,
      lastMessageText: '# Summary\n\n**Done**: found [three offers](https://x.y) and `npm test` passes.\n- first\n- second\n> quoted',
    },
    'Marveen',
  )
  assert.equal(p.body, 'Summary Done: found three offers and npm test passes. first second quoted')
})

test('snake_case words and lone asterisks survive', () => {
  assert.equal(stripMarkdown('Renamed foo_bar_baz to qux'), 'Renamed foo_bar_baz to qux')
  assert.equal(stripMarkdown('2 * 3 = 6'), '2 * 3 = 6')
  assert.equal(stripMarkdown('5*3=15 or 2*4=8'), '5*3=15 or 2*4=8')
  assert.equal(stripMarkdown('an *italic* and _another_ one'), 'an italic and another one')
})

test('an image becomes its alt text', () => {
  assert.equal(stripMarkdown('![chart of sales](a.png)'), 'chart of sales')
})

test('text that is only markup falls back to the chat name', () => {
  const p = buildNotificationPayload(
    { name: 'Kutatas', lastFailedTurnAt: null, lastAssistantAt: 5, lastMessageText: '```\n```' },
    'Marveen',
  )
  assert.equal(p.body, 'Kutatas')
})
