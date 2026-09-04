import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { runWithTempDataDir } from '@/lib/server/test-utils/run-with-temp-data-dir'
import { api } from '@/lib/app/api-client'

interface RpcCall {
  status: number
  type: string | null
  body: string
}

interface RpcRouteResult {
  echo: RpcCall
  awaited: RpcCall
  emptyBody: RpcCall
  unknownMethod: RpcCall
  unknownExtension: RpcCall
  disabled: RpcCall
  notJson: RpcCall
  arrayBody: RpcCall
  boom: RpcCall
  silent: RpcCall
  nullResult: RpcCall
  htmlFragment: RpcCall
  circular: RpcCall
  inheritedConstructor: RpcCall
  inheritedToString: RpcCall
  inheritedHasOwnProperty: RpcCall
  inheritedValueOf: RpcCall
  constructorOnMissing: RpcCall
}

// One child process exercises every case; the assertions below read its report.
const result = runWithTempDataDir<RpcRouteResult>(`
  const extensionsMod = await import('@/lib/server/extensions')
  const { getExtensionManager } = extensionsMod.default || extensionsMod
  const routeMod = await import('@/app/api/extensions/[id]/call/[method]/route')
  const { POST } = routeMod.default || routeMod

  const manager = getExtensionManager()
  await manager.saveExtensionSource('rpc_a.mjs', 'export default { name: "R", rpc: { echo: (b) => ({ got: b }), later: async (b) => ({ awaited: b.n }), boom: () => { throw new Error("kaboom") }, silent: () => undefined, nothing: () => null, fragment: () => "<p>hi</p>", circular: () => { const o = {}; o.self = o; return o } } }')
  await manager.saveExtensionSource('rpc_off.mjs', 'export default { name: "Off", rpc: { echo: (b) => ({ got: b }) } }')
  manager.setEnabled('rpc_off.mjs', false)
  manager.reload()

  // \`raw\` is the exact request body; \`undefined\` sends no body at all.
  const call = async (method, raw, id = 'rpc_a.mjs') => {
    const init = { method: 'POST', headers: { 'content-type': 'application/json' } }
    if (raw !== undefined) init.body = raw
    const res = await POST(new Request('http://local/api', init), { params: Promise.resolve({ id, method }) })
    return { status: res.status, type: res.headers.get('content-type'), body: await res.text() }
  }

  console.log(JSON.stringify({
    echo: await call('echo', JSON.stringify({ a: 1 })),
    awaited: await call('later', JSON.stringify({ n: 7 })),
    emptyBody: await call('echo', undefined),
    unknownMethod: await call('nope', '{}'),
    unknownExtension: await call('echo', '{}', 'rpc_missing.mjs'),
    disabled: await call('echo', '{}', 'rpc_off.mjs'),
    notJson: await call('echo', 'not json at all'),
    arrayBody: await call('echo', '[1,2]'),
    boom: await call('boom', '{}'),
    silent: await call('silent', '{}'),
    nullResult: await call('nothing', '{}'),
    htmlFragment: await call('fragment', '{}'),
    circular: await call('circular', '{}'),
    inheritedConstructor: await call('constructor', JSON.stringify({ a: 1 })),
    inheritedToString: await call('toString', '{}'),
    inheritedHasOwnProperty: await call('hasOwnProperty', '{}'),
    inheritedValueOf: await call('valueOf', '{}'),
    constructorOnMissing: await call('constructor', JSON.stringify({ a: 1 }), 'rpc_missing.mjs'),
  }))
`)

const parse = (call: RpcCall): unknown => JSON.parse(call.body)

const originalFetch = global.fetch

/**
 * Replay one recorded route response through the real browser client.
 *
 * `callExtensionMethod` in `src/components/layout/extension-host.tsx` goes
 * through `api()`, and `api()` decides what an extension author's `catch` sees.
 * Asserting the payload shape alone would not prove the message survives that
 * hop, so these cases stub `fetch` and read the thrown message back out.
 */
async function browserErrorFor(call: RpcCall): Promise<string> {
  global.fetch = (async () =>
    new Response(call.body, {
      status: call.status,
      headers: call.type ? { 'content-type': call.type } : {},
    })) as unknown as typeof fetch
  try {
    await api('POST', '/extensions/rpc_a.mjs/call/boom', {})
    return '<no error thrown>'
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  } finally {
    global.fetch = originalFetch
  }
}

