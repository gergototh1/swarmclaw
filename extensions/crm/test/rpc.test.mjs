import assert from 'node:assert/strict'
import test from 'node:test'

import { MIGRATIONS, createRepo } from '../src/db.mjs'
import { createRpc } from '../src/rpc.mjs'
import { memStorage } from './helpers.mjs'

function rpcOf() {
  const S = memStorage()
  for (const m of MIGRATIONS) S.raw.exec(m.sql)
  const state = { storage: S, repo: createRepo(S), settings: () => ({}), log: console }
  return { rpc: createRpc(state), repo: state.repo }
}

/** Ugyanaz, mint `rpcOf`, de a state-en van egy `contracts` dublőr, amit a hívó ad meg. */
function rpcWithContracts(contracts) {
  const S = memStorage()
  for (const m of MIGRATIONS) S.raw.exec(m.sql)
  const state = { storage: S, repo: createRepo(S), settings: () => ({}), log: console, contracts }
  return { rpc: createRpc(state), repo: state.repo }
}

test('a board egy hívásból adja a lap alapállapotát', async () => {
  const { rpc, repo } = rpcOf()
  repo.createAccount({ name: 'Morvai Kft.', status: 'client' })
  const board = await rpc.board({})
  assert.equal(board.accounts.length, 1)
  assert.deepEqual(board.unmatched, [])
  assert.deepEqual(board.suggestions, [])
})

test('az account-lap az összefoglaló frissességét is viszi', async () => {
  const { rpc, repo } = rpcOf()
  const acc = repo.createAccount({ name: 'X' })
  repo.recordEvent({ accountId: acc.id, kind: 'note', occurredAt: '2026-09-01T10:00:00.000Z',
                     excerpt: 'e1', sourceSystem: 'manual', sourceId: 'n1' })
  repo.writeSummary({ accountId: acc.id, text: 'régi', agentId: 'ag1' })
  repo.recordEvent({ accountId: acc.id, kind: 'note', occurredAt: '2026-09-05T10:00:00.000Z',
                     excerpt: 'e2', sourceSystem: 'manual', sourceId: 'n2' })

  const page = await rpc.account({ accountId: acc.id })
  assert.equal(page.summary.stale, true)
  assert.equal(page.summary.newerEvents, 1)
  assert.equal(page.events.length, 2)
})

test('a jegyzet eseményt ír, kézi forrással', async () => {
  const { rpc, repo } = rpcOf()
  const acc = repo.createAccount({ name: 'X' })
  const res = await rpc.addNote({ accountId: acc.id, text: 'Telefonon egyeztettünk.' })
  assert.equal(res.event.kind, 'note')
  assert.equal(res.event.source_system, 'manual')
  assert.equal(repo.getEventBody(res.event.id), 'Telefonon egyeztettünk.')
})

test('a besorolatlan hozzárendelése tanult címet ír, es magat az uzenetet is felviszi az idovonalra', async () => {
  const { rpc, repo } = rpcOf()
  const acc = repo.createAccount({ name: 'Morvai Kft.' })
  const con = repo.createContact({ accountId: acc.id, name: 'Dorina' })
  const { row } = repo.recordUnmatched({ sourceSystem: 'gmail', sourceId: 't1',
    senderAddress: 'dorina@morvai.hu', subject: 'Ajanlat kerese', excerpt: 'Kerek egy ajanlatot.',
    receivedAt: '2026-09-01T10:00:00.000Z', threadId: 'thr_1' })

  await rpc.assignUnmatched({ unmatchedId: row.id, contactId: con.id })

  assert.equal(repo.contactByEmail('dorina@morvai.hu').id, con.id, 'a cim tanult')
  assert.equal(repo.listUnmatched().length, 0, 'a sor kiurult')

  const events = repo.listEvents({ accountId: acc.id })
  assert.equal(events.length, 1, 'a besorolt uzenet felkerult az idovonalra')
  assert.equal(events[0].kind, 'email_in')
  assert.equal(events[0].title, 'Ajanlat kerese')
  assert.equal(events[0].source_system, 'gmail')
  assert.equal(events[0].source_id, 't1')
  assert.equal(events[0].thread_id, 'thr_1')
  assert.equal(events[0].contact_id, con.id)

  // Ujra behuzva ugyanaz a forras (source_system, source_id) -- a
  // recordEvent idempotens, tehat egy kesobbi ujra-sopres nem duplikal.
  const ismet = repo.recordEvent({ accountId: acc.id, contactId: con.id, kind: 'email_in',
    occurredAt: '2026-09-01T10:00:00.000Z', title: 'Ajanlat kerese', sourceSystem: 'gmail', sourceId: 't1' })
  assert.equal(ismet.created, false)
  assert.equal(repo.listEvents({ accountId: acc.id }).length, 1)
})

