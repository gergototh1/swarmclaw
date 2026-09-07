import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * A shim-et `process.execPath`-szel indítjuk, loader nélkül: ez az a
 * futtatókörnyezet, amiben ténylegesen fut -- a CLI sima `node`-dal indítja,
 * egy olyan workspace-ből, amiben nincs `node_modules`. Minden host itt egy
 * lokális `http` szerver 127.0.0.1-en, amit maga a teszt indít; semmi nem
 * hagyja el a gépet.
 *
 * A port-fájl szerződés négy ellenőrzése ugyanaz a kód, mint a tts shim-é, és
 * ott teljes egészében le van fedve; ami itt van tesztelve, az, amiben ez a
 * shim más -- a hosttól kéri el a tool-tábláját ahelyett, hogy magával
 * hordozná, és továbbítja a hívónak azt, amit a host az env-jébe stancolt.
 *
 * AMIT EZEK A TESZTEK NEM MUTATNAK MEG. A hamis host `service: "swarmclaw"`-val
 * válaszol, mert ezt a fájl így írja meg. Tehát minden lent a shimet a
 * szerződés ellen teszteli úgy, ahogy ez a repó érti azt, és semmi lent nem
 * bizonyíték arra, hogy egy futó SwarmClaw megfelel ennek az értelmezésnek.
 * Egy élő futtatás az egyetlen, ami ezt végponttól végpontig igazolhatja, és
 * az még hátravan.
 */
const SHIM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'mcp', 'server.mjs')
const INSTANCE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
const SWARMCLAW_HEALTHZ = { status: 200, json: { ok: true, service: 'swarmclaw', instanceId: INSTANCE, time: 1 } }

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
        const out = req.url === '/api/healthz' && healthz ? healthz : handler({ url: req.url, body })
        if ('text' in out) {
          res.writeHead(out.status, { 'content-type': 'text/plain' })
          res.end(out.text)
          return
        }
        res.writeHead(out.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(out.json))
      })
    })
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, seen, close: () => new Promise((r) => server.close(r)) }))
  })
}

