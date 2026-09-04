import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { runWithTempDataDir } from '@/lib/server/test-utils/run-with-temp-data-dir'

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
  circular: RpcCall
}

// One child process exercises every case; the assertions below read its report.
const result = runWithTempDataDir<RpcRouteResult>(`
  const extensionsMod = await import('@/lib/server/extensions')
  const { getExtensionManager } = extensionsMod.default || extensionsMod
  const routeMod = await import('@/app/api/extensions/[id]/call/[method]/route')
  const { POST } = routeMod.default || routeMod

  const manager = getExtensionManager()
  await manager.saveExtensionSource('rpc_a.mjs', 'export default { name: "R", rpc: { echo: (b) => ({ got: b }), later: async (b) => ({ awaited: b.n }), boom: () => { throw new Error("kaboom") }, silent: () => undefined, circular: () => { const o = {}; o.self = o; return o } } }')
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
    circular: await call('circular', '{}'),
  }))
`)

const parse = (call: RpcCall): unknown => JSON.parse(call.body)

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
    })
    assert.equal(result.unknownExtension.status, 404)
    // A disabled extension is indistinguishable from one that was never installed:
    // the route must not become a probe for what is installed but switched off.
    assert.equal(result.disabled.status, 404)
    assert.deepEqual(parse(result.disabled), {
      error: { code: 'not_found', message: 'no rpc method "echo" on extension "rpc_off.mjs"' },
    })
  })

  it('returns 400 when the body is not a JSON object', () => {
    assert.equal(result.notJson.status, 400)
    assert.equal((parse(result.notJson) as { error: { code: string } }).error.code, 'bad_request')
    // A JSON array parses, so only the object check refuses it. Handlers are typed
    // `(body: Record<string, unknown>)` and would otherwise be handed an array.
    assert.equal(result.arrayBody.status, 400)
    assert.deepEqual(parse(result.arrayBody), {
      error: { code: 'bad_request', message: 'body must be a JSON object' },
    })
  })

  it('turns a throwing handler into a 500 that keeps its message', () => {
    assert.equal(result.boom.status, 500)
    assert.deepEqual(parse(result.boom), { error: { code: 'internal', message: 'kaboom' } })
  })

  it('answers a handler that returns undefined with an empty object', () => {
    // The browser caller reads the parsed JSON directly, so an empty 200 body
    // would make it throw on parse instead of resolving to "nothing to report".
    assert.equal(result.silent.status, 200)
    assert.deepEqual(parse(result.silent), {})
  })

  it('turns an unserialisable result into a 500 rather than a crashed route', () => {
    assert.equal(result.circular.status, 500)
    const body = parse(result.circular) as { error: { code: string; message: string } }
    assert.equal(body.error.code, 'internal')
    assert.match(body.error.message, /circular/i)
  })
})
