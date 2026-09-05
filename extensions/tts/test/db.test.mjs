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
  r.addMasodperc('2026-09-05', 12.5)
  r.addMasodperc('2026-09-05', 2.5)
  assert.equal(r.maiMasodperc('2026-09-05'), 15)
  assert.equal(r.maiMasodperc('2026-09-06'), 0)
  assert.equal(napOf('2026-09-05T07:15:00.000Z'), '2026-09-05')
})

test('counts and kerelmek report what is stored', () => {
  const r = fresh()
  r.insertKerelem(row)
  r.insertKerelem({ ...row, szoveg: 'Más.', status: 'hiba', hibaKod: 'tts_halozat' })
  assert.deepEqual(r.counts(), { kerelmek: 2, kesz: 1, hiba: 1 })
  assert.equal(r.kerelmek(1).length, 1)
})
