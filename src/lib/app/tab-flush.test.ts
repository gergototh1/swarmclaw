import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { FLUSH_REFUSAL_COOLDOWN_MS, FLUSH_TIMEOUT_MS, createFlushRequests, onTabFlushRequest, runTabFlushHandlers } from './tab-flush'

describe('tab flush handlers', () => {
  it('is true with no handlers', async () => {
    assert.equal(await runTabFlushHandlers(), true)
  })

  it('is true only when every handler answers true, and a throw counts as false', async () => {
    const offA = onTabFlushRequest(async () => true)
    assert.equal(await runTabFlushHandlers(), true)
    const offB = onTabFlushRequest(async () => { throw new Error('boom') })
    assert.equal(await runTabFlushHandlers(), false)
    offB()
    assert.equal(await runTabFlushHandlers(), true)
    offA()
  })
})

/** A hand-driven clock: `advance` runs every timer that has come due. */
function fakeClock() {
  let now = 0
  let n = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  return {
    now: () => now,
    schedule: (fn: () => void, ms: number) => {
      const id = ++n
      timers.set(id, { at: now + ms, fn })
      return () => { timers.delete(id) }
    },
    advance(ms: number) {
      now += ms
      for (const [id, timer] of [...timers]) {
        if (timer.at > now) continue
        timers.delete(id)
        timer.fn()
      }
    },
    pending: () => timers.size,
  }
}

function setup() {
  const clock = fakeClock()
  let r = 0
  const sent: string[] = []
  const flushes = createFlushRequests({ newRequestId: () => `r${++r}`, schedule: clock.schedule, now: clock.now })
  const send = (id: string) => (requestId: string) => { sent.push(`${id}:${requestId}`) }
  return { clock, sent, flushes, send }
}

/** Settles a promise into a readable slot without awaiting it. */
function track(promise: Promise<boolean>) {
  const slot: { value: boolean | 'pending' } = { value: 'pending' }
  void promise.then((ok) => { slot.value = ok })
  return slot
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

describe('createFlushRequests', () => {
  it('asks once and resolves with the matching answer', async () => {
    const { flushes, sent, send } = setup()
    const result = track(flushes.request('a', send('a')))
    assert.deepEqual(sent, ['a:r1'])
    assert.equal(flushes.isPending('a'), true)
    flushes.answer('a', 'stale', false)
    flushes.answer('b', 'r1', false)
    await tick()
    assert.equal(result.value, 'pending')
    flushes.answer('a', 'r1', true)
    await tick()
    assert.equal(result.value, true)
    assert.equal(flushes.isPending('a'), false)
  })

  it('joins a second request onto the pending one, and both get the answer', async () => {
    const { flushes, sent, send } = setup()
    const first = track(flushes.request('a', send('a')))
    const second = track(flushes.request('a', send('a')))
    assert.deepEqual(sent, ['a:r1'])
    flushes.answer('a', 'r1', true)
    await tick()
    assert.equal(first.value, true)
    assert.equal(second.value, true)
  })

  it('resolves every joined request with false when the timeout fires', async () => {
    const { flushes, send, clock } = setup()
    const first = track(flushes.request('a', send('a')))
    clock.advance(FLUSH_TIMEOUT_MS - 1)
    const second = track(flushes.request('a', send('a')))
    clock.advance(1)
    await tick()
    assert.equal(first.value, false)
    assert.equal(second.value, false)
    assert.equal(flushes.isPending('a'), false)
    assert.equal(clock.pending(), 0)
  })

  it('remembers a refusal for the cooldown, and a later success clears it', async () => {
    const { flushes, send, clock } = setup()
    void flushes.request('a', send('a'))
    flushes.answer('a', 'r1', false)
    assert.equal(flushes.refusedRecently('a'), true)
    clock.advance(FLUSH_REFUSAL_COOLDOWN_MS - 1)
    assert.equal(flushes.refusedRecently('a'), true)
    clock.advance(1)
    assert.equal(flushes.refusedRecently('a'), false)

    void flushes.request('b', send('b'))
    clock.advance(FLUSH_TIMEOUT_MS)
    assert.equal(flushes.refusedRecently('b'), true, 'a timeout counts as a refusal')
    void flushes.request('b', send('b'))
    flushes.answer('b', 'r3', true)
    assert.equal(flushes.refusedRecently('b'), false)
  })

  it('forgets a tab: its pending request resolves false and its refusal is dropped', async () => {
    const { flushes, send, clock } = setup()
    void flushes.request('a', send('a'))
    flushes.answer('a', 'r1', false)
    const pending = track(flushes.request('b', send('b')))
    flushes.retain(new Set(['c']))
    await tick()
    assert.equal(pending.value, false)
    assert.equal(flushes.isPending('b'), false)
    assert.equal(flushes.refusedRecently('a'), false)
    assert.equal(clock.pending(), 0)
  })

  it('keeps the tabs it is told to retain', async () => {
    const { flushes, send } = setup()
    const pending = track(flushes.request('a', send('a')))
    void flushes.request('b', send('b'))
    flushes.answer('b', 'r2', false)
    flushes.retain(new Set(['a', 'b']))
    await tick()
    assert.equal(pending.value, 'pending')
    assert.equal(flushes.refusedRecently('b'), true)
  })

  it('dispose settles everything as false and cancels the timers', async () => {
    const { flushes, send, clock } = setup()
    const pending = track(flushes.request('a', send('a')))
    flushes.dispose()
    await tick()
    assert.equal(pending.value, false)
    assert.equal(clock.pending(), 0)
  })
})
