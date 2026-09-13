import assert from 'node:assert/strict'
import { afterEach, beforeEach, mock, test } from 'node:test'

import { createAutosave } from '../ui/autosave.ts'

beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }))
afterEach(() => mock.timers.reset())

function harness(initial = 'old') {
  const state = { text: initial, saved: initial, saves: [] }
  const autosave = createAutosave({
    delayMs: 800,
    read: () => state.text,
    saved: () => state.saved,
    save: (md) => { state.saves.push(md); state.saved = md },
  })
  return { state, autosave }
}

test('saves once when the quiet period ends', () => {
  const { state, autosave } = harness()
  state.text = 'new'
  autosave.schedule()
  mock.timers.tick(799)
  assert.deepEqual(state.saves, [])
  mock.timers.tick(1)
  assert.deepEqual(state.saves, ['new'])
})

test('every edit restarts the countdown', () => {
  const { state, autosave } = harness()
  state.text = 'ne'
  autosave.schedule()
  mock.timers.tick(500)
  state.text = 'new'
  autosave.schedule()
  mock.timers.tick(500)
  assert.deepEqual(state.saves, [])
  mock.timers.tick(300)
  assert.deepEqual(state.saves, ['new'])
})

test('flushPending saves the waiting edit at once, and the late timer does not save again', () => {
  const { state, autosave } = harness()
  state.text = 'new'
  autosave.schedule()
  autosave.flushPending()
  assert.deepEqual(state.saves, ['new'])
  mock.timers.tick(800)
  assert.deepEqual(state.saves, ['new'])
})

test('flushPending does nothing when no edit is waiting', () => {
  const { state, autosave } = harness()
  state.text = 'new'
  autosave.flushPending()
  assert.deepEqual(state.saves, [])
})

test('does not save text equal to what was last confirmed', () => {
  const { state, autosave } = harness()
  autosave.schedule()
  mock.timers.tick(800)
  assert.deepEqual(state.saves, [])
})

test('cancel drops the waiting edit without saving it', () => {
  const { state, autosave } = harness()
  state.text = 'new'
  autosave.schedule()
  autosave.cancel()
  mock.timers.tick(800)
  assert.deepEqual(state.saves, [])
})
