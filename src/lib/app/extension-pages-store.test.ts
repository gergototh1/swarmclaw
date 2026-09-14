import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createExtensionPagesStore, type ExtensionPage, type ExtensionPagesStoreDeps } from './extension-pages-store'

const page = (id: string): ExtensionPage => ({
  extensionId: `${id}.mjs`, id, label: id, path: `/x/${id}`, entry: 'dist/index.js',
})

/** Lets the store's own `.then`/`.catch` chain settle. */
const settle = () => new Promise<void>((resolve) => { setTimeout(resolve, 0) })

interface Harness {
  deps: ExtensionPagesStoreDeps
  /** Every `GET /extensions/ui?type=pages` the store has made. */
  fetches: number
  /** What the next fetch answers. */
  answer: { kind: 'pages'; pages: ExtensionPage[] } | { kind: 'error'; message: string }
  connected: boolean
  active: boolean
  /** Fire the `extensions` push topic. */
  pushEvent(): void
  /** Fire a socket connect/disconnect notification. */
  pushConnection(): void
  /** Fire one of the two active-state sources. */
  pushActive(): void
  /** Run every pending fallback tick once. */
  tickFallback(): void
  subscriberCounts(): { events: number; connection: number; active: number }
}

function harness(): Harness {
  const events = new Set<() => void>()
  const connection = new Set<() => void>()
  const activeListeners = new Set<() => void>()
  const timers = new Map<number, () => void>()
  let nextTimer = 1

  const h: Harness = {
    fetches: 0,
    answer: { kind: 'pages', pages: [] },
    connected: true,
    active: true,
    pushEvent: () => { for (const cb of events) cb() },
    pushConnection: () => { for (const cb of connection) cb() },
    pushActive: () => { for (const cb of activeListeners) cb() },
    tickFallback: () => { for (const fn of timers.values()) fn() },
    subscriberCounts: () => ({ events: events.size, connection: connection.size, active: activeListeners.size }),
    deps: {
      fetchPages: () => {
        h.fetches++
        return h.answer.kind === 'pages'
          ? Promise.resolve(h.answer.pages)
          : Promise.reject(new Error(h.answer.message))
      },
      subscribeEvents: (cb) => { events.add(cb); return () => { events.delete(cb) } },
      subscribeConnection: (cb) => { connection.add(cb); return () => { connection.delete(cb) } },
      subscribeActive: (cb) => { activeListeners.add(cb); return () => { activeListeners.delete(cb) } },
      isConnected: () => h.connected,
      isActive: () => h.active,
      hadSocketGap: () => false,
      fallbackMs: 60_000,
      setTimer: (fn) => { const id = nextTimer++; timers.set(id, fn); return id },
      clearTimer: (id) => { timers.delete(id) },
    },
  }
  return h
}

