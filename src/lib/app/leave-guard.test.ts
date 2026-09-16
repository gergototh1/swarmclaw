import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { hasLeaveGuard, requestLeave, setLeaveGuard } from './leave-guard'

describe('leave guard', () => {
  let release: () => void = () => {}
  afterEach(() => release())

  it('proceeds at once when nothing is guarded', () => {
    let went = false
    requestLeave(() => { went = true })
    assert.equal(went, true)
    assert.equal(hasLeaveGuard(), false)
  })

  it('hands the proceed callback to the guard instead', () => {
    const held: { fn: (() => void) | null } = { fn: null }
    release = setLeaveGuard((proceed) => { held.fn = proceed })
    let went = false
    requestLeave(() => { went = true })
    assert.equal(went, false)
    assert.ok(held.fn)
    held.fn()
    assert.equal(went, true)
  })

  it('a stale release does not remove a newer guard', () => {
    const releaseOld = setLeaveGuard(() => {})
    release = setLeaveGuard(() => {})
    releaseOld()
    assert.equal(hasLeaveGuard(), true)
  })
})
