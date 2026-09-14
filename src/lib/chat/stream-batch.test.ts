import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createStreamBatch } from './stream-batch'

interface State { text: string; phase: string }

function harness(intervalMs = 50) {
  const applied: Partial<State>[] = []
  let now = 0
  const timers: { id: number; at: number; fn: () => void }[] = []
  let nextId = 1
  const batch = createStreamBatch<State>({
    intervalMs,
    apply: (patch) => applied.push(patch),
    setTimer: (fn, ms) => { const id = nextId++; timers.push({ id, at: now + ms, fn }); return id },
    clearTimer: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1) },
  })
  const advance = (ms: number) => {
    now += ms
    for (const timer of timers.filter((t) => t.at <= now)) {
      const i = timers.indexOf(timer)
      if (i >= 0) timers.splice(i, 1)
      timer.fn()
    }
  }
  return { applied, batch, advance, pendingTimers: () => timers.length }
}

describe('createStreamBatch', () => {
  it('applies the first patch at once, then merges the rest of the window into one write', () => {
    const { applied, batch, advance } = harness()
    batch.push({ text: 'a' })
    assert.deepEqual(applied, [{ text: 'a' }])
    batch.push({ text: 'ab' })
    batch.push({ text: 'abc' })
    batch.push({ phase: 'responding' })
    assert.equal(applied.length, 1, 'nothing else is written inside the window')
    advance(50)
    assert.deepEqual(applied, [{ text: 'a' }, { text: 'abc', phase: 'responding' }])
  })

  it('opens a new window only when something is pushed again', () => {
    const { applied, batch, advance, pendingTimers } = harness()
    batch.push({ text: 'a' })
    advance(50)
    assert.equal(pendingTimers(), 0, 'an idle stream keeps no timer running')
    batch.push({ text: 'ab' })
    assert.deepEqual(applied, [{ text: 'a' }, { text: 'ab' }])
  })

  it('flush applies a pending patch immediately and leaves nothing behind', () => {
    const { applied, batch, advance } = harness()
    batch.push({ text: 'a' })
    batch.push({ text: 'ab' })
    batch.flush()
    assert.deepEqual(applied, [{ text: 'a' }, { text: 'ab' }])
    batch.flush()
    advance(100)
    assert.equal(applied.length, 2, 'a flush with nothing pending writes nothing')
  })

  it('dispose drops the pending patch and its timer', () => {
    const { applied, batch, advance, pendingTimers } = harness()
    batch.push({ text: 'a' })
    batch.push({ text: 'ab' })
    batch.dispose()
    assert.equal(pendingTimers(), 0)
    advance(100)
    assert.deepEqual(applied, [{ text: 'a' }])
  })
})
