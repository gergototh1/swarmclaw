import assert from 'node:assert/strict'
import test from 'node:test'

import { bundle } from '../scripts/build.mjs'
import { idovonalOsztaly, lapozottIdovonal, ugyfelFeladatai } from '../ui/ugyfel-lap.tsx'

/**
 * A "Korábbiak" gomb a `timeline` rpc-t hívja a lista végén (a legrégebbi
 * eseménynél) lévő `occurred_at`-tal, és a választ hozzáfűzi a meglévő
 * listához. Három eset dönti el, hogy a gomb ezután mit mutat és marad-e
 * látható:
 *
 * 1. A visszakapott lap valódi, korábbi eseményeket hoz -- ezeket a végéhez
 *    kell fűzni, a sorrend megtartásával.
 * 2. A visszakapott lap üres -- nincs több korábbi esemény, a hívónak ezt
 *    kell jeleznie, hogy a gomb eltűnhessen.
 * 3. Az id szerinti szűrés véd, ha egy id mindkét lapon szerepelne -- a repo
 *    (`src/db.mjs` `listEvents`) mostantól a `beforeId`-vel az összetett
 *    `(occurred_at, id)` határon lapoz, ezért ez sem duplikálás, sem
 *    elhagyás formájában nem fordulhat elő; a teszt csak azt pinneli le,
 *    hogy a védekező szűrés önmagában ártalmatlan és nem dob el semmit
 *    feleslegesen.
 */

const eseny = (id, occurredAt) => ({ id, kind: 'note', occurred_at: occurredAt, title: '', excerpt: id })

test('hozzáfűzi az új lapot a meglévő lista végéhez', () => {
  const meglevo = [eseny('e3', '2026-09-03T10:00:00Z'), eseny('e2', '2026-09-02T10:00:00Z')]
  const ujOldal = [eseny('e1', '2026-09-01T10:00:00Z')]
  const eredmeny = lapozottIdovonal(meglevo, ujOldal)
  assert.deepEqual(eredmeny.map((e) => e.id), ['e3', 'e2', 'e1'])
})

test('üres lap esetén a lista változatlan marad', () => {
  const meglevo = [eseny('e3', '2026-09-03T10:00:00Z')]
  const eredmeny = lapozottIdovonal(meglevo, [])
  assert.deepEqual(eredmeny, meglevo)
})

test('a védekező id-szűrés nem dob el semmit, ha egy id mindkét lapon szerepel', () => {
  const meglevo = [eseny('e3', '2026-09-03T10:00:00Z'), eseny('e2', '2026-09-02T10:00:00Z')]
  const ujOldal = [eseny('e2', '2026-09-02T10:00:00Z'), eseny('e1', '2026-09-01T10:00:00Z')]
  const eredmeny = lapozottIdovonal(meglevo, ujOldal)
  assert.deepEqual(eredmeny.map((e) => e.id), ['e3', 'e2', 'e1'])
})

/**
 * A 7. feladat: a host `/api/tasks` GET-je objektumot ad (id -> feladat), a
 * kapcsolat a `customFields.crm_account` mezőn áll -- ezt az `acceptSuggestion`
 * (`src/rpc.mjs`) írja rá elfogadáskor. A szűrésnek ki kell hagynia a más
 * ügyfélhez tartozó és a CRM-en kívülről (customFields nélkül) érkező
 * feladatokat is, és a legfrissebbet kell előre tennie.
 */
const feladat = (id, accountId, createdAt) => ({
  id, title: `Feladat ${id}`, status: 'queued', dueAt: null, createdAt,
  customFields: accountId ? { crm_account: accountId } : undefined,
})

test('csak az adott ügyfélhez tartozó feladatokat adja, a legfrissebbel elöl', () => {
  const feladatok = {
    t1: feladat('t1', 'acc_1', 100),
    t2: feladat('t2', 'acc_2', 200),
    t3: feladat('t3', 'acc_1', 300),
    t4: feladat('t4', null, 400),
  }
  const eredmeny = ugyfelFeladatai(feladatok, 'acc_1')
  assert.deepEqual(eredmeny.map((f) => f.id), ['t3', 't1'])
})

test('üres feladatlistára üres tömböt ad', () => {
  assert.deepEqual(ugyfelFeladatai({}, 'acc_1'), [])
})

test('az ugyfel lap ket hasabra bomlik', async () => {
  const out = await bundle({ write: false })
  const js = out.outputFiles[0].text
  assert.match(js, /crm-cols/, 'hianyzik a ket hasab kerete')
  assert.match(js, /crm-tl-out/, 'az idovonal iranyt jelol')
})

test('az idovonal minden esemenynek iranyt ad, ismeretlennek is', async () => {
  const out = await bundle({ write: false })
  const js = out.outputFiles[0].text
  assert.match(js, /idovonalOsztaly/, 'az irany-lekepezes kiemelt fuggveny')
})

test('az esemeny fajtaja adja az idovonal-osztalyt', () => {
  assert.equal(idovonalOsztaly('email_in'), 'crm-tlitem')
  assert.equal(idovonalOsztaly('email_out'), 'crm-tlitem crm-tl-out')
  assert.equal(idovonalOsztaly('note'), 'crm-tlitem crm-tl-note')
  assert.equal(idovonalOsztaly('barmi_mas'), 'crm-tlitem crm-tl-note')
})
