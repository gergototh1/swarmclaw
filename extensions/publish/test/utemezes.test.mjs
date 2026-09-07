import assert from 'node:assert/strict'
import test from 'node:test'

import { KIADAS_ALLAPOTOK } from '../src/db.mjs'
import { esedekes, kovetkezoSzabadSav } from '../src/utemezes.mjs'

/**
 * Task 3's own tests, from the brief verbatim (task-3-brief.md 3.1) -- the
 * slot arithmetic and the due filter, injected `most` so both are testable
 * without a clock -- plus the cases the mutation pass added: `ora`/`perc`
 * are not interchangeable, a boundary at exactly `most`, several due and
 * not-yet-due releases sharing one call, and the refusals on malformed
 * input.
 */

test('a jóváhagyott kiadás a következő SZABAD sávba áll', () => {
  const savok = [{ id: 's1', nap: 1, ora: 9, perc: 0 }, { id: 's2', nap: 1, ora: 18, perc: 0 }]
  const most = new Date('2026-09-07T07:00:00.000Z')
  assert.equal(kovetkezoSzabadSav(savok, [], most).savId, 's1')
  const foglalt = [{ savId: 's1', idopont: '2026-09-07T09:00:00.000Z' }]
  assert.equal(kovetkezoSzabadSav(savok, foglalt, most).savId, 's2')
})

test('nincs több szabad sáv: null, nem az első újra', () => {
  const savok = [{ id: 's1', nap: 1, ora: 9, perc: 0 }]
  const most = new Date('2026-09-07T10:00:00.000Z')
  // A mai 09:00 elment; a következő ugyanaz a sáv a KÖVETKEZŐ héten.
  const r = kovetkezoSzabadSav(savok, [], most)
  assert.ok(r !== null && Date.parse(r.idopont) > most.getTime(), 'soha nem ad múltbeli időpontot')
})

test('esedekes: a megadott idő UTÁNI első futás viszi ki', () => {
  const k = [{ id: 'k1', idopont: '2026-09-07T09:00:00.000Z', allapot: 'utemezve' }]
  assert.deepEqual(esedekes(k, new Date('2026-09-07T08:59:00.000Z')).map((x) => x.id), [])
  assert.deepEqual(esedekes(k, new Date('2026-09-07T09:07:00.000Z')).map((x) => x.id), ['k1'])
})

test('esedekes csak utemezve állapotút hoz — vázlatot soha', () => {
  const k = [{ id: 'k1', idopont: '2026-09-07T09:00:00.000Z', allapot: 'vazlat' }]
  assert.deepEqual(esedekes(k, new Date('2026-09-07T10:00:00.000Z')), [])
})

// --- the mutation pass: ora and perc are not interchangeable ---

test('kovetkezoSzabadSav: az ora és a perc nem cserélhető fel némán -- a pontos időpont dönt, nem csak a sorrend', () => {
  // Swap ora<->perc in the implementation and this still "sort of" works
  // unless the fixture pins an exact instant: s1 at 09:47 real time would
  // read as 47:09 (invalid) or silently as some other hour if ora/perc were
  // swapped, so assert the FULL computed instant, not just which slot won.
  const savok = [{ id: 's1', nap: 2, ora: 9, perc: 47 }, { id: 's2', nap: 2, ora: 9, perc: 12 }]
  const most = new Date('2026-09-08T00:00:00.000Z') // Tuesday 00:00 UTC (nap=2)
  const r = kovetkezoSzabadSav(savok, [], most)
  assert.equal(r.savId, 's2')
  assert.equal(r.idopont, '2026-09-08T09:12:00.000Z')
})

test('kovetkezoSzabadSav: a nap száma getUTCDay() szerint dönt, nem a tömbindex', () => {
  const savok = [{ id: 'pentek', nap: 5, ora: 8, perc: 0 }, { id: 'szerda', nap: 3, ora: 8, perc: 0 }]
  const most = new Date('2026-09-07T00:00:00.000Z') // Monday
  const r = kovetkezoSzabadSav(savok, [], most)
  assert.equal(r.savId, 'szerda')
  assert.equal(r.idopont, '2026-09-09T08:00:00.000Z') // the Wednesday two days later, not the Friday
})

test('kovetkezoSzabadSav: a most-tal pontosan egybeeső előfordulás NEM szabad -- egy héttel odébb ugrik', () => {
  const savok = [{ id: 's1', nap: 1, ora: 9, perc: 0 }]
  const most = new Date('2026-09-07T09:00:00.000Z') // exactly the slot's own instant
  const r = kovetkezoSzabadSav(savok, [], most)
  assert.equal(r.idopont, '2026-09-14T09:00:00.000Z')
})

test('kovetkezoSzabadSav: üres savok esetén null', () => {
  assert.equal(kovetkezoSzabadSav([], [], new Date('2026-09-07T09:00:00.000Z')), null)
})

test('kovetkezoSzabadSav: elutasítja az érvénytelen sávot, a hívó értékét vissza nem mondva', () => {
  assert.throws(() => kovetkezoSzabadSav([{ id: 's1', nap: 9, ora: 9, perc: 0 }], [], new Date()), TypeError)
})

test('kovetkezoSzabadSav: elutasítja az érvénytelen most-ot', () => {
  assert.throws(() => kovetkezoSzabadSav([], [], new Date('nem-datum')), TypeError)
  assert.throws(() => kovetkezoSzabadSav([], [], 'nem is Date'), TypeError)
})

// --- the mutation pass: esedekes over several releases at once ---

test('esedekes: több kiadás közül csak az esedékes utemezve-ket adja, a sorrendet megtartva', () => {
  const most = new Date('2026-09-07T10:00:00.000Z')
  const k = [
    { id: 'jovoben', idopont: '2026-09-07T11:00:00.000Z', allapot: KIADAS_ALLAPOTOK.UTEMEZVE },
    { id: 'esedekes-1', idopont: '2026-09-07T09:00:00.000Z', allapot: KIADAS_ALLAPOTOK.UTEMEZVE },
    { id: 'jovahagyva-de-nem-utemezve', idopont: '2026-09-07T09:00:00.000Z', allapot: KIADAS_ALLAPOTOK.JOVAHAGYVA },
    { id: 'esedekes-2', idopont: '2026-09-07T10:00:00.000Z', allapot: KIADAS_ALLAPOTOK.UTEMEZVE },
  ]
  assert.deepEqual(esedekes(k, most).map((x) => x.id), ['esedekes-1', 'esedekes-2'])
})

test('esedekes: idopont nélküli utemezve sor nem esedékes, nem dob hibát', () => {
  const k = [{ id: 'k1', allapot: KIADAS_ALLAPOTOK.UTEMEZVE }]
  assert.deepEqual(esedekes(k, new Date('2026-09-07T10:00:00.000Z')), [])
})

test('esedekes: elutasítja az érvénytelen bemenetet', () => {
  assert.throws(() => esedekes([{ id: 'k1' }], new Date()), TypeError)
  assert.throws(() => esedekes([], 'nem Date'), TypeError)
})
