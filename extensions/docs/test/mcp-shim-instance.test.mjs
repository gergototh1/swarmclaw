import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * The shim must talk to the host that STARTED it, not to whichever SwarmClaw
 * last wrote the port file.
 *
 * The incident: a second server sharing one SWARMCLAW_HOME rewrote
 * `run/port.json`, so the desktop app's shims reached the dev server — which
 * refuses the desktop app's access key. Check 4 did not catch it, because it
 * compared the port file's own token against the healthz answer of the host
 * that had just written that file: circular, and both instances pass it. The
 * host now stamps SWARMCLAW_INSTANCE_ID into the shim's env, and that is what
 * check 4 compares against.
 *
 * Why this matters more than the usual misconfiguration: a refused request
 * becomes an EMPTY tool list, not an error. `listTools()` swallows the failure
 * on purpose so a briefly-unreachable host does not cost the agent its server
 * for a whole session. So the whole visible symptom is an agent that silently
 * has no tools, which reads as the CLI dropping the server.
 */

const SHIM = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'mcp', 'server.mjs')

/** A host that answers healthz as `instanceId` and serves one tool. */
async function fakeHost(instanceId) {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url === '/api/healthz') {
      res.end(JSON.stringify({ ok: true, service: 'swarmclaw', instanceId }))
      return
    }
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      if (req.url.endsWith('/call/mcpTools')) {
        res.end(JSON.stringify({ tools: [{ name: 'docs_list', description: 'x', parameters: { type: 'object' } }] }))
        return
      }
      res.end(JSON.stringify({ instructions: '' }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, port: server.address().port }
}

/** Drive the shim through initialize + tools/list and return the tool names it served. */
async function listToolsFrom(env) {
  const child = spawn(process.execPath, [SHIM], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
  let out = ''
  let err = ''
  child.stdout.on('data', (c) => { out += c })
  child.stderr.on('data', (c) => { err += c })
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`)
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`)
  const exited = new Promise((resolve) => child.on('exit', resolve))
  const timer = setTimeout(() => child.kill(), 15_000)
  child.stdin.end()
  await exited
  clearTimeout(timer)
  const listing = out.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((m) => m.id === 2)
  return { names: (listing?.result?.tools ?? []).map((t) => t.name), stderr: err }
}

test('the shim serves its tools when it reaches the instance that started it', async () => {
  const { server, port } = await fakeHost('instance-A')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-inst-'))
  const file = path.join(dir, 'port.json')
  fs.writeFileSync(file, JSON.stringify({ port, wsPort: port + 1, pid: process.pid, startedAt: Date.now(), instanceId: 'instance-A' }))
  try {
    const { names } = await listToolsFrom({ SWARMCLAW_PORT_FILE: file, SWARMCLAW_INSTANCE_ID: 'instance-A', SWARMCLAW_ACCESS_KEY: '' })
    assert.deepEqual(names, ['docs_list'])
  } finally {
    server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the shim refuses a host that is not the one that started it, even when the port file agrees with that host', async () => {
  // Exactly the incident's shape: the OTHER SwarmClaw is on the port and it
  // wrote the port file, so the file's own token matches what healthz answers.
  // Only the env stamp knows the difference.
  const { server, port } = await fakeHost('instance-B')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-inst-'))
  const file = path.join(dir, 'port.json')
  fs.writeFileSync(file, JSON.stringify({ port, wsPort: port + 1, pid: process.pid, startedAt: Date.now(), instanceId: 'instance-B' }))
  try {
    const { names, stderr } = await listToolsFrom({ SWARMCLAW_PORT_FILE: file, SWARMCLAW_INSTANCE_ID: 'instance-A', SWARMCLAW_ACCESS_KEY: '' })
    assert.deepEqual(names, [], 'the shim served tools from a foreign instance')
    assert.match(stderr, /DIFFERENT SwarmClaw instance/, `expected the reason on stderr, got: ${stderr}`)
  } finally {
    server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('without the stamp the shim falls back to the port file, so an older config still works', async () => {
  const { server, port } = await fakeHost('instance-B')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-inst-'))
  const file = path.join(dir, 'port.json')
  fs.writeFileSync(file, JSON.stringify({ port, wsPort: port + 1, pid: process.pid, startedAt: Date.now(), instanceId: 'instance-B' }))
  try {
    const { names } = await listToolsFrom({ SWARMCLAW_PORT_FILE: file, SWARMCLAW_INSTANCE_ID: '', SWARMCLAW_ACCESS_KEY: '' })
    assert.deepEqual(names, ['docs_list'])
  } finally {
    server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
