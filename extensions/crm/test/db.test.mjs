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
