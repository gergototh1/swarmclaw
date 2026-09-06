import assert from 'node:assert/strict'
import test from 'node:test'

import { MIGRATIONS, createRepo } from '../src/db.mjs'
import { createSweep } from '../src/sweep.mjs'
import { memStorage } from './helpers.mjs'

/** A `mailbox` szerzodes kettose: ket metodus, memoriabol. */
function fakeMailbox(uzenetek) {
  return {
    list: async () => ({ ids: uzenetek.map((u) => u.id), nextCursor: '', complete: true, stoppedOn: '' }),
    get: async ({ id }) => uzenetek.find((u) => u.id === id),
  }
}

function sweepOf(uzenetek) {
  const S = memStorage()
  for (const m of MIGRATIONS) S.raw.exec(m.sql)
  const repo = createRepo(S)
  const state = { repo, log: console, contracts: { get: () => fakeMailbox(uzenetek) } }
  return { sweep: createSweep(state), repo }
}

const LEVEL = (over) => ({
  id: 'msg_1', threadId: 'thr_1', labelIds: ['INBOX'], subject: 'Ajanlat',
  fromName: 'Morvai Dorina', fromEmail: 'dorina@morvai.hu',
  sentAt: '2026-09-01T10:00:00.000Z', text: 'Kerek egy ajanlatot.',
  textInAttachment: false, sizeEstimate: 100, ...over,
})

test('ismert cimrol jovo level az ugyfel idovonalara kerul', async () => {
  const { sweep, repo } = sweepOf([LEVEL()])
  const acc = repo.createAccount({ name: 'Morvai Kft.' })
  const con = repo.createContact({ accountId: acc.id, name: 'Dorina' })
  repo.attachEmail(con.id, 'dorina@morvai.hu')

  const r = await sweep.runSweep({})
  assert.equal(r.recorded, 1)
  assert.equal(r.unmatched, 0)
  const ev = repo.listEvents({ accountId: acc.id })[0]
  assert.equal(ev.kind, 'email_in')
  assert.equal(ev.source_system, 'gmail')
  assert.equal(ev.source_id, 'msg_1')
  assert.equal(repo.getEventBody(ev.id), 'Kerek egy ajanlatot.')
})

test('a sopres ketszer futtatva nem duplikal', async () => {
  const { sweep, repo } = sweepOf([LEVEL()])
  const acc = repo.createAccount({ name: 'X' })
  const con = repo.createContact({ accountId: acc.id, name: 'D' })
  repo.attachEmail(con.id, 'dorina@morvai.hu')

  await sweep.runSweep({})
  const masodik = await sweep.runSweep({})
  assert.equal(masodik.recorded, 0, 'a masodik futas semmit nem ir')
  assert.equal(repo.listEvents({ accountId: acc.id }).length, 1)
})

test('ismeretlen felado a besorolatlan sorba megy, nem talalgatunk', async () => {
  const { sweep, repo } = sweepOf([LEVEL({ fromEmail: 'senki@sehol.hu' })])
  const r = await sweep.runSweep({})
  assert.equal(r.recorded, 0)
  assert.equal(r.unmatched, 1)
  assert.equal(repo.listUnmatched()[0].sender_address, 'senki@sehol.hu')
})

test('domain-egyezes tippel megy a besorolatlanba, nem az idovonalra', async () => {
  const { sweep, repo } = sweepOf([LEVEL({ fromEmail: 'konyveles@morvai.hu' })])
  const acc = repo.createAccount({ name: 'Morvai Kft.', domains: ['morvai.hu'] })

  const r = await sweep.runSweep({})
  assert.equal(r.recorded, 0, 'a tipp NEM sorol be')
  assert.equal(repo.listUnmatched()[0].guess_account_id, acc.id)
  assert.equal(repo.listEvents({ accountId: acc.id }).length, 0)
})

test('a szerzodes hianya nevesitett hiba, nem csendes nulla', async () => {
  const { sweep } = sweepOf([])
  sweep.__state.contracts = { get: () => null }
  await assert.rejects(() => sweep.runSweep({}), /crm_nincs_postafiok/)
})