describe('extension pages store', () => {
  it('starts on the first subscriber and stops on the last', async () => {
    const h = harness()
    const store = createExtensionPagesStore(h.deps)
    assert.equal(h.fetches, 0, 'nothing runs before anything is mounted')

    const offA = store.subscribe(() => {})
    const offB = store.subscribe(() => {})
    assert.equal(h.fetches, 1, 'the second caller shares the first one\'s fetch')
    assert.deepEqual(h.subscriberCounts(), { events: 1, connection: 1, active: 1 })

    offA()
    assert.deepEqual(h.subscriberCounts(), { events: 1, connection: 1, active: 1 }, 'one caller left keeps it running')
    offB()
    assert.deepEqual(h.subscriberCounts(), { events: 0, connection: 0, active: 0 }, 'the last one turns everything off')

    await settle()
    h.pushEvent()
    await settle()
    assert.equal(h.fetches, 1, 'a push nobody is subscribed to costs nothing')
  })

  it('restarts cleanly after the last subscriber has gone', async () => {
    const h = harness()
    const store = createExtensionPagesStore(h.deps)
    h.answer = { kind: 'pages', pages: [page('crm')] }
    const off = store.subscribe(() => {})
    await settle()
    off()

    const offAgain = store.subscribe(() => {})
    assert.equal(h.fetches, 2, 'a remount asks the server again')
    assert.deepEqual(h.subscriberCounts(), { events: 1, connection: 1, active: 1 })
    await settle()
    h.pushEvent()
    await settle()
    assert.equal(h.fetches, 3, 'and the restarted push subscription still works')
    offAgain()
  })

  it('keeps what the server last said across a stop and start', async () => {
    const h = harness()
    const store = createExtensionPagesStore(h.deps)
    assert.equal(store.getSnapshot().loaded, false, 'nothing has been asked yet')

    h.answer = { kind: 'pages', pages: [page('docs')] }
    const off = store.subscribe(() => {})
    await settle()
    assert.deepEqual(store.getSnapshot().pages.map((p) => p.id), ['docs'])
    off()

    // The `/x/<slug>` route tells "not loaded yet" from "no such page" by this
    // flag, so what it reads between a remount and the refetch landing has to be
    // the last thing the server said — not an empty list that reads as "gone".
    assert.equal(store.getSnapshot().loaded, true)
    const offAgain = store.subscribe(() => {})
    assert.deepEqual(store.getSnapshot().pages.map((p) => p.id), ['docs'])
    assert.equal(store.getSnapshot().loaded, true)
    offAgain()
  })

  it('a failed fetch keeps the pages on screen and says why', async () => {
    const h = harness()
    const store = createExtensionPagesStore(h.deps)
    h.answer = { kind: 'pages', pages: [page('video')] }
    const off = store.subscribe(() => {})
    await settle()

    h.answer = { kind: 'error', message: 'fetch failed' }
    h.pushEvent()
    await settle()
    assert.deepEqual(store.getSnapshot().pages.map((p) => p.id), ['video'], 'the rendered page does not blank')
    assert.equal(store.getSnapshot().loaded, true)
    assert.equal(store.getSnapshot().error, 'fetch failed')

    h.answer = { kind: 'pages', pages: [page('video'), page('crm')] }
    h.pushEvent()
    await settle()
    assert.equal(store.getSnapshot().error, undefined, 'a transient failure does not stick')
    off()
  })

  it('a reconnect re-fetches only when the last attempt failed', async () => {
    const h = harness()
    const store = createExtensionPagesStore(h.deps)
    h.answer = { kind: 'error', message: 'offline' }
    h.connected = false
    const off = store.subscribe(() => {})
    await settle()
    assert.equal(h.fetches, 1)

    h.answer = { kind: 'pages', pages: [page('crm')] }
    h.connected = true
    h.pushConnection()
    await settle()
    assert.equal(h.fetches, 2, 'the failed attempt is retried the moment the socket is back')

    h.pushConnection()
    await settle()
    assert.equal(h.fetches, 2, 'a later state change with nothing broken costs nothing')
    off()
  })

  it('polls only while active and disconnected', async () => {
    const h = harness()
    const store = createExtensionPagesStore(h.deps)
    h.connected = true
    const off = store.subscribe(() => {})
    await settle()
    h.tickFallback()
    assert.equal(h.fetches, 1, 'a live socket needs no polling')

    h.connected = false
    h.pushConnection()
    h.tickFallback()
    assert.equal(h.fetches, 2)

    h.active = false
    h.pushActive()
    h.tickFallback()
    assert.equal(h.fetches, 2, 'a background frame does not poll')
    off()
  })

  it('both active-state sources firing at once still costs one refresh', async () => {
    const h = harness()
    const store = createExtensionPagesStore(h.deps)
    const off = store.subscribe(() => {})
    await settle()
    const before = h.fetches

    h.active = false
    h.pushActive()
    h.pushEvent()
    h.pushEvent()
    await settle()
    assert.equal(h.fetches, before, 'a background frame runs no handler')

    // `visibilitychange` and the tab frame's own flag are two independent
    // sources, and coming back to a tab fires both. Only the one that sees the
    // transition asks for the catch-up.
    h.active = true
    h.pushActive()
    h.pushActive()
    await settle()
    assert.equal(h.fetches, before + 1, 'two signals, three missed events, one fetch')
    off()
  })

  it('a reactivation with nothing missed does not re-fetch', async () => {
    const h = harness()
    const store = createExtensionPagesStore(h.deps)
    const off = store.subscribe(() => {})
    await settle()
    const before = h.fetches

    h.active = false
    h.pushActive()
    h.active = true
    h.pushActive()
    await settle()
    assert.equal(h.fetches, before, 'the socket stayed up and nothing arrived')
    off()
  })

  it('a socket that was closed in the background refetches on return', async () => {
    const h = harness()
    let gap = false
    const store = createExtensionPagesStore({ ...h.deps, hadSocketGap: () => gap })
    const off = store.subscribe(() => {})
    await settle()
    const before = h.fetches

    h.active = false
    h.pushActive()
    // No push event could have been missed: there was no socket to miss it on.
    gap = true
    h.active = true
    h.pushActive()
    await settle()
    assert.equal(h.fetches, before + 1)
    off()
  })

  it('hands React the same server snapshot every time', () => {
    const h = harness()
    const store = createExtensionPagesStore(h.deps)
    assert.equal(store.getServerSnapshot(), store.getServerSnapshot())
    assert.deepEqual(store.getServerSnapshot(), { pages: [], loaded: false })
  })
})
