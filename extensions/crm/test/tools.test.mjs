import assert from 'node:assert/strict'
import test from 'node:test'

import { MIGRATIONS, createRepo } from '../src/db.mjs'
import { createTools } from '../src/tools.mjs'
import { memStorage } from './helpers.mjs'

function toolsOf() {
  const S = memStorage()
  for (const m of MIGRATIONS) S.raw.exec(m.sql)
  const state = { storage: S, repo: createRepo(S), log: console }
  const list = createTools(state)
  return { byName: Object.fromEntries(list.map((t) => [t.name, t])), repo: state.repo, list }
}

test('a CRM-1 négy olvasó eszközt ad, és egy írót sem', () => {
  const { list } = toolsOf()
  assert.deepEqual(list.map((t) => t.name).sort(),
    ['crm_account', 'crm_event_body', 'crm_search', 'crm_timeline'])
})

test('egyik eszköz sem tud ügyfelet létrehozni vagy szakaszt állítani', () => {
  const { byName } = toolsOf()
  for (const tiltott of ['crm_create_account', 'crm_close_deal', 'crm_assign_unmatched']) {
    assert.equal(byName[tiltott], undefined, `${tiltott} nem lehet az ügynök kezében`)
  }
})

test('a keresés névre és címre is talál', async () => {
  const { byName, repo } = toolsOf()
  const acc = repo.createAccount({ name: 'Morvai Kft.' })
  const con = repo.createContact({ accountId: acc.id, name: 'Dorina' })
  repo.attachEmail(con.id, 'dorina@morvai.hu')

  const byNev = await byName.crm_search.execute({ query: 'morvai' }, { session: { agentId: 'ag1' } })
  assert.equal(byNev.accounts[0].id, acc.id)

  const byCim = await byName.crm_search.execute({ query: 'dorina@morvai.hu' }, { session: { agentId: 'ag1' } })
  assert.equal(byCim.contacts[0].id, con.id)
})

test('az idővonal nem hozza a teljes szöveget; azt külön kell kérni', async () => {
  const { byName, repo } = toolsOf()
  const acc = repo.createAccount({ name: 'X' })
  const { event } = repo.recordEvent({ accountId: acc.id, kind: 'note',
    occurredAt: '2026-09-01T10:00:00.000Z', excerpt: 'rövid',
    sourceSystem: 'manual', sourceId: 'n1', body: 'a teljes szöveg' })

  const tl = await byName.crm_timeline.execute({ accountId: acc.id }, { session: {} })
  assert.equal('content' in tl.events[0], false)

  const body = await byName.crm_event_body.execute({ eventId: event.id }, { session: {} })
  assert.equal(body.content, 'a teljes szöveg')
})
