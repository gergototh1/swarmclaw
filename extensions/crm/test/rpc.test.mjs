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

test('a besorolatlan hozzárendelése tanult címet ír', async () => {
  const { rpc, repo } = rpcOf()
  const acc = repo.createAccount({ name: 'Morvai Kft.' })
  const con = repo.createContact({ accountId: acc.id, name: 'Dorina' })
  const { row } = repo.recordUnmatched({ sourceSystem: 'gmail', sourceId: 't1',
    senderAddress: 'dorina@morvai.hu', receivedAt: '2026-09-01T10:00:00.000Z' })

  await rpc.assignUnmatched({ unmatchedId: row.id, contactId: con.id })

  assert.equal(repo.contactByEmail('dorina@morvai.hu').id, con.id)
  assert.equal(repo.listUnmatched().length, 0)
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