test('a besorolatlan hozzarendelese ugyfel nelkuli kapcsolathoz tanul, de esemenyt nem visz fel', async () => {
  const { rpc, repo } = rpcOf()
  const con = repo.createContact({ name: 'Ismeretlen kapcsolat' }) // nincs accountId
  const { row } = repo.recordUnmatched({ sourceSystem: 'gmail', sourceId: 't5',
    senderAddress: 'valaki@sehol.hu', subject: 'Erdeklodes', receivedAt: '2026-09-01T10:00:00.000Z' })

  const res = await rpc.assignUnmatched({ unmatchedId: row.id, contactId: con.id })

  assert.equal(repo.contactByEmail('valaki@sehol.hu').id, con.id, 'a cim akkor is tanult')
  assert.equal(repo.listUnmatched().length, 0, 'a sor akkor is kiurul')
  // Nincs ugyfel, amire az esemenyt irni lehetne (`account_id NOT NULL`) --
  // ez a dontes, nem baleset: a matching.mjs sem ad 'exact' talalatot ugyfel
  // nelkuli kapcsolatra, es assignUnmatched ugyanezt a szabalyt koveti, es ezt
  // a valaszban is jelzi, nem csendben hagyja el.
  assert.equal(res.eventFiled, false)
  assert.equal(res.event, null)
})

test('a contactsForPicker minden kapcsolatot ad, az ügyfél nevével', async () => {
  const { rpc, repo } = rpcOf()
  const acc = repo.createAccount({ name: 'Morvai Kft.' })
  const c1 = repo.createContact({ accountId: acc.id, name: 'Dorina' })
  const c2 = repo.createContact({ name: 'Ügyfél nélküli' })
  const lista = await rpc.contactsForPicker({})
  const byId = Object.fromEntries(lista.map((c) => [c.id, c]))
  assert.equal(byId[c1.id].accountName, 'Morvai Kft.')
  assert.equal(byId[c2.id].accountName, '')
})

test('az ismeretlen ügyfél nevesített hibát ad, nem üres választ', async () => {
  const { rpc } = rpcOf()
  await assert.rejects(() => rpc.account({ accountId: 'acc_nincs' }), /crm_ismeretlen_ugyfel/)
})

test('az ismeretlen ügy frissítése nevesített hibát ad, nem néma null-t', async () => {
  const { rpc } = rpcOf()
  await assert.rejects(
    () => rpc.updateDeal({ dealId: 'deal_nincs', title: 'Új cím' }),
    /crm_ismeretlen_ugy/,
  )
})

test('az ismeretlen ügy lezárása nevesített hibát ad, nem néma null-t', async () => {
  const { rpc } = rpcOf()
  await assert.rejects(
    () => rpc.closeDeal({ dealId: 'deal_nincs', stage: 'won', reason: 'x' }),
    /crm_ismeretlen_ugy/,
  )
})

