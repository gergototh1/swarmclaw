import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createIdleSocket } from './idle-socket'

function harness(graceMs = 30_000) {
  const connects: number[] = []
  const disconnects: number[] = []
  let now = 0
  const timers: { id: number; at: number; fn: () => void }[] = []
  let nextId = 1
  const socket = createIdleSocket({
    graceMs,
    connect: () => { connects.push(now) },
    disconnect: () => { disconnects.push(now) },
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
  return { connects, disconnects, socket, advance, pendingTimers: () => timers.length }
}

describe('createIdleSocket', () => {
  it('a short trip away and back never disconnects', () => {
    const { connects, disconnects, socket, advance } = harness()
    socket.setActive(false)
    advance(5_000)
    socket.setActive(true)
    assert.deepEqual(disconnects, [])
    assert.deepEqual(connects, [], 'never disconnected, so no reconnect is needed either')
  })

  it('staying inactive past the grace period disconnects once, and returning reconnects once', () => {
    const { connects, disconnects, socket, advance } = harness()
    socket.setActive(false)
    advance(30_000)
    assert.deepEqual(disconnects, [30_000])
    socket.setActive(true)
    assert.deepEqual(connects, [30_000])
  })

  it('repeated setActive(false) does not stack timers or disconnect twice', () => {
    const { disconnects, socket, advance, pendingTimers } = harness()
    socket.setActive(false)
    assert.equal(pendingTimers(), 1)
    socket.setActive(false)
    socket.setActive(false)
    assert.equal(pendingTimers(), 1, 'no extra timer was started')
    advance(30_000)
    assert.deepEqual(disconnects, [30_000])
    // Still inactive past the grace period: no second disconnect fires.
    socket.setActive(false)
    advance(30_000)
    assert.deepEqual(disconnects, [30_000])
  })

  it('dispose while the timer is pending does not disconnect', () => {
    const { disconnects, socket, advance, pendingTimers } = harness()
    socket.setActive(false)
    socket.dispose()
    assert.equal(pendingTimers(), 0)
    advance(30_000)
    assert.deepEqual(disconnects, [])
  })

  it('going active again cancels a still-pending grace timer', () => {
    const { connects, disconnects, socket, advance, pendingTimers } = harness()
    socket.setActive(false)
    advance(10_000)
    socket.setActive(true)
    assert.equal(pendingTimers(), 0)
    advance(30_000)
    assert.deepEqual(disconnects, [], 'the timer was cancelled, not merely superseded')
    assert.deepEqual(connects, [])
  })
})
