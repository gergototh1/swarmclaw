import assert from 'node:assert/strict'
import { beforeEach, afterEach, mock, test } from 'node:test'

import { createAutosave } from '../ui/autosave.ts'

beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }))
afterEach(() => mock.timers.reset())

function harness(initial = 'régi') {
  const state = { text: initial, saved: initial, saves: [] }
  const autosave = createAutosave({
    delayMs: 800,
    read: () => state.text,
    saved: () => state.saved,
    save: (md) => { state.saves.push(md); state.saved = md; return Promise.resolve() },
  })
  return { state, autosave }
}

// A single-flight teszteknek kézben kell tartaniuk, mikor zárul le egy mentés
// -- a `harness()` fenti szinkron `save`-je erre nem alkalmas, mert nem lehet
// vele egy mentést "függőben" tartani, amíg egy másik kör el nem indul.
function fuggoHarness(initial = 'régi') {
  const state = { text: initial, saved: initial, saves: [], mentesek: [] }
  const autosave = createAutosave({
    delayMs: 800,
    read: () => state.text,
    saved: () => state.saved,
    save: (md) => {
      state.saves.push(md)
      return new Promise((resolve, reject) => {
        state.mentesek.push({
          resolve: () => { state.saved = md; resolve() },
          reject: (err) => reject(err),
        })
      })
    },
  })
  return { state, autosave }
}

test('a csend lejártakor ment, egyszer', () => {
  const { state, autosave } = harness()
  state.text = 'új'
  autosave.schedule()
  mock.timers.tick(799)
  assert.deepEqual(state.saves, [])
  mock.timers.tick(1)
  assert.deepEqual(state.saves, ['új'])
})

test('minden szerkesztés újraindítja a visszaszámlálást', () => {
  const { state, autosave } = harness()
  state.text = 'ú'
  autosave.schedule()
  mock.timers.tick(500)
  state.text = 'új'
  autosave.schedule()
  mock.timers.tick(500)
  assert.deepEqual(state.saves, [])
  mock.timers.tick(300)
  assert.deepEqual(state.saves, ['új'])
})

test('a flushPending azonnal elmenti a függő szerkesztést, és a késői időzítő már nem ment újra', () => {
  const { state, autosave } = harness()
  state.text = 'új'
  autosave.schedule()
  autosave.flushPending()
  assert.deepEqual(state.saves, ['új'])
  mock.timers.tick(800)
  assert.deepEqual(state.saves, ['új'])
})

test('a flushPending nem ment, ha nincs függő szerkesztés', () => {
  const { state, autosave } = harness()
  state.text = 'új'
  autosave.flushPending()
  assert.deepEqual(state.saves, [])
})

test('nem ment, ha a szöveg megegyezik a legutóbb visszaigazolttal', () => {
  const { state, autosave } = harness()
  autosave.schedule()
  mock.timers.tick(800)
  assert.deepEqual(state.saves, [])
})

test('a cancel ment nélkül dobja el a függő szerkesztést', () => {
  const { state, autosave } = harness()
  state.text = 'új'
  autosave.schedule()
  autosave.cancel()
  mock.timers.tick(800)
  assert.deepEqual(state.saves, [])
})

test('egy futó mentés alatt induló kör nem indít második mentést', () => {
  const { state, autosave } = fuggoHarness()
  state.text = 'első'
  autosave.schedule()
  mock.timers.tick(800)
  assert.deepEqual(state.saves, ['első'])
  // Az első mentés még függőben van (nem resolve-oltuk), mégis jön egy új kör.
  state.text = 'második'
  autosave.schedule()
  mock.timers.tick(800)
  assert.deepEqual(state.saves, ['első'])
})

test('a futó mentés lezárultával egyszer lefut a legfrissebb szöveggel', async () => {
  const { state, autosave } = fuggoHarness()
  state.text = 'első'
  autosave.schedule()
  mock.timers.tick(800)
  state.text = 'második'
  autosave.schedule()
  mock.timers.tick(800)
  assert.deepEqual(state.saves, ['első'])

  state.mentesek[0].resolve()
  await Promise.resolve()
  await Promise.resolve()

  assert.deepEqual(state.saves, ['első', 'második'])
})

test('semmit nem ment, ha a szöveg a futó mentés lezárultára megegyezik a mentettel', async () => {
  const { state, autosave } = fuggoHarness()
  state.text = 'első'
  autosave.schedule()
  mock.timers.tick(800)
  state.text = 'második'
  autosave.schedule()
  mock.timers.tick(800)
  assert.deepEqual(state.saves, ['első'])

  // Mire az első mentés lezárul, a szöveg visszaáll arra, amit az elmenteni
  // kívánt: nincs mit menteni.
  state.text = 'első'
  state.mentesek[0].resolve()
  await Promise.resolve()
  await Promise.resolve()

  assert.deepEqual(state.saves, ['első'])
})

test('egy elutasított mentés is elengedi a következő kört', async () => {
  const { state, autosave } = fuggoHarness()
  state.text = 'első'
  autosave.schedule()
  mock.timers.tick(800)
  state.text = 'második'
  autosave.schedule()
  mock.timers.tick(800)
  assert.deepEqual(state.saves, ['első'])

  state.mentesek[0].reject(new Error('nem sikerült'))
  await Promise.resolve()
  await Promise.resolve()

  assert.deepEqual(state.saves, ['első', 'második'])
})
