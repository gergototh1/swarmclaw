import assert from 'node:assert/strict'
import test from 'node:test'

import { MIGRATIONS, createRepo } from '../src/db.mjs'
import { memStorage } from './helpers.mjs'

function repoOf() {
  const S = memStorage()
  for (const m of MIGRATIONS) S.raw.exec(m.sql)
  return { repo: createRepo(S), S }
}

test('az ügyfél létrejön és visszaolvasható', () => {
  const { repo } = repoOf()
  const acc = repo.createAccount({ name: 'Morvai Kft.', domains: ['morvai.hu'] })
  assert.match(acc.id, /^acc_[0-9a-f]{16}$/)
  assert.equal(acc.type, 'company')
  assert.equal(acc.status, 'lead')
  assert.deepEqual(repo.getAccount(acc.id).domains, ['morvai.hu'])
})

test('a domainek kisbetűsen és üresek nélkül tárolódnak', () => {
  const { repo } = repoOf()
  const acc = repo.createAccount({ name: 'X', domains: ['  Morvai.HU ', '', 'x.hu'] })
  assert.deepEqual(repo.getAccount(acc.id).domains, ['morvai.hu', 'x.hu'])
})

test('a listAccounts státuszra szűr', () => {
  const { repo } = repoOf()
  repo.createAccount({ name: 'A', status: 'lead' })
  repo.createAccount({ name: 'B', status: 'client' })
  assert.equal(repo.listAccounts({ status: 'client' }).length, 1)
  assert.equal(repo.listAccounts({}).length, 2)
})

test('egy email-cím egy kapcsolathoz tartozik, és kisbetűsen tárolódik', () => {
  const { repo } = repoOf()
  const acc = repo.createAccount({ name: 'Morvai Kft.' })
  const c = repo.createContact({ accountId: acc.id, name: 'Morvai Dorina' })
  repo.attachEmail(c.id, '  Dorina@Morvai.HU ')
  assert.equal(repo.contactByEmail('dorina@morvai.hu').id, c.id)
  assert.equal(repo.contactByEmail('DORINA@MORVAI.HU').id, c.id)
})

test('ugyanaz a cím másodszor a másik kapcsolatra íródik át, nem duplikál', () => {
  const { repo, S } = repoOf()
  const acc = repo.createAccount({ name: 'X' })
  const a = repo.createContact({ accountId: acc.id, name: 'A' })
  const b = repo.createContact({ accountId: acc.id, name: 'B' })
  repo.attachEmail(a.id, 'k@x.hu')
  repo.attachEmail(b.id, 'k@x.hu', 'learned')
  assert.equal(repo.contactByEmail('k@x.hu').id, b.id)
  assert.equal(S.all('SELECT * FROM ext_crm_contact_email').length, 1)
})

test('a searchContacts névre keres, ügyfél-határon és account nélküli kapcsolaton át is', () => {
  const { repo } = repoOf()
  const acc1 = repo.createAccount({ name: 'Acme Kft.' })
  const acc2 = repo.createAccount({ name: 'Beta Bt.' })
  const c1 = repo.createContact({ accountId: acc1.id, name: 'Dorina Nagy' })
  const c2 = repo.createContact({ accountId: acc2.id, name: 'dorina Kis' })
  const c3 = repo.createContact({ name: 'Ismeretlen Dorina' })
  repo.createContact({ accountId: acc1.id, name: 'Nem Talalt' })

  const found = repo.searchContacts('dorina').map((c) => c.id).sort()
  assert.deepEqual(found, [c1.id, c2.id, c3.id].sort())

  assert.deepEqual(repo.searchContacts('nincs ilyen'), [])
})

test('a searchContacts a %-ot és a _-t szó szerinti karakterként kezeli, nem jokerként', () => {
  // Escape nélkül egy '_' keresés minden kapcsolatot visszaadná (a LIKE
  // '%_%' mintaként bármely egyetlen karakterre illeszkedik, tehát gyakorlatilag
  // minden nem üres névre), és egy '%' hasonlóan mindenre. Escape-elve a '_'
  // csakis a szó szerinti aláhúzást tartalmazó nevekre talál.
  const { repo } = repoOf()
  const acc = repo.createAccount({ name: 'X' })
  repo.createContact({ accountId: acc.id, name: 'Dorina' })
  repo.createContact({ accountId: acc.id, name: 'A_B' })

  assert.deepEqual(repo.searchContacts('_').map((c) => c.name), ['A_B'])
  assert.deepEqual(repo.searchContacts('%'), [])

  const found = repo.searchContacts('a_b').map((c) => c.name)
  assert.deepEqual(found, ['A_B'])
})

