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
 * The shim is started with `process.execPath` and no loader: that is the
 * runtime it ships on, the CLI spawning plain `node` in a workspace with no
 * node_modules. Every host here is a local `http` server on 127.0.0.1 that the
 * test itself started; nothing leaves the machine.
 *
 * The port-file contract's four checks are the same code as the tts shim's and
 * are covered there in full; what is tested here is what this shim does
 * differently — it asks the host for its tool table instead of carrying one,
 * and it forwards the caller the host stamped into its env.
 *
 * WHAT THESE TESTS CANNOT SHOW. The fake host answers `service: "swarmclaw"`
 * because this file makes it. So everything below tests the shim against the
 * contract as this repository understands it, and nothing below is evidence
 * that a running SwarmClaw matches that understanding. A live run is the only
 * thing that can confirm it end to end, and it is still owed.
 */
const SHIM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'server.mjs')
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
  const child = spawn(process.execPath, [SHIM], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'inherit'] })
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-mcp-'))
let fileNo = 0
function liveFile(port) {
  fileNo += 1
  const file = path.join(tmp, `run-${fileNo}`, 'port.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify({ port, wsPort: port + 1, pid: process.pid, startedAt: Date.now(), instanceId: INSTANCE })}\n`)
  return file
}

const TOOL_TABLE = { tools: [{ name: 'manage_tasks', description: 'tasks', inputSchema: { type: 'object', properties: {} } }] }

test('tools/list comes from the host, so the extension stays the only place a tool is defined', async () => {
  const host = await fakeHost(({ body }) => (
    body?.op === 'tools' ? { status: 200, json: TOOL_TABLE } : { status: 404, json: {} }
  ))
  const shim = startShim({ SWARMCLAW_PORT_FILE: liveFile(host.port), SWARMCLAW_ACCESS_KEY: 'kulcs' })
  try {
    const init = await shim.call('initialize', {})
    assert.equal(init.result.serverInfo.name, 'swarmclaw-platform')
    const list = await shim.call('tools/list', {})
    assert.deepEqual(list.result.tools.map((t) => t.name), ['manage_tasks'])
    const asked = host.seen.find((r) => r.body?.op === 'tools')
    assert.equal(asked.key, 'kulcs', 'the access key is sent, or an authenticated host answers 401')
  } finally {
    await shim.stop()
    await host.close()
  }
})

test('tools/call forwards the caller the host stamped into the env, never an argument', async () => {
  // This is the whole reason the stamp exists: MCP carries no caller identity,
  // so a tool that gates on "which agent is asking" would otherwise lose the
  // gate the moment it moved behind a shim.
  const host = await fakeHost(({ body }) => (
    body?.op === 'tools' ? { status: 200, json: TOOL_TABLE } : { status: 200, json: { result: { got: body } } }
  ))
  const shim = startShim({
    SWARMCLAW_PORT_FILE: liveFile(host.port),
    SWARMCLAW_AGENT_ID: 'agent-7',
    SWARMCLAW_AGENT_NAME: 'Sidekick',
    SWARMCLAW_SESSION_ID: 'sess-9',
  })
  try {
    const r = await shim.call('tools/call', { name: 'manage_tasks', arguments: { agentId: 'HAZUDIK' } })
    const sent = JSON.parse(r.result.content[0].text).got
    assert.equal(sent.agentId, 'agent-7')
    assert.equal(sent.agentName, 'Sidekick')
    assert.equal(sent.sessionId, 'sess-9')
    // An agent naming itself in the arguments must not become the caller: the
    // argument stays inside `args`, where the tool sees it as data.
    assert.deepEqual(sent.args, { agentId: 'HAZUDIK' })
  } finally {
    await shim.stop()
    await host.close()
  }
})

test('an unstamped shim sends no caller at all rather than an empty one', async () => {
  const host = await fakeHost(({ body }) => (
    body?.op === 'tools' ? { status: 200, json: TOOL_TABLE } : { status: 200, json: { result: { got: body } } }
  ))
  const shim = startShim({ SWARMCLAW_PORT_FILE: liveFile(host.port), SWARMCLAW_AGENT_ID: '  ' })
  try {
    const r = await shim.call('tools/call', { name: 'manage_tasks', arguments: {} })
    const sent = JSON.parse(r.result.content[0].text).got
    assert.equal(sent.agentId, undefined, 'a blank id would defeat the extension\'s own fallback')
    assert.equal(sent.agentName, undefined)
  } finally {
    await shim.stop()
    await host.close()
  }
})

test('a host that is down answers tools/list with an empty list, not a protocol error', async () => {
  // An MCP client that fails tools/list usually drops the server for the whole
  // session, so a host that is briefly down would cost the agent its tools
  // until the next turn.
  const shim = startShim({ SWARMCLAW_PORT_FILE: path.join(tmp, 'nincs-ilyen', 'port.json') })
  try {
    const list = await shim.call('tools/list', {})
    assert.deepEqual(list.result.tools, [])
  } finally {
    await shim.stop()
  }
})

test('a tool error from the host comes back as isError, and a value comes back as a value', async () => {
  const host = await fakeHost(({ body }) => {
    if (body?.op === 'tools') return { status: 200, json: TOOL_TABLE }
    return body.args.rossz ? { status: 400, json: { error: { code: 'x', message: 'nem ment' }, message: 'nem ment' } } : { status: 200, json: { result: { ok: true } } }
  })
  const shim = startShim({ SWARMCLAW_PORT_FILE: liveFile(host.port) })
  try {
    const bad = await shim.call('tools/call', { name: 'manage_tasks', arguments: { rossz: true } })
    assert.equal(bad.result.isError, true)
    const good = await shim.call('tools/call', { name: 'manage_tasks', arguments: {} })
    assert.equal(good.result.isError, false)
  } finally {
    await shim.stop()
    await host.close()
  }
})

test('a 404 from the host says the route is missing, not that the tool is wrong', async () => {
  // The agent must not read "the extension is not installed" as "I called the
  // tool wrongly" and retry with different arguments.
  const host = await fakeHost(({ body }) => (body?.op === 'tools' ? { status: 200, json: TOOL_TABLE } : { status: 404, json: {} }))
  const shim = startShim({ SWARMCLAW_PORT_FILE: liveFile(host.port) })
  try {
    const r = await shim.call('tools/call', { name: 'manage_tasks', arguments: {} })
    assert.equal(r.result.isError, true)
    assert.equal(JSON.parse(r.result.content[0].text).error.code, 'platform_mcp_hianyzik')
  } finally {
    await shim.stop()
    await host.close()
  }
})

test('a bad tool name and an unknown method are refused by their JSON-RPC code, with no call sent', async () => {
  const host = await fakeHost(({ body }) => (body?.op === 'tools' ? { status: 200, json: TOOL_TABLE } : { status: 200, json: {} }))
  const shim = startShim({ SWARMCLAW_PORT_FILE: liveFile(host.port) })
  try {
    assert.equal((await shim.call('tools/call', { name: 'nem-azonosito!', arguments: {} })).error.code, -32602)
    assert.equal((await shim.call('tools/call', { name: 'manage_tasks', arguments: 'nem objektum' })).error.code, -32602)
    assert.equal((await shim.call('nincs/ilyen', {})).error.code, -32601)
    assert.equal(host.seen.some((r) => r.body?.op === 'call'), false, 'nothing reached the host')
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
