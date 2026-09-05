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

import { createRpc } from '../src/rpc.mjs'

/**
 * The MCP server, driven the way it will actually run.
 *
 * The shim is started with `process.execPath` and no loader: that is the
 * runtime it ships on, an MCP client spawning plain `node` in a workspace with
 * no node_modules. Every host here is a local `http` server on 127.0.0.1 that
 * the test itself started; NOTHING REACHES GOOGLE and no credential exists in
 * this file. The fake host stands in for the rpc, so what is under test is the
 * shim: which method each tool forwards to, which names it refuses, and the
 * four port-file checks it makes before it sends anything at all.
 *
 * A "swarmclaw" host answers `/api/healthz` with `service: "swarmclaw"` and the
 * instance token its port file names, as the real route does, so the shim's
 * checks pass and the rpc mapping is what gets exercised. The port file written
 * for it carries the test's own pid and a `startedAt` of now, which is what a
 * live server's file looks like; each of the four checks then gets a case that
 * fails it alone.
 *
 * WHAT THESE TESTS CANNOT SHOW. The fake host answers `service: "swarmclaw"`
 * because this file makes it, and it writes the port file because this file
 * writes it. So everything below is a test of the shim against the contract as
 * this repository understands it, and nothing below is evidence that a running
 * SwarmClaw matches that understanding. The live run is test/deploy.smoke.mjs,
 * which starts this same shim against a real host with the entry that host's
 * own `mcpConfig` printed; it needs a running server and is therefore not in
 * this suite. See the same note in mcp/server.mjs.
 */
const SHIM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'mcp', 'server.mjs')

/** The six tools, in the order the shim lists them. Written out: this list is the agent-facing surface. */
const TOOLOK = ['gmail_search', 'gmail_read', 'gmail_labels', 'gmail_label', 'gmail_draft', 'gmail_outbox']

/** The rpc methods the shim may reach, paired with the tool that reaches each. */
const TOOL_METODUS = [
  ['gmail_search', 'search'],
  ['gmail_read', 'read'],
  ['gmail_labels', 'labels'],
  ['gmail_label', 'label'],
  ['gmail_draft', 'draft'],
  ['gmail_outbox', 'outbox'],
]

/**
 * The rpc methods that write from the operator's hand. They exist on the rpc
 * and must not be reachable from here; a case below pins both halves.
 */
const OPERATOR_METODUSOK = ['releaseDraft', 'discardDraft', 'addRecipient', 'retireRecipient']

/**
 * The instance token the fake host and its port file share. A real host mints
 * one per boot and answers it on /api/healthz; here the two sides are made to
 * agree so the identity check passes and the rpc mapping is what is exercised.
 * The check that they must agree gets its own case below.
 */
const INSTANCE = 'b7c1d2e3f4a5968708192a3b4c5d6e7f'
const SWARMCLAW_HEALTHZ = { status: 200, json: { ok: true, service: 'swarmclaw', instanceId: INSTANCE, time: 1 } }

/**
 * `handler` gets `{ url, method, key, body }` and returns `{ status, json }` or
 * `{ status, text }`; `seen` records every request. A handler that leaves
 * `/api/healthz` alone gets the SwarmClaw answer for it.
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

/** Every request that was not the identity probe. */
const rpcCalls = (host) => host.seen.filter((r) => r.url !== '/api/healthz')

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
  const tool = async (name, args = {}) => {
    const r = await call('tools/call', { name, arguments: args })
    if (!r.result) return { protocolError: r.error }
    return { isError: r.result.isError, value: JSON.parse(r.result.content[0].text) }
  }
  const raw = (text) => { child.stdin.write(`${text}\n`) }
  const stop = () => new Promise((resolve) => { child.once('exit', resolve); child.stdin.end() })
  return { child, call, send, tool, raw, stop, unmatched }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-mcp-'))