test('a kapcsolat ügyfél nélkül is létezhet', () => {
  const { repo } = repoOf()
  const c = repo.createContact({ name: 'Ismeretlen' })
  assert.equal(c.accountId, null)
})

test('az ügy nyitottként jön létre és lezárható', () => {
  const { repo } = repoOf()
  const acc = repo.createAccount({ name: 'X' })
  const d = repo.createDeal({ accountId: acc.id, title: 'Kickoff', valueHuf: 500000 })
  assert.equal(d.kind, 'lead')
  assert.equal(d.closed_at, null)
  assert.equal(repo.listDeals({ openOnly: true }).length, 1)

  repo.closeDeal(d.id, { stage: 'won', reason: 'aláírva' })
  assert.equal(repo.listDeals({ openOnly: true }).length, 0)
  assert.equal(repo.listDeals({ accountId: acc.id })[0].stage, 'won')
})

test('ugyanaz a forrás-azonosító másodszor nem hoz létre új eseményt', () => {
  const { repo } = repoOf()
  const acc = repo.createAccount({ name: 'X' })
  const args = { accountId: acc.id, kind: 'email_in', occurredAt: '2026-09-01T10:00:00.000Z',
                 title: 'Ajánlat', excerpt: 'kérek egy…', sourceSystem: 'gmail', sourceId: 'thr_1' }
  const first = repo.recordEvent(args)
  const second = repo.recordEvent(args)
  assert.equal(first.created, true)
  assert.equal(second.created, false)
  assert.equal(second.event.id, first.event.id)
  assert.equal(repo.listEvents({ accountId: acc.id }).length, 1)
})

test('a teljes szöveg külön táblában van, és nem jön az idővonallal', () => {
  const { repo } = repoOf()
  const acc = repo.createAccount({ name: 'X' })
  const { event } = repo.recordEvent({ accountId: acc.id, kind: 'note',
    occurredAt: '2026-09-01T10:00:00.000Z', excerpt: 'rövid',
    sourceSystem: 'manual', sourceId: 'n1', body: 'a nagyon hosszú szöveg' })
  assert.equal(repo.getEventBody(event.id), 'a nagyon hosszú szöveg')
  assert.equal('content' in repo.listEvents({ accountId: acc.id })[0], false)
})

test('az idővonal a legfrissebbel kezd és lapozható', () => {
  const { repo } = repoOf()
  const acc = repo.createAccount({ name: 'X' })
  for (const n of [1, 2, 3]) {
    repo.recordEvent({ accountId: acc.id, kind: 'note', occurredAt: `2026-09-0${n}T10:00:00.000Z`,
                       excerpt: `e${n}`, sourceSystem: 'manual', sourceId: `n${n}` })
  }
  const page = repo.listEvents({ accountId: acc.id, limit: 2 })
  assert.deepEqual(page.map((e) => e.excerpt), ['e3', 'e2'])
  const next = repo.listEvents({ accountId: acc.id, before: page[1].occurred_at, limit: 2 })
  assert.deepEqual(next.map((e) => e.excerpt), ['e1'])
  assert.equal(repo.lastEventAt(acc.id), '2026-09-03T10:00:00.000Z')
})

