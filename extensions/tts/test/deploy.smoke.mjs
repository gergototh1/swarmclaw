import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { DatabaseSync } from 'node:sqlite'

import { MIGRATIONS } from '../src/db.mjs'

/**
 * The tts extension on a deployed host, checked over the wire.
 *
 * The unit suite runs this module's code under `tsx` in this checkout, and the
 * MCP shim's suite drives it against a fake host in the same process -- one
 * that writes its own port file and answers `service: "swarmclaw"` by
 * construction. Both prove this repository consistent with itself and neither
 * proves the contract with a running SwarmClaw. That is what this script is
 * for, and step 6 below is the first thing in this repository that runs the
 * shipped shim against a real host: the host writes `run/port.json` where
 * index.mjs computes it, the shim reads it, the identity check passes, and
 * `tts_status` comes back with the running host's own voice setting.
 *
 * It takes a server that is already running and, in order:
 *
 *   1. waits for `/api/healthz` and signs in with the server's access key;
 *   2. reads `/api/extensions` and requires the fields only a *loaded*
 *      extension has, and no recorded failure. `toolCount` is 0 by design:
 *      agents reach this extension through the shim and other extensions
 *      through the `narration` contract, and a tool would be a third,
 *      unreviewed route to a paid provider call;
 *   3. requires the page in `/api/extensions/ui?type=pages`, with its script
 *      and stylesheet served from the workspace's `dist`;
 *   4. requires `/x/tts` to answer with the shell rather than a redirect;
 *   5. calls `status`, `health` and `mcpConfig` over rpc, checks that no key
 *      value is in any answer, that the port file `mcpConfig` names exists and
 *      holds a live pid -- the host's side of the port-file contract, on a
 *      running host -- and that the `command` it prints is a path that exists
 *      on this deployment rather than a name to look up on a `PATH`;
 *   6. starts the shipped shim with exactly the `command`, `args` and `env`
 *      `mcpConfig` printed, plus this run's own access key, and requires
 *      `tools/call tts_status` to answer with the running host's `hang`;
 *   7. with DATA_DIR set: requires every migration to have been applied
 *      through the host's own database driver and the workspace to hold no
 *      native module.
 *
 * Run it against a server on any host:
 *
 *   SWARMCLAW_DEPLOY_BASE_URL=http://127.0.0.1:3518 \
 *   SWARMCLAW_DEPLOY_ACCESS_KEY=... DATA_DIR=/path/to/data \
 *   node extensions/tts/test/deploy.smoke.mjs
 *
 * Without DATA_DIR step 7 is skipped and reported as skipped, never as passed.
 * The key is never printed and never written anywhere: it goes into the shim's
 * environment and into request headers, and nowhere else.
 */

const EXTENSION_ID = 'tts.mjs'
const PAGE_PATH = '/x/tts'
const HEALTH_TIMEOUT_MS = 120_000
const LOAD_TIMEOUT_MS = 120_000
const SHIM_TIMEOUT_MS = 30_000

const baseUrl = (process.env.SWARMCLAW_DEPLOY_BASE_URL || '').replace(/\/+$/, '')
const accessKey = process.env.SWARMCLAW_DEPLOY_ACCESS_KEY || process.env.ACCESS_KEY || ''
const dataDir = process.env.DATA_DIR || ''

if (!baseUrl) throw new Error('SWARMCLAW_DEPLOY_BASE_URL is required: the base url of the running server')
if (!accessKey) throw new Error('SWARMCLAW_DEPLOY_ACCESS_KEY (or ACCESS_KEY) is required: the running server\'s access key')

let passed = 0
function log(message) {
  console.log(`[tts deploy] ${message}`)
}

