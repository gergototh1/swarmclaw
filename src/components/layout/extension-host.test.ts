import assert from 'node:assert/strict'
import { test } from 'node:test'

// `getHostRegistry` (and the module-level install it triggers on import) is
// browser-only: `typeof window === 'undefined'` throws. Stubbing `window` and
// `document` before the import — rather than reaching for a DOM harness — is
// enough, because nothing this function touches needs a real document: `api()`
// only reads `window.localStorage` (absent here, so it is treated as unset)
// and dispatches an event the assertions below never trigger.
;(globalThis as unknown as { window: unknown }).window = globalThis
;(globalThis as unknown as { document: unknown }).document = { currentScript: null }

const originalFetch = globalThis.fetch

function stubFetch(status: number, contentType: string, body: string): void {
  globalThis.fetch = (async () =>
    new Response(body, { status, headers: { 'content-type': contentType } })) as unknown as typeof fetch
}

test.afterEach(() => {
  globalThis.fetch = originalFetch
})

test("a handler's own error message reaches the caller", async () => {
  const { getHostRegistry } = await import('./extension-host')
  const host = getHostRegistry()

  stubFetch(
    500,
    'application/json',
    JSON.stringify({ error: { code: 'internal', message: 'kaboom' }, message: 'kaboom' }),
  )

  await assert.rejects(host.rpc('some-extension', 'boom', {}), /^Error: kaboom$/)
})

test('an HTML fragment comes back as the handler value, not as "unavailable"', async () => {
  const { getHostRegistry } = await import('./extension-host')
  const host = getHostRegistry()

  // The real route always answers `application/json`, so a fragment a handler
  // returns arrives as a JSON-encoded string, not as a raw `text/html` body.
  stubFetch(200, 'application/json', JSON.stringify('<p>hi</p>'))

  const result = await host.rpc('some-extension', 'renderPreview', {})
  assert.equal(result, '<p>hi</p>')
})

test('a 200 text/html document is rejected as endpoint-unavailable', async () => {
  const { getHostRegistry } = await import('./extension-host')
  const host = getHostRegistry()

  // What an interstitial in front of the app answers: an ngrok warning page, a
  // captive portal, an SPA rewrite. `api()` resolves a 200 non-JSON response
  // with the raw body, so without the success-path guard this would resolve as
  // though the document text were the handler's own return value.
  stubFetch(200, 'text/html', '<!doctype html><html><body>proxy</body></html>')

  await assert.rejects(host.rpc('some-extension', 'renderPreview', {}), /endpoint is not available/i)
})

test('tabs.onFlushRequest registers a handler that runTabFlushHandlers actually runs, and its unsubscribe removes it', async () => {
  const { getHostRegistry } = await import('./extension-host')
  const { runTabFlushHandlers } = await import('@/lib/app/tab-flush')
  const host = getHostRegistry()

  const off = host.tabs.onFlushRequest(async () => false)
  try {
    // A handler resolving false makes the flush answer false.
    assert.equal(await runTabFlushHandlers(), false)
  } finally {
    off()
  }
  // Unsubscribed: with no handlers left, the flush answers true again.
  assert.equal(await runTabFlushHandlers(), true)
})

test("tabs.openInNewTab is tab-frame-bridge's openAppUrlInNewTab: false outside a tab", async () => {
  const { getHostRegistry } = await import('./extension-host')
  const host = getHostRegistry()

  // `openAppUrlInNewTab` reads `window.location.origin`, which the module-level
  // stub above never sets. Add it here, scoped to this test, and restore
  // whatever was there afterwards. `window.parent`/`window.self` are both
  // `undefined` on a plain Node global, so `tabIdFromWindow` already reports
  // "not a tab" without any further stubbing.
  const win = window as unknown as { location?: { origin: string } }
  const hadLocation = 'location' in win
  const originalLocation = win.location
  win.location = { origin: 'http://localhost:3456' }
  try {
    assert.equal(host.tabs.openInNewTab('/x/docs/some-doc'), false)
  } finally {
    if (hadLocation) win.location = originalLocation
    else delete win.location
  }
})

test('getHostRegistry backfills tabs onto an existing window.swarmclaw that lacks it, keeping the same object', async () => {
  const { getHostRegistry } = await import('./extension-host')
  const existing = getHostRegistry()

  // Simulate HMR from an older host build: `window.swarmclaw` is already
  // installed, but predates the `tabs` field.
  delete (existing as unknown as { tabs?: unknown }).tabs
  assert.equal((window as unknown as { swarmclaw?: { tabs?: unknown } }).swarmclaw?.tabs, undefined)

  const backfilled = getHostRegistry()
  assert.equal(backfilled, existing, 'the existing object is kept, not replaced')
  assert.equal(typeof backfilled.tabs.onFlushRequest, 'function')
  assert.equal(typeof backfilled.tabs.openInNewTab, 'function')
})
