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
