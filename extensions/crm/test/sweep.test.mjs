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

function sweepOf(uzenetek, { settings = () => ({}), mailbox } = {}) {
  const S = memStorage()
  for (const m of MIGRATIONS) S.raw.exec(m.sql)
  const repo = createRepo(S)
  const state = {
    repo, log: console, settings,
    contracts: { get: () => mailbox || fakeMailbox(uzenetek) },
  }
  return { sweep: createSweep(state), repo, state }
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

// ---- C1: a sentAt nullazhato, es egy hibazo level nem allithatja meg a lapot ----

test('a sentAt nelkuli level kimarad es szamolodik, nem dobja el a sopres futasat', async () => {
  const { sweep, repo } = sweepOf([
    LEVEL({ id: 'msg_ok' }),
    LEVEL({ id: 'msg_null_sentat', sentAt: null, fromEmail: 'masik@morvai.hu' }),
  ])
  const acc = repo.createAccount({ name: 'Morvai Kft.' })
  const con = repo.createContact({ accountId: acc.id, name: 'Dorina' })
  repo.attachEmail(con.id, 'dorina@morvai.hu')

  const r = await sweep.runSweep({})
  assert.equal(r.scanned, 2)
  assert.equal(r.recorded, 1, 'a rendes level bekerul')
  assert.equal(r.failed, 1, 'a nullazott sentAt-u level szamolt, nem dobott hibat')
  assert.equal(repo.listEvents({ accountId: acc.id }).length, 1)
  assert.equal(
    repo.listEvents({ accountId: acc.id }).some((e) => e.source_id === 'msg_null_sentat'),
    false,
    'a nullazott sentAt-u level nem talalgatott datummal kerult be',
  )
})

test('egy hibazo uzenet nem allitja meg a lap tobbi levelenek behuzasat, es a kurzor akkor is frissul', async () => {
  const uzenetek = [
    LEVEL({ id: 'ok1' }),
    LEVEL({ id: 'bad' }),
    LEVEL({ id: 'ok2', fromEmail: 'masik@morvai.hu' }),
  ]
  const mailbox = {
    list: async () => ({ ids: uzenetek.map((u) => u.id), nextCursor: '', complete: true, stoppedOn: '' }),
    get: async ({ id }) => {
      if (id === 'bad') throw new Error('gmail_fetch_failed')
      return uzenetek.find((u) => u.id === id)
    },
  }
  const { sweep, repo } = sweepOf(uzenetek, { mailbox })
  const acc = repo.createAccount({ name: 'Morvai Kft.' })
  const con1 = repo.createContact({ accountId: acc.id, name: 'Dorina' })
  repo.attachEmail(con1.id, 'dorina@morvai.hu')
  const con2 = repo.createContact({ accountId: acc.id, name: 'Masik' })
  repo.attachEmail(con2.id, 'masik@morvai.hu')

  const r = await sweep.runSweep({})
  assert.equal(r.scanned, 3)
  assert.equal(r.failed, 1, 'a hibazo level szamolt')
  assert.equal(r.recorded, 2, 'a ket ep level bekerult a hibazo ellenere')
  assert.deepEqual(
    repo.listEvents({ accountId: acc.id }).map((e) => e.source_id).sort(),
    ['ok1', 'ok2'],
  )
  assert.equal(repo.getSweepState('gmail').cursor, '', 'a kurzor akkor is frissult, ha volt hiba')
})

// ---- C2: a listazas hatarolt, es a sajat kimeno level nem kerul be email_in-kent ----

test('a SENT cimkeju level nem kerul be email_in-kent, es a besorolatlanba sem', async () => {
  const { sweep, repo } = sweepOf([LEVEL({ id: 'msg_sent', labelIds: ['SENT'] })])
  const acc = repo.createAccount({ name: 'Morvai Kft.' })
  const con = repo.createContact({ accountId: acc.id, name: 'Dorina' })
  repo.attachEmail(con.id, 'dorina@morvai.hu')

  const r = await sweep.runSweep({})
  assert.equal(r.recorded, 0, 'a sajat kimeno level nem kerul az idovonalra')
  assert.equal(r.unmatched, 0, 'a sajat kimeno level a besorolatlanba sem kerul')
  assert.equal(repo.listEvents({ accountId: acc.id }).length, 0)
  assert.equal(repo.listUnmatched().length, 0)
})

test('a listazas alapbol az INBOX cimkere es 90 napra hatarolt', async () => {
  const kapott = []
  const uzenetek = [LEVEL()]
  const mailbox = {
    list: async (args) => {
      kapott.push(args)
      return { ids: uzenetek.map((u) => u.id), nextCursor: '', complete: true, stoppedOn: '' }
    },
    get: async ({ id }) => uzenetek.find((u) => u.id === id),
  }
  const { sweep } = sweepOf(uzenetek, { mailbox })
  await sweep.runSweep({})
  assert.deepEqual(kapott[0].labelIds, ['INBOX'])
  assert.equal(kapott[0].q, 'newer_than:90d')
})

test('a beallitott cimke es lekerdezes felulirja az alapertelmezettet', async () => {
  const kapott = []
  const uzenetek = [LEVEL()]
  const mailbox = {
    list: async (args) => {
      kapott.push(args)
      return { ids: uzenetek.map((u) => u.id), nextCursor: '', complete: true, stoppedOn: '' }
    },
    get: async ({ id }) => uzenetek.find((u) => u.id === id),
  }
  const { sweep } = sweepOf(uzenetek, {
    mailbox,
    settings: () => ({ sopresCimke: 'Ugyfelek', sopresLekerdezes: 'newer_than:30d' }),
  })
  await sweep.runSweep({})
  assert.deepEqual(kapott[0].labelIds, ['Ugyfelek'])
  assert.equal(kapott[0].q, 'newer_than:30d')
})
