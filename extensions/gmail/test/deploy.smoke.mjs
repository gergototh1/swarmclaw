import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { DatabaseSync } from 'node:sqlite'

import { MIGRATIONS } from '../src/db.mjs'
import { HEALTH_CODES } from '../src/health.mjs'

/**
 * The gmail extension on a deployed host, checked over the wire.
 *
 * The unit suite runs this module's code under `tsx` in this checkout, and the
 * MCP shim's suite drives the shim against a fake host in the same process --
 * one that writes its own port file and answers `service: "swarmclaw"` by
 * construction. Both prove this repository consistent with itself and neither
 * proves the contract with a running SwarmClaw. That is what this script is
 * for, and step 6 below is the first thing that runs THIS module's shipped shim
 * against a real host: the host writes `run/port.json` where index.mjs computes
 * it, the shim reads it, all four of its checks pass, and the outbound queue
 * comes back through the same rpc the page calls.
 *
 * IT IS ALSO THE ONLY CHECK THAT AN ENABLED EXTENSION ACTUALLY LOADED. The host
 * reports an external file as `enabled: true` whether or not it ever loaded, so
 * "it is in the list" proves nothing. Two separate causes made a module on this
 * branch load nowhere while the card said enabled -- `require(esm)` failing
 * under Electron's Node, and a contract `summary` of 223 characters against a
 * 200-character cap failing every load at `load.contracts` -- and both were
 * silent. `hasUI`, `contractsProvided` and an absent `lastFailureError` are the
 * fields only a loaded module has, and this module declares no tools, so
 * `toolCount` cannot stand in for them the way it can elsewhere: 0 is what a
 * loaded gmail and a never-loaded anything both report.
 *
 * It takes a server that is already running and, in order:
 *
 *   1. waits for `/api/healthz` and signs in with the server's access key;
 *   2. reads `/api/extensions` and requires the fields only a loaded extension
 *      has, `contractsProvided` naming `mailbox` v1, and no recorded failure;
 *   3. requires the page in `/api/extensions/ui?type=pages`, with its script
 *      and stylesheet served from the workspace's `dist`;
 *   4. requires `/x/gmail` to answer with the shell rather than a redirect;
 *   5. calls `health`, `board` and `mcpConfig` over rpc: every reported code is
 *      one this module's own vocabulary has a sentence for, no answer carries a
 *      credential or a key, an unknown method is a 404 rather than a crash, and
 *      the port file `mcpConfig` names exists and holds a live pid from this
 *      host -- the host's side of the port-file contract, on a running host;
 *   5b. with SWARMCLAW_DEPLOY_EXPECT_MODE set: requires the deploy mode this
 *      module reports to be the one the deployment actually runs in, which is
 *      what decides whether the page names the Desktop-app pair or the Web
 *      pair as the remedy. The desktop app sets it in
 *      `electron/server-lifecycle.ts` and the image bakes it into the
 *      `Dockerfile`, and neither of those is visible from inside a unit test;
 *   6. starts the shipped shim with exactly the `command`, `args` and `env`
 *      `mcpConfig` printed, plus this run's own access key, and requires
 *      `tools/list` to answer with the six tools and `gmail_outbox` to come
 *      back with the running host's own outbound queue;
 *   7. with DATA_DIR set: requires every migration to have been applied through
 *      the host's own database driver, the four tables to be there, and the
 *      installed workspace to hold no native module.
 *
 * NOTHING HERE REACHES GOOGLE. Every method it calls -- `health`, `board`,
 * `outbox`, `mcpConfig` -- answers from this host's own database, and the one
 * that would make a network call (`health`'s profile read) only makes it when a
 * credential is stored, which on a scratch data directory there is not. A
 * deployment WITH a mailbox connected is still safe: the profile read is a
 * read, and this script never drafts, never labels and never releases.
 *
 * Run it against a server on any host:
 *
 *   SWARMCLAW_DEPLOY_BASE_URL=http://127.0.0.1:3518 \
 *   SWARMCLAW_DEPLOY_ACCESS_KEY=... DATA_DIR=/path/to/data \
 *   node extensions/gmail/test/deploy.smoke.mjs
 *
 * SWARMCLAW_DEPLOY_EXPECT_MODE is `desktop` or `vps` -- what the deployment
 * being tested runs in. Without it step 5b is skipped and reported as skipped,
 * never as passed.
 *
 * DATA_DIR is the directory holding that server's `swarmclaw.db`. In a
 * container, run the script inside the container so the file is local to it;
 * SQLite's WAL locking does not survive a bind mount shared with another
 * process on the host. Without DATA_DIR step 7 is skipped and reported as
 * skipped, never as passed.
 *
 * The key is never printed and never written anywhere: it goes into the shim's
 * environment and into request headers, and nowhere else.
 */