function startShim(env) {
  const child = spawn(process.execPath, [SHIM], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'ignore'] })
  const lines = readline.createInterface({ input: child.stdout })
  const pending = new Map()
  lines.on('line', (line) => {
    const msg = JSON.parse(line)
    const p = msg.id !== undefined && msg.id !== null ? pending.get(msg.id) : undefined
    if (p) { pending.delete(msg.id); p(msg) }
  })
  let next = 1
  const call = (method, params) => new Promise((resolve) => {
    const id = next++
    pending.set(id, resolve)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
  const stop = () => new Promise((resolve) => { child.once('exit', resolve); child.stdin.end() })
  return { call, stop }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-mcp-'))
let fileNo = 0
function liveFile(port) {
  fileNo += 1
  const file = path.join(tmp, `run-${fileNo}`, 'port.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify({ port, wsPort: port + 1, pid: process.pid, startedAt: Date.now(), instanceId: INSTANCE })}\n`)
  return file
}

const TOOL_TABLE = { tools: [{ name: 'crm_search', description: 'keres', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }] }

test('tools/list comes from the host, so the extension stays the only place a tool is defined', async () => {
  const host = await fakeHost(({ url }) => (
    url === '/api/extensions/crm.mjs/call/mcpTools' ? { status: 200, json: TOOL_TABLE } : { status: 404, json: {} }
  ))
  const shim = startShim({ SWARMCLAW_PORT_FILE: liveFile(host.port), SWARMCLAW_ACCESS_KEY: 'kulcs' })
  try {
    const init = await shim.call('initialize', {})
    assert.equal(init.result.serverInfo.name, 'swarmclaw-crm')
    const list = await shim.call('tools/list', {})
    assert.deepEqual(list.result.tools.map((t) => t.name), ['crm_search'])
    const asked = host.seen.find((r) => r.url.endsWith('/mcpTools'))
    assert.equal(asked.key, 'kulcs', 'the access key is sent, or an authenticated host answers 401')
  } finally {
    await shim.stop()
    await host.close()
  }
})

test('tools/call forwards the caller the host stamped into the env, never an argument', async () => {
  // Ez a stancolás egész indoka: az MCP nem visz hívó-azonosítót, tehát egy
  // olyan tool, ami a "melyik ügynök kérdez"-re kapuz, elvesztené a kapuját,
  // amint egy shim mögé kerül.
  const host = await fakeHost(({ url, body }) => (
    url.endsWith('/mcpTools') ? { status: 200, json: TOOL_TABLE } : { status: 200, json: { got: body } }
  ))
  const shim = startShim({
    SWARMCLAW_PORT_FILE: liveFile(host.port),
    SWARMCLAW_AGENT_ID: 'agent-7',
    SWARMCLAW_AGENT_NAME: 'Ügyfélkezelő',
    SWARMCLAW_SESSION_ID: 'sess-9',
  })
  try {
    const r = await shim.call('tools/call', { name: 'crm_search', arguments: { agentId: 'HAZUDIK' } })
    const sent = JSON.parse(r.result.content[0].text).got
    assert.equal(sent.agentId, 'agent-7')
    assert.equal(sent.agentName, 'Ügyfélkezelő')
    assert.equal(sent.sessionId, 'sess-9')
    // Egy ügynök, aki magát nevezi meg az argumentumokban, nem válhat hívóvá:
    // az érv az `args`-ban marad, ahol a tool adatnak látja.
    assert.deepEqual(sent.args, { agentId: 'HAZUDIK' })
  } finally {
    await shim.stop()
    await host.close()
  }
})

test('an unstamped shim sends no caller at all rather than an empty one', async () => {
  const host = await fakeHost(({ url, body }) => (
    url.endsWith('/mcpTools') ? { status: 200, json: TOOL_TABLE } : { status: 200, json: { got: body } }
  ))
  const shim = startShim({ SWARMCLAW_PORT_FILE: liveFile(host.port), SWARMCLAW_AGENT_ID: '  ' })
  try {
    const r = await shim.call('tools/call', { name: 'crm_search', arguments: {} })
    const sent = JSON.parse(r.result.content[0].text).got
    assert.equal(sent.agentId, undefined, 'a blank id would defeat the extension\'s own fallback')
    assert.equal(sent.agentName, undefined)
  } finally {
    await shim.stop()
    await host.close()
  }
})

test('a host that is down answers tools/list with an empty list, not a protocol error', async () => {
  // Egy MCP kliens, ami elbukik egy tools/list-en, a legtöbb esetben eldobja
  // a szervert az egész munkamenetre, tehát egy röviden leálló host az
  // ügynöknek a tool-jaiba kerülne a következő fordulóig.
  const shim = startShim({ SWARMCLAW_PORT_FILE: path.join(tmp, 'nincs-ilyen', 'port.json') })
  try {
    const list = await shim.call('tools/list', {})
    assert.deepEqual(list.result.tools, [])
  } finally {
    await shim.stop()
  }
})

test('a tool error from the host comes back as isError, and a value comes back as a value', async () => {
  const host = await fakeHost(({ url, body }) => {
    if (url.endsWith('/mcpTools')) return { status: 200, json: TOOL_TABLE }
    return { status: 200, json: body.args.rossz ? { error: { code: 'x', message: 'nem ment' } } : { ok: true } }
  })
  const shim = startShim({ SWARMCLAW_PORT_FILE: liveFile(host.port) })
  try {
    const bad = await shim.call('tools/call', { name: 'crm_search', arguments: { rossz: true } })
    assert.equal(bad.result.isError, true)
    const good = await shim.call('tools/call', { name: 'crm_search', arguments: {} })
    assert.equal(good.result.isError, false)
  } finally {
    await shim.stop()
    await host.close()
  }
})

test('a 404 from the host names the extension rather than the tool', async () => {
  // Az ügynök nem olvashatja úgy egy 404-et, hogy "az extension nincs
  // telepítve" helyett "rosszul hívtam a toolt", és nem próbálkozhat más
  // argumentumokkal.
  const host = await fakeHost(({ url }) => (url.endsWith('/mcpTools') ? { status: 200, json: TOOL_TABLE } : { status: 404, json: {} }))
  const shim = startShim({ SWARMCLAW_PORT_FILE: liveFile(host.port) })
  try {
    const r = await shim.call('tools/call', { name: 'crm_search', arguments: {} })
    assert.equal(r.result.isError, true)
    assert.equal(JSON.parse(r.result.content[0].text).error.code, 'extension_hianyzik')
  } finally {
    await shim.stop()
    await host.close()
  }
})

test('a bad tool name and an unknown method are refused by their JSON-RPC code, with no call sent', async () => {
  const host = await fakeHost(({ url }) => (url.endsWith('/mcpTools') ? { status: 200, json: TOOL_TABLE } : { status: 200, json: {} }))
  const shim = startShim({ SWARMCLAW_PORT_FILE: liveFile(host.port) })
  try {
    assert.equal((await shim.call('tools/call', { name: 'nem-azonosito!', arguments: {} })).error.code, -32602)
    assert.equal((await shim.call('tools/call', { name: 'crm_search', arguments: 'nem objektum' })).error.code, -32602)
    assert.equal((await shim.call('nincs/ilyen', {})).error.code, -32601)
    assert.equal(host.seen.some((r) => r.url.endsWith('/mcpCall')), false, 'nothing reached the host')
  } finally {
    await shim.stop()
    await host.close()
  }
})

test('the shim exits when its stdin closes', async () => {
  const shim = startShim({ SWARMCLAW_PORT_FILE: liveFile(1) })
  const code = await shim.stop()
  assert.equal(code, 0)
})