test('a lapozás egy occurred_at-on osztozó csoportot sem nem ismétel, sem el nem hagy', () => {
  // A Gmail internalDate másodperc-pontos, tehát az egyezés rutin, nem
  // kivétel -- egy söprés akár 50 levelet is felvehet egy futásban. A
  // reprodukció: HÁROM esemény pontosan ugyanazon az occurred_at-on, limit 2
  // mellett -- ez a lapméretnél nagyobb egyezés-csoport. Tiebreak nélkül az
  // első lap tetszőleges kettőt ad vissza a háromból (SQLite nem ígér
  // sorrendet az egyenlő kulcsok között), a `before` erre az egyező
  // occurred_at-ra áll, és a második lap egy szigorú `occurred_at < before`
  // határral a maradék harmadikat *soha* nem adja vissza -- az véglegesen
  // kimarad, függetlenül attól, hogy az első lap melyik kettőt választotta.
  const { repo } = repoOf()
  const acc = repo.createAccount({ name: 'X' })
  const t = '2026-09-01T10:00:00.000Z'
  const { event: a } = repo.recordEvent({ accountId: acc.id, kind: 'note', occurredAt: t,
    excerpt: 'a', sourceSystem: 'manual', sourceId: 'tie_a' })
  const { event: b } = repo.recordEvent({ accountId: acc.id, kind: 'note', occurredAt: t,
    excerpt: 'b', sourceSystem: 'manual', sourceId: 'tie_b' })
  const { event: c } = repo.recordEvent({ accountId: acc.id, kind: 'note', occurredAt: t,
    excerpt: 'c', sourceSystem: 'manual', sourceId: 'tie_c' })

  const osszes = []
  let before
  let beforeId
  for (let i = 0; i < 10; i += 1) {
    const page = repo.listEvents({ accountId: acc.id, before, beforeId, limit: 2 })
    if (page.length === 0) break
    osszes.push(...page)
    const utolso = page[page.length - 1]
    before = utolso.occurred_at
    beforeId = utolso.id
  }
  assert.deepEqual(osszes.map((e) => e.id).sort(), [a.id, b.id, c.id].sort())
  assert.equal(new Set(osszes.map((e) => e.id)).size, 3, 'egy esemény sem ismétlődhet a lapok között')
})

test('a listEvents beforeId nélkül a régi, szigorú occurred_at < ? határt tartja (visszafele kompatibilis)', () => {
  const { repo } = repoOf()
  const acc = repo.createAccount({ name: 'X' })
  const t = '2026-09-01T10:00:00.000Z'
  repo.recordEvent({ accountId: acc.id, kind: 'note', occurredAt: t, excerpt: 'a',
    sourceSystem: 'manual', sourceId: 'tie_a' })
  repo.recordEvent({ accountId: acc.id, kind: 'note', occurredAt: t, excerpt: 'b',
    sourceSystem: 'manual', sourceId: 'tie_b' })
  // beforeId nélkül, ugyanarra az occurred_at-ra a régi hívó a régi
  // (hiányos) viselkedést kapja: a `before`-ral egyező occurred_at-ú sorok
  // kimaradnak, mert a határ szigorúan `<`.
  const next = repo.listEvents({ accountId: acc.id, before: t, limit: 10 })
  assert.equal(next.length, 0)
})

test('esemény nélküli ügyfélnél a lastEventAt pontosan null', () => {
  const { repo } = repoOf()
  const acc = repo.createAccount({ name: 'X' })
  assert.strictEqual(repo.lastEventAt(acc.id), null)
})

test('az updateDeal részleges patch-je nem nullázza a meg nem adott mezőket', () => {
  const { repo } = repoOf()
  const acc = repo.createAccount({ name: 'X' })
  const d = repo.createDeal({ accountId: acc.id, title: 'Kickoff', stage: 'new',
    valueHuf: 500000, kind: 'lead', expectedClose: '2026-10-01' })

  const updated = repo.updateDeal(d.id, { title: 'Uj cim' })
  assert.equal(updated.title, 'Uj cim')
  assert.equal(updated.stage, 'new')
  assert.equal(updated.value_huf, 500000)
  assert.equal(updated.kind, 'lead')
  assert.equal(updated.expected_close, '2026-10-01')
})

test('az összefoglaló a szerver által bélyegzett eseményig fedez', () => {
  const { repo } = repoOf()
  const acc = repo.createAccount({ name: 'X' })
  repo.recordEvent({ accountId: acc.id, kind: 'note', occurredAt: '2026-09-01T10:00:00.000Z',
                     excerpt: 'e1', sourceSystem: 'manual', sourceId: 'n1' })
  // Az ügynök NEM ad covers_event_id-t; a repo veszi a legfrissebbet.
  repo.writeSummary({ accountId: acc.id, text: 'Az ügyfél vár egy ajánlatot.', agentId: 'ag1' })

  const s = repo.latestSummary(acc.id)
  assert.equal(s.stale, false)
  assert.equal(s.newerEvents, 0)
  assert.equal(s.summary.covers_event_at, '2026-09-01T10:00:00.000Z')
})

