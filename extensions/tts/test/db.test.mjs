import assert from 'node:assert/strict'
import { test } from 'node:test'

import { MIGRATIONS, createRepo, napOf, sha256 } from '../src/db.mjs'
import { memStorage } from './helpers.mjs'

function fresh() {
  const s = memStorage()
  for (const m of MIGRATIONS) s.raw.exec(m.sql)
  return createRepo(s)
}

const key = { szolgaltato: 'soniox', modell: 'tts-rt-v1', hang: 'Kenji', nyelv: 'hu', szovegHash: sha256('Szia.') }
const row = {
  szolgaltato: 'soniox', modell: 'tts-rt-v1', hang: 'Kenji', nyelv: 'hu', szoveg: 'Szia.',
  fajl: '/tmp/a.mp3', hosszMs: 900, bajt: 12000, status: 'kesz', hibaKod: '', kerte: 'contract',
}

test('every migration table uses the ext_tts_ prefix', () => {
  for (const m of MIGRATIONS) {
    for (const t of m.sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)) assert.match(t[1], /^ext_tts_/)
  }
})

test('the cache key finds a finished row, ignores a failed one, and the unique index refuses a second finished row', () => {
  const r = fresh()
  assert.equal(r.cacheHit(key), null)
  r.insertKerelem({ ...row, status: 'hiba', hibaKod: 'tts_halozat' })
  assert.equal(r.cacheHit(key), null)
  const { id } = r.insertKerelem(row)
  assert.equal(r.cacheHit(key).id, id)
  assert.throws(() => r.insertKerelem(row), /UNIQUE/)
  r.markLost(id)
  assert.equal(r.cacheHit(key), null)
})

test('a different voice is a different key', () => {
  const r = fresh()
  r.insertKerelem(row)
  assert.equal(r.cacheHit({ ...key, hang: 'Mira' }), null)
})

test('the daily counter accumulates per day', () => {
  const r = fresh()
  assert.equal(r.maiMasodperc('2026-09-05'), 0)
  assert.deepEqual(r.foglal('2026-09-05', 12.5, 900), { ok: true, mai: 0 })
  assert.deepEqual(r.foglal('2026-09-05', 2.5, 900), { ok: true, mai: 12.5 })
  assert.equal(r.maiMasodperc('2026-09-05'), 15)
  assert.equal(r.maiMasodperc('2026-09-06'), 0)
  assert.equal(napOf('2026-09-05T07:15:00.000Z'), '2026-09-05')
})

test('a reservation that would cross the cap is refused and writes nothing; one that fits is taken before the caller returns', () => {
  const r = fresh()
  assert.deepEqual(r.foglal('2026-09-05', 9, 10), { ok: true, mai: 0 })
  // The room left is 1 s, so a 1.5 s reservation is refused and the counter
  // is exactly where it was: a refused reservation costs the day nothing.
  assert.deepEqual(r.foglal('2026-09-05', 1.5, 10), { ok: false, mai: 9 })
  assert.equal(r.maiMasodperc('2026-09-05'), 9)
  // Exactly filling the cap is allowed; a hair over it is not.
  assert.equal(r.foglal('2026-09-05', 1, 10).ok, true)
  assert.equal(r.maiMasodperc('2026-09-05'), 10)
  assert.equal(r.foglal('2026-09-05', 0.001, 10).ok, false)
  assert.equal(r.maiMasodperc('2026-09-05'), 10)
  // Another day has its own room.
  assert.equal(r.foglal('2026-09-06', 10, 10).ok, true)
})

test('a reservation is corrected up, down or all the way back, and the day never reads as credit', () => {
  const r = fresh()
  r.foglal('2026-09-05', 4, 900)
  r.igazit('2026-09-05', 1.5 - 4)
  assert.equal(r.maiMasodperc('2026-09-05'), 1.5)
  r.igazit('2026-09-05', 2)
  assert.equal(r.maiMasodperc('2026-09-05'), 3.5)
  r.igazit('2026-09-05', 0)
  assert.equal(r.maiMasodperc('2026-09-05'), 3.5)
  // Releasing a reservation in full puts the room back for the next call.
  r.foglal('2026-09-05', 6, 10)
  r.igazit('2026-09-05', -6)
  assert.equal(r.maiMasodperc('2026-09-05'), 3.5)
  assert.equal(r.foglal('2026-09-05', 6, 10).ok, true)
  // The floor: a correction larger than the day holds leaves it empty, not negative.
  r.igazit('2026-09-05', -1000)
  assert.equal(r.maiMasodperc('2026-09-05'), 0)
})

test('counts and kerelmek report what is stored', () => {
  const r = fresh()
  r.insertKerelem(row)
  r.insertKerelem({ ...row, szoveg: 'Más.', status: 'hiba', hibaKod: 'tts_halozat' })
  assert.deepEqual(r.counts(), { kerelmek: 2, kesz: 1, hiba: 1 })
  assert.equal(r.kerelmek(1).length, 1)
})
