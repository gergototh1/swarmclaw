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