test('az összefoglaló elavul, amint újabb esemény jön', () => {
  const { repo } = repoOf()
  const acc = repo.createAccount({ name: 'X' })
  repo.recordEvent({ accountId: acc.id, kind: 'note', occurredAt: '2026-09-01T10:00:00.000Z',
                     excerpt: 'e1', sourceSystem: 'manual', sourceId: 'n1' })
  repo.writeSummary({ accountId: acc.id, text: 'régi', agentId: 'ag1' })
  repo.recordEvent({ accountId: acc.id, kind: 'note', occurredAt: '2026-09-05T10:00:00.000Z',
                     excerpt: 'e2', sourceSystem: 'manual', sourceId: 'n2' })

  const s = repo.latestSummary(acc.id)
  assert.equal(s.stale, true)
  assert.equal(s.newerEvents, 1)
})

test('az összefoglaló elavul, ha egy új esemény a fedezett eseménnyel egy másodpercre esik', () => {
  // A Gmail internalDate másodperc-pontos: két esemény megoszthat egy
  // occurred_at-ot. A `covers_event_at`-ra való egyszerű `>` összehasonlítás
  // ekkor nem számolja el a másodikat -- a `covers_event_id`-t (és az azzal
  // vett összetett rendezést) kell nézni, nem csak az időbélyeget.
  const { repo, S } = repoOf()
  const acc = repo.createAccount({ name: 'X' })
  const t = '2026-09-01T10:00:00.000Z'
  repo.recordEvent({ accountId: acc.id, kind: 'note', occurredAt: t, excerpt: 'e1',
    sourceSystem: 'manual', sourceId: 'n1' })
  const sum = repo.writeSummary({ accountId: acc.id, text: 'x', agentId: 'ag1' })
  assert.notEqual(sum.covers_event_id, '')

  // Egy második esemény, szándékosan ugyanazon a másodpercen, és
  // szándékosan olyan id-vel, ami a fedezett esemény id-je UTÁN rendeződik
  // -- közvetlen SQL-beszúrással, hogy az id ne a véletlenre legyen bízva.
  S.exec(
    `INSERT INTO ext_crm_event (id, account_id, kind, occurred_at, excerpt, source_system, source_id, thread_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, '', ?)`,
    ['evt_ffffffffffffffff', acc.id, 'note', t, 'e2', 'manual', 'n2', new Date().toISOString()],
  )

  const s = repo.latestSummary(acc.id)
  assert.equal(s.stale, true)
  assert.equal(s.newerEvents, 1)
})

test('az esemény nélküli ügyfélnek nincs összefoglalója', () => {
  const { repo } = repoOf()
  const acc = repo.createAccount({ name: 'X' })
  assert.equal(repo.latestSummary(acc.id), null)
})

test('a feladat nélküli saját ígéret külön kérdezhető', () => {
  const { repo } = repoOf()
  const acc = repo.createAccount({ name: 'X' })
  const { event } = repo.recordEvent({ accountId: acc.id, kind: 'meeting',
    occurredAt: '2026-09-01T10:00:00.000Z', excerpt: 'x', sourceSystem: 'manual', sourceId: 'm1' })
  const mine = repo.writeCommitment({ accountId: acc.id, eventId: event.id,
    text: 'Küldöm az ajánlatot', direction: 'ours' })
  repo.writeCommitment({ accountId: acc.id, eventId: event.id,
    text: 'Küldi a cégadatokat', direction: 'theirs' })

  assert.equal(repo.listCommitments({ direction: 'ours', openOnly: true }).length, 1)
  repo.linkCommitmentTask(mine.id, 'task_42')
  assert.equal(repo.listCommitments({ direction: 'ours', openOnly: true }).length, 0)
})

