import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createCatchUp } from './ws-catch-up'

describe('createCatchUp', () => {
  it('runs at once while active', () => {
    let runs = 0
    const c = createCatchUp(() => { runs++ })
    c.onEvent(true)
    c.onEvent(true)
    assert.equal(runs, 2)
  })

  it('coalesces everything missed while inactive into one run', () => {
    let runs = 0
    const c = createCatchUp(() => { runs++ })
    c.onEvent(false)
    c.onEvent(false)
    c.onEvent(false)
    assert.equal(runs, 0)
    c.onActiveChange(true)
    assert.equal(runs, 1)
    c.onActiveChange(true)
    assert.equal(runs, 1, 'nothing missed since the last catch-up')
  })

  it('does not run when going inactive, and misses after that still coalesce', () => {
    let runs = 0
    const c = createCatchUp(() => { runs++ })
    c.onActiveChange(false)
    assert.equal(runs, 0)
    c.onEvent(false)
    c.onActiveChange(true)
    assert.equal(runs, 1)
  })
})
