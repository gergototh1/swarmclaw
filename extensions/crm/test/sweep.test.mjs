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

test('a SENT cimkeju level email_out-kent kerul be, nem email_in-kent es nem a besorolatlanba', async () => {
  const { sweep, repo } = sweepOf([LEVEL({ id: 'msg_sent', labelIds: ['SENT'] })])
  const acc = repo.createAccount({ name: 'Morvai Kft.' })
  const con = repo.createContact({ accountId: acc.id, name: 'Dorina' })
  repo.attachEmail(con.id, 'dorina@morvai.hu')

  const r = await sweep.runSweep({})
  assert.equal(r.recorded, 0, 'a sajat kimeno level nem email_in-kent kerul az idovonalra')
  assert.equal(r.recordedOut, 1, 'a sajat kimeno level email_out-kent szamolodik')
  assert.equal(r.unmatched, 0, 'a sajat kimeno level a besorolatlanba sem kerul')
  const events = repo.listEvents({ accountId: acc.id })
  assert.equal(events.length, 1)
  assert.equal(events[0].kind, 'email_out')
  assert.equal(repo.listUnmatched().length, 0)
})

test('a kimeno level, aminek se pontos cime, se szala, a besorolatlanba sem kerul', async () => {
  // Ha bekerulne, a `sender_address` a MI cimunk volna, es az rpc
  // `assignUnmatched` ezt tanulna meg egy ugyfel cimekent -- csendben
  // elrontva a jovobeli cimillesztest. Lasd src/sweep.mjs.
  const { sweep, repo } = sweepOf([
    LEVEL({ id: 'm_out_arva', labelIds: ['SENT'], threadId: 'thr_arva', fromEmail: 'en@sajat.hu' }),
  ])
  const r = await sweep.runSweep({})
  assert.equal(r.recorded, 0)
  assert.equal(r.recordedOut, 0)
  assert.equal(r.unmatched, 0)
  assert.equal(repo.listUnmatched().length, 0)
  assert.equal(r.skippedOut, 1, 'a kimarado kimeno level szamolodik, nem tunik el nyomtalanul')
})

test('a listazas alapbol az INBOX es SENT cimkere es 90 napra hatarolt', async () => {
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
  assert.deepEqual(kapott[0].labelIds, ['INBOX', 'SENT'])
  assert.equal(kapott[0].q, 'newer_than:90d')
})

test('a sopresCimkek vesszos listaja szetbontva megy a listazasba', async () => {
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
    settings: () => ({ sopresCimkek: ' Ugyfelek , SENT ,, ' }),
  })
  await sweep.runSweep({})
  assert.deepEqual(kapott[0].labelIds, ['Ugyfelek', 'SENT'])
})

test('a sopresCimkek elsobbseget elvez a regi sopresCimke felett, ha mindketto be van allitva', async () => {
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
    settings: () => ({ sopresCimkek: 'Uj', sopresCimke: 'Regi' }),
  })
  await sweep.runSweep({})
  assert.deepEqual(kapott[0].labelIds, ['Uj'])
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

// ---- Task 1: kimeno levelek behuzasa ----

test('a sajat elkuldott level email_out-kent kerul be, nem email_in-kent', async () => {
  const { sweep, repo } = sweepOf([
    LEVEL({ id: 'm_in', labelIds: ['INBOX'], fromEmail: 'dorina@morvai.hu' }),
    LEVEL({ id: 'm_out', labelIds: ['SENT'], threadId: 'thr_1', fromEmail: 'en@sajat.hu' }),
  ])
  const acc = repo.createAccount({ name: 'Morvai Kft.' })
  const con = repo.createContact({ accountId: acc.id, name: 'Dorina' })
  repo.attachEmail(con.id, 'dorina@morvai.hu')

  await sweep.runSweep({})
  const kinds = repo.listEvents({ accountId: acc.id }).map((e) => e.kind).sort()
  assert.deepEqual(kinds, ['email_in', 'email_out'])
})