/**
 * I4 (code review): a `getCommitment` a `crm_suggestion_write` (src/tools.mjs)
 * ownership-ellenőrzésének az alapja -- egy ügynök által küldött
 * `commitmentId`-t csak úgy lehet a saját ügyfeléhez tartozónak ellenőrizni,
 * ha az ígéret sora egyáltalán lekérdezhető id szerint.
 */
test('a getCommitment az igeretet adja vissza id szerint, vagy undefined-et', () => {
  const { repo } = repoOf()
  const acc = repo.createAccount({ name: 'X' })
  const { event } = repo.recordEvent({ accountId: acc.id, kind: 'meeting',
    occurredAt: '2026-09-01T10:00:00.000Z', excerpt: 'x', sourceSystem: 'manual', sourceId: 'm1' })
  const igeret = repo.writeCommitment({ accountId: acc.id, eventId: event.id, text: 'Küldöm', direction: 'ours' })

  assert.equal(repo.getCommitment(igeret.id).account_id, acc.id)
  assert.equal(repo.getCommitment('cmt_nincs'), undefined)
})

test('a besorolatlan sor forrásra idempotens és lezárható', () => {
  const { repo } = repoOf()
  const args = { sourceSystem: 'gmail', sourceId: 'thr_9', senderAddress: 'a@b.hu',
                 subject: 'Szia', receivedAt: '2026-09-01T10:00:00.000Z' }
  assert.equal(repo.recordUnmatched(args).created, true)
  assert.equal(repo.recordUnmatched(args).created, false)
  assert.equal(repo.listUnmatched().length, 1)

  repo.resolveUnmatched(repo.listUnmatched()[0].id)
  assert.equal(repo.listUnmatched().length, 0)
})

test('a javaslat megíródik és az "new" státuszú listában visszajön', () => {
  const { repo } = repoOf()
  const acc = repo.createAccount({ name: 'X' })
  repo.writeSuggestion({ accountId: acc.id, text: 'Küldj emlékeztetőt',
    reason: 'két hete nincs válasz', triggerKind: 'silence' })

  const rows = repo.listSuggestions({ status: 'new' })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].trigger_kind, 'silence')
  assert.equal(rows[0].reason, 'két hete nincs válasz')
})

/**
 * A 6. feladat előfeltétele: a javaslat tudja meg, melyik ígéretből született.
 * Enélkül az elfogadás feladatot csinál az ígéretből, de az ígéret task_id-je
 * üresen marad, és a figyelem-lista örökre újra felhozza ugyanazt az ígéretet.
 */
test('a javaslat commitmentId-vel visszaolvasható, és null marad, ha nem adták meg', () => {
  const { repo } = repoOf()
  const acc = repo.createAccount({ name: 'X' })
  const { event } = repo.recordEvent({ accountId: acc.id, kind: 'meeting',
    occurredAt: '2026-09-01T10:00:00.000Z', excerpt: 'x', sourceSystem: 'manual', sourceId: 'm1' })
  const igeret = repo.writeCommitment({ accountId: acc.id, eventId: event.id, text: 'Küldöm', direction: 'ours' })

  const sugIgeretbol = repo.writeSuggestion({ accountId: acc.id, text: 'Küldd el', commitmentId: igeret.id })
  assert.equal(sugIgeretbol.commitment_id, igeret.id)

  const sugMasik = repo.writeSuggestion({ accountId: acc.id, text: 'Másik javaslat' })
  assert.equal(sugMasik.commitment_id, null)
})

test('a javaslat státusza módosítható, és utána kikerül az "new" listából', () => {
  const { repo } = repoOf()
  const acc = repo.createAccount({ name: 'X' })
  const sug = repo.writeSuggestion({ accountId: acc.id, text: 'Küldj emlékeztetőt' })

  const updated = repo.setSuggestionStatus(sug.id, 'dismissed')
  assert.equal(updated.status, 'dismissed')
  assert.equal(repo.listSuggestions({ status: 'new' }).length, 0)
})

test('az ismeretlen javaslat státusz-állítása pontosan null-t ad', () => {
  const { repo } = repoOf()
  assert.strictEqual(repo.setSuggestionStatus('sug_nincs', 'dismissed'), null)
})