const EXTENSION_ID = 'gmail.mjs'
const PAGE_PATH = '/x/gmail'
const HEALTH_TIMEOUT_MS = 120_000
const LOAD_TIMEOUT_MS = 120_000
const SHIM_TIMEOUT_MS = 30_000

/** The six tools the shim offers, sorted. Written out: this list is the agent-facing surface. */
const SHIM_TOOLS = ['gmail_draft', 'gmail_label', 'gmail_labels', 'gmail_outbox', 'gmail_read', 'gmail_search']

/** The tables MIGRATIONS leave behind, sorted. */
const TABLAK = ['ext_gmail_cimzettek', 'ext_gmail_kimeno', 'ext_gmail_kiserletek', 'ext_gmail_napi']

/**
 * Words that must not appear in any answer this script reads.
 *
 * This module holds a Google refresh token, which is the one credential in the
 * product that can send mail, and every one of its answers is built by hand out
 * of named fields precisely so no part of it can ride out. That is an argument,
 * not evidence; these are the strings that would be there if the argument were
 * wrong. `access_token` and `refresh_token` are the field names Google's own
 * token endpoint uses, so a token object spread into an answer anywhere carries
 * them; `CLIENT_SECRET` is how the host's environment names the other half.
 */
const TILTOTT = ['refresh_token', 'access_token', 'CLIENT_SECRET']

const baseUrl = (process.env.SWARMCLAW_DEPLOY_BASE_URL || '').replace(/\/+$/, '')
const accessKey = process.env.SWARMCLAW_DEPLOY_ACCESS_KEY || process.env.ACCESS_KEY || ''
const dataDir = process.env.DATA_DIR || ''
/**
 * The deploy mode this deployment is supposed to be running in, named by
 * whoever started the server. It is not a second source of truth for the mode:
 * the mode is the server process's own `SWARMCLAW_DEPLOY_MODE`, and this is
 * only what the run requires the module to report back, so that a deployment
 * whose mode never reached the extension fails here instead of quietly naming
 * the wrong pair of environment variables on the operator's status bar.
 */
const expectedDeployMode = (process.env.SWARMCLAW_DEPLOY_EXPECT_MODE || '').trim()

/** Which OAuth client pair a deploy mode makes the host read. */
const CLIENT_PAIR = { desktop: 'GOOGLE_OAUTH_CLIENT_DESKTOP_*', vps: 'GOOGLE_OAUTH_CLIENT_WEB_*' }

if (!baseUrl) throw new Error('SWARMCLAW_DEPLOY_BASE_URL is required: the base url of the running server')
if (!accessKey) throw new Error('SWARMCLAW_DEPLOY_ACCESS_KEY (or ACCESS_KEY) is required: the running server\'s access key')

let passed = 0
function log(message) {
  console.log(`[gmail deploy] ${message}`)
}

