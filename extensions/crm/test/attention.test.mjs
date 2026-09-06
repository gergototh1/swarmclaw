import assert from 'node:assert/strict'
import test from 'node:test'

import { rangsor } from '../src/attention.mjs'

const MOST = '2026-09-06T12:00:00.000Z'

test('ures bemenetre ures lista', () => {
  assert.deepEqual(rangsor({ silent: [], unanswered: [], oursOverdue: [], theirsOverdue: [] }, MOST), [])
})

test('a sajat igeret elozi a tobbit azonos kornal', () => {
  const nap = (n) => new Date(Date.parse(MOST) - n * 86400000).toISOString()
  const lista = rangsor({
    silent: [{ deal_id: 'd1', account_id: 'a1', title: 'Ugy', last_event_at: nap(10) }],
    unanswered: [{ account_id: 'a1', thread_id: 't1', event_id: 'e1', subject: 'Level', occurred_at: nap(10) }],
    oursOverdue: [{ id: 'c1', account_id: 'a1', event_id: 'e2', text: 'Kuldom', direction: 'ours', created_at: nap(10) }],
    theirsOverdue: [{ id: 'c2', account_id: 'a1', event_id: 'e3', text: 'Kuldi', direction: 'theirs', created_at: nap(10) }],
  }, MOST)
  assert.equal(lista[0].kind, 'sajat_igeret', 'amit EN igertem, az az en tartozasom')
})

test('azonos tipuson belul a regebbi elorebb', () => {
  const nap = (n) => new Date(Date.parse(MOST) - n * 86400000).toISOString()
  const lista = rangsor({
    silent: [
      { deal_id: 'uj', account_id: 'a1', title: 'Ujabb', last_event_at: nap(10) },
      { deal_id: 'regi', account_id: 'a1', title: 'Regebbi', last_event_at: nap(40) },
    ],
    unanswered: [], oursOverdue: [], theirsOverdue: [],
  }, MOST)
  assert.deepEqual(lista.map((x) => x.dealId), ['regi', 'uj'])
})

test('az esemeny nelkuli ugy kora nem NaN, es a lista elejere kerul', () => {
  const lista = rangsor({
    silent: [
      { deal_id: 'sosem', account_id: 'a1', title: 'Sosem', last_event_at: null },
      { deal_id: 'volt', account_id: 'a1', title: 'Volt',
        last_event_at: new Date(Date.parse(MOST) - 5 * 86400000).toISOString() },
    ],
    unanswered: [], oursOverdue: [], theirsOverdue: [],
  }, MOST)
  assert.equal(Number.isFinite(lista[0].kor), true)
  assert.equal(lista[0].dealId, 'sosem')
})

test('minden sor megmondja, MIERT van rajta', () => {
  const nap = (n) => new Date(Date.parse(MOST) - n * 86400000).toISOString()
  const lista = rangsor({
    silent: [], unanswered: [{ account_id: 'a1', thread_id: 't1', event_id: 'e1', subject: 'Ajanlat?', occurred_at: nap(4) }],
    oursOverdue: [], theirsOverdue: [],
  }, MOST)
  assert.match(lista[0].indok, /4 napja/)
  assert.match(lista[0].cim, /Ajanlat\?/)
})
