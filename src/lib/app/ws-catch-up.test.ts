import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createCatchUp } from './ws-catch-up'

/** A handler that always gets to run, and counts how often it did. */
function counter() {
  const calls = { runs: 0 }
  const run = () => { calls.runs++; return true }
  return { calls, run }
}

describe('createCatchUp', () => {
  it('runs at once while active', () => {
    const { calls, run } = counter()
    const c = createCatchUp(run)
    c.onEvent(true)
    c.onEvent(true)
    assert.equal(calls.runs, 2)
  })

  it('coalesces everything missed while inactive into one run', () => {
    const { calls, run } = counter()
    const c = createCatchUp(run)
    c.onEvent(false)
    c.onEvent(false)
    c.onEvent(false)
    assert.equal(calls.runs, 0)
    c.onActiveChange(true)
    assert.equal(calls.runs, 1)
    c.onActiveChange(true)
    assert.equal(calls.runs, 1, 'nothing missed since the last catch-up')
  })

  it('does not run when going inactive, and misses after that still coalesce', () => {
    const { calls, run } = counter()
    const c = createCatchUp(run)
    c.onActiveChange(false)
    assert.equal(calls.runs, 0)
    c.onEvent(false)
    c.onActiveChange(true)
    assert.equal(calls.runs, 1)
  })

  it('an event handled while active does not also arm a miss', () => {
    // The whole point of the branch: a reactivation refetches only when
    // something actually happened while nobody was looking. An event that was
    // handled on the spot, because the frame was on screen at the time, is not
    // that — if it armed a miss anyway, every tab switch would refetch every
    // topic, which is the cost this exists to avoid.
    const { calls, run } = counter()
    const c = createCatchUp(run)
    c.onEvent(true)
    assert.equal(calls.runs, 1)
    c.onActiveChange(false)
    c.onActiveChange(true)
    assert.equal(calls.runs, 1, 'the handled event must not come back as a miss')
  })

  it('a stale reconnect with nothing missed still runs, and a plain re-check does not run again', () => {
    const { calls, run } = counter()
    const c = createCatchUp(run)
    // Nothing arrived while inactive (the socket was closed, so nothing could).
    c.onActiveChange(true, true)
    assert.equal(calls.runs, 1)
    // The caller only passes `stale: true` on the transition itself (see
    // `useWs`'s `becameActive`); a re-check with nothing missed and nothing
    // stale this time does not run again.
    c.onActiveChange(true, false)
    assert.equal(calls.runs, 1)
  })

  it('a missed event and a stale reconnect on the same activation still run only once', () => {
    // Regression: `useWs` used to run its own immediate refresh (for a still-
    // disconnected socket) in a separate effect from the catch-up coordinator,
    // so a reactivation that was both "something was missed" and "the socket
    // is still down" fired the handler twice. Routing the stale case through
    // `onActiveChange` instead keeps this to exactly one call.
    const { calls, run } = counter()
    const c = createCatchUp(run)
    c.onEvent(false)
    c.onActiveChange(true, true)
    assert.equal(calls.runs, 1)
  })

  it('keeps the miss when the catch-up could not actually run', () => {
    // `useWs`'s handler refuses to start while the previous run is still in
    // flight. Clearing the miss anyway would drop it with nothing left to
    // retry it, so a refused run leaves it armed for the next catch-up.
    let runs = 0
    let allowed = false
    const c = createCatchUp(() => { runs++; return allowed })
    c.onEvent(false)
    c.onActiveChange(true)
    assert.equal(runs, 1, 'it tried')
    allowed = true
    c.onActiveChange(false)
    c.onActiveChange(true)
    assert.equal(runs, 2, 'the refused run left the miss armed')
    c.onActiveChange(false)
    c.onActiveChange(true)
    assert.equal(runs, 2, 'and the run that succeeded cleared it')
  })

  it('a refused stale reconnect is retried on the next activation', () => {
    let runs = 0
    let allowed = false
    const c = createCatchUp(() => { runs++; return allowed })
    c.onActiveChange(true, true)
    assert.equal(runs, 1)
    allowed = true
    c.onActiveChange(false)
    // No `stale` this time: the socket stayed up. The refused reconnect
    // refresh is what carries the need for this run.
    c.onActiveChange(true, false)
    assert.equal(runs, 2)
  })
})

// `useWs` asks `socket-gap.ts` whether this frame's socket was closed while it
// was away, for every topic — a topic with no fallback interval (e.g.
// `'extensions'` in chat-area.tsx) used to get no refresh at all when it had
// been. These name the four cases that decision has to get right, independent
// of how `stale` itself is decided upstream.
describe('reactivation refresh: socket state crossed with missed events', () => {
  it('socket stayed open + events missed → one run', () => {
    const { calls, run } = counter()
    const c = createCatchUp(run)
    c.onEvent(false)
    c.onActiveChange(true, false)
    assert.equal(calls.runs, 1)
  })

  it('socket closed, no events → one run', () => {
    const { calls, run } = counter()
    const c = createCatchUp(run)
    c.onActiveChange(true, true)
    assert.equal(calls.runs, 1)
  })

  it('socket closed + events missed → one run, not two', () => {
    const { calls, run } = counter()
    const c = createCatchUp(run)
    c.onEvent(false)
    c.onActiveChange(true, true)
    assert.equal(calls.runs, 1)
  })

  it('frame never went inactive → no extra run', () => {
    // `useWs` only ever passes `stale: true` on an actual inactive→active
    // transition (`becameActive`); a frame that was already active, with
    // nothing missed, gets no run just because `onActiveChange(true, …)` is
    // called again.
    const { calls, run } = counter()
    const c = createCatchUp(run)
    c.onActiveChange(true, false)
    assert.equal(calls.runs, 0)
  })
})