test('a sopres-allapot irhato es visszaolvashato', () => {
  const { repo } = repoOf()
  assert.equal(repo.getSweepState('gmail'), null)
  repo.setSweepState('gmail', { cursor: 'c1', lastSeenAt: '2026-09-01T10:00:00.000Z' })
  assert.equal(repo.getSweepState('gmail').cursor, 'c1')
  repo.setSweepState('gmail', { cursor: 'c2', lastSeenAt: '2026-09-02T10:00:00.000Z' })
  assert.equal(repo.getSweepState('gmail').cursor, 'c2', 'a masodik iras felulir, nem duplikal')
})

test('accountIdByThread a szal mar besorolt uzenetebol dolgozik', () => {
  const { repo } = repoOf()
  const acc = repo.createAccount({ name: 'X' })
  repo.recordEvent({ accountId: acc.id, kind: 'email_in', occurredAt: '2026-09-01T10:00:00.000Z',
                     excerpt: 'e', sourceSystem: 'gmail', sourceId: 'msg_1', threadId: 'thr_1' })
  assert.equal(repo.accountIdByThread('thr_1'), acc.id)
  assert.equal(repo.accountIdByThread('thr_nincs'), null)
})

test('accountIdByThread ures szal-azonositora null, akkor is ha van kezi esemeny ures thread_id-vel', () => {
  const { repo } = repoOf()
  const acc = repo.createAccount({ name: 'X' })
  // A kezi esemeny thread_id-je az oszlop alapertekebol '' -- ez nem tartozhat
  // egyetlen szalhoz sem, tehat egy ures kereses nem adhatja vissza ennek az
  // ugyfelnek az id-jet.
  repo.recordEvent({ accountId: acc.id, kind: 'note', occurredAt: '2026-09-01T10:00:00.000Z',
                     excerpt: 'e', sourceSystem: 'manual', sourceId: 'note:1' })
  assert.equal(repo.accountIdByThread(''), null)
})

test('accountsByDomain csak a pontos domain-egyezest adja', () => {
  const { repo } = repoOf()
  const a = repo.createAccount({ name: 'A', domains: ['morvai.hu'] })
  repo.createAccount({ name: 'B', domains: ['mas.hu'] })
  assert.deepEqual(repo.accountsByDomain('morvai.hu'), [a.id])
  assert.deepEqual(repo.accountsByDomain('nincs.hu'), [])
})

test('silentDeals csak a NYITOTT ugyeket adja, es csak a nemakat', () => {
  const { repo } = repoOf()
  const acc = repo.createAccount({ name: 'X' })
  const nema = repo.createDeal({ accountId: acc.id, title: 'Nema' })
  const friss = repo.createDeal({ accountId: acc.id, title: 'Friss' })
  const zart = repo.createDeal({ accountId: acc.id, title: 'Zart' })
  repo.closeDeal(zart.id, { stage: 'won', reason: '' })

  repo.recordEvent({ accountId: acc.id, dealId: nema.id, kind: 'note',
    occurredAt: '2026-08-01T10:00:00.000Z', excerpt: 'regi', sourceSystem: 'manual', sourceId: 'r1' })
  repo.recordEvent({ accountId: acc.id, dealId: friss.id, kind: 'note',
    occurredAt: '2026-09-05T10:00:00.000Z', excerpt: 'uj', sourceSystem: 'manual', sourceId: 'r2' })
  repo.recordEvent({ accountId: acc.id, dealId: zart.id, kind: 'note',
    occurredAt: '2026-08-01T10:00:00.000Z', excerpt: 'regi', sourceSystem: 'manual', sourceId: 'r3' })

  const nemak = repo.silentDeals('2026-09-01T00:00:00.000Z')
  assert.deepEqual(nemak.map((d) => d.title), ['Nema'])
})

test('silentDeals az esemeny nelkuli nyitott ugyet is nemanak szamolja', () => {
  const { repo } = repoOf()
  const acc = repo.createAccount({ name: 'X' })
  repo.createDeal({ accountId: acc.id, title: 'Sosem tortent semmi' })
  const nemak = repo.silentDeals('2026-09-01T00:00:00.000Z')
  assert.equal(nemak.length, 1, 'egy ugy, amin SOHA nem tortent semmi, a legnemabb')
  assert.equal(nemak[0].last_event_at, null)
})

