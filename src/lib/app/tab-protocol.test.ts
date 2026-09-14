import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  appUrlFromHref, isEditableElementLike, isValidAppPath, parseFrameMessage, parseHostMessage, parseTabCommand, tabCommandForKey,
} from './tab-protocol'

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

  it('rejects a location url that uses the backslash-as-slash origin trick', () => {
    const message = { source: 'sc-tab', type: 'location', tabId: 't1', url: '/\\evil.example' }
    assert.equal(parseFrameMessage(message), null)
  })

  it('rejects a location url with a percent-encoded slash disguising /api/', () => {
    const message = { source: 'sc-tab', type: 'location', tabId: 't1', url: '/api%2ffiles/serve' }
    assert.equal(parseFrameMessage(message), null)
  })

  it('rejects a location url with a percent-encoded backslash', () => {
    const message = { source: 'sc-tab', type: 'location', tabId: 't1', url: '/api%5cfiles/serve' }
    assert.equal(parseFrameMessage(message), null)
  })

  it('rejects an encoded double-dot segment that would resolve into /api/ (the URL parser already collapses dot segments, changing the path, so the round-trip check refuses it)', () => {
    const message = { source: 'sc-tab', type: 'location', tabId: 't1', url: '/%2e%2e/api/files' }
    assert.equal(parseFrameMessage(message), null)
  })

  it('does not decode a percent-encoded letter, so /%61pi/ is not treated as an API path', () => {
    // Decision: only backslash and encoded slash/backslash (which can disguise a
    // path-segment boundary) are blocked. Decoding every percent-escape to catch
    // "api" spelled as "%61pi" would require full, general percent-decoding of
    // the path, which is a much larger and riskier normalization step than this
    // fix calls for -- so this string is accepted, not rejected.
    const message = { source: 'sc-tab', type: 'location', tabId: 't1', url: '/%61pi/files' }
    assert.ok(parseFrameMessage(message))
  })

  it('rejects a location url that is an auth page with one trailing slash', () => {
    assert.equal(parseFrameMessage({ source: 'sc-tab', type: 'location', tabId: 't1', url: '/setup/' }), null)
    assert.equal(parseFrameMessage({ source: 'sc-tab', type: 'location', tabId: 't1', url: '/login/?next=%2Fhome' }), null)
  })

  it('accepts a valid url with a query and a hash unchanged', () => {
    const message = { source: 'sc-tab', type: 'location', tabId: 't1', url: '/tasks?a=1#frag' }
    assert.deepEqual(parseFrameMessage(message), message)
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

  it('rejects navigate to the backslash-as-slash origin trick', () => {
    assert.equal(parseHostMessage({ source: 'sc-host', type: 'navigate', href: '/\\evil.example' }), null)
  })

  it('accepts a navigate that carries a panel intent, and only a known one', () => {
    for (const panel of ['toggle', 'open', 'close']) {
      const message = { source: 'sc-host', type: 'navigate', href: '/tasks', panel }
      assert.deepEqual(parseHostMessage(message), message)
    }
    assert.equal(parseHostMessage({ source: 'sc-host', type: 'navigate', href: '/tasks', panel: 'flip' }), null)
    assert.equal(parseHostMessage({ source: 'sc-host', type: 'navigate', href: '/tasks', panel: true }), null)
  })

  it('refuses a navigate or an open-tab to a share page', () => {
    assert.equal(parseHostMessage({ source: 'sc-host', type: 'navigate', href: '/s/token' }), null)
    assert.equal(parseFrameMessage({ source: 'sc-tab', type: 'open-tab', tabId: 't1', url: '/s/token', activate: true }), null)
  })

  it('accepts navigate to a valid url with a query and a hash unchanged', () => {
    const message = { source: 'sc-host', type: 'navigate', href: '/chat?a=1#frag' }
    assert.deepEqual(parseHostMessage(message), message)
  })

  it('accepts an active message and rejects a malformed one', () => {
    assert.deepEqual(parseHostMessage({ source: 'sc-host', type: 'active', active: false }), { source: 'sc-host', type: 'active', active: false })
    assert.equal(parseHostMessage({ source: 'sc-host', type: 'active' }), null)
    assert.equal(parseHostMessage({ source: 'sc-host', type: 'active', active: 'yes' }), null)
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

  it('refuses an auth page reached with one trailing slash', () => {
    assert.equal(appUrlFromHref('/login/', origin), null)
    assert.equal(appUrlFromHref('/setup/', origin), null)
    assert.equal(appUrlFromHref('/user/', origin), null)
  })

  it('does not treat a path that only starts with an auth page name as one', () => {
    assert.equal(appUrlFromHref('/login-help', origin), '/login-help')
    assert.equal(appUrlFromHref('/user/settings', origin), '/user/settings')
  })

  it('refuses the backslash-as-slash origin trick', () => {
    assert.equal(appUrlFromHref('/\\evil.example', origin), null)
  })

  it('refuses a percent-encoded slash disguising /api/', () => {
    assert.equal(appUrlFromHref('/api%2ffiles/serve', origin), null)
  })

  it('refuses a percent-encoded backslash disguising /api/', () => {
    assert.equal(appUrlFromHref('/api%5cfiles/serve', origin), null)
  })

  it('refuses an encoded double-dot segment that would resolve into /api/', () => {
    assert.equal(appUrlFromHref('/%2e%2e/api/files', origin), null)
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

  it('in an editable target, takes only Cmd/Ctrl+K -- every Option command becomes null', () => {
    assert.equal(tabCommandForKey(key({ code: 'KeyT', altKey: true }), 'browser', { editable: true }), null)
    assert.equal(tabCommandForKey(key({ code: 'KeyW', altKey: true }), 'browser', { editable: true }), null)
    assert.equal(tabCommandForKey(key({ key: 'ArrowLeft', code: 'ArrowLeft', altKey: true }), 'browser', { editable: true }), null)
    assert.equal(tabCommandForKey(key({ code: 'Digit3', altKey: true }), 'browser', { editable: true }), null)
    assert.deepEqual(tabCommandForKey(key({ key: 'k', metaKey: true }), 'browser', { editable: true }), { kind: 'palette' })
  })
})

describe('isEditableElementLike', () => {
  it('is true for a textarea, a select and a contentEditable element', () => {
    assert.equal(isEditableElementLike({ tagName: 'TEXTAREA' }), true)
    assert.equal(isEditableElementLike({ tagName: 'SELECT' }), true)
    assert.equal(isEditableElementLike({ tagName: 'DIV', isContentEditable: true }), true)
  })

  it('is true for a text input, and for an input with no type (defaults to text)', () => {
    assert.equal(isEditableElementLike({ tagName: 'INPUT', type: 'text' }), true)
    assert.equal(isEditableElementLike({ tagName: 'INPUT' }), true)
  })

  it('is false for an input type that takes no text, and for a plain div', () => {
    for (const type of ['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit']) {
      assert.equal(isEditableElementLike({ tagName: 'INPUT', type }), false)
    }
    assert.equal(isEditableElementLike({ tagName: 'DIV' }), false)
  })

  it('is false for null', () => {
    assert.equal(isEditableElementLike(null), false)
  })
})

describe('isValidAppPath', () => {
  it('accepts canonical app paths', () => {
    assert.equal(isValidAppPath('/tasks'), true)
    assert.equal(isValidAppPath('/x/docs/doc_1?a=1#h'), true)
    assert.equal(isValidAppPath('/skills'), true)
    assert.equal(isValidAppPath('/settings'), true)
  })

  it('refuses share pages, auth pages, API routes and anything off-origin or non-canonical', () => {
    for (const bad of ['/s/token', '/login', '/api/x', '/_next/a.js', '/\\evil.example', '//evil.example', 'https://evil.example', '/a/../api/x', 'tasks', '']) {
      assert.equal(isValidAppPath(bad), false, bad)
    }
  })

  it('refuses a share link through appUrlFromHref as well', () => {
    assert.equal(appUrlFromHref('/s/token', 'http://app.example'), null)
    assert.equal(appUrlFromHref('http://app.example/s/token?x=1', 'http://app.example'), null)
  })
})