test('a kimeno level akkor is a szalhoz kerul, ha a felado ismeretlen', async () => {
  const { sweep, repo } = sweepOf([
    LEVEL({ id: 'm_out', labelIds: ['SENT'], threadId: 'thr_x', fromEmail: 'en@sajat.hu' }),
  ])
  const acc = repo.createAccount({ name: 'X' })
  repo.recordEvent({ accountId: acc.id, kind: 'email_in', occurredAt: '2026-09-01T09:00:00.000Z',
                     excerpt: 'e', sourceSystem: 'gmail', sourceId: 'korabbi', threadId: 'thr_x' })
  const r = await sweep.runSweep({})
  assert.equal(r.recordedOut, 1)
  assert.equal(repo.listEvents({ accountId: acc.id })[0].kind, 'email_out')
})

/**
 * A TAROLT, ORDOGOLT `sopresCimke` NEMAN KIKAPCSOLJA A ZASZLOSHAJO-JELZEST.
 *
 * A CRM-2 alapertelmezese pontosan `'INBOX'` volt, tehat barmelyik telepitesen,
 * ahol az operator ezt a mezot valaha elmentette, a tartalek-ag egy SENT nelkuli
 * cimkelistat ad. Ekkor egyetlen `email_out` esemeny sem keletkezik, es az
 * `unansweredThreads` -- ami PONTOSAN a kimeno esemeny hianyat keresi -- minden
 * bejovo levelet valasz nelkulinek mond. A sopres nem hasal el, a szamlalok
 * rendben nezenek ki, es semmi nem koti ossze a ket dolgot: ezert kell a
 * nevesitett naplobejegyzes.
 */
function naplozoSweep(uzenetek, settings) {
  const naplo = []
  const S = memStorage()
  for (const m of MIGRATIONS) S.raw.exec(m.sql)
  const state = {
    repo: createRepo(S),
    log: { warn: (msg, meta) => naplo.push({ msg, meta }), info: () => {}, error: () => {} },
    settings,
    contracts: { get: () => fakeMailbox(uzenetek) },
  }
  return { sweep: createSweep(state), naplo }
}

test('a tarolt, SENT nelkuli sopresCimke nevesitett figyelmeztetest ir a logba', async () => {
  const { sweep, naplo } = naplozoSweep([], () => ({ sopresCimke: 'INBOX' }))
  await sweep.runSweep({})
  const figyelmeztetes = naplo.find((n) => n.msg.includes('nincs SENT'))
  assert.ok(figyelmeztetes, 'a SENT hianya nem jelent meg a logban')
  assert.deepEqual(figyelmeztetes.meta.labelIds, ['INBOX'], 'a figyelmeztetes megnevezi a felbontott listat')
  assert.match(figyelmeztetes.msg, /valasz nelkuli/i,
    'a figyelmeztetesnek meg kell mondania, MI romlik el tole -- nem csak azt, hogy hianyzik egy cimke')
})

test('a SENT-et is tartalmazo beallitas NEM ir figyelmeztetest', async () => {
  const { sweep, naplo } = naplozoSweep([], () => ({ sopresCimkek: 'INBOX, SENT' }))
  await sweep.runSweep({})
  assert.equal(naplo.some((n) => n.msg.includes('nincs SENT')), false)
})

test('beallitas nelkul (alapertelmezett cimkek) sincs figyelmeztetes -- a DEFAULT_LABELS viszi a SENT-et', async () => {
  const { sweep, naplo } = naplozoSweep([], () => ({}))
  await sweep.runSweep({})
  assert.equal(naplo.some((n) => n.msg.includes('nincs SENT')), false)
})

test('a hivo altal atadott, SENT nelkuli labelIds is figyelmeztetest kap', async () => {
  const { sweep, naplo } = naplozoSweep([], () => ({}))
  await sweep.runSweep({ labelIds: ['INBOX'] })
  assert.ok(naplo.some((n) => n.msg.includes('nincs SENT')))
})