test('unansweredThreads csak azt adja, amire nem ment valasz', () => {
  const { repo } = repoOf()
  const acc = repo.createAccount({ name: 'X' })
  repo.recordEvent({ accountId: acc.id, kind: 'email_in', occurredAt: '2026-08-20T10:00:00.000Z',
    title: 'Varok valaszt', excerpt: 'e', sourceSystem: 'gmail', sourceId: 'a1', threadId: 'thr_a' })
  repo.recordEvent({ accountId: acc.id, kind: 'email_in', occurredAt: '2026-08-20T10:00:00.000Z',
    title: 'Ez megvalaszolva', excerpt: 'e', sourceSystem: 'gmail', sourceId: 'b1', threadId: 'thr_b' })
  repo.recordEvent({ accountId: acc.id, kind: 'email_out', occurredAt: '2026-08-21T10:00:00.000Z',
    excerpt: 'valasz', sourceSystem: 'gmail', sourceId: 'b2', threadId: 'thr_b' })

  const varok = repo.unansweredThreads('2026-09-01T00:00:00.000Z')
  assert.deepEqual(varok.map((x) => x.thread_id), ['thr_a'])
})

test('unansweredThreads a KESOBBI valaszt szamitja, nem barmelyiket', () => {
  const { repo } = repoOf()
  const acc = repo.createAccount({ name: 'X' })
  repo.recordEvent({ accountId: acc.id, kind: 'email_out', occurredAt: '2026-08-10T10:00:00.000Z',
    excerpt: 'regi valasz', sourceSystem: 'gmail', sourceId: 'o1', threadId: 'thr_c' })
  repo.recordEvent({ accountId: acc.id, kind: 'email_in', occurredAt: '2026-08-20T10:00:00.000Z',
    title: 'Ujabb kerdes', excerpt: 'e', sourceSystem: 'gmail', sourceId: 'i1', threadId: 'thr_c' })

  const varok = repo.unansweredThreads('2026-09-01T00:00:00.000Z')
  assert.deepEqual(varok.map((x) => x.thread_id), ['thr_c'],
    'a valasz KORABBI mint a kerdes, tehat nem valasz ra')
})

/**
 * I1: a fuggveny neve, a docstringje es a spec is SZALAT mond, a lekerdezes
 * viszont `email_in`-enkent adott egy sort. Egy sokat surgeto szal igy ot
 * majdnem azonos `valasz_nelkul` sort termel, es a napi kor (`agents.mjs`:
 * "vedd az elso legfeljebb ot sort") egyetlen beszelgetesre egeti el az egesz
 * napi keretet.
 */
test('unansweredThreads szalankent EGY sort ad, tobb valasz nelkuli level eseten is', () => {
  const { repo } = repoOf()
  const acc = repo.createAccount({ name: 'X' })
  const idok = ['2026-08-20T10:00:00.000Z', '2026-08-22T10:00:00.000Z', '2026-08-24T10:00:00.000Z',
                '2026-08-26T10:00:00.000Z', '2026-08-28T10:00:00.000Z']
  idok.forEach((ts, i) => {
    repo.recordEvent({ accountId: acc.id, kind: 'email_in', occurredAt: ts,
      title: `Surgetes ${i}`, excerpt: 'e', sourceSystem: 'gmail', sourceId: `i${i}`, threadId: 'thr_a' })
  })

  const varok = repo.unansweredThreads('2026-09-01T00:00:00.000Z')
  assert.equal(varok.length, 1, 'egy szal, egy sor -- nem levelenkent egy')
  assert.equal(varok[0].thread_id, 'thr_a')
  assert.equal(varok[0].occurred_at, idok[0],
    'a LEGREGEBBI valasz nelkuli level kepviseli a szalat: a rangsort a kor hajtja, es az adossag ott kezdodott')
  assert.equal(varok[0].subject, 'Surgetes 0')
})

/**
 * A kepviselo nem a szal ELSO levele, hanem az utolso valasz UTANI elso: egy
 * regen megvalaszolt szal nem "harminc napja valasz nelkul", hanem annyi ideje,
 * amiota tenylegesen adosak vagyunk.
 */