describe('extension rpc route', () => {
  it("returns the handler's value as JSON", () => {
    assert.equal(result.echo.status, 200)
    assert.match(result.echo.type || '', /application\/json/)
    assert.deepEqual(parse(result.echo), { got: { a: 1 } })
  })

  it('awaits a handler that returns a promise', () => {
    assert.equal(result.awaited.status, 200)
    assert.deepEqual(parse(result.awaited), { awaited: 7 })
  })

  it('treats an absent body as an empty object', () => {
    assert.equal(result.emptyBody.status, 200)
    assert.deepEqual(parse(result.emptyBody), { got: {} })
  })

  it('returns 404 for an unknown method, an unknown extension and a disabled one', () => {
    assert.equal(result.unknownMethod.status, 404)
    assert.deepEqual(parse(result.unknownMethod), {
      error: { code: 'not_found', message: 'no rpc method "nope" on extension "rpc_a.mjs"' },
      message: 'no rpc method "nope" on extension "rpc_a.mjs"',
    })
    assert.equal(result.unknownExtension.status, 404)
    // A disabled extension is indistinguishable from one that was never installed:
    // the route must not become a probe for what is installed but switched off.
    assert.equal(result.disabled.status, 404)
    assert.deepEqual(parse(result.disabled), {
      error: { code: 'not_found', message: 'no rpc method "echo" on extension "rpc_off.mjs"' },
      message: 'no rpc method "echo" on extension "rpc_off.mjs"',
    })
  })

  it('does not treat an inherited Object.prototype name as a callable method', () => {
    // `rpc` is a plain object literal, so `rpc.constructor`, `rpc.toString`,
    // `rpc.hasOwnProperty` and `rpc.valueOf` all resolve up the prototype chain
    // and are all functions. Only own properties are callable methods.
    assert.equal(result.inheritedConstructor.status, 404)
    assert.deepEqual(parse(result.inheritedConstructor), {
      error: { code: 'not_found', message: 'no rpc method "constructor" on extension "rpc_a.mjs"' },
      message: 'no rpc method "constructor" on extension "rpc_a.mjs"',
    })
    assert.equal(result.inheritedToString.status, 404)
    assert.equal(result.inheritedHasOwnProperty.status, 404)
    assert.equal(result.inheritedValueOf.status, 404)
  })

  it('answers an inherited name the same way whether or not the extension exists', () => {
    // The route's promise that a caller cannot tell an installed extension from
    // one that was never installed only holds if every name answers alike. A
    // prototype name that reached the handler would answer 200 for an installed
    // extension and 404 for a missing one, which is exactly that probe.
    assert.equal(result.constructorOnMissing.status, result.inheritedConstructor.status)
    assert.equal(
      result.constructorOnMissing.body.replace(/rpc_missing\.mjs/g, 'rpc_a.mjs'),
      result.inheritedConstructor.body,
    )
  })

  it('returns 400 when the body is not a JSON object', () => {
    assert.equal(result.notJson.status, 400)
    assert.equal((parse(result.notJson) as { error: { code: string } }).error.code, 'bad_request')
    // A JSON array parses, so only the object check refuses it. Handlers are typed
    // `(body: Record<string, unknown>)` and would otherwise be handed an array.
    assert.equal(result.arrayBody.status, 400)
    assert.deepEqual(parse(result.arrayBody), {
      error: { code: 'bad_request', message: 'body must be a JSON object' },
      message: 'body must be a JSON object',
    })
  })

  it('turns a throwing handler into a 500 that keeps its message', () => {
    assert.equal(result.boom.status, 500)
    assert.deepEqual(parse(result.boom), {
      error: { code: 'internal', message: 'kaboom' },
      message: 'kaboom',
    })
  })

  it('answers a handler that returns undefined with an empty object', () => {
    // The browser caller reads the parsed JSON directly, so an empty 200 body
    // would make it throw on parse instead of resolving to "nothing to report".
    assert.equal(result.silent.status, 200)
    assert.deepEqual(parse(result.silent), {})
  })

  it('round-trips a deliberate null return', () => {
    // `null` is a value a handler can mean ("looked, found nothing"), and JSON
    // carries it. Only `undefined`, which JSON cannot carry, becomes `{}`.
    assert.equal(result.nullResult.status, 200)
    assert.equal(result.nullResult.body, 'null')
  })

  it('returns an HTML fragment as the handler wrote it', () => {
    // The response is `application/json`, so the fragment arrives as a JSON
    // string. The browser caller must not mistake it for an error page.
    assert.equal(result.htmlFragment.status, 200)
    assert.match(result.htmlFragment.type || '', /application\/json/)
    assert.equal(parse(result.htmlFragment), '<p>hi</p>')
  })

  it('turns an unserialisable result into a 500 rather than a crashed route', () => {
    assert.equal(result.circular.status, 500)
    const body = parse(result.circular) as { error: { code: string; message: string } }
    assert.equal(body.error.code, 'internal')
    assert.match(body.error.message, /circular/i)
  })
})

describe('extension rpc failures as the browser caller sees them', () => {
  it("surfaces a throwing handler's own message", async () => {
    assert.equal(await browserErrorFor(result.boom), 'kaboom')
  })

  it('surfaces which method was not found', async () => {
    assert.equal(await browserErrorFor(result.unknownMethod), 'no rpc method "nope" on extension "rpc_a.mjs"')
    assert.equal(
      await browserErrorFor(result.unknownExtension),
      'no rpc method "echo" on extension "rpc_missing.mjs"',
    )
    assert.equal(await browserErrorFor(result.disabled), 'no rpc method "echo" on extension "rpc_off.mjs"')
  })

  it('surfaces why a body was refused', async () => {
    assert.equal(await browserErrorFor(result.arrayBody), 'body must be a JSON object')
  })

  it('surfaces why a result could not be serialised', async () => {
    assert.match(await browserErrorFor(result.circular), /circular/i)
  })
})
