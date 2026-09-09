import test from 'node:test'
import assert from 'node:assert/strict'
import { focusedSnapshot, subscribe, getServerSnapshot } from './use-window-focused'

test('document nelkul (SSR) true', () => {
  const g = globalThis as { document?: unknown }
  const saved = g.document
  delete g.document
  try {
    assert.equal(focusedSnapshot(), true)
  } finally {
    if (saved !== undefined) g.document = saved
  }
})

test('document.hasFocus() eredmenyet adja vissza', () => {
  const g = globalThis as { document?: unknown }
  const saved = g.document
  g.document = { hasFocus: () => false }
  try {
    assert.equal(focusedSnapshot(), false)
    g.document = { hasFocus: () => true }
    assert.equal(focusedSnapshot(), true)
  } finally {
    if (saved === undefined) delete g.document
    else g.document = saved
  }
})

test('subscribe: registers both focus and blur listeners', () => {
  const g = globalThis as { window?: unknown }
  const savedWindow = g.window

  const listeners: { event: string; callback: () => void }[] = []
  const fakeWindow = {
    addEventListener(event: string, cb: () => void) {
      listeners.push({ event, callback: cb })
    },
    removeEventListener(_event: string, _cb: () => void) {
      // stub
    },
  }

  g.window = fakeWindow
  try {
    const callback = () => {}
    subscribe(callback)

    assert.equal(listeners.length, 2, 'should register exactly 2 listeners')
    const eventNames = listeners.map((l) => l.event).sort()
    assert.deepEqual(eventNames, ['blur', 'focus'], 'should register blur and focus events')
    assert.equal(listeners[0].callback, callback, 'first listener should use the same callback')
    assert.equal(listeners[1].callback, callback, 'second listener should use the same callback')
  } finally {
    if (savedWindow === undefined) delete g.window
    else g.window = savedWindow
  }
})

test('subscribe: dispatching focus and blur events calls the callback', () => {
  const g = globalThis as { window?: unknown }
  const savedWindow = g.window

  const callbacks: Map<string, () => void> = new Map()
  const fakeWindow = {
    addEventListener(event: string, cb: () => void) {
      callbacks.set(event, cb)
    },
    removeEventListener(_event: string, _cb: () => void) {
      // stub
    },
  }

  g.window = fakeWindow
  try {
    let callCount = 0
    const callback = () => {
      callCount++
    }
    subscribe(callback)

    // Dispatch focus event
    const focusCb = callbacks.get('focus')
    assert(focusCb, 'focus listener should be registered')
    focusCb()
    assert.equal(callCount, 1, 'callback should be called once after focus event')

    // Dispatch blur event
    const blurCb = callbacks.get('blur')
    assert(blurCb, 'blur listener should be registered')
    blurCb()
    assert.equal(callCount, 2, 'callback should be called twice after blur event')
  } finally {
    if (savedWindow === undefined) delete g.window
    else g.window = savedWindow
  }
})

test('subscribe: cleanup removes both listeners with correct callback reference', () => {
  const g = globalThis as { window?: unknown }
  const savedWindow = g.window

  const addedListeners: { event: string; callback: () => void }[] = []
  const removedListeners: { event: string; callback: () => void }[] = []

  const fakeWindow = {
    addEventListener(event: string, cb: () => void) {
      addedListeners.push({ event, callback: cb })
    },
    removeEventListener(event: string, cb: () => void) {
      removedListeners.push({ event, callback: cb })
    },
  }

  g.window = fakeWindow
  try {
    const callback = () => {}
    const cleanup = subscribe(callback)

    // Verify listeners were added
    assert.equal(addedListeners.length, 2, 'should add 2 listeners')

    // Call cleanup
    cleanup()

    // Verify listeners were removed with the same callback reference
    assert.equal(removedListeners.length, 2, 'cleanup should remove both listeners')
    const removedEventNames = removedListeners.map((l) => l.event).sort()
    assert.deepEqual(removedEventNames, ['blur', 'focus'], 'should remove blur and focus events')
    assert.equal(removedListeners[0].callback, callback, 'removed listener should use the same callback reference')
    assert.equal(removedListeners[1].callback, callback, 'removed listener should use the same callback reference')

    // Verify the removed listeners match the added ones
    const addedSet = new Set(addedListeners.map((l) => `${l.event}:${l.callback.toString()}`))
    const removedSet = new Set(removedListeners.map((l) => `${l.event}:${l.callback.toString()}`))
    assert.equal(addedSet.size, removedSet.size, 'all added listeners should be removed')
  } finally {
    if (savedWindow === undefined) delete g.window
    else g.window = savedWindow
  }
})

test('getServerSnapshot returns true', () => {
  assert.equal(getServerSnapshot(), true)
})
