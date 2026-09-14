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

  it('a stale reconnect with nothing missed still runs, and a plain re-check does not run again', () => {
    let runs = 0
    const c = createCatchUp(() => { runs++ })
    // Nothing arrived while inactive (the socket was closed, so nothing could).
    c.onActiveChange(true, true)
    assert.equal(runs, 1)
    // The caller only passes `stale: true` on the transition itself (see
    // `useWs`'s `becameActive`); a re-check with nothing missed and nothing
    // stale this time does not run again.
    c.onActiveChange(true, false)
    assert.equal(runs, 1)
  })

  it('a missed event and a stale reconnect on the same activation still run only once', () => {
    // Regression: `useWs` used to run its own immediate refresh (for a still-
    // disconnected socket) in a separate effect from the catch-up coordinator,
    // so a reactivation that was both "something was missed" and "the socket
    // is still down" fired the handler twice. Routing the stale case through
    // `onActiveChange` instead keeps this to exactly one call.
    let runs = 0
    const c = createCatchUp(() => { runs++ })
    c.onEvent(false)
    c.onActiveChange(true, true)
    assert.equal(runs, 1)
  })
})

// `useWs` computes `stale` from `isWsConnected()` for every topic now, not
// only ones with a `fallbackMs` — a topic with no fallback interval (e.g.
// `'extensions'` in chat-area.tsx) used to get no refresh at all when the
// frame's own socket (idle-socket.ts) had actually closed while it was away.
// These name the four cases that decision has to get right, independent of
// how `stale` itself is computed upstream.
describe('reactivation refresh: socket state crossed with missed events', () => {
  it('socket stayed open + events missed → one run', () => {
    let runs = 0
    const c = createCatchUp(() => { runs++ })
    c.onEvent(false)
    c.onActiveChange(true, false)
    assert.equal(runs, 1)
  })

  it('socket closed, no events → one run', () => {
    let runs = 0
    const c = createCatchUp(() => { runs++ })
    c.onActiveChange(true, true)
    assert.equal(runs, 1)
  })

  it('socket closed + events missed → one run, not two', () => {
    let runs = 0
    const c = createCatchUp(() => { runs++ })
    c.onEvent(false)
    c.onActiveChange(true, true)
    assert.equal(runs, 1)
  })

  it('frame never went inactive → no extra run', () => {
    // `useWs` only ever passes `stale: true` on an actual inactive→active
    // transition (`becameActive`); a frame that was already active, with
    // nothing missed, gets no run just because `onActiveChange(true, …)` is
    // called again.
    let runs = 0
    const c = createCatchUp(() => { runs++ })
    c.onActiveChange(true, false)
    assert.equal(runs, 0)
  })
})
