import assert from 'node:assert/strict'
import test from 'node:test'

import { createSaveQueue } from '../ui/save-queue.ts'

function deferred() {
  let resolve
  const promise = new Promise((res) => { resolve = res })
  return { promise, resolve }
}

const afterMicrotasks = () => new Promise((res) => setImmediate(res))

test('two runs for the same doc run one after the other', async () => {
  const queue = createSaveQueue()
  const order = []
  const first = deferred()
  const a = queue('doc_1', async () => { order.push('a:start'); await first.promise; order.push('a:end') })
  const b = queue('doc_1', async () => { order.push('b:start') })
  await afterMicrotasks()
  assert.deepEqual(order, ['a:start'])
  first.resolve()
  await Promise.all([a, b])
  assert.deepEqual(order, ['a:start', 'a:end', 'b:start'])
})

test('runs for different docs do not wait for each other', async () => {
  const queue = createSaveQueue()
  const order = []
  const blocker = deferred()
  const a = queue('doc_1', async () => { order.push('a:start'); await blocker.promise; order.push('a:end') })
  const b = queue('doc_2', async () => { order.push('b:start') })
  await b
  assert.deepEqual(order, ['a:start', 'b:start'])
  blocker.resolve()
  await a
})

test('a rejected run does not block the next run for its doc, and its caller still sees the rejection', async () => {
  const queue = createSaveQueue()
  const failing = queue('doc_1', async () => { throw new Error('network') })
  let ranNext = false
  const next = queue('doc_1', async () => { ranNext = true })
  await assert.rejects(failing, /network/)
  await next
  assert.equal(ranNext, true)
})

/** Resolves to true if the promise settles before the pending microtasks and immediates drain. */
async function settledYet(promise) {
  let settled = false
  void promise.then(() => { settled = true }, () => { settled = true })
  await afterMicrotasks()
  return settled
}

test('whenIdle resolves at once with nothing queued', async () => {
  const queue = createSaveQueue()
  assert.equal(await settledYet(queue.whenIdle()), true)
})

test('whenIdle waits for the runs out on several docs', async () => {
  const queue = createSaveQueue()
  const one = deferred()
  const two = deferred()
  const a = queue('doc_1', async () => { await one.promise })
  const b = queue('doc_2', async () => { await two.promise })
  const idle = queue.whenIdle()
  assert.equal(await settledYet(idle), false)
  one.resolve()
  await a
  assert.equal(await settledYet(idle), false)
  two.resolve()
  await b
  assert.equal(await settledYet(idle), true)
})

test('whenIdle waits for every run queued on a doc, not only the first', async () => {
  const queue = createSaveQueue()
  const first = deferred()
  const second = deferred()
  const a = queue('doc_1', async () => { await first.promise })
  const b = queue('doc_1', async () => { await second.promise })
  const idle = queue.whenIdle()
  first.resolve()
  await a
  assert.equal(await settledYet(idle), false)
  second.resolve()
  await b
  assert.equal(await settledYet(idle), true)
})

test('a rejected run does not make whenIdle reject', async () => {
  const queue = createSaveQueue()
  const failing = queue('doc_1', async () => { throw new Error('network') })
  const idle = queue.whenIdle()
  await assert.rejects(failing, /network/)
  await idle
})

test('a run reads what the previous run for the same doc wrote', async () => {
  const queue = createSaveQueue()
  const versions = new Map([['doc_1', 1]])
  const seen = []
  const land = deferred()
  const a = queue('doc_1', async () => {
    seen.push(versions.get('doc_1'))
    await land.promise
    versions.set('doc_1', 2)
  })
  const b = queue('doc_1', async () => { seen.push(versions.get('doc_1')) })
  await afterMicrotasks()
  land.resolve()
  await Promise.all([a, b])
  assert.deepEqual(seen, [1, 2])
})