let fileNo = 0
/** A fresh port file per call, so cases that run concurrently never share one. */
function writePort(content) {
  fileNo += 1
  const file = path.join(tmp, `run-${fileNo}`, 'port.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof content === 'string' ? content : `${JSON.stringify(content)}\n`)
  return file
}
const liveFile = (port, extra = {}) => writePort({ port, wsPort: port + 1, pid: process.pid, startedAt: Date.now(), instanceId: INSTANCE, ...extra })

// --- protocol and the six tools ---

test('the shim speaks initialize, ping and tools/list, and lists exactly the six tools', async () => {
  const shim = startShim({ SWARMCLAW_PORT_FILE: '', SWARMCLAW_ACCESS_KEY: '' })
  try {
    const init = await shim.call('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } })
    assert.equal(init.result.protocolVersion, '2024-11-05')
    assert.deepEqual(init.result.capabilities, { tools: {} })
    assert.equal(init.result.serverInfo.name, 'swarmclaw-gmail')
    shim.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    const list = await shim.call('tools/list', {})
    assert.deepEqual(list.result.tools.map((t) => t.name), TOOLOK)
    for (const t of list.result.tools) {
      assert.deepEqual(Object.keys(t).sort(), ['description', 'inputSchema', 'name'], `${t.name}: only the wire fields cross`)
      assert.equal(t.inputSchema.additionalProperties, false)
    }
    assert.deepEqual(list.result.tools.find((t) => t.name === 'gmail_read').inputSchema.required, ['id'])
    assert.deepEqual(list.result.tools.find((t) => t.name === 'gmail_draft').inputSchema.required, ['szoveg'])
    assert.equal((await shim.call('ping', {})).result !== undefined, true)
    assert.deepEqual(shim.unmatched, [], 'the initialized notification got no reply')
  } finally { await shim.stop() }
})

test('there is no send tool, and no tool reaches an operator-only rpc method', async () => {
  const host = await fakeHost(() => ({ status: 200, json: { ok: true } }))
  const shim = startShim({ SWARMCLAW_PORT_FILE: liveFile(host.port), SWARMCLAW_ACCESS_KEY: 'k' })
  try {
    const list = await shim.call('tools/list', {})
    const names = list.result.tools.map((t) => t.name)
    assert.equal(names.some((n) => /send|kuld|release|kiad/i.test(n)), false, 'nothing on this surface sends')
    // Both halves of the "two mistakes" rule. First: the four operator methods
    // really are on the rpc, so their absence here is an omission somebody made
    // and not a method that does not exist.
    const rpc = createRpc({}, { workspaceDir: '/tmp/ws', portFile: '/tmp/ws/run/port.json' })
    for (const metodus of OPERATOR_METODUSOK) assert.equal(typeof rpc[metodus], 'function', `${metodus} is on the rpc`)
    // Second: the shim refuses each of them as a tool name, and sends nothing.
    for (const metodus of [...OPERATOR_METODUSOK, 'gmail_send', 'gmail_release']) {
      const r = await shim.tool(metodus, { kimenoId: 'aaaaaaaaaaaaaaaa' })
      assert.equal(r.isError, true, metodus)
      assert.equal(r.value.error.code, 'mcp_ismeretlen_metodus', metodus)
    }
    assert.deepEqual(rpcCalls(host), [], 'not one of them reached the host')
  } finally { await shim.stop(); await host.close() }
})

test('each tool forwards to its own rpc method, with the key and the arguments whole', async () => {
  const host = await fakeHost(({ url }) => ({ status: 200, json: { hol: url } }))
  const shim = startShim({ SWARMCLAW_PORT_FILE: liveFile(host.port), SWARMCLAW_ACCESS_KEY: 'secret-1' })
  try {
    for (const [name] of TOOL_METODUS) await shim.tool(name, { proba: 1 })
    assert.deepEqual(
      rpcCalls(host).map((r) => [r.method, r.url, r.key]),
      TOOL_METODUS.map(([, metodus]) => ['POST', `/api/extensions/gmail.mjs/call/${metodus}`, 'secret-1']),
    )
    assert.deepEqual(rpcCalls(host).map((r) => r.body), TOOL_METODUS.map(() => ({ proba: 1 })))
    assert.equal(host.seen.filter((r) => r.url === '/api/healthz').length, TOOL_METODUS.length, 'every tool call re-runs the identity check')
    assert.equal(host.seen.some((r) => r.url === '/api/healthz' && r.key !== undefined), false, 'the key is never sent to healthz')
  } finally { await shim.stop(); await host.close() }
})

test('gmail_search hands the cursor through and gives back complete, nextCursor and stoppedOn untouched', async () => {
  const lap = { ids: ['m1', 'm2'], nextCursor: 'PAGE-TOKEN-2', complete: false, stoppedOn: 'cap' }
  const host = await fakeHost(({ url }) => (url.endsWith('/call/search') ? { status: 200, json: lap } : { status: 500, json: {} }))
  const shim = startShim({ SWARMCLAW_PORT_FILE: liveFile(host.port), SWARMCLAW_ACCESS_KEY: 'k' })
  try {
    const args = { labelIds: ['INBOX', 'Label_7'], query: 'from:valaki@pelda.hu newer_than:7d', max: 2, cursor: 'PAGE-TOKEN-1' }
    const first = await shim.tool('gmail_search', args)
    assert.equal(first.isError, false)
    assert.deepEqual(first.value, lap, 'the four fields come back as the host wrote them')
    assert.deepEqual(rpcCalls(host)[0].body, args, 'the query and the cursor reach the host unchanged')
    // The agent pages by handing nextCursor back, which is the whole point of
    // this tool existing beside the Gmail MCP server the operator already runs.
    await shim.tool('gmail_search', { ...args, cursor: first.value.nextCursor })
    assert.equal(rpcCalls(host)[1].body.cursor, 'PAGE-TOKEN-2')
  } finally { await shim.stop(); await host.close() }
})

test('an extension refusal is passed through with its own code, not translated into a shim code', async () => {
  const host = await fakeHost(({ url }) => {
    if (url.endsWith('/call/draft')) return { status: 200, json: { error: { code: 'gmail_cimzett_cim_literal', message: 'cimzett nem lehet e-mail cim' } } }
    return { status: 200, json: { total: 0, count: 0, items: [] } }
  })
  const shim = startShim({ SWARMCLAW_PORT_FILE: liveFile(host.port), SWARMCLAW_ACCESS_KEY: 'k' })
  try {
    const r = await shim.tool('gmail_draft', { cimzettHandlek: ['valaki@pelda.hu'], targy: 'Szia', szoveg: 'Szoveg.' })
    assert.equal(r.isError, true)
    assert.equal(r.value.error.code, 'gmail_cimzett_cim_literal')
  } finally { await shim.stop(); await host.close() }
})

test('an outbox row in the bizonytalan state reaches the agent as it stands, and the tool offers no way to act on it', async () => {
  const sor = { id: 'aaaaaaaaaaaaaaaa', allapot: 'bizonytalan', hibaKod: 'gmail_kiadas_bizonytalan', torzs: 'Szia.' }
  const host = await fakeHost(() => ({ status: 200, json: { total: 1, count: 1, items: [sor] } }))
  const shim = startShim({ SWARMCLAW_PORT_FILE: liveFile(host.port), SWARMCLAW_ACCESS_KEY: 'k' })
  try {
    const r = await shim.tool('gmail_outbox', { allapot: 'bizonytalan' })
    assert.equal(r.isError, false)
    assert.deepEqual(r.value.items, [sor])
    const list = await shim.call('tools/list', {})
    const outbox = list.result.tools.find((t) => t.name === 'gmail_outbox')
    assert.deepEqual(outbox.inputSchema.properties.allapot.enum, ['piszkozat', 'kiadva', 'elvetve', 'hiba', 'bizonytalan'], 'all five states are askable')
    assert.match(outbox.description, /bizonytalan/)
    assert.match(outbox.description, /VÉGÁLLAPOT/)
    assert.match(outbox.description, /CSAK OLVAS/)
  } finally { await shim.stop(); await host.close() }
})

test('the two descriptions an agent has to read before it decides say what they must', async () => {
  const shim = startShim({ SWARMCLAW_PORT_FILE: '', SWARMCLAW_ACCESS_KEY: '' })
  try {
    const list = await shim.call('tools/list', {})
    const search = list.result.tools.find((t) => t.name === 'gmail_search').description
    assert.match(search, /SZÓ SZERINT/, 'the query is literal')
    assert.match(search, /nincs fuzzy illesztés/)
    assert.match(search, /nincs természetes nyelvi átírás/)
    assert.match(search, /cursor\/nextCursor/, 'paging is named by the pair it runs on')
    const draft = list.result.tools.find((t) => t.name === 'gmail_draft').description
    assert.match(draft, /PISZKOZATOT ÍR, NEM KÜLD/)
    assert.match(draft, /\/x\/gmail/, 'the release is the operator\'s, and the page is named')
  } finally { await shim.stop() }
})

test('a malformed tools/call and an unknown JSON-RPC method are protocol errors, and a parse error is answered', async () => {
  const shim = startShim({ SWARMCLAW_PORT_FILE: '', SWARMCLAW_ACCESS_KEY: '' })
  try {
    const badArgs = await shim.call('tools/call', { name: 'gmail_labels', arguments: ['x'] })
    assert.equal(badArgs.error.code, -32602)
    const noName = await shim.call('tools/call', {})
    assert.equal(noName.error.code, -32602)
    const method = await shim.call('resources/list', {})
    assert.equal(method.error.code, -32601)
    shim.raw('{not json')
    const pong = await shim.call('ping', {})
    assert.deepEqual(pong.result, {})
    assert.deepEqual(shim.unmatched.map((m) => m.error.code), [-32700])
  } finally { await shim.stop() }
})

test('a tool name that is not an identifier is refused without being repeated', async () => {
  const shim = startShim({ SWARMCLAW_PORT_FILE: '', SWARMCLAW_ACCESS_KEY: '' })
  try {
    const r = await shim.tool('rm -rf /; $(x)', {})
    assert.equal(r.value.error.code, 'mcp_ismeretlen_metodus')
    assert.equal(r.value.error.message.includes('rm'), false, 'a name that is not an identifier is not echoed')
  } finally { await shim.stop() }
})

test('the shim exits when its stdin closes', async () => {
  const shim = startShim({ SWARMCLAW_PORT_FILE: '', SWARMCLAW_ACCESS_KEY: '' })
  const code = await shim.stop()
  assert.equal(code, 0)
})

// --- finding the host: the four checks of the port-file contract ---

test('no port file named is gmail_port_fajl_beallitatlan, before anything is read or sent', async () => {
  for (const value of ['', '   ']) {
    const shim = startShim({ SWARMCLAW_PORT_FILE: value, SWARMCLAW_ACCESS_KEY: 'k' })
    try {
      const r = await shim.tool('gmail_labels', {})
      assert.equal(r.isError, true)
      assert.equal(r.value.error.code, 'gmail_port_fajl_beallitatlan')
      assert.match(r.value.error.message, /\/x\/gmail/, 'the page that shows the right value is named')
    } finally { await shim.stop() }
  }
})

test('check 1: a missing file and a file of the wrong shape are swarmclaw_nem_fut with their own reason, and no port is guessed', async () => {
  const cases = [
    [path.join(tmp, 'nincs', 'port.json'), 'port_fajl_hianyzik'],
    [writePort('{not json'), 'port_fajl_ervenytelen'],
    [writePort([1]), 'port_fajl_ervenytelen'],
    [writePort({ port: 0, wsPort: 2, pid: process.pid, startedAt: Date.now(), instanceId: INSTANCE }), 'port_fajl_ervenytelen'],
    [writePort({ port: 65536, wsPort: 2, pid: process.pid, startedAt: Date.now(), instanceId: INSTANCE }), 'port_fajl_ervenytelen'],
    [writePort({ port: 3456, pid: process.pid, startedAt: Date.now(), instanceId: INSTANCE }), 'port_fajl_ervenytelen'],
    [writePort({ port: 3456, wsPort: 3457, pid: 0, startedAt: Date.now(), instanceId: INSTANCE }), 'port_fajl_ervenytelen'],
    [writePort({ port: 3456, wsPort: 3457, pid: 1.5, startedAt: Date.now(), instanceId: INSTANCE }), 'port_fajl_ervenytelen'],
    [writePort({ port: 3456, wsPort: 3457, pid: process.pid, instanceId: INSTANCE }), 'port_fajl_ervenytelen'],
    [writePort({ port: 3456, wsPort: 3457, pid: process.pid, startedAt: Date.now() }), 'port_fajl_ervenytelen'],
  ]
  for (const [file, reason] of cases) {
    const shim = startShim({ SWARMCLAW_PORT_FILE: file, SWARMCLAW_ACCESS_KEY: 'k' })
    try {
      const r = await shim.tool('gmail_labels', {})
      assert.equal(r.isError, true)
      assert.equal(r.value.error.code, 'swarmclaw_nem_fut', file)
      assert.equal(r.value.error.reason, reason, file)
      assert.equal(r.value.error.message.includes(file), true, 'the path is named, the content is not')
    } finally { await shim.stop() }
  }
})

test('check 2: a startedAt before this boot is stale even with a live pid and a real server behind it; a dead pid is stale too', async () => {
  const host = await fakeHost(() => ({ status: 200, json: { ok: true } }))
  try {
    const old = startShim({ SWARMCLAW_PORT_FILE: liveFile(host.port, { startedAt: 0 }), SWARMCLAW_ACCESS_KEY: 'k' })
    try {
      const r = await old.tool('gmail_labels', {})
      assert.equal(r.value.error.code, 'swarmclaw_nem_fut')
      assert.equal(r.value.error.reason, 'port_fajl_regi')
      assert.equal(host.seen.length, 0, 'a file from before this boot is never followed to its port')
    } finally { await old.stop() }
    const gone = spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid
    const dead = startShim({ SWARMCLAW_PORT_FILE: liveFile(host.port, { pid: gone }), SWARMCLAW_ACCESS_KEY: 'k' })
    try {
      const r = await dead.tool('gmail_labels', {})
      assert.equal(r.value.error.code, 'swarmclaw_nem_fut')
      assert.equal(r.value.error.reason, 'pid_nem_el')
      assert.equal(host.seen.length, 0)
    } finally { await dead.stop() }
  } finally { await host.close() }
})

test('check 3: a live pid whose port refuses, answers something else, or answers nothing is swarmclaw_nem_fut, and no rpc is sent', async () => {
  const refused = startShim({ SWARMCLAW_PORT_FILE: liveFile(await closedPort()), SWARMCLAW_ACCESS_KEY: 'k' })
  try {
    const r = await refused.tool('gmail_labels', {})
    assert.equal(r.value.error.code, 'swarmclaw_nem_fut')
    assert.equal(r.value.error.reason, 'kapcsolat_elutasitva')
  } finally { await refused.stop() }

  const other = await fakeHost(() => ({ status: 200, json: { ok: true } }), { healthz: { status: 200, json: { ok: true, service: 'something-else' } } })
  try {
    const shim = startShim({ SWARMCLAW_PORT_FILE: liveFile(other.port), SWARMCLAW_ACCESS_KEY: 'k' })
    try {
      const r = await shim.tool('gmail_labels', {})
      assert.equal(r.value.error.reason, 'masik_program_a_porton')
      assert.equal(r.value.error.message.includes('something-else'), false, 'the body of an unknown server is never quoted')
      assert.deepEqual(other.seen.map((s) => s.url), ['/api/healthz'])
    } finally { await shim.stop() }
  } finally { await other.close() }

  const silent = await fakeHost(() => ({ status: 200, json: {} }), { healthz: { hang: true } })
  try {
    const shim = startShim({ SWARMCLAW_PORT_FILE: liveFile(silent.port), SWARMCLAW_ACCESS_KEY: 'k' })
    try {
      const r = await shim.tool('gmail_labels', {})
      assert.equal(r.value.error.reason, 'healthz_nem_valaszolt')
      assert.match(r.value.error.message, /nem tudni, SwarmClaw-e/)
    } finally { await shim.stop() }
  } finally { silent.server.closeAllConnections(); await silent.close() }
})

test('check 4: a SwarmClaw on the port that is not the one the file names is refused, and no mailbox request is sent', async () => {
  // The case: this instance was SIGKILLed, its port file stayed behind, its pid
  // was handed to something else inside the same boot, and a second SwarmClaw
  // -- another home, another database, another Google credential -- now holds
  // that port. Checks 1, 2 and 3 all pass on that file. Without the token the
  // shim would read another operator's mailbox, or write a draft into it.
  const masik = await fakeHost(() => ({ status: 200, json: { ok: true } }), {
    healthz: { status: 200, json: { ok: true, service: 'swarmclaw', instanceId: 'ffffffffffffffffffffffffffffffff', time: 1 } },
  })
  try {
    const shim = startShim({ SWARMCLAW_PORT_FILE: liveFile(masik.port), SWARMCLAW_ACCESS_KEY: 'k' })
    try {
      const r = await shim.tool('gmail_draft', { cimzettHandlek: ['dorina'], targy: 'Szia', szoveg: 'Szoveg.' })
      assert.equal(r.value.error.code, 'swarmclaw_nem_fut')
      assert.equal(r.value.error.reason, 'masik_peldany_a_porton')
      assert.match(r.value.error.message, /MÁSIK SwarmClaw-példány/)
      assert.equal(r.value.error.message.includes('ffffffff'), false, 'the other instance token is not repeated')
      assert.deepEqual(masik.seen.map((s) => s.url), ['/api/healthz'], 'nothing was sent past the identity check')
    } finally { await shim.stop() }
  } finally { await masik.close() }

  // A server that answers the service name but no token cannot be compared, and
  // an answer that cannot be compared is not an answer.
  const nevtelen = await fakeHost(() => ({ status: 200, json: { ok: true } }), {
    healthz: { status: 200, json: { ok: true, service: 'swarmclaw', time: 1 } },
  })
  try {
    const shim = startShim({ SWARMCLAW_PORT_FILE: liveFile(nevtelen.port), SWARMCLAW_ACCESS_KEY: 'k' })
    try {
      const r = await shim.tool('gmail_labels', {})
      assert.equal(r.value.error.reason, 'masik_peldany_a_porton')
      assert.deepEqual(nevtelen.seen.map((s) => s.url), ['/api/healthz'])
    } finally { await shim.stop() }
  } finally { await nevtelen.close() }
})

// --- what the host answers ---

test('a 404 from the host is gmail_extension_hianyzik, a 500 and an unreadable 200 are host_hiba, and a null is a value', async () => {
  const host = await fakeHost(({ url, body }) => {
    if (url.endsWith('/call/labels')) return { status: 404, json: { error: { code: 'not_found', message: 'no rpc method "labels" on extension "gmail.mjs"' }, message: 'x' } }
    if (body && body.id === 'five-hundred') return { status: 500, json: { error: { code: 'internal', message: 'boom in the handler' }, message: 'boom in the handler' } }
    if (body && body.id === 'garbage') return { status: 200, text: 'not json at all' }
    if (body && body.id === 'empty') return { status: 200, text: '' }
    if (body && body.id === 'null') return { status: 200, json: null }
    return { status: 200, json: {} }
  })
  const shim = startShim({ SWARMCLAW_PORT_FILE: liveFile(host.port), SWARMCLAW_ACCESS_KEY: 'k' })
  try {
    const missing = await shim.tool('gmail_labels', {})
    assert.equal(missing.value.error.code, 'gmail_extension_hianyzik')
    assert.match(missing.value.error.message, /nincs telepítve, le van tiltva, vagy régebbi kiadás/)
    const five = await shim.tool('gmail_read', { id: 'five-hundred' })
    assert.deepEqual([five.isError, five.value.error.code, five.value.error.httpStatus], [true, 'host_hiba', 500])
    assert.equal(five.value.error.message, 'boom in the handler')
    const garbage = await shim.tool('gmail_read', { id: 'garbage' })
    assert.deepEqual([garbage.value.error.code, garbage.value.error.reason], ['host_hiba', 'valasz_nem_json'])
    assert.equal(garbage.value.error.message.includes('not json at all'), false)
    const empty = await shim.tool('gmail_read', { id: 'empty' })
    assert.match(empty.value.error.message, /üres/)
    const nothing = await shim.tool('gmail_read', { id: 'null' })
    assert.deepEqual([nothing.isError, nothing.value], [false, null])
  } finally { await shim.stop(); await host.close() }
})

test('a 401 is swarmclaw_kulcs_beallitatlan without a key and swarmclaw_kulcs_ervenytelen with one; 429 and 403 are host_hiba', async () => {
  const host = await fakeHost(({ key }) => {
    if (key === 'locked') return { status: 429, json: { error: 'Too many failed attempts. Try again later.', retryAfter: 42 } }
    if (key === 'origin') return { status: 403, json: { error: 'Origin not allowed' } }
    if (key !== 'right') return { status: 401, json: { error: 'Unauthorized' } }
    return { status: 200, json: [{ id: 'INBOX', name: 'INBOX', type: 'system' }] }
  })
  const run = async (env) => {
    const shim = startShim({ SWARMCLAW_PORT_FILE: liveFile(host.port), ...env })
    try { return await shim.tool('gmail_labels', {}) } finally { await shim.stop() }
  }
  try {
    const none = await run({ SWARMCLAW_ACCESS_KEY: '' })
    assert.equal(none.value.error.code, 'swarmclaw_kulcs_beallitatlan')
    assert.equal(host.seen.at(-1).key, undefined, 'no header is sent when no key is set')
    const wrong = await run({ SWARMCLAW_ACCESS_KEY: 'wrong' })
    assert.equal(wrong.value.error.code, 'swarmclaw_kulcs_ervenytelen')
    assert.equal(JSON.stringify(wrong.value).includes('wrong'), false, 'the key value is never in the answer')
    const right = await run({ SWARMCLAW_ACCESS_KEY: ' right ' })
    assert.deepEqual([right.isError, right.value[0].id], [false, 'INBOX'])
    const locked = await run({ SWARMCLAW_ACCESS_KEY: 'locked' })
    assert.deepEqual([locked.value.error.code, locked.value.error.reason, locked.value.error.retryAfter], ['host_hiba', 'zarolas', 42])
    const origin = await run({ SWARMCLAW_ACCESS_KEY: 'origin' })
    assert.deepEqual([origin.value.error.code, origin.value.error.httpStatus], ['host_hiba', 403])
  } finally { await host.close() }

  const open = await fakeHost(({ key }) => ({ status: 200, json: { key: key === undefined ? 'none' : 'sent' } }))
  try {
    const shim = startShim({ SWARMCLAW_PORT_FILE: liveFile(open.port), SWARMCLAW_ACCESS_KEY: '' })
    try {
      const r = await shim.tool('gmail_labels', {})
      assert.deepEqual([r.isError, r.value.key], [false, 'none'], 'a host without ACCESS_KEY answers without one, and the shim does not refuse first')
    } finally { await shim.stop() }
  } finally { await open.close() }
})

test('a stranger\'s text goes to the host byte for byte and comes back the same, and reaches nothing else', async () => {
  const host = await fakeHost(({ body }) => ({ status: 200, json: { echo: body } }))
  const shim = startShim({ SWARMCLAW_PORT_FILE: liveFile(host.port), SWARMCLAW_ACCESS_KEY: 'k' })
  try {
    const szoveg = 'Szia "világ"; $(rm -rf /) `x` \n\t  \\ ${y} ' + "'; drop table kimeno; --"
    const args = { cimzettHandlek: ['dorina'], targy: szoveg, szoveg, html: '<b>x</b>' }
    const r = await shim.tool('gmail_draft', args)
    assert.equal(r.isError, false)
    assert.deepEqual(r.value.echo, args)
    // `html` is forwarded for the host to refuse by name (gmail_mezo_nem_tamogatott),
    // not dropped here: a silently stripped field is a caller told its request
    // succeeded when part of it was thrown away.
    assert.deepEqual(rpcCalls(host)[0].body, args)
  } finally { await shim.stop(); await host.close() }
})

test('a host that restarts on a new port between two calls is found again, and one that goes away is swarmclaw_nem_fut', async () => {
  const first = await fakeHost(() => ({ status: 200, json: { which: 'first' } }))
  const file = liveFile(first.port)
  const shim = startShim({ SWARMCLAW_PORT_FILE: file, SWARMCLAW_ACCESS_KEY: 'k' })
  try {
    assert.equal((await shim.tool('gmail_labels', {})).value.which, 'first')
    first.server.closeAllConnections()
    await first.close()
    const away = await shim.tool('gmail_labels', {})
    assert.equal(away.value.error.code, 'swarmclaw_nem_fut')
    assert.equal(away.value.error.reason, 'kapcsolat_elutasitva')
    const second = await fakeHost(() => ({ status: 200, json: { which: 'second' } }))
    try {
      // A restart rewrites the file, token and all; the shim reads it fresh on
      // every call, so the new port and the new identity are both picked up.
      fs.writeFileSync(file, `${JSON.stringify({ port: second.port, wsPort: second.port + 1, pid: process.pid, startedAt: Date.now(), instanceId: INSTANCE })}\n`)
      assert.equal((await shim.tool('gmail_labels', {})).value.which, 'second')
    } finally { await second.close() }
  } finally { await shim.stop() }
})
