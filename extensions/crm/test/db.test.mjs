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