async function check(label, fn) {
  try {
    const detail = await fn()
    passed += 1
    log(`ok   ${label}${detail ? ` (${detail})` : ''}`)
    return detail
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
    body: JSON.stringify({ setupCompleted: true, userName: 'Gmail deploy smoke' }),
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
 * No secret is in this answer.
 *
 * The access key is a value this script holds, so finding it in a response body
 * would be a live leak. The Google tokens are values this script does not hold,
 * so what can be checked about them is structural: the field names a leaked
 * token object would arrive under.
 */
function assertNoSecret(what, text) {
  assert.ok(!text.includes(accessKey), `${what} carries the access key value`)
  for (const word of TILTOTT) {
    assert.ok(!text.includes(word), `${what} carries "${word}"`)
  }
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
 * A conversation with the shipped shim, started the way the host's MCP client
 * starts it: the `command`, `args` and `env` the running host just printed in
 * `mcpConfig`, and nothing this script chose for itself.
 *
 * Taking the command from the answer rather than substituting `process.execPath`
 * is the point. The entry an operator copies into Settings > MCP Servers is the
 * thing being tested, and on a packaged desktop app that entry has to name a
 * runtime the host's own environment can actually spawn -- the host's `PATH`
 * there is `/usr/bin:/bin:/usr/sbin:/sbin`, where no Node installation lives. A
 * smoke that spawned its own Node would pass on exactly the deployment where
 * the operator's copy of that entry does not run.
 *
 * One child answers both requests, because the four port-file checks run on
 * every call and a second process would only repeat the first one's.
 */
function shimSession(command, shimPath, env, requests) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [shimPath], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
    const stderr = []
    const answers = new Map()
    child.stderr.on('data', (c) => stderr.push(c.toString('utf8')))
    const fail = (message) => {
      clearTimeout(timer)
      child.kill('SIGKILL')
      reject(new Error(`${message}${stderr.length ? `; stderr: ${stderr.join('')}` : ''}`))
    }
    const timer = setTimeout(() => fail(`the shim did not answer in ${SHIM_TIMEOUT_MS / 1000}s`), SHIM_TIMEOUT_MS)
    const lines = readline.createInterface({ input: child.stdout })
    lines.on('line', (line) => {
      let msg
      try { msg = JSON.parse(line) } catch { return }
      if (typeof msg.id !== 'number' || msg.id < 2) return
      answers.set(msg.id, msg)
      if (answers.size < requests.length) return
      clearTimeout(timer)
      child.stdin.end()
      resolve(requests.map((_, i) => answers.get(i + 2)))
    })
    child.once('error', (err) => { clearTimeout(timer); reject(err) })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'deploy-smoke', version: '0' } } })}\n`)
    requests.forEach((req, i) => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: i + 2, ...req })}\n`)
    })
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
      // This module declares no tools, so toolCount cannot separate a loaded
      // module from a never-loaded one: hasUI and the provided contract are the
      // two fields only a loaded module has.
      return found.hasUI === true && (found.contractsProvided || []).length > 0 ? found : undefined
    }, LOAD_TIMEOUT_MS).catch(async (err) => {
      const res = await fetchJson(`${baseUrl}/api/extensions`, { headers })
      const found = Array.isArray(res.body) ? res.body.find((m) => m?.filename === EXTENSION_ID) : null
      throw new Error(`${err.message}; last listing: ${JSON.stringify(found)}`)
    })
    assert.equal(entry.enabled, true, 'enabled')
    assert.equal(entry.name, 'Gmail', 'name is the one index.mjs declares, not the filename')
    assert.equal(entry.version, '0.1.0', 'version is the one index.mjs declares')
    assert.equal(entry.hasUI, true, 'hasUI')
    assert.equal(entry.toolCount ?? 0, 0, 'toolCount: this extension declares no tools by design')
    assert.equal(entry.autoDisabled, false, 'autoDisabled')
    assert.equal(entry.lastFailureError, undefined, `a failure is recorded: ${entry.lastFailureStage} ${entry.lastFailureError}`)
    // No managed agent and no managed schedule (spec 11.10): this is the fact
    // that makes Reconcile unnecessary for this module, and if it ever stopped
    // being true the installer's report would be telling operators to skip a
    // step they now need.
    assert.equal(entry.managedAgentCount ?? 0, 0, 'managedAgentCount')
    assert.equal(entry.managedScheduleCount ?? 0, 0, 'managedScheduleCount')
    assert.deepEqual(
      (entry.contractsProvided || []).map((c) => ({ contract: c.contract, version: c.version })),
      [{ contract: 'mailbox', version: 1 }],
      'contractsProvided',
    )
    return `name=${entry.name} tools=${entry.toolCount ?? 0} contract=mailbox v1 managed=0/0`
  })

  const page = await check('page is declared and its assets are served from dist', async () => {
    const res = await fetchJson(`${baseUrl}/api/extensions/ui?type=pages`, { headers })
    assert.ok(res.ok && Array.isArray(res.body), `GET /api/extensions/ui?type=pages answered ${res.status}`)
    const found = res.body.find((p) => p?.path === PAGE_PATH)
    assert.ok(found, `${PAGE_PATH} is not among the pages: ${JSON.stringify(res.body.map((p) => p?.path))}`)
    assert.equal(found.extensionId, EXTENSION_ID)
    assert.equal(found.entry, 'dist/index.js', 'entry')
    assert.equal(found.css, 'dist/style.css', 'css')
    const assetUrl = (rel) => `${baseUrl}/api/extensions/${encodeURIComponent(found.extensionId)}/assets/${rel.slice('dist/'.length)}`
    const script = await fetchRaw(assetUrl(found.entry), { headers })
    assert.equal(script.status, 200, `script ${found.entry} answered ${script.status}`)
    assert.match(script.headers.get('content-type') || '', /javascript/, 'script content-type')
    assert.ok(script.text.includes('registerPage'), 'the served bundle registers a page')
    assert.ok(!/\bfunction useState\b/.test(script.text), 'the served bundle must not carry its own React')
    const style = await fetchRaw(assetUrl(found.css), { headers })
    assert.equal(style.status, 200, `stylesheet ${found.css} answered ${style.status}`)
    assert.match(style.headers.get('content-type') || '', /text\/css/, 'stylesheet content-type')
    return `entry=${found.entry} (${script.text.length} bytes) css=${style.text.length} bytes`
  })

  await check(`${PAGE_PATH} answers with the shell`, async () => {
    const res = await fetchRaw(`${baseUrl}${PAGE_PATH}`, { headers: { Cookie: headers.Cookie } })
    assert.equal(res.status, 200, `answered ${res.status}${res.headers.get('location') ? ` -> ${res.headers.get('location')}` : ''}`)
    assert.match(res.headers.get('content-type') || '', /text\/html/, 'content-type')
    assert.ok(res.text.includes('<div'), 'the html is not a shell')
    return `${res.text.length} bytes`
  })

  let health = null
  await check('rpc health answers its own vocabulary and no secret', async () => {
    const res = await rpc(headers, 'health')
    health = res.body
    assert.equal(res.status, 200, `answered ${res.status}: ${JSON.stringify(res.body)}`)
    const body = res.body
    assert.equal(typeof body?.ok, 'boolean', 'ok')
    for (const list of ['hibak', 'figyelmeztetesek', 'nemValaszolt', 'blokkolt']) {
      assert.ok(Array.isArray(body?.[list]), list)
    }
    // Every reported code has to be one this module has a sentence for. A code
    // the page cannot word is a status bar that shows a blank line where the
    // one wall in the way should be, which is how an install that did nothing
    // comes to look like an install that worked.
    for (const item of [...body.hibak, ...body.figyelmeztetesek]) {
      assert.ok(HEALTH_CODES.includes(item?.kod), `health reported ${JSON.stringify(item?.kod)}, which is outside HEALTH_CODES`)
    }
    assert.equal(typeof body?.keretek?.nap, 'string', 'keretek.nap')
    assert.equal(typeof body?.szamok?.cimzettek, 'number', 'szamok.cimzettek')
    assert.equal(typeof body?.szamok?.bizonytalan, 'number', 'szamok.bizonytalan')
    assert.equal(typeof body?.portFajl?.utvonal, 'string', 'portFajl.utvonal')
    // The mailbox address is either a string or null. `postafiok` being absent
    // and being null are different claims and only the second is one this
    // module makes.
    assert.ok(body.postafiok === null || typeof body.postafiok === 'string', 'postafiok')
    assertNoSecret('health', res.text)
    const kodok = [...body.hibak, ...body.figyelmeztetesek].map((h) => h.kod)
    return `ok=${body.ok} kodok=${kodok.join(',') || 'none'} blokkolt=${body.blokkolt.join(',') || 'none'}`
  })

  // The mode is only observable in the detail of `google_oauth_client_missing`,
  // which is the one place it changes what the operator is told to do. On a
  // host that HAS a client configured the code is absent and there is nothing
  // to read, so the run says so rather than passing a check it did not make.
  const klienshiany = (health?.hibak || []).find((h) => h?.kod === 'google_oauth_client_missing') || null
  if (!expectedDeployMode) {
    log('skip the deploy-mode check: SWARMCLAW_DEPLOY_EXPECT_MODE not set (whoever starts the server names the deployment)')
  } else if (!klienshiany) {
    log('skip the deploy-mode check: a Google client is configured on this host, so health does not report which pair to set')
  } else {
    await check('the deploy mode the module reports is the one this deployment runs in', async () => {
      assert.ok(
        Object.hasOwn(CLIENT_PAIR, expectedDeployMode),
        `SWARMCLAW_DEPLOY_EXPECT_MODE=${JSON.stringify(expectedDeployMode)} is neither "desktop" nor "vps"`,
      )
      assert.equal(
        klienshiany.mode,
        expectedDeployMode,
        `the module reports deploy mode ${JSON.stringify(klienshiany.mode)} on a deployment running in ${JSON.stringify(expectedDeployMode)}; `
        + 'the page would name the wrong pair of environment variables as the remedy',
      )
      return `mode=${klienshiany.mode} -> the page names ${CLIENT_PAIR[klienshiany.mode]}`
    })
  }

  const board = await check('rpc board answers with the queue and the book, and no secret', async () => {
    const res = await rpc(headers, 'board')
    assert.equal(res.status, 200, `answered ${res.status}: ${JSON.stringify(res.body)}`)
    assert.equal(typeof res.body?.health?.ok, 'boolean', 'health.ok')
    assert.ok(Array.isArray(res.body?.kimeno?.items), 'kimeno.items')
    assert.equal(typeof res.body?.kimeno?.total, 'number', 'kimeno.total')
    assert.equal(typeof res.body?.kimenoLimit, 'number', 'kimenoLimit')
    assert.ok(Array.isArray(res.body?.konyv), 'konyv')
    assertNoSecret('board', res.text)
    return `kimeno=${res.body.kimeno.total} konyv=${res.body.konyv.length}`
  })

  await check('rpc refuses an unknown method with 404 rather than crashing', async () => {
    const res = await rpc(headers, 'no-such-method')
    assert.equal(res.status, 404, `answered ${res.status}`)
  })

  const mcp = await check('rpc mcpConfig names a port file this running host actually wrote', async () => {
    const res = await rpc(headers, 'mcpConfig')
    assert.equal(res.status, 200, `answered ${res.status}: ${JSON.stringify(res.body)}`)
    assert.equal(res.body?.transport, 'stdio')
    assert.ok(Array.isArray(res.body?.args) && res.body.args.length === 1, 'args')
    assert.ok(fs.existsSync(res.body.args[0]), `the shim is not at ${res.body.args[0]}`)
    // The host spawns an MCP server with its own environment, so a bare `node`
    // here would be looked up in the host's PATH -- and a packaged desktop
    // app's PATH is `/usr/bin:/bin:/usr/sbin:/sbin`, where no Node installation
    // puts a binary. On this deployment, whatever it names has to be there.
    const command = res.body?.command
    assert.equal(typeof command, 'string', 'command')
    assert.ok(path.isAbsolute(command), `command "${command}" is a name to look up, not a path`)
    assert.ok(fs.existsSync(command), `command names ${command}, which does not exist on this host`)
    // The access key is named by its variable and never by its value.
    assertNoSecret('mcpConfig', res.text)
    assert.equal(typeof res.body?.env?.SWARMCLAW_ACCESS_KEY, 'string', 'env.SWARMCLAW_ACCESS_KEY')
    // The port file is the host's half of the contract the shim reads: the file
    // has to exist, parse, name a live pid, and name the port this smoke is
    // talking to. index.mjs computes that path from a copy of the host's own
    // rule, and this is the only place the copy is compared with the original.
    const portFile = res.body?.env?.SWARMCLAW_PORT_FILE
    assert.equal(typeof portFile, 'string', 'env.SWARMCLAW_PORT_FILE')
    assert.ok(fs.existsSync(portFile), `the host wrote no port file at ${portFile}`)
    const parsed = JSON.parse(fs.readFileSync(portFile, 'utf8'))
    assert.ok(Number.isInteger(parsed.port) && parsed.port > 0 && parsed.port < 65536, `port ${parsed.port}`)
    assert.ok(Number.isInteger(parsed.pid) && parsed.pid > 0, `pid ${parsed.pid}`)
    assert.ok(pidAlive(parsed.pid), `the pid in the port file (${parsed.pid}) is not alive`)
    assert.ok(baseUrl.endsWith(`:${parsed.port}`), `the port file names ${parsed.port}, this smoke is talking to ${baseUrl}`)
    // `health` reports the same path from inside the host, and both come from
    // the one `resolvePortFile` in index.mjs. If they ever differed, the status
    // bar would be describing a file the MCP entry does not use -- one of them
    // green while an agent's shim looks somewhere else.
    const fromHealth = (await rpc(headers, 'health')).body?.portFajl
    assert.equal(fromHealth?.utvonal, portFile, 'health and mcpConfig name different port files')
    assert.equal(fromHealth?.elo, true, 'health says the port file names no live process from this boot')
    return `${portFile} -> port ${parsed.port}, pid ${parsed.pid}`
  })

  await check('the shipped shim, started exactly as mcpConfig says, lists six tools and reaches the running host', async () => {
    const config = (await rpc(headers, 'mcpConfig')).body
    const direct = (await rpc(headers, 'outbox')).body
    // The operator fills the key in by hand; here the smoke's own key stands in
    // for that step. It goes into the child's environment and nowhere else.
    // Everything but the key comes from the host's own answer, including the
    // command: on the desktop app that is the app's Electron binary plus the
    // ELECTRON_RUN_AS_NODE the entry carries, and this is where that pair is
    // proven to start the shim rather than a browser window.
    const [list, call] = await shimSession(
      config.command,
      config.args[0],
      { ...config.env, SWARMCLAW_ACCESS_KEY: accessKey },
      [
        { method: 'tools/list', params: {} },
        // `gmail_outbox` is the one tool that answers from this host's own
        // database with no Google request behind it, so it exercises the whole
        // chain -- port file, four checks, access key, rpc route, repository --
        // on a deployment with no mailbox connected as well as on one with.
        { method: 'tools/call', params: { name: 'gmail_outbox', arguments: {} } },
      ],
    )
    assert.ok(list?.result, `tools/list answered with an error: ${JSON.stringify(list?.error)}`)
    assert.deepEqual(list.result.tools.map((t) => t.name).sort(), SHIM_TOOLS, 'the six tools')
    assert.ok(call?.result, `gmail_outbox answered with an error: ${JSON.stringify(call?.error)}`)
    assert.equal(call.result.isError, false, `the shim refused: ${call.result.content?.[0]?.text}`)
    const value = JSON.parse(call.result.content[0].text)
    // The same number the rpc answered directly a moment ago, this time found
    // by the shipped shim through the port file the host wrote: the whole
    // contract end to end, on a real host, for the first time.
    assert.equal(value.total, direct.total, 'the shim and the rpc disagree about the outbound total')
    assertNoSecret('the shim answer', call.result.content[0].text)
    return `tools=${list.result.tools.length} outbox total=${value.total}`
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
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'ext_gmail_%' ORDER BY name").all().map((r) => r.name)
        assert.deepEqual(tables, TABLAK, 'tables')
        return `v${latest}, tables ${tables.join(', ')}`
      } finally {
        db.close()
      }
    })

    await check('installed workspace carries no native module', async () => {
      const workspace = path.join(dataDir, 'extensions', '.workspaces', 'gmail_mjs')
      assert.ok(fs.existsSync(path.join(dataDir, 'extensions', EXTENSION_ID)), 'the shim entry is missing')
      assert.ok(fs.existsSync(path.join(workspace, 'index.js')), 'the workspace entry is missing')
      assert.ok(fs.existsSync(path.join(workspace, 'mcp', 'server.mjs')), 'the MCP server is not in the workspace')
      const natives = nativeModulesUnder(workspace)
      assert.deepEqual(natives, [], `native modules found: ${natives.join(', ')}`)
      return workspace
    })
  }

  log(`${passed} checks passed against ${baseUrl} in ${((Date.now() - started) / 1000).toFixed(1)}s`)
  return { meta, page, board, mcp }
}

main().catch((err) => {
  console.error(`[gmail deploy] ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
