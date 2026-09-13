import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { appUrlFromHref, parseFrameMessage, parseHostMessage, parseTabCommand, tabCommandForKey } from './tab-protocol'

const key = (over: Partial<{ key: string; code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }>) => ({
  key: '', code: '', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...over,
})

describe('parseFrameMessage', () => {
  it('accepts a well-formed message', () => {
    const message = { source: 'sc-tab', type: 'location', tabId: 't1', url: '/tasks' }
    assert.deepEqual(parseFrameMessage(message), message)
  })

  it('rejects other sources, unknown types and foreign URLs', () => {
    assert.equal(parseFrameMessage({ source: 'other', type: 'ready', tabId: 't1' }), null)
    assert.equal(parseFrameMessage({ source: 'sc-tab', type: 'nope', tabId: 't1' }), null)
    assert.equal(parseFrameMessage({ source: 'sc-tab', type: 'location', tabId: 't1', url: '//evil.example/x' }), null)
    assert.equal(parseFrameMessage('ready'), null)
  })

  it('accepts a flush answer and an open-tab request', () => {
    assert.ok(parseFrameMessage({ source: 'sc-tab', type: 'flushed', tabId: 't1', requestId: 'r1', ok: false }))
    assert.ok(parseFrameMessage({ source: 'sc-tab', type: 'open-tab', tabId: 't1', url: '/x/docs/doc_1', activate: true }))
  })
})

describe('parseHostMessage and parseTabCommand', () => {
  it('accepts navigate and flush', () => {
    assert.ok(parseHostMessage({ source: 'sc-host', type: 'navigate', href: '/chat' }))
    assert.ok(parseHostMessage({ source: 'sc-host', type: 'flush', requestId: 'r1' }))
    assert.equal(parseHostMessage({ source: 'sc-host', type: 'navigate', href: 'https://evil.example' }), null)
  })

  it('validates goto positions', () => {
    assert.deepEqual(parseTabCommand({ kind: 'goto', position: 9 }), { kind: 'goto', position: 9 })
    assert.equal(parseTabCommand({ kind: 'goto', position: 10 }), null)
  })
})

describe('appUrlFromHref', () => {
  const origin = 'http://127.0.0.1:3456'

  it('keeps path, query and hash of a same-origin page', () => {
    assert.equal(appUrlFromHref('/x/docs?doc=1#h', origin), '/x/docs?doc=1#h')
    assert.equal(appUrlFromHref(`${origin}/tasks`, origin), '/tasks')
  })

  it('refuses other origins, API routes, assets and auth pages', () => {
    assert.equal(appUrlFromHref('https://example.com/tasks', origin), null)
    assert.equal(appUrlFromHref('/api/files/serve?x=1', origin), null)
    assert.equal(appUrlFromHref('/_next/static/a.js', origin), null)
    assert.equal(appUrlFromHref('/login', origin), null)
    assert.equal(appUrlFromHref('/setup', origin), null)
  })
})

describe('tabCommandForKey', () => {
  it('maps the browser layout on Option/Alt', () => {
    assert.deepEqual(tabCommandForKey(key({ code: 'KeyT', altKey: true }), 'browser'), { kind: 'new' })
    assert.deepEqual(tabCommandForKey(key({ code: 'KeyT', altKey: true, shiftKey: true }), 'browser'), { kind: 'reopen' })
    assert.deepEqual(tabCommandForKey(key({ code: 'KeyW', altKey: true }), 'browser'), { kind: 'close' })
    assert.deepEqual(tabCommandForKey(key({ key: 'ArrowRight', code: 'ArrowRight', altKey: true }), 'browser'), { kind: 'next' })
    assert.deepEqual(tabCommandForKey(key({ key: 'ArrowLeft', code: 'ArrowLeft', altKey: true }), 'browser'), { kind: 'previous' })
    assert.deepEqual(tabCommandForKey(key({ code: 'Digit3', altKey: true }), 'browser'), { kind: 'goto', position: 3 })
  })

  it('maps Cmd/Ctrl+K to the palette on both platforms', () => {
    assert.deepEqual(tabCommandForKey(key({ key: 'k', metaKey: true }), 'browser'), { kind: 'palette' })
    assert.deepEqual(tabCommandForKey(key({ key: 'K', ctrlKey: true }), 'desktop-app'), { kind: 'palette' })
  })

  it('leaves the tab keys to the menu in the desktop app', () => {
    assert.equal(tabCommandForKey(key({ code: 'KeyT', altKey: true }), 'desktop-app'), null)
  })

  it('ignores Option combined with Cmd or Ctrl, and plain typing', () => {
    assert.equal(tabCommandForKey(key({ code: 'KeyT', altKey: true, metaKey: true }), 'browser'), null)
    assert.equal(tabCommandForKey(key({ key: 't', code: 'KeyT' }), 'browser'), null)
  })
})
