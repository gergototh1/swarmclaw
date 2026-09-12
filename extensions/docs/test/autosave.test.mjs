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
    save: (md) => { state.saves.push(md); state.saved = md },
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
