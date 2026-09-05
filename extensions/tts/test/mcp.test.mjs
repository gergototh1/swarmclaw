import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * The shim is started with `process.execPath` and no loader: that is the
 * runtime it ships on, the host's MCP client spawning plain `node` in a
 * workspace with no node_modules. Every host here is a local `http` server
 * on 127.0.0.1 that the test itself started; nothing leaves the machine.
 *
 * A "swarmclaw" host answers `/api/healthz` with `service: "swarmclaw"`, as
 * the real route does, so the shim's identity check passes and the rpc
 * mapping is what gets exercised. The port file written for it carries the
 * test's own pid and a `startedAt` of now, which is what a live server's
 * file looks like; each of the three checks then gets a test that fails it
 * alone.
 */
const SHIM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'mcp', 'server.mjs')
const SWARMCLAW_HEALTHZ = { status: 200, json: { ok: true, service: 'swarmclaw', time: 1 } }

/**
 * `handler` gets `{ url, method, key, body }` and returns `{ status, json }`
 * or `{ status, text }`; `seen` records every request. A handler that
 * leaves `/api/healthz` alone gets the SwarmClaw answer for it.
 */
function fakeHost(handler, { healthz = SWARMCLAW_HEALTHZ } = {}) {
  const seen = []
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = ''
      req.on('data', (c) => { raw += c })
      req.on('end', () => {
        const body = raw ? JSON.parse(raw) : undefined
        const key = req.headers['x-access-key']
        seen.push({ url: req.url, method: req.method, key, body })
        const out = req.url === '/api/healthz' && healthz ? healthz : handler({ url: req.url, method: req.method, key, body })
        if (out.hang) return
        if ('text' in out) {
          res.writeHead(out.status, { 'content-type': 'text/plain' })
          res.end(out.text)
          return
        }
        res.writeHead(out.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(out.json))
      })
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, seen, close: () => new Promise((r) => server.close(r)) }))
  })
}

/** A port nothing listens on: bound once by the OS, released before the test uses it. */
function closedPort() {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })
}

function startShim(env) {
  const child = spawn(process.execPath, [SHIM], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'inherit'] })
  const lines = readline.createInterface({ input: child.stdout })
  const pending = new Map()
  const unmatched = []
  lines.on('line', (line) => {
    const msg = JSON.parse(line)
    const p = msg.id !== undefined && msg.id !== null ? pending.get(msg.id) : undefined
    if (p) { pending.delete(msg.id); p(msg) } else unmatched.push(msg)
  })
  let next = 1
  const send = (msg) => { child.stdin.write(`${JSON.stringify(msg)}\n`) }
  const call = (method, params) => new Promise((resolve) => { const id = next++; pending.set(id, resolve); send({ jsonrpc: '2.0', id, method, params }) })
  const raw = (text) => { child.stdin.write(`${text}\n`) }
  const stop = () => new Promise((resolve) => { child.once('exit', resolve); child.stdin.end() })
  return { child, call, send, raw, stop, unmatched }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-mcp-'))
