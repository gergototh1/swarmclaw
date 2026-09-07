import assert from 'node:assert/strict'
import test from 'node:test'

import { createAttention } from '../src/attention-service.mjs'
import { rangsor } from '../src/attention.mjs'

const MOST = '2026-09-06T12:00:00.000Z'

test('ures bemenetre ures lista', () => {
  assert.deepEqual(rangsor({ silent: [], unanswered: [], oursOverdue: [], theirsOverdue: [] }, MOST), [])
})

test('azonos kornal a teljes tipussorrend: sajat igeret, valasz nelkul, nema ugy, idegen igeret', () => {
  const nap = (n) => new Date(Date.parse(MOST) - n * 86400000).toISOString()
  const lista = rangsor({
    silent: [{ deal_id: 'd1', account_id: 'a1', title: 'Ugy', last_event_at: nap(10) }],
    unanswered: [{ account_id: 'a1', thread_id: 't1', event_id: 'e1', subject: 'Level', occurred_at: nap(10) }],
    oursOverdue: [{ id: 'c1', account_id: 'a1', event_id: 'e2', text: 'Kuldom', direction: 'ours', created_at: nap(10) }],
    theirsOverdue: [{ id: 'c2', account_id: 'a1', event_id: 'e3', text: 'Kuldi', direction: 'theirs', created_at: nap(10) }],
  }, MOST)
  assert.deepEqual(
    lista.map((x) => x.kind),
    ['sajat_igeret', 'valasz_nelkul', 'nema_ugy', 'idegen_igeret'],
    'a teljes tipussorrendnek kell allnia, nem csak az elso elemnek',
  )
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

/**
 * A DONTETLEN-TORES. A rangsor harmadik kulcsa (`localeCompare` az
 * azonositokon) azert van ott, hogy ket egyforma futas KOZT ne mozogjon a
 * sorrend -- a ket elso kulcs (tipus, kor) egy azonos napon rogzitett sornal
 * dontetlen, es olyankor a lista sorrendjet a nyers SQL sorrend adna, ami
 * nem stabil szerzodes. Az `Array.prototype.sort` stabil, tehat a klauzula
 * torlese a BEMENETI sorrendet hagyna meg: ez a teszt ezert szandekosan
 * FORDITOTT sorrendben adja be a sorokat.
 */
test('azonos tipusnal ES azonos kornal az azonosito tori a dontetlent, a bemeneti sorrendtol fuggetlenul', () => {
  const azonosNap = new Date(Date.parse(MOST) - 12 * 86400000).toISOString()
  const lista = rangsor({
    silent: [
      { deal_id: 'd_zebra', account_id: 'a1', title: 'Zebra', last_event_at: azonosNap },
      { deal_id: 'd_alma', account_id: 'a1', title: 'Alma', last_event_at: azonosNap },
    ],
    unanswered: [], oursOverdue: [], theirsOverdue: [],
  }, MOST)
  assert.deepEqual(lista.map((x) => x.dealId), ['d_alma', 'd_zebra'],
    'a dontetlent az azonositonak kell tornie -- a bemeneti sorrend nem szerzodes')
})

test('a dontetlen-tores a masik iranybol is all: mar rendezett bemenet sem fordul meg', () => {
  const azonosNap = new Date(Date.parse(MOST) - 12 * 86400000).toISOString()
  const lista = rangsor({
    silent: [], unanswered: [], theirsOverdue: [],
    oursOverdue: [
      { id: 'c_alma', account_id: 'a1', event_id: 'e1', text: 'Alma', direction: 'ours', created_at: azonosNap },
      { id: 'c_zebra', account_id: 'a1', event_id: 'e2', text: 'Zebra', direction: 'ours', created_at: azonosNap },
    ],
  }, MOST)
  assert.deepEqual(lista.map((x) => x.commitmentId), ['c_alma', 'c_zebra'])
})

/**
 * A LIMIT ES AZ `osszes`. A szolgaltatas doksija az `osszes`-t a "limitalas
 * ELOTTI szam"-kent irja le, es ez a mezo teherbiro: enelkul az operator (es
 * az ugynok) ot sort latva nem tudna megkulonboztetni, hogy az az EGESZ lista,
 * vagy csak a teteje egy szaznak -- a lap limit-jelzese (`ui/ma.tsx`) pontosan
 * ezt a ket szamot hasonlitja ossze.
 *
 * A repo itt szandekosan csonk, nem valodi `createRepo`: a negy lekerdezes
 * eredmenye a teszt bemenete, es igy a `slice` es az `osszes` mereseben semmi
 * mas nem vesz reszt.
 */
function attentionStub(sorok) {
  return createAttention({
    settings: () => ({}),
    repo: {
      silentDeals: () => sorok,
      unansweredThreads: () => [],
      openCommitmentsOlderThan: () => [],
    },
  })
}

const nemaSorok = (n) => Array.from({ length: n }, (_, i) => ({
  deal_id: `d${String(i).padStart(2, '0')}`,
  account_id: 'a1',
  title: `Ugy ${i}`,
  last_event_at: new Date(Date.parse(MOST) - (30 - i) * 86400000).toISOString(),
}))

test('a limit TENYLEGESEN vag: tobb sorbol csak a lista teteje jon vissza', () => {
  const eredmeny = attentionStub(nemaSorok(7)).list({ limit: 3, most: MOST })
  assert.equal(eredmeny.sorok.length, 3, 'a limit nelkul az egesz lista jonne vissza')
})

test('az `osszes` a LIMITALAS ELOTTI szam, nem a visszaadott sorok szama', () => {
  const eredmeny = attentionStub(nemaSorok(7)).list({ limit: 3, most: MOST })
  assert.equal(eredmeny.osszes, 7,
    'az `osszes` a teljes talalatszam -- ha a limitalas UTAN szamolodna, 3 lenne, '
    + 'es semmi nem mondana meg, hogy a lista folytatodik')
  assert.notEqual(eredmeny.osszes, eredmeny.sorok.length,
    'ebben az esetben a ket szamnak kulonboznie KELL, kulonben a teszt semmit nem allit')
})

test('limit alatti talalatszamnal az `osszes` es a visszaadott hossz egybeesik', () => {
  const eredmeny = attentionStub(nemaSorok(2)).list({ limit: 10, most: MOST })
  assert.equal(eredmeny.sorok.length, 2)
  assert.equal(eredmeny.osszes, 2)
})

test('a limitalt lista a rangsor TETEJE, nem egy tetszoleges reszhalmaz', () => {
  const teljes = attentionStub(nemaSorok(7)).list({ limit: 50, most: MOST })
  const vagott = attentionStub(nemaSorok(7)).list({ limit: 3, most: MOST })
  assert.deepEqual(vagott.sorok.map((x) => x.dealId), teljes.sorok.slice(0, 3).map((x) => x.dealId))
})