test('az ismeretlen kapcsolathoz rendelés nevesített hibát ad, és a sor nyitva marad', async () => {
  const { rpc, repo } = rpcOf()
  repo.createAccount({ name: 'Morvai Kft.' })
  const { row } = repo.recordUnmatched({ sourceSystem: 'gmail', sourceId: 't2',
    senderAddress: 'ismeretlen@morvai.hu', receivedAt: '2026-09-01T10:00:00.000Z' })

  await assert.rejects(
    () => rpc.assignUnmatched({ unmatchedId: row.id, contactId: 'con_nincs' }),
    /crm_ismeretlen_kapcsolat/,
  )
  assert.ok(repo.listUnmatched().some((u) => u.id === row.id))
})

test('az ismeretlen kapcsolathoz email csatolása nevesített hibát ad', async () => {
  const { rpc } = rpcOf()
  await assert.rejects(
    () => rpc.attachEmail({ contactId: 'con_nincs', address: 'x@y.hu' }),
    /crm_ismeretlen_kapcsolat/,
  )
})

test('az üres feladó-cím nélküli besorolatlan sor is feloldható, kivétel nélkül', async () => {
  const { rpc, repo } = rpcOf()
  const acc = repo.createAccount({ name: 'Morvai Kft.' })
  const con = repo.createContact({ accountId: acc.id, name: 'Dorina' })
  const { row } = repo.recordUnmatched({ sourceSystem: 'gmail', sourceId: 't3',
    receivedAt: '2026-09-01T10:00:00.000Z' })
  assert.equal(row.sender_address, '')

  await rpc.assignUnmatched({ unmatchedId: row.id, contactId: con.id })

  assert.ok(!repo.listUnmatched().some((u) => u.id === row.id))
})

test('az ismeretlen esemény törzsének kérése nevesített hibát ad, nem üres tartalmat', async () => {
  // Ugyanaz a szerződés, mint az ügynök felületén (src/tools.mjs
  // crm_event_body): egy ismeretlen eventId ugyanazt a hibát dobja, nem
  // { content: '' }-t.
  const { rpc } = rpcOf()
  await assert.rejects(() => rpc.eventBody({ eventId: 'ev_nincs' }), /crm_ismeretlen_esemeny/)
})

test('az esemény törzse visszaadódik ismert eseményre', async () => {
  const { rpc, repo } = rpcOf()
  const acc = repo.createAccount({ name: 'X' })
  const res = await rpc.addNote({ accountId: acc.id, text: 'A törzs szövege.' })
  const body = await rpc.eventBody({ eventId: res.event.id })
  assert.equal(body.content, 'A törzs szövege.')
})

test('az ügy lezárása csak won/lost szakaszt fogad el, mást nevesített hibával utasít el', async () => {
  const { rpc, repo } = rpcOf()
  const acc = repo.createAccount({ name: 'X' })
  const deal = repo.createDeal({ accountId: acc.id, kind: 'lead', title: 'Ajánlat' })

  await assert.rejects(
    () => rpc.closeDeal({ dealId: deal.id, stage: 'talking', reason: 'x' }),
    /crm_ismeretlen_ugy_szakasz/,
  )

  const closed = await rpc.closeDeal({ dealId: deal.id, stage: 'won', reason: 'aláírva' })
  assert.equal(closed.stage, 'won')
})

test('a mailboxHealth nevesített okot ad, ha a state-en egyáltalán nincs contracts', async () => {
  const { rpc } = rpcOf()            // a rpcOf nem ad contracts-ot
  const h = await rpc.mailboxHealth({})
  assert.equal(h.available, false)
  assert.equal(h.reason, 'crm_nincs_contracts')
})

test('a mailboxHealth a hoszt saját okkódját adja tovább, ha a get() null-t ad', async () => {
  const { rpc } = rpcWithContracts({
    get: () => null,
    why: () => 'provider_disabled',
  })
  const h = await rpc.mailboxHealth({})
  assert.equal(h.available, false)
  assert.equal(h.reason, 'provider_disabled')
})