test('unansweredThreads kepviseloje az utolso valasz UTANI elso level', () => {
  const { repo } = repoOf()
  const acc = repo.createAccount({ name: 'X' })
  repo.recordEvent({ accountId: acc.id, kind: 'email_in', occurredAt: '2026-08-01T10:00:00.000Z',
    title: 'Regi kerdes', excerpt: 'e', sourceSystem: 'gmail', sourceId: 'r1', threadId: 'thr_d' })
  repo.recordEvent({ accountId: acc.id, kind: 'email_out', occurredAt: '2026-08-05T10:00:00.000Z',
    excerpt: 'valasz', sourceSystem: 'gmail', sourceId: 'r2', threadId: 'thr_d' })
  repo.recordEvent({ accountId: acc.id, kind: 'email_in', occurredAt: '2026-08-10T10:00:00.000Z',
    title: 'Ujabb kerdes', excerpt: 'e', sourceSystem: 'gmail', sourceId: 'r3', threadId: 'thr_d' })
  repo.recordEvent({ accountId: acc.id, kind: 'email_in', occurredAt: '2026-08-15T10:00:00.000Z',
    title: 'Surgetes', excerpt: 'e', sourceSystem: 'gmail', sourceId: 'r4', threadId: 'thr_d' })

  const varok = repo.unansweredThreads('2026-09-01T00:00:00.000Z')
  assert.equal(varok.length, 1)
  assert.equal(varok[0].occurred_at, '2026-08-10T10:00:00.000Z')
  assert.equal(varok[0].subject, 'Ujabb kerdes')
})

/** Ket szal ket sor marad, es a regebbi szal all elol. */
test('unansweredThreads tobb szalnal szalankent egy sort ad, a regebbi elol', () => {
  const { repo } = repoOf()
  const acc = repo.createAccount({ name: 'X' })
  repo.recordEvent({ accountId: acc.id, kind: 'email_in', occurredAt: '2026-08-10T10:00:00.000Z',
    title: 'Regebbi szal', excerpt: 'e', sourceSystem: 'gmail', sourceId: 'a1', threadId: 'thr_regi' })
  repo.recordEvent({ accountId: acc.id, kind: 'email_in', occurredAt: '2026-08-12T10:00:00.000Z',
    title: 'Regebbi szal surgetes', excerpt: 'e', sourceSystem: 'gmail', sourceId: 'a2', threadId: 'thr_regi' })
  repo.recordEvent({ accountId: acc.id, kind: 'email_in', occurredAt: '2026-08-20T10:00:00.000Z',
    title: 'Ujabb szal', excerpt: 'e', sourceSystem: 'gmail', sourceId: 'b1', threadId: 'thr_uj' })

  const varok = repo.unansweredThreads('2026-09-01T00:00:00.000Z')
  assert.deepEqual(varok.map((x) => x.thread_id), ['thr_regi', 'thr_uj'])
})

test('openCommitmentsOlderThan iranyra szur es a feladat nelkulieket adja', () => {
  const { repo } = repoOf()
  const acc = repo.createAccount({ name: 'X' })
  const { event } = repo.recordEvent({ accountId: acc.id, kind: 'meeting',
    occurredAt: '2026-08-01T10:00:00.000Z', excerpt: 'x', sourceSystem: 'manual', sourceId: 'm1' })
  const enyem = repo.writeCommitment({ accountId: acc.id, eventId: event.id, text: 'Kuldom', direction: 'ours' })
  repo.writeCommitment({ accountId: acc.id, eventId: event.id, text: 'Kuldi', direction: 'theirs' })
  const mar = repo.writeCommitment({ accountId: acc.id, eventId: event.id, text: 'Ez kesz', direction: 'ours' })
  repo.linkCommitmentTask(mar.id, 'task_1')

  // A commitment `created_at`-je a valodi orajarasbol (`now()`) szarmazik --
  // a kuszobnek ezert a futtatas pillanatahoz kepest kesobbinek kell lennie,
  // nem egy fixre irt datumnak, kulonben a teszt a naptartol fuggne.
  const cutoff = new Date(Date.now() + 60_000).toISOString()
  const sajat = repo.openCommitmentsOlderThan(cutoff, 'ours')
  assert.deepEqual(sajat.map((c) => c.id), [enyem.id])
})
