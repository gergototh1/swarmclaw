import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { addressBarUpdate, isOwnFrameMessage, reconcileFrames, type MountedFrame } from './tab-frames'
import type { TabsState } from './tabs'

const ORIGIN = 'http://app.example'

function stateOf(urls: Record<string, string>, activeId: string): TabsState {
  const tabs = Object.entries(urls).map(([id, url]) => ({ id, url, title: null }))
  return { tabs, activeId, lastUsed: [activeId], closed: [] }
}

describe('reconcileFrames', () => {
  it('mounts a frame for the active tab from its URL', () => {
    const next = reconcileFrames([], stateOf({ a: '/tasks' }, 'a'))
    assert.deepEqual(next, [{ id: 'a', src: '/tasks', generation: 0 }])
  })

  it('returns the same array when nothing changed', () => {
    const current: MountedFrame[] = [{ id: 'a', src: '/tasks', generation: 2 }]
    assert.equal(reconcileFrames(current, stateOf({ a: '/other' }, 'a')), current)
  })

  it('drops the frame of a closed tab at once and keeps the others as they are', () => {
    const current: MountedFrame[] = [{ id: 'a', src: '/a', generation: 1 }, { id: 'b', src: '/b', generation: 0 }]
    assert.deepEqual(reconcileFrames(current, stateOf({ b: '/b' }, 'b')), [{ id: 'b', src: '/b', generation: 0 }])
  })

  it('leaves frames over the live cap for the flush-then-sleep effect', () => {
    const current: MountedFrame[] = Array.from({ length: 8 }, (_, i) => ({ id: `t${i}`, src: `/t${i}`, generation: 0 }))
    const urls = Object.fromEntries(current.map((f) => [f.id, f.src]))
    assert.equal(reconcileFrames(current, stateOf(urls, 't0')).length, 8)
  })
})

describe('isOwnFrameMessage', () => {
  const frameWindow = { name: 'frame a' }
  const otherWindow = { name: 'something else on this origin' }
  const frames = new Map([['a', { contentWindow: frameWindow }], ['b', { contentWindow: otherWindow }]])

  it('accepts a message from the app origin sent by the frame created for that tab', () => {
    assert.equal(isOwnFrameMessage({ origin: ORIGIN, source: frameWindow }, ORIGIN, 'a', frames), true)
  })

  it('refuses the right window on another origin (a frame that navigated away)', () => {
    assert.equal(isOwnFrameMessage({ origin: 'http://evil.example', source: frameWindow }, ORIGIN, 'a', frames), false)
  })

  it('refuses a same-origin window that is not that tab frame', () => {
    assert.equal(isOwnFrameMessage({ origin: ORIGIN, source: otherWindow }, ORIGIN, 'a', frames), false)
    assert.equal(isOwnFrameMessage({ origin: ORIGIN, source: null }, ORIGIN, 'a', frames), false)
  })

  it('refuses a frame that names another tab id than its own', () => {
    assert.equal(isOwnFrameMessage({ origin: ORIGIN, source: otherWindow }, ORIGIN, 'a', frames), false)
    assert.equal(isOwnFrameMessage({ origin: ORIGIN, source: frameWindow }, ORIGIN, 'b', frames), false)
  })

  it('refuses a tab id the host has no frame for, or a frame without a window yet', () => {
    assert.equal(isOwnFrameMessage({ origin: ORIGIN, source: frameWindow }, ORIGIN, 'missing', frames), false)
    const detached = new Map([['a', { contentWindow: null }]])
    assert.equal(isOwnFrameMessage({ origin: ORIGIN, source: null }, ORIGIN, 'a', detached), false)
  })
})

describe('addressBarUpdate', () => {
  it('names the active tab URL when the address bar shows something else', () => {
    assert.equal(addressBarUpdate(stateOf({ a: '/tasks' }, 'a'), '/home'), '/tasks')
  })

  it('is null when the address bar already shows it, or before the tabs load', () => {
    assert.equal(addressBarUpdate(stateOf({ a: '/tasks' }, 'a'), '/tasks'), null)
    assert.equal(addressBarUpdate(null, '/home'), null)
  })

  it('never hands replaceState a URL that fails the app-path gate', () => {
    for (const bad of ['/\\evil.example', '//evil.example', '/s/token', '/login']) {
      assert.equal(addressBarUpdate(stateOf({ a: bad }, 'a'), '/home'), null, bad)
    }
  })
})
