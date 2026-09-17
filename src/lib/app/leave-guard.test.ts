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

  it('a proceed that asks again runs once the guard is released first', () => {
    // The editor's confirm: release the guard, then run the held navigation,
    // which itself goes through requestLeave (the rail and useNavigate do).
    let prompts = 0
    const held: { fn: (() => void) | null } = { fn: null }
    const releaseGuard = setLeaveGuard((proceed) => { prompts += 1; held.fn = proceed })
    release = releaseGuard
    let went = false
    requestLeave(() => requestLeave(() => { went = true }))
    assert.equal(prompts, 1)
    releaseGuard()
    held.fn?.()
    assert.equal(went, true)
    assert.equal(prompts, 1)
    assert.equal(hasLeaveGuard(), false)
  })

  it('without the release the nested ask prompts again', () => {
    let prompts = 0
    const held: { fn: (() => void) | null } = { fn: null }
    release = setLeaveGuard((proceed) => { prompts += 1; held.fn = proceed })
    let went = false
    requestLeave(() => requestLeave(() => { went = true }))
    const first = held.fn
    first?.()
    assert.equal(prompts, 2)
    assert.equal(went, false)
  })

  it('a stale release does not remove a newer guard', () => {
    const releaseOld = setLeaveGuard(() => {})
    release = setLeaveGuard(() => {})
    releaseOld()
    assert.equal(hasLeaveGuard(), true)
  })
})