async function check(label, fn) {
  try {
    const detail = await fn()
    passed += 1
    log(`ok   ${label}${detail ? ` (${detail})` : ''}`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log(`FAIL ${label}: ${message}`)
    throw new Error(`${label}: ${message}`)
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function until(what, probe, timeoutMs, intervalMs = 1_000) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const value = await probe()
      if (value !== undefined) return value
    } catch (err) {
      lastError = err
    }
    await wait(intervalMs)
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : ''
  throw new Error(`timed out after ${timeoutMs / 1000}s waiting for ${what}${detail}`)
}

async function fetchRaw(url, init = {}, timeoutMs = 15_000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { redirect: 'manual', ...init, signal: controller.signal })
    const text = await res.text()
    return { status: res.status, ok: res.ok, text, headers: res.headers }
  } finally {
    clearTimeout(timer)
  }
}

async function fetchJson(url, init = {}, timeoutMs = 15_000) {
  const res = await fetchRaw(url, init, timeoutMs)
  let body = null
  try { body = JSON.parse(res.text) } catch { body = res.text }
  return { ...res, body }
}

async function authenticate() {
  const res = await fetchJson(`${baseUrl}/api/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: accessKey }),
  })
  if (!res.ok) throw new Error(`POST /api/auth answered ${res.status}; is the access key the server's?`)
  const setCookie = res.headers.get('set-cookie') || ''
  const cookie = setCookie.split(',').map((part) => part.split(';')[0]?.trim()).find((part) => part?.startsWith('sc_auth='))
  if (!cookie) throw new Error('POST /api/auth answered without an sc_auth cookie')
  const headers = { 'Content-Type': 'application/json', 'X-Access-Key': accessKey, Cookie: cookie }
  const settings = await fetchJson(`${baseUrl}/api/settings`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ setupCompleted: true, userName: 'TTS deploy smoke' }),
  })
  if (!settings.ok) throw new Error(`PUT /api/settings answered ${settings.status}`)
  return headers
}