test('a mailboxHealth a postafiók címét adja vissza, ha a szerződés feloldódik', async () => {
  const { rpc } = rpcWithContracts({
    get: (extensionId, contract) => {
      assert.equal(extensionId, 'gmail')
      assert.equal(contract, 'mailbox')
      return { mailbox: async () => ({ address: 'dorina@morvai.hu' }) }
    },
    why: () => null,
  })
  const h = await rpc.mailboxHealth({})
  assert.equal(h.available, true)
  assert.equal(h.address, 'dorina@morvai.hu')
})

test('a mailboxHealth nevesitett okot ad -- nem 500-at --, ha a szerzodes feloldodik de a hivas elhasal', async () => {
  const { rpc } = rpcWithContracts({
    get: () => ({ mailbox: async () => { throw new Error('lejart hitelesito') } }),
    why: () => null,
  })
  const h = await rpc.mailboxHealth({})
  assert.equal(h.available, false)
  assert.equal(h.reason, 'crm_postafiok_hiba')
  assert.equal(h.message, 'lejart hitelesito')
})

test('a mailboxHealth a gmail extension nevesitett hibajanak uzenetet is viszi, a stabil kod mellett', async () => {
  // Élő eset: a hoszton nincs Google OAuth kliens konfigurálva -- a `gmail`
  // extension saját `health` rpc-je ezt `google_oauth_client_missing`
  // kóddal jelzi, a `mailbox()` hívás pedig ugyanezzel a szöveggel utasít el.
  const { rpc } = rpcWithContracts({
    get: () => ({ mailbox: async () => { throw new Error('google_oauth_client_missing') } }),
    why: () => null,
  })
  const h = await rpc.mailboxHealth({})
  assert.equal(h.available, false)
  assert.equal(h.reason, 'crm_postafiok_hiba')
  assert.equal(h.message, 'google_oauth_client_missing')
})

/** A `mailbox` szerződés dublőre, ugyanaz az alak, mint a sweep sajét tesztjeiben. */
function fakeMailbox(uzenetek) {
  return {
    list: async () => ({ ids: uzenetek.map((u) => u.id), nextCursor: '', complete: true, stoppedOn: '' }),
    get: async ({ id }) => uzenetek.find((u) => u.id === id),
  }
}

const LEVEL = (over) => ({
  id: 'msg_1', threadId: 'thr_1', labelIds: ['INBOX'], subject: 'Ajanlat',
  fromName: 'Morvai Dorina', fromEmail: 'dorina@morvai.hu',
  sentAt: '2026-09-01T10:00:00.000Z', text: 'Kerek egy ajanlatot.',
  textInAttachment: false, sizeEstimate: 100, ...over,
})

test('a sweepNow ugyanazt a torzset hivja, mint az ugynok crm_sweep eszkoze', async () => {
  const uzenetek = [LEVEL()]
  const { rpc, repo } = rpcWithContracts({ get: () => fakeMailbox(uzenetek) })
  const acc = repo.createAccount({ name: 'Morvai Kft.' })
  const con = repo.createContact({ accountId: acc.id, name: 'Dorina' })
  repo.attachEmail(con.id, 'dorina@morvai.hu')

  const r = await rpc.sweepNow({ max: 50 })
  assert.equal(r.scanned, 1)
  assert.equal(r.recorded, 1)
  assert.equal(r.unmatched, 0)
  assert.equal(repo.listEvents({ accountId: acc.id }).length, 1)
})

test('a sweepNow max nelkul is fut, 50-es alapertelmezettel', async () => {
  const uzenetek = [LEVEL({ id: 'msg_2', fromEmail: 'senki@sehol.hu' })]
  const { rpc } = rpcWithContracts({ get: () => fakeMailbox(uzenetek) })
  const r = await rpc.sweepNow({})
  assert.equal(r.scanned, 1)
  assert.equal(r.unmatched, 1)
})

test('a sweepNow szerzodes hianyaban nevesitett hibat ad', async () => {
  const { rpc } = rpcOf()
  await assert.rejects(() => rpc.sweepNow({}), /crm_nincs_postafiok/)
})