let fileNo = 0
/** A fresh port file per call, so tests that run concurrently never share one. */
function writePort(content) {
  fileNo += 1
  const file = path.join(tmp, `run-${fileNo}`, 'port.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof content === 'string' ? content : `${JSON.stringify(content)}\n`)
  return file
}
const liveFile = (port, extra = {}) => writePort({ port, wsPort: port + 1, pid: process.pid, startedAt: Date.now(), ...extra })

async function statusCall(shim) {
  const r = await shim.call('tools/call', { name: 'tts_status', arguments: {} })
  return { isError: r.result.isError, value: JSON.parse(r.result.content[0].text) }
}

// --- protocol ---

test('the shim speaks initialize, tools/list and tools/call, and forwards to the host with the key', async () => {
  const host = await fakeHost(({ url }) => {
    if (url.endsWith('/call/status')) return { status: 200, json: { kulcsBeallitva: true, vegpontBeallitva: true, maiMasodperc: 3, napiKeret: 900, hang: 'Kenji', modell: 'tts-rt-v1', nyelv: 'hu' } }
    if (url.endsWith('/call/synthesize')) return { status: 200, json: { error: { code: 'tts_keret_kimerult', message: 'ma elfogyott', maiMasodperc: 900, napiKeret: 900 } } }
    return { status: 404, json: { error: { code: 'not_found', message: 'no' } } }
  })
  const shim = startShim({ SWARMCLAW_PORT_FILE: liveFile(host.port), SWARMCLAW_ACCESS_KEY: 'secret-1' })
  try {
    const init = await shim.call('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } })
    assert.equal(init.result.protocolVersion, '2024-11-05')
    assert.deepEqual(init.result.capabilities, { tools: {} })
    shim.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    const list = await shim.call('tools/list', {})
    assert.deepEqual(list.result.tools.map((t) => t.name), ['tts_synthesize', 'tts_status'])
    assert.deepEqual(list.result.tools[0].inputSchema.required, ['szoveg', 'celFajl'])
    const status = await statusCall(shim)
    assert.equal(status.isError, false)
    assert.equal(status.value.hang, 'Kenji')
    const synth = await shim.call('tools/call', { name: 'tts_synthesize', arguments: { szoveg: 'Szia.', celFajl: '/abs/a.mp3' } })
    assert.equal(synth.result.isError, true)
    assert.deepEqual(JSON.parse(synth.result.content[0].text).error.code, 'tts_keret_kimerult')
    const rpc = host.seen.filter((r) => r.url !== '/api/healthz')
    assert.deepEqual(rpc.map((r) => [r.method, r.url, r.key]), [
      ['POST', '/api/extensions/tts.mjs/call/status', 'secret-1'],
      ['POST', '/api/extensions/tts.mjs/call/synthesize', 'secret-1'],
    ])
    assert.deepEqual(rpc[0].body, {})
    assert.deepEqual(rpc[1].body, { szoveg: 'Szia.', celFajl: '/abs/a.mp3' })
    assert.equal(host.seen.filter((r) => r.url === '/api/healthz').length, 2, 'every tool call re-runs the identity check')
    assert.equal(host.seen.some((r) => r.url === '/api/healthz' && r.key !== undefined), false, 'the key is never sent to healthz')
    assert.equal((await shim.call('ping', {})).result !== undefined, true)
    assert.deepEqual(shim.unmatched, [], 'the initialized notification got no reply')
  } finally { await shim.stop(); await host.close() }
})

test('an unknown tool, a non-object argument set, an unknown method, a bad request and a parse error are each refused by their JSON-RPC code', async () => {
  const shim = startShim({ SWARMCLAW_PORT_FILE: '', SWARMCLAW_ACCESS_KEY: '' })
  try {
    const unknown = await shim.call('tools/call', { name: 'nope', arguments: {} })
    assert.equal(unknown.error.code, -32602)
    assert.match(unknown.error.message, /nope/)
    const odd = await shim.call('tools/call', { name: 'rm -rf /; $(x)', arguments: {} })
    assert.equal(odd.error.code, -32602)
    assert.equal(odd.error.message.includes('rm'), false, 'a tool name that is not an identifier is not repeated')
    const badArgs = await shim.call('tools/call', { name: 'tts_status', arguments: ['x'] })
    assert.equal(badArgs.error.code, -32602)
    const noName = await shim.call('tools/call', {})
    assert.equal(noName.error.code, -32602)
    const method = await shim.call('resources/list', {})
    assert.equal(method.error.code, -32601)
    shim.raw('{"id": 77, "method": "ping"}')
    shim.raw('[1,2]')
    shim.raw('{not json')
    const pong = await shim.call('ping', {})
    assert.deepEqual(pong.result, {})
    // Replies may land in any order: a parse error is answered on the spot,
    // the rest after the handler's turn. JSON-RPC promises no order.
    const codes = shim.unmatched.map((m) => [m.id, m.error && m.error.code]).sort((a, b) => String(a).localeCompare(String(b)))
    assert.deepEqual(codes, [[77, -32600], [null, -32600], [null, -32700]].sort((a, b) => String(a).localeCompare(String(b))))
  } finally { await shim.stop() }
})

test('the shim exits when its stdin closes', async () => {
  const shim = startShim({ SWARMCLAW_PORT_FILE: '', SWARMCLAW_ACCESS_KEY: '' })
  const code = await shim.stop()
  assert.equal(code, 0)
})

// --- finding the host: the three checks of the port-file contract ---

test('no port file named is port_fajl_beallitatlan, before anything is read or sent', async () => {
  for (const value of ['', '   ']) {
    const shim = startShim({ SWARMCLAW_PORT_FILE: value, SWARMCLAW_ACCESS_KEY: 'k' })
    try {
      const { isError, value: v } = await statusCall(shim)
      assert.equal(isError, true)
      assert.equal(v.error.code, 'port_fajl_beallitatlan')
    } finally { await shim.stop() }
  }
})

test('check 1: a missing file and a file of the wrong shape are swarmclaw_nem_fut with their own reason, and no port is guessed', async () => {
  const cases = [
    [path.join(tmp, 'nincs', 'port.json'), 'port_fajl_hianyzik'],
    [writePort('{not json'), 'port_fajl_ervenytelen'],
    [writePort([1]), 'port_fajl_ervenytelen'],
    [writePort({ port: 0, wsPort: 2, pid: process.pid, startedAt: Date.now() }), 'port_fajl_ervenytelen'],
    [writePort({ port: 65536, wsPort: 2, pid: process.pid, startedAt: Date.now() }), 'port_fajl_ervenytelen'],
    [writePort({ port: 3456, pid: process.pid, startedAt: Date.now() }), 'port_fajl_ervenytelen'],
    [writePort({ port: 3456, wsPort: 3457, pid: 0, startedAt: Date.now() }), 'port_fajl_ervenytelen'],
    [writePort({ port: 3456, wsPort: 3457, pid: 1.5, startedAt: Date.now() }), 'port_fajl_ervenytelen'],
    [writePort({ port: 3456, wsPort: 3457, pid: process.pid }), 'port_fajl_ervenytelen'],
  ]
  for (const [file, reason] of cases) {
    const shim = startShim({ SWARMCLAW_PORT_FILE: file, SWARMCLAW_ACCESS_KEY: 'k' })
    try {
      const { isError, value } = await statusCall(shim)
      assert.equal(isError, true)
      assert.equal(value.error.code, 'swarmclaw_nem_fut', file)
      assert.equal(value.error.reason, reason, file)
      assert.equal(value.error.message.includes(file), reason === 'port_fajl_hianyzik' || reason === 'port_fajl_ervenytelen', 'the path is named, the content is not')
    } finally { await shim.stop() }
  }
})

test('check 2: a startedAt before this boot is stale even with a live pid and a real server behind it; a dead pid is stale too', async () => {
  const host = await fakeHost(() => ({ status: 200, json: { hang: 'Kenji' } }))
  try {
    const old = startShim({ SWARMCLAW_PORT_FILE: liveFile(host.port, { startedAt: 0 }), SWARMCLAW_ACCESS_KEY: 'k' })
    try {
      const { value } = await statusCall(old)
      assert.equal(value.error.code, 'swarmclaw_nem_fut')
      assert.equal(value.error.reason, 'port_fajl_regi')
      assert.equal(host.seen.length, 0, 'a file from before this boot is never followed to its port')
    } finally { await old.stop() }
    const gone = spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid
    const dead = startShim({ SWARMCLAW_PORT_FILE: liveFile(host.port, { pid: gone }), SWARMCLAW_ACCESS_KEY: 'k' })
    try {
      const { value } = await statusCall(dead)
      assert.equal(value.error.code, 'swarmclaw_nem_fut')
      assert.equal(value.error.reason, 'pid_nem_el')
      assert.equal(host.seen.length, 0)
    } finally { await dead.stop() }
  } finally { await host.close() }
})

test('check 3: a live pid whose port refuses, answers something else, or answers nothing is swarmclaw_nem_fut, and no rpc is sent', async () => {
  const refused = startShim({ SWARMCLAW_PORT_FILE: liveFile(await closedPort()), SWARMCLAW_ACCESS_KEY: 'k' })
  try {
    const { value } = await statusCall(refused)
    assert.equal(value.error.code, 'swarmclaw_nem_fut')
    assert.equal(value.error.reason, 'kapcsolat_elutasitva')
  } finally { await refused.stop() }

  const other = await fakeHost(() => ({ status: 200, json: { hang: 'Kenji' } }), { healthz: { status: 200, json: { ok: true, service: 'something-else' } } })
  try {
    const shim = startShim({ SWARMCLAW_PORT_FILE: liveFile(other.port), SWARMCLAW_ACCESS_KEY: 'k' })
    try {
      const { value } = await statusCall(shim)
      assert.equal(value.error.code, 'swarmclaw_nem_fut')
      assert.equal(value.error.reason, 'masik_program_a_porton')
      assert.equal(value.error.message.includes('something-else'), false, 'the body of an unknown server is never quoted')
      assert.deepEqual(other.seen.map((r) => r.url), ['/api/healthz'])
    } finally { await shim.stop() }
  } finally { await other.close() }

  const html = await fakeHost(() => ({ status: 200, json: {} }), { healthz: { status: 404, text: '<html>nope</html>' } })
  try {
    const shim = startShim({ SWARMCLAW_PORT_FILE: liveFile(html.port), SWARMCLAW_ACCESS_KEY: 'k' })
    try {
      const { value } = await statusCall(shim)
      assert.equal(value.error.reason, 'masik_program_a_porton')
    } finally { await shim.stop() }
  } finally { await html.close() }

  const silent = await fakeHost(() => ({ status: 200, json: {} }), { healthz: { hang: true } })
  try {
    const shim = startShim({ SWARMCLAW_PORT_FILE: liveFile(silent.port), SWARMCLAW_ACCESS_KEY: 'k' })
    try {
      const { value } = await statusCall(shim)
      assert.equal(value.error.code, 'swarmclaw_nem_fut')
      assert.equal(value.error.reason, 'healthz_nem_valaszolt')
      assert.match(value.error.message, /nem tudni, SwarmClaw-e/)
    } finally { await shim.stop() }
  } finally { silent.server.closeAllConnections(); await silent.close() }
})

// --- what the host answers ---

test('a 404 from the host is tts_extension_hianyzik, a 500 and an unreadable 200 are host_hiba, and a null is a value', async () => {
  const host = await fakeHost(({ url, body }) => {
    if (body && body.szoveg === 'five-hundred') return { status: 500, json: { error: { code: 'internal', message: 'boom in the handler' }, message: 'boom in the handler' } }
    if (body && body.szoveg === 'garbage') return { status: 200, text: 'not json at all' }
    if (body && body.szoveg === 'empty') return { status: 200, text: '' }
    if (body && body.szoveg === 'null') return { status: 200, json: null }
    if (url.endsWith('/call/status')) return { status: 404, json: { error: { code: 'not_found', message: 'no rpc method "status" on extension "tts.mjs"' }, message: 'x' } }
    return { status: 200, json: {} }
  })
  const shim = startShim({ SWARMCLAW_PORT_FILE: liveFile(host.port), SWARMCLAW_ACCESS_KEY: 'k' })
  const synth = async (szoveg) => {
    const r = await shim.call('tools/call', { name: 'tts_synthesize', arguments: { szoveg, celFajl: '/abs/a.mp3' } })
    return { isError: r.result.isError, value: JSON.parse(r.result.content[0].text) }
  }
  try {
    const missing = await statusCall(shim)
    assert.equal(missing.value.error.code, 'tts_extension_hianyzik')
    assert.match(missing.value.error.message, /nincs telepítve, le van tiltva, vagy régebbi kiadás/)
    const five = await synth('five-hundred')
    assert.equal(five.isError, true)
    assert.equal(five.value.error.code, 'host_hiba')
    assert.equal(five.value.error.httpStatus, 500)
    assert.equal(five.value.error.message, 'boom in the handler')
    const garbage = await synth('garbage')
    assert.deepEqual([garbage.value.error.code, garbage.value.error.reason], ['host_hiba', 'valasz_nem_json'])
    assert.equal(garbage.value.error.message.includes('not json at all'), false)
    const empty = await synth('empty')
    assert.deepEqual([empty.value.error.code, empty.value.error.reason], ['host_hiba', 'valasz_nem_json'])
    assert.match(empty.value.error.message, /üres/)
    const nothing = await synth('null')
    assert.equal(nothing.isError, false)
    assert.equal(nothing.value, null)
  } finally { await shim.stop(); await host.close() }
})

test('a 401 is kulcs_beallitatlan without a key and kulcs_ervenytelen with one; a host that wants no key is called without one; 429 and 403 are host_hiba', async () => {
  const host = await fakeHost(({ key }) => {
    if (key === 'locked') return { status: 429, json: { error: 'Too many failed attempts. Try again later.', retryAfter: 42 } }
    if (key === 'origin') return { status: 403, json: { error: 'Origin not allowed' } }
    if (key !== 'right') return { status: 401, json: { error: 'Unauthorized' } }
    return { status: 200, json: { hang: 'Kenji' } }
  })
  const run = async (env) => {
    const shim = startShim({ SWARMCLAW_PORT_FILE: liveFile(host.port), ...env })
    try { return await statusCall(shim) } finally { await shim.stop() }
  }
  try {
    const none = await run({ SWARMCLAW_ACCESS_KEY: '' })
    assert.equal(none.value.error.code, 'kulcs_beallitatlan')
    assert.equal(host.seen.at(-1).key, undefined, 'no header is sent when no key is set')
    const wrong = await run({ SWARMCLAW_ACCESS_KEY: 'wrong' })
    assert.equal(wrong.value.error.code, 'kulcs_ervenytelen')
    assert.equal(JSON.stringify(wrong.value).includes('wrong'), false, 'the key value is never in the answer')
    const right = await run({ SWARMCLAW_ACCESS_KEY: ' right ' })
    assert.deepEqual([right.isError, right.value.hang], [false, 'Kenji'])
    const locked = await run({ SWARMCLAW_ACCESS_KEY: 'locked' })
    assert.deepEqual([locked.value.error.code, locked.value.error.reason, locked.value.error.retryAfter], ['host_hiba', 'zarolas', 42])
    const origin = await run({ SWARMCLAW_ACCESS_KEY: 'origin' })
    assert.deepEqual([origin.value.error.code, origin.value.error.httpStatus], ['host_hiba', 403])
  } finally { await host.close() }

  const open = await fakeHost(({ key }) => ({ status: 200, json: { kulcsBeallitva: false, key: key === undefined ? 'none' : 'sent' } }))
  try {
    const shim = startShim({ SWARMCLAW_PORT_FILE: liveFile(open.port), SWARMCLAW_ACCESS_KEY: '' })
    try {
      const { isError, value } = await statusCall(shim)
      assert.deepEqual([isError, value.key], [false, 'none'], 'a host without ACCESS_KEY answers without one, and the shim does not refuse first')
    } finally { await shim.stop() }
  } finally { await open.close() }
})

test('the argument object reaches the host whole: extra keys are not stripped, and the text arrives byte for byte', async () => {
  const host = await fakeHost(({ body }) => ({ status: 200, json: { echo: body } }))
  const shim = startShim({ SWARMCLAW_PORT_FILE: liveFile(host.port), SWARMCLAW_ACCESS_KEY: 'k' })
  try {
    const text = 'Szia "világ"; $(rm -rf /) `x` \n\t  \\ ${y} ' + "'; drop table kerelmek; --"
    const args = { szoveg: text, celFajl: '/abs/../a.mp3', hang: 'Mira' }
    const r = await shim.call('tools/call', { name: 'tts_synthesize', arguments: args })
    assert.equal(r.result.isError, false)
    assert.deepEqual(JSON.parse(r.result.content[0].text).echo, args)
    assert.deepEqual(host.seen.filter((s) => s.url !== '/api/healthz')[0].body, args, 'hang is forwarded for the host to refuse by name, not dropped')
    const s = await shim.call('tools/call', { name: 'tts_status', arguments: { limit: 5 } })
    assert.deepEqual(JSON.parse(s.result.content[0].text).echo, { limit: 5 })
  } finally { await shim.stop(); await host.close() }
})

test('a host that restarts on a new port between two calls is found again, and one that goes away is swarmclaw_nem_fut', async () => {
  const first = await fakeHost(() => ({ status: 200, json: { which: 'first' } }))
  const file = liveFile(first.port)
  const shim = startShim({ SWARMCLAW_PORT_FILE: file, SWARMCLAW_ACCESS_KEY: 'k' })
  try {
    assert.equal((await statusCall(shim)).value.which, 'first')
    first.server.closeAllConnections()
    await first.close()
    const away = await statusCall(shim)
    assert.equal(away.value.error.code, 'swarmclaw_nem_fut')
    assert.equal(away.value.error.reason, 'kapcsolat_elutasitva')
    const second = await fakeHost(() => ({ status: 200, json: { which: 'second' } }))
    try {
      fs.writeFileSync(file, `${JSON.stringify({ port: second.port, wsPort: second.port + 1, pid: process.pid, startedAt: Date.now() })}\n`)
      assert.equal((await statusCall(shim)).value.which, 'second')
    } finally { await second.close() }
  } finally { await shim.stop() }
})
