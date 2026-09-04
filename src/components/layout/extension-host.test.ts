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