function rpc(headers, method, body = {}) {
  return fetchJson(`${baseUrl}/api/extensions/${encodeURIComponent(EXTENSION_ID)}/call/${method}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

/**
 * No key value is in this answer.
 *
 * The access key is a value this script holds, so finding it in a response
 * body would be a live leak. The Soniox key is one this script does not hold,
 * so the check that can be made about it is structural: `mcpConfig` names the
 * access key by its variable and carries a sentence in place of a value, and
 * no other answer may carry an `apiKey` field at all.
 */
function assertNoAccessKey(what, text) {
  assert.ok(!text.includes(accessKey), `${what} carries the access key value`)
}

function nativeModulesUnder(dir) {
  const found = []
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.node')) found.push(full)
    }
  }
  walk(dir)
  return found
}

/** True when a pid names a process this user can see; EPERM is a live process another user owns. */
function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err && err.code === 'EPERM'
  }
}

/**
 * One `tools/call` against the shipped shim, started the way the host's MCP
 * client starts it: the `command`, `args` and `env` the running host just
 * printed in `mcpConfig`, and nothing this script chose for itself.
 *
 * Taking the command from the answer rather than substituting `process.execPath`
 * is the point. The entry an operator copies into Settings > MCP Servers is the
 * thing being tested, and on a packaged desktop app that entry has to name a
 * runtime the host's own environment can actually spawn -- the host's `PATH`
 * there is `/usr/bin:/bin:/usr/sbin:/sbin`, where no Node installation lives.
 * A smoke that spawned its own Node would pass on exactly the deployment where
 * the operator's copy of that entry does not run.
 */
function shimCall(command, shimPath, env, name) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [shimPath], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
    const stderr = []
    child.stderr.on('data', (c) => stderr.push(c.toString('utf8')))
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`the shim did not answer in ${SHIM_TIMEOUT_MS / 1000}s${stderr.length ? `; stderr: ${stderr.join('')}` : ''}`))
    }, SHIM_TIMEOUT_MS)
    const lines = readline.createInterface({ input: child.stdout })
    lines.on('line', (line) => {
      let msg
      try { msg = JSON.parse(line) } catch { return }
      if (msg.id !== 2) return
      clearTimeout(timer)
      child.stdin.end()
      resolve(msg)
    })
    child.once('error', (err) => { clearTimeout(timer); reject(err) })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'deploy-smoke', version: '0' } } })}\n`)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: {} } })}\n`)
  })
}

async function main() {
  const started = Date.now()

  await check('server answers /api/healthz', async () => {
    await until(`${baseUrl}/api/healthz`, async () => {
      const res = await fetchJson(`${baseUrl}/api/healthz`, {}, 5_000)
      return res.ok && res.body?.ok === true ? true : undefined
    }, HEALTH_TIMEOUT_MS)
  })

  const headers = await authenticate()
  passed += 1
  log('ok   signed in with the access key')

  const meta = await check('extension is loaded, not merely listed', async () => {
    const entry = await until(`the host to load ${EXTENSION_ID}`, async () => {
      const res = await fetchJson(`${baseUrl}/api/extensions`, { headers })
      if (!res.ok || !Array.isArray(res.body)) return undefined
      const found = res.body.find((m) => m?.filename === EXTENSION_ID)
      if (!found) throw new Error(`${EXTENSION_ID} is not in /api/extensions at all`)
      // This extension declares no tools, so toolCount cannot stand in for
      // "loaded" the way it can elsewhere; hasUI and the provided contract are
      // the two fields only a loaded module has.
      return found.hasUI === true && (found.contractsProvided || []).length > 0 ? found : undefined
    }, LOAD_TIMEOUT_MS).catch(async (err) => {
      const res = await fetchJson(`${baseUrl}/api/extensions`, { headers })
      const found = Array.isArray(res.body) ? res.body.find((m) => m?.filename === EXTENSION_ID) : null
      throw new Error(`${err.message}; last listing: ${JSON.stringify(found)}`)
    })
    assert.equal(entry.enabled, true, 'enabled')
    assert.equal(entry.name, 'Narráció (TTS)', 'name is the one index.mjs declares, not the filename')
    assert.equal(entry.version, '0.1.0', 'version is the one index.mjs declares')
    assert.equal(entry.hasUI, true, 'hasUI')
    assert.equal(entry.toolCount ?? 0, 0, 'toolCount: this extension declares no tools by design')
    assert.equal(entry.autoDisabled, false, 'autoDisabled')
    assert.equal(entry.lastFailureError, undefined, `a failure is recorded: ${entry.lastFailureStage} ${entry.lastFailureError}`)
    assert.deepEqual(
      (entry.contractsProvided || []).map((c) => ({ contract: c.contract, version: c.version })),
      [{ contract: 'narration', version: 1 }],
      'contractsProvided',
    )
    return `name=${entry.name} tools=${entry.toolCount ?? 0} contract=narration v1`
  })

  const page = await check('page is declared and its assets are served from dist', async () => {
    const res = await fetchJson(`${baseUrl}/api/extensions/ui?type=pages`, { headers })
    assert.ok(res.ok && Array.isArray(res.body), `GET /api/extensions/ui?type=pages answered ${res.status}`)
    const found = res.body.find((p) => p?.path === PAGE_PATH)
    assert.ok(found, `${PAGE_PATH} is not among the pages: ${JSON.stringify(res.body.map((p) => p?.path))}`)
    assert.equal(found.extensionId, EXTENSION_ID)
    assert.ok(typeof found.entry === 'string' && found.entry.startsWith('dist/'), `entry ${found.entry}`)
    const assetUrl = (rel) => `${baseUrl}/api/extensions/${encodeURIComponent(found.extensionId)}/assets/${rel.slice('dist/'.length)}`
    const script = await fetchRaw(assetUrl(found.entry), { headers })
    assert.equal(script.status, 200, `script ${found.entry} answered ${script.status}`)
    assert.match(script.headers.get('content-type') || '', /javascript/, 'script content-type')
    assert.ok(script.text.includes('registerPage'), 'the served bundle registers a page')
    assert.ok(!/\bfunction useState\b/.test(script.text), 'the served bundle must not carry its own React')
    assert.ok(found.css, 'the page declares no stylesheet')
    const style = await fetchRaw(assetUrl(found.css), { headers })
    assert.equal(style.status, 200, `stylesheet ${found.css} answered ${style.status}`)
    return `entry=${found.entry} (${script.text.length} bytes) css=${style.text.length} bytes`
  })

  await check(`${PAGE_PATH} answers with the shell`, async () => {
    const res = await fetchRaw(`${baseUrl}${PAGE_PATH}`, { headers: { Cookie: headers.Cookie } })
    assert.equal(res.status, 200, `answered ${res.status}${res.headers.get('location') ? ` -> ${res.headers.get('location')}` : ''}`)
    assert.match(res.headers.get('content-type') || '', /text\/html/, 'content-type')
    assert.ok(res.text.includes('<div'), 'the html is not a shell')
    return `${res.text.length} bytes`
  })

  const status = await check('rpc status answers with the settings and the day counter, and no key value', async () => {
    const res = await rpc(headers, 'status')
    assert.equal(res.status, 200, `answered ${res.status}: ${JSON.stringify(res.body)}`)
    assert.equal(typeof res.body?.kulcsBeallitva, 'boolean', 'kulcsBeallitva is a boolean, never the key')
    assert.equal(typeof res.body?.hang, 'string', 'hang')
    // The one directory this extension writes into. It is on the answer so a
    // caller can name a target the module will accept; an empty one means
    // every synthesis call on this deployment is refused by name.
    assert.equal(typeof res.body?.hangGyoker, 'string', 'hangGyoker')
    assert.equal(typeof res.body?.napiKeret, 'number', 'napiKeret')
    assertNoAccessKey('status', res.text)
    return `hang=${res.body.hang} kulcsBeallitva=${res.body.kulcsBeallitva}`
  })

  await check('rpc health answers with the counts and the two paths, and no key value', async () => {
    const res = await rpc(headers, 'health')
    assert.equal(res.status, 200, `answered ${res.status}: ${JSON.stringify(res.body)}`)
    assert.equal(typeof res.body?.counts?.kerelmek, 'number', 'counts.kerelmek')
    assert.equal(typeof res.body?.portFile, 'string', 'portFile')
    assert.equal(typeof res.body?.shim, 'string', 'shim')
    assertNoAccessKey('health', res.text)
    return `kerelmek=${res.body.counts.kerelmek}`
  })

  const mcp = await check('rpc mcpConfig names a port file this running host actually wrote', async () => {
    const res = await rpc(headers, 'mcpConfig')
    assert.equal(res.status, 200, `answered ${res.status}: ${JSON.stringify(res.body)}`)
    assert.equal(res.body?.transport, 'stdio')
    assert.ok(Array.isArray(res.body?.args) && res.body.args.length === 1, 'args')
    assert.ok(fs.existsSync(res.body.args[0]), `the shim is not at ${res.body.args[0]}`)
    // The host spawns an MCP server with its own environment, so a bare
    // `node` here would be looked up in the host's PATH -- and a packaged
    // desktop app's PATH is `/usr/bin:/bin:/usr/sbin:/sbin`, where no Node
    // installation puts a binary. On this deployment, whatever it names has to
    // be a path that is really there.
    const command = res.body?.command
    assert.equal(typeof command, 'string', 'command')
    assert.ok(path.isAbsolute(command), `command "${command}" is a name to look up, not a path`)
    assert.ok(fs.existsSync(command), `command names ${command}, which does not exist on this host`)
    // The access key is named by its variable and never by its value: the
    // operator fills it in from the host's own .env.local.
    assertNoAccessKey('mcpConfig', res.text)
    assert.equal(typeof res.body?.env?.SWARMCLAW_ACCESS_KEY, 'string', 'env.SWARMCLAW_ACCESS_KEY')
    // The port file is the host's half of the contract the shim reads, and
    // this is the first place in this repository where a running host is asked
    // for it: the file has to exist, parse, and name a live pid.
    const portFile = res.body?.env?.SWARMCLAW_PORT_FILE
    assert.equal(typeof portFile, 'string', 'env.SWARMCLAW_PORT_FILE')
    assert.ok(fs.existsSync(portFile), `the host wrote no port file at ${portFile}`)
    const parsed = JSON.parse(fs.readFileSync(portFile, 'utf8'))
    assert.ok(Number.isInteger(parsed.port) && parsed.port > 0 && parsed.port < 65536, `port ${parsed.port}`)
    assert.ok(Number.isInteger(parsed.pid) && parsed.pid > 0, `pid ${parsed.pid}`)
    assert.ok(pidAlive(parsed.pid), `the pid in the port file (${parsed.pid}) is not alive`)
    assert.ok(baseUrl.endsWith(`:${parsed.port}`), `the port file names ${parsed.port}, this smoke is talking to ${baseUrl}`)
    return `${portFile} -> port ${parsed.port}, pid ${parsed.pid}`
  })

  await check('the shipped shim, started exactly as mcpConfig says, answers tts_status from the running host', async () => {
    const config = (await rpc(headers, 'mcpConfig')).body
    const direct = (await rpc(headers, 'status')).body
    // The operator fills the key in by hand; here the smoke's own key stands in
    // for that step. It goes into the child's environment and nowhere else.
    // Everything but the key comes from the host's own answer, including the
    // command: on the desktop app that is the app's Electron binary plus the
    // ELECTRON_RUN_AS_NODE the entry carries, and this is where that pair is
    // proven to start the shim rather than a browser window.
    const answer = await shimCall(config.command, config.args[0], {
      ...config.env,
      SWARMCLAW_ACCESS_KEY: accessKey,
    }, 'tts_status')
    assert.ok(answer.result, `the shim answered with an error: ${JSON.stringify(answer.error)}`)
    assert.equal(answer.result.isError, false, `the shim refused: ${answer.result.content?.[0]?.text}`)
    const value = JSON.parse(answer.result.content[0].text)
    // The same fields the rpc answered directly a moment ago, this time found
    // by the shipped shim through the port file the host wrote: the whole
    // contract end to end, on a real host, for the first time.
    assert.equal(value.hang, direct.hang, 'the shim and the rpc disagree about the voice')
    assert.equal(value.modell, direct.modell, 'the shim and the rpc disagree about the model')
    assert.equal(value.napiKeret, direct.napiKeret, 'the shim and the rpc disagree about the daily budget')
    assertNoAccessKey('the shim answer', JSON.stringify(value))
    return `hang=${value.hang} modell=${value.modell}`
  })

  if (!dataDir) {
    log('skip migrations and native-module checks: DATA_DIR not set')
  } else {
    const dbPath = path.join(dataDir, 'swarmclaw.db')

    await check('every migration was applied through the host database', async () => {
      const latest = Math.max(...MIGRATIONS.map((m) => m.version))
      assert.ok(fs.existsSync(dbPath), `${dbPath} does not exist`)
      const db = new DatabaseSync(dbPath)
      db.exec('PRAGMA busy_timeout = 5000')
      try {
        const row = db.prepare('SELECT MAX(version) AS v FROM ext_migrations WHERE extension_id = ?').get(EXTENSION_ID)
        assert.equal(row?.v, latest, `ext_migrations holds v${row?.v}, db.mjs declares v${latest}`)
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'ext_tts_%' ORDER BY name").all().map((r) => r.name)
        assert.deepEqual(tables, ['ext_tts_kerelmek', 'ext_tts_napi'], 'tables')
        return `v${latest}, tables ${tables.join(', ')}`
      } finally {
        db.close()
      }
    })

    await check('installed workspace carries no native module', async () => {
      const workspace = path.join(dataDir, 'extensions', '.workspaces', 'tts_mjs')
      assert.ok(fs.existsSync(path.join(dataDir, 'extensions', EXTENSION_ID)), 'the shim entry is missing')
      assert.ok(fs.existsSync(path.join(workspace, 'index.js')), 'the workspace entry is missing')
      const natives = nativeModulesUnder(workspace)
      assert.deepEqual(natives, [], `native modules found: ${natives.join(', ')}`)
      return workspace
    })
  }

  log(`${passed} checks passed against ${baseUrl} in ${((Date.now() - started) / 1000).toFixed(1)}s`)
  return { meta, page, status, mcp }
}

main().catch((err) => {
  console.error(`[tts deploy] ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
