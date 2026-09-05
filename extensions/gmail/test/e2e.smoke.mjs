import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright'

import { MIGRATIONS, createRepo, torzsHashOf } from '../src/db.mjs'
import { cimekFejlecbol } from '../src/kiadas.mjs'

/**
 * The gmail page, driven in a real browser.
 *
 * THE ONE ASSERTION THIS FILE EXISTS FOR IS "EXACTLY ONE SEND". This is the
 * only page in the product that can put a letter in front of a stranger, and
 * every other check here is worth less than the three facts around that one
 * click: the letter went out once, to the addresses the page displayed, with
 * the body the page displayed. Nothing below asserts that a send "worked"
 * without also asserting how many sends there were.
 *
 * The unit suite pins everything that can be pinned without a DOM: the
 * repository, the client, the release order, the wording of every sentence,
 * the built bundle's shape. What it cannot see is the page as the host
 * actually serves it -- the bundle loaded through the shell, its hooks running
 * against the host's React, the CSP the shell sends, a keydown React
 * dispatches to a focused control, and the whole release path from a button
 * press to an HTTP request that sends. That is what this file is for. It is a
 * smoke test: one path through the page that fails loudly for a real break and
 * never for a slow machine.
 *
 * What it does, in order:
 *
 *   1. builds the bundle and installs the extension into a scratch data
 *      directory the way `scripts/install.mjs` does for an operator;
 *   2. starts a FAKE GMAIL on a free port -- a plain HTTP server in this
 *      process that answers `users.drafts.get` and `users.drafts.send` -- and
 *      points the scratch install's copy of the extension at it through the
 *      two seams `index.mjs` declares for exactly this (`fetchImpl` and the
 *      token read). See `writeSeam` for what is replaced and what is not:
 *      every other byte of the module, the built bundle included, is the
 *      shipped one, and no request can leave the machine;
 *   3. starts a dev server on a free port with DATA_DIR, WORKSPACE_DIR and
 *      SWARMCLAW_HOME pointed at that scratch directory and every
 *      `GOOGLE_OAUTH_CLIENT_*` variable removed from its environment, so the
 *      host really has no OAuth client and the status bar's first sentence is
 *      the true one rather than a mocked one;
 *   4. requires the extension to have LOADED, not merely to be listed. A
 *      contract `summary` two dozen characters over the host's cap once failed
 *      every load of this module at `load.contracts` while the card still read
 *      "enabled", and a page that never registers looks exactly like a slow
 *      machine unless something asks the host why;
 *   5. seeds the extension's own tables through `createRepo` -- the same code
 *      the rpc writes through -- so a UI break cannot produce an empty fixture
 *      and a green run. The fixture is hostile on purpose: script and image
 *      tags in every text field, a 900-character unbroken word, an address in
 *      the book that has been retired, and one draft whose live copy in the
 *      fake Gmail differs from the stored row;
 *   6. opens `/x/gmail` and checks what the page's own review confirmed by
 *      hand: the connect button disabled with the mode and the env pair beside
 *      it, every hostile field arriving as text, no `<a>` anywhere in this
 *      bundle's DOM, the long word not widening the page;
 *   7. reads and writes the recipient book -- the retired row shown as
 *      retired, a duplicate handle refused by its code, a new handle accepted
 *      -- before anything is sent, so the one step in this file that sends is
 *      reached with no reload in flight;
 *   8. drives the whole release by keyboard -- Enter on the tab, Tab to the
 *      card, Enter to prepare, Space on the gate, Enter on `Kiadás` -- and
 *      then checks the fake Gmail's log: one send, of the draft that was
 *      displayed, with the `megerosites` on the wire equal to the hash on the
 *      screen and to a fingerprint recomputed here over the bytes that
 *      actually went out;
 *   9. asks for the same release a second time over the same door and requires
 *      `gmail_kimeno_allapot` with the send count still one;
 *  10. edits a second draft in the fake Gmail BETWEEN the read and the click
 *      and requires `gmail_lap_elavult` with nothing sent;
 *  11. reads the `bizonytalan` row (its own sentence, and no release control)
 *      and the attempts view, where the two seeded refusals and the two this
 *      run provoked are shown as somebody else's text;
 *  12. fails on any uncaught page error, any CSP violation, any console error,
 *      any window the page tried to open and any request the fake Gmail did
 *      not recognise.
 *
 * Every wait is on a condition, never a sleep. A negative ("no second send",
 * "no url opened") is asserted after a later positive has landed, so a stray
 * action would have shown up in a log before it.
 *
 * Run locally from the repo root:
 *
 *   npm run test:e2e:gmail
 *
 * or `node extensions/gmail/test/e2e.smoke.mjs`. Needs Playwright's Chromium
 * (`npx playwright install chromium` once). It builds and serves the repo it
 * sits in, so run it from a checkout no dev server is already using: `next dev`
 * owns `.next/`, and two of them in one directory fight over it.
 *
 * IT NEVER TALKS TO GOOGLE. The scratch host has no OAuth client and no
 * credential, so nothing in the host would reach Google on its own; the
 * module's own requests go through a `fetchImpl` that refuses any origin but
 * `https://gmail.googleapis.com` and rewrites that one onto the fake Gmail in
 * this process. The access key is minted for the scratch server, never
 * printed, and never written anywhere but the scratch directory, which is
 * removed on exit.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const EXT_ROOT = path.resolve(here, '..')
const REPO_ROOT = path.resolve(EXT_ROOT, '..', '..')
const EXTENSION_ID = 'gmail.mjs'
const PAGE_PATH = '/x/gmail'
const CALL_PREFIX = `/api/extensions/${encodeURIComponent(EXTENSION_ID)}/call/`

/** The first load compiles the route on a dev server; every later wait is on an already compiled page. */
const HEALTH_TIMEOUT_MS = 120_000
const FIRST_LOAD_TIMEOUT_MS = 180_000
const WAIT_MS = 30_000

/** The origin the client is hardcoded to. The seam refuses every other one, so a mistake here is a refusal and never a request. */
const GMAIL_ORIGIN = 'https://gmail.googleapis.com'

/** Markup in every stored text field. Nothing on this page may turn any of it into an element. */
const HTML = '<script>alert(1)</script><img src=x onerror=alert(2)><b>félkövér</b>'

/** 900 characters with no space in them: the layout check's whole point is that this cannot widen the page. */
const HOSSZU_SZO = 'árvíztűrő'.repeat(100)

/** The two book entries. `regi` is retired, which is what makes it count as outside the book at release time. */
const ELO_CIM = 'dorina@example.test'
const VISSZAVONT_CIM = 'regi@example.test'

function log(message) {
  console.log(`[gmail smoke] ${message}`)
}

function elapsed(since) {
  return `${((Date.now() - since) / 1000).toFixed(1)}s`
}

async function step(label, fn) {
  try {
    return await fn()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`${label}: ${message}`)
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Polls `probe` until it returns a value other than undefined, or `what` times out. */
async function until(what, probe, timeoutMs = WAIT_MS, intervalMs = 250) {
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

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => {
        if (typeof address === 'object' && address?.port) resolve(address.port)
        else reject(new Error('could not allocate a free port'))
      })
    })
  })
}

async function fetchJson(url, init = {}, timeoutMs = 10_000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...init, signal: controller.signal })
    const text = await res.text()
    let body = null
    try { body = JSON.parse(text) } catch { body = text }
    return { status: res.status, ok: res.ok, body, headers: res.headers }
  } finally {
    clearTimeout(timer)
  }
}

/* -------------------------------------------------------------------------- */
/*  The fake Gmail                                                            */
/* -------------------------------------------------------------------------- */

const b64url = (text) => Buffer.from(text, 'utf8').toString('base64url')

/**
 * One draft as `users.drafts.get?format=full` returns it.
 *
 * Built to the shape `projectMessage` in src/client.mjs actually reads -- a
 * payload with headers and a base64url `text/plain` body -- rather than to a
 * shape invented here, because the point of a real HTTP double over a stubbed
 * client is that the module's own parsing runs. A draft whose body this
 * function encoded and whose text the release then hashed is the same byte
 * sequence at both ends or the run fails.
 */
function draftResource(draft) {
  return {
    id: draft.draftId,
    message: {
      id: `${draft.draftId}-msg`,
      threadId: `${draft.draftId}-thread`,
      labelIds: ['DRAFT'],
      internalDate: String(Date.UTC(2026, 8, 5, 9, 0)),
      payload: {
        mimeType: 'text/plain',
        headers: [
          { name: 'From', value: 'Smoke Mailbox <smoke@example.test>' },
          { name: 'To', value: draft.to },
          { name: 'Subject', value: draft.subject },
        ],
        body: { data: b64url(draft.text) },
      },
    },
  }
}

/**
 * A Gmail that answers the two calls the release path makes, and records
 * everything.
 *
 * IT IS THE ONLY WITNESS TO A SEND. The page can say a letter went out and the
 * database can hold a row saying so, and neither is evidence: both are written
 * by the code under test. `sends` here is written by the thing that would have
 * been Google, it holds the draft's bytes AS THEY STOOD AT THE MOMENT OF THE
 * SEND, and every "exactly one send" assertion in this file reads it.
 *
 * An unrecognised path is recorded and answered 404 rather than ignored: a
 * release that reached a call this double does not implement would otherwise
 * look like a client bug at a random later assertion.
 */
function startFakeGmail(port) {
  const drafts = new Map()
  const requests = []
  const sends = []
  const unexpected = []
  let sentCount = 0

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const rel = url.pathname.replace(/^\/gmail\/v1\/users\/me/, '')
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let body = null
      try { body = raw === '' ? null : JSON.parse(raw) } catch { body = raw }
      requests.push({ method: req.method, path: rel, body })

      const answer = (status, payload) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(payload))
      }

      const getMatch = rel.match(/^\/drafts\/([^/?]+)$/)
      if (req.method === 'GET' && getMatch) {
        const draft = drafts.get(decodeURIComponent(getMatch[1]))
        if (!draft) return answer(404, { error: { message: 'no such draft' } })
        return answer(200, draftResource(draft))
      }
      if (req.method === 'POST' && rel === '/drafts/send') {
        const draftId = typeof body?.id === 'string' ? body.id : ''
        const draft = drafts.get(draftId)
        if (!draft) return answer(404, { error: { message: 'no such draft' } })
        sentCount += 1
        const messageId = `sent-${sentCount}`
        // The snapshot is the whole point: what went out, at the instant it
        // went out, recorded by the far side rather than by the sender.
        sends.push({ draftId, messageId, draft: { ...draft } })
        drafts.delete(draftId)
        return answer(200, { id: messageId, threadId: `${draftId}-thread`, labelIds: ['SENT'] })
      }
      unexpected.push({ method: req.method, path: rel })
      return answer(404, { error: { message: 'the gmail smoke double does not implement this call' } })
    })
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      resolve({
        server,
        origin: `http://127.0.0.1:${port}`,
        drafts,
        requests,
        sends,
        unexpected,
        put: (draft) => { drafts.set(draft.draftId, { ...draft }) },
        close: () => new Promise((done) => server.close(() => done())),
      })
    })
  })
}

/* -------------------------------------------------------------------------- */
/*  The scratch install, and the two seams                                    */
/* -------------------------------------------------------------------------- */

function runNode(label, script, env) {
  const result = spawnSync(process.execPath, [script], { cwd: path.dirname(script), env, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`${label} failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`)
  }
}

/**
 * Points the scratch install's copy of the extension at the fake Gmail,
 * through the two seams `index.mjs` declares and nothing else.
 *
 * WHAT IS REPLACED, EXACTLY TWO THINGS:
 *
 *   - `state.fetchImpl`, so the module's own HTTP client issues its requests
 *     against this process instead of Google. It refuses any origin but
 *     `https://gmail.googleapis.com`, which is what makes "no request left the
 *     machine" a property of the run rather than a hope;
 *   - `getGoogleAccessToken`, because a scratch host has no credential and the
 *     release path asks for a bearer token before it asks for anything else.
 *     A token is a string here and the fake Gmail does not check it: what is
 *     under test is the release, not the host's OAuth storage, which has its
 *     own suite.
 *
 * WHAT IS NOT REPLACED, and this is the half that matters: everything else.
 * `googleClientConfigured` and `hasGoogleCredential` still answer the host's
 * own truth, which on this scratch install is "no client", so the status bar's
 * first sentence and the disabled connect button are the real ones. The rpc,
 * the release, the confirmation hash, the whole of `client.mjs` including its
 * timeouts and its status handling, the built bundle and the page are the
 * shipped code.
 *
 * IT LIVES ONLY IN THE SCRATCH INSTALL. The repo's own `index.mjs` is
 * untouched; this rewrites the copy `scripts/install.mjs` put in a throwaway
 * data directory, which is deleted when the run ends. The wrapper is inert
 * when the environment variable is absent, so a scratch install made without
 * this smoke behaves like any other.
 */
function writeSeam(workspaceDir) {
  const entry = path.join(workspaceDir, 'index.js')
  const real = path.join(workspaceDir, 'index.real.js')
  fs.copyFileSync(entry, real)
  const source = [
    '// Written by extensions/gmail/test/e2e.smoke.mjs into a THROWAWAY install.',
    '// It fills the two seams index.mjs declares for a test -- the fetch the Gmail',
    '// client issues its requests through, and the bearer token it asks for first --',
    '// and nothing else. Every other byte of this extension is the shipped one.',
    "import gmail, { state } from './index.real.js'",
    '',
    `const GMAIL_ORIGIN = ${JSON.stringify(GMAIL_ORIGIN)}`,
    'const DOUBLE = process.env.SWARMCLAW_GMAIL_SMOKE_DOUBLE || \'\'',
    '',
    'export default {',
    '  ...gmail,',
    '  setup(ctx) {',
    '    gmail.setup(ctx)',
    '    if (DOUBLE === \'\') return',
    '    const oauth = ctx.oauth',
    '    state.oauth = {',
    '      googleClientConfigured: () => oauth.googleClientConfigured(),',
    '      hasGoogleCredential: (purpose) => oauth.hasGoogleCredential(purpose),',
    '      getGoogleAccessToken: async () => \'smoke-access-token\',',
    '    }',
    '    state.fetchImpl = (url, init) => {',
    '      const target = new URL(String(url))',
    '      if (target.origin !== GMAIL_ORIGIN) {',
    '        throw new Error(`gmail smoke: refusing a request to ${target.origin}, which is not Gmail`)',
    '      }',
    '      return fetch(`${DOUBLE}${target.pathname}${target.search}`, init)',
    '    }',
    '  },',
    '}',
    '',
  ].join('\n')
  fs.writeFileSync(entry, source, 'utf8')
}

/**
 * The environment the scratch server runs in.
 *
 * EVERY `GOOGLE_*` VARIABLE IS REMOVED, deliberately. The first thing this
 * page reports is that the host has no OAuth client, and a machine whose shell
 * happens to carry a real client pair would silently turn that assertion into
 * its opposite -- and give the host a client it could try to use. The deploy
 * mode is removed for the same reason: the sentence names the env pair of the
 * mode the host is in, so the mode has to be a known one rather than whatever
 * this terminal holds.
 */
function serverEnv(scratch, accessKey, doubleOrigin) {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.startsWith('GOOGLE_')) delete env[key]
  }
  delete env.SWARMCLAW_DEPLOY_MODE
  return {
    ...env,
    ACCESS_KEY: accessKey,
    CREDENTIAL_SECRET: crypto.randomBytes(32).toString('hex'),
    DATA_DIR: scratch.dataDir,
    WORKSPACE_DIR: path.join(scratch.root, 'workspace'),
    SWARMCLAW_HOME: scratch.home,
    BROWSER_PROFILES_DIR: path.join(scratch.root, 'browser-profiles'),
    NEXT_TELEMETRY_DISABLED: '1',
    SWARMCLAW_DAEMON_AUTOSTART: '0',
    SWARMCLAW_GMAIL_SMOKE_DOUBLE: doubleOrigin,
  }
}

function startServer(port, env) {
  const nextBin = path.join(REPO_ROOT, 'node_modules', 'next', 'dist', 'bin', 'next')
  // `next dev` forks the actual server as a child of its own. Signalling the
  // parent alone leaves that child alive after a run, still writing into the
  // scratch directory as it shuts down, which re-creates the directory after it
  // has been removed. Its own process group makes the whole tree one target.
  const child = spawn(process.execPath, [nextBin, 'dev', '--turbopack', '--hostname', '127.0.0.1', '-p', String(port)], {
    cwd: REPO_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  })
  const logs = []
  const record = (chunk) => {
    for (const line of chunk.toString('utf8').split(/\r?\n/)) {
      if (!line.trim()) continue
      logs.push(line)
      if (logs.length > 200) logs.shift()
    }
  }
  child.stdout.on('data', record)
  child.stderr.on('data', record)
  return { child, logs }
}

function signalServer(server, signal) {
  try {
    if (process.platform !== 'win32') process.kill(-server.child.pid, signal)
    else server.child.kill(signal)
  } catch {
    // Already gone.
  }
}

function groupAlive(server) {
  try {
    if (process.platform !== 'win32') process.kill(-server.child.pid, 0)
    else process.kill(server.child.pid, 0)
    return true
  } catch {
    return false
  }
}

async function stopServer(server) {
  if (!server) return
  signalServer(server, 'SIGTERM')
  const gone = await until('the server process group to exit', () => (groupAlive(server) ? undefined : true), 10_000, 100).catch(() => false)
  if (gone === false) {
    signalServer(server, 'SIGKILL')
    await until('the server process group to die', () => (groupAlive(server) ? undefined : true), 5_000, 100)
  }
}

async function waitForHealth(baseUrl, logs) {
  await until(`${baseUrl}/api/healthz`, async () => {
    const res = await fetchJson(`${baseUrl}/api/healthz`, {}, 5_000)
    return res.ok && res.body?.ok === true ? true : undefined
  }, HEALTH_TIMEOUT_MS, 1_000).catch((err) => {
    const tail = logs?.slice(-40).join('\n')
    throw new Error(`${err.message}${tail ? `\n\nserver log tail:\n${tail}` : ''}`)
  })
}

/* -------------------------------------------------------------------------- */
/*  Auth, and the host's own answer about the extension                       */
/* -------------------------------------------------------------------------- */

async function authenticate(baseUrl, accessKey) {
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
  // The shell's first-run gate would otherwise send the browser to setup.
  const settings = await fetchJson(`${baseUrl}/api/settings`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ setupCompleted: true, userName: 'Gmail smoke' }),
  })
  if (!settings.ok) throw new Error(`PUT /api/settings answered ${settings.status}`)
  return { cookieValue: cookie.slice('sc_auth='.length), headers }
}

/**
 * Waits until the host has LOADED the extension, and says why if it never
 * does.
 *
 * "It is in the list" proves nothing: the host reports an external file as
 * enabled whether or not it ever loaded. A contract `summary` of 223
 * characters against a 200-character cap once failed every load of this module
 * at `load.contracts` with the card still reading enabled, and the only
 * visible symptom was a page that did not register. This module declares no
 * tools, so `toolCount` cannot separate a loaded module from a never-loaded
 * one; `hasUI` and a provided contract can, and `lastFailureError` is the
 * host's own sentence about what went wrong. Reporting that sentence is the
 * difference between a smoke that names the defect and one that times out
 * somewhere in the browser.
 */
async function waitForLoadedExtension(baseUrl, headers) {
  const read = async () => {
    const res = await fetchJson(`${baseUrl}/api/extensions`, { headers })
    return Array.isArray(res.body) ? res.body.find((m) => m?.filename === EXTENSION_ID) ?? null : null
  }
  const entry = await until(`the host to load ${EXTENSION_ID}`, async () => {
    const found = await read()
    if (!found) return undefined
    if (typeof found.lastFailureError === 'string' && found.lastFailureError !== '') {
      throw new Error(`the host recorded a load failure at ${found.lastFailureStage}: ${found.lastFailureError}`)
    }
    return found.hasUI === true && (found.contractsProvided || []).length > 0 ? found : undefined
  }, HEALTH_TIMEOUT_MS, 1_000).catch(async (err) => {
    throw new Error(`${err.message}; last listing: ${JSON.stringify(await read())}`)
  })
  assert.equal(entry.enabled, true, 'the extension is enabled')
  assert.equal(entry.autoDisabled, false, 'the extension was not auto-disabled')
  return entry
}

async function waitForExtensionPage(baseUrl, headers) {
  return until(`the host to list ${PAGE_PATH} among its extension pages`, async () => {
    const res = await fetchJson(`${baseUrl}/api/extensions/ui?type=pages`, { headers })
    if (!res.ok || !Array.isArray(res.body)) return undefined
    return res.body.find((p) => p?.path === PAGE_PATH) ?? undefined
  }, HEALTH_TIMEOUT_MS, 1_000)
}

/** One rpc call over the same door the page uses, answered as `{ ok, body }`. */
async function callRpc(baseUrl, headers, method, body = {}) {
  const res = await fetchJson(`${baseUrl}${CALL_PREFIX}${method}`, { method: 'POST', headers, body: JSON.stringify(body) })
  return res
}

/* -------------------------------------------------------------------------- */
/*  The fixture, written through the extension's own repository               */
/* -------------------------------------------------------------------------- */

/**
 * The storage handle `createRepo` expects, over the host's database file.
 *
 * The same surface `test/helpers.mjs` builds for the unit suite, opened on the
 * file the host has open instead of in memory. The host writes through
 * better-sqlite3 and this reads and writes through node:sqlite; both are
 * SQLite in WAL mode on one file, and the busy timeout is what makes the two
 * connections take turns rather than fail on a lock.
 */
function fileStorage(dbPath) {
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA busy_timeout = 5000')
  return {
    exec: (sql, p = []) => { db.prepare(sql).run(...p) },
    all: (sql, p = []) => db.prepare(sql).all(...p),
    get: (sql, p = []) => db.prepare(sql).get(...p),
    transaction: (fn) => {
      db.exec('BEGIN IMMEDIATE')
      try {
        const r = fn()
        db.exec('COMMIT')
        return r
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }
    },
    close: () => db.close(),
  }
}

/** Waits until the host has applied every migration db.mjs declares, so the tables the fixture goes into exist. */
async function waitForMigrations(dbPath) {
  const latest = Math.max(...MIGRATIONS.map((m) => m.version))
  return until(`the host to apply migration v${latest} of ${EXTENSION_ID}`, () => {
    if (!fs.existsSync(dbPath)) return undefined
    const storage = fileStorage(dbPath)
    try {
      const hasTable = storage.get("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'ext_migrations'")
      if (!hasTable) return undefined
      const row = storage.get('SELECT MAX(version) AS v FROM ext_migrations WHERE extension_id = ?', [EXTENSION_ID])
      return row?.v === latest ? true : undefined
    } finally {
      storage.close()
    }
  }, HEALTH_TIMEOUT_MS, 1_000)
}

/**
 * The rows, and what each one is there to catch.
 *
 * `created_at` is written explicitly after each insert rather than left to
 * `now()`, because the queue is ordered by it and two rows written in the same
 * millisecond would fall back to a random id -- which would make the tab order
 * this file walks depend on which hex string sorted higher.
 */
function seed(storage, gmail) {
  const repo = createRepo(storage)
  const t = (minutes) => new Date(Date.UTC(2026, 8, 5, 9, minutes)).toISOString()

  // The book. One live entry and one the operator retired: a retired address
  // counts as OUTSIDE the book at release time, which is what the released
  // draft below is built to show.
  repo.addCimzett({ handle: 'dorina', cim: ELO_CIM, megjegyzes: `kinek ${HTML}` })
  repo.addCimzett({ handle: 'regi', cim: VISSZAVONT_CIM, megjegyzes: 'régi cím' })
  repo.retireCimzett('regi')

  const at = (id, iso) => { storage.exec('UPDATE ext_gmail_kimeno SET created_at = ?, updated_at = ? WHERE id = ?', [iso, iso, id]) }

  /**
   * The draft that gets released.
   *
   * Its live copy in Gmail differs from the row on purpose: different body,
   * and a second recipient the operator added in their own client which the
   * book has retired. That is the case the two-step release exists for -- the
   * panel must show the LIVE bytes, the confirmation must be the LIVE
   * fingerprint, and the row must be brought up to what is actually there.
   */
  const kiadandoTarolt = {
    targy: `Tárgy ${HTML}`,
    torzs: `A TÁROLT törzs, ahogy a piszkozat készült. ${HTML}`,
    cimek: [ELO_CIM],
  }
  const kiadando = repo.insertKimeno({
    allapot: 'piszkozat',
    ajto: 'szerzodes',
    cimzettHandlek: ['dorina'],
    cimzettCimek: kiadandoTarolt.cimek,
    targy: kiadandoTarolt.targy,
    torzs: kiadandoTarolt.torzs,
    torzsHash: torzsHashOf(kiadandoTarolt),
    gmailDraftId: 'draft-kiadando',
  })
  at(kiadando.id, t(50))
  const kiadandoElo = {
    draftId: 'draft-kiadando',
    to: `Kis Dorina <${ELO_CIM}>, Régi Cím <${VISSZAVONT_CIM}>`,
    subject: `Tárgy ${HTML}`,
    text: `A GMAILBEN ÁLLÓ törzs, ez megy ki. ${HTML}\n${HOSSZU_SZO}\nhttps://example.test/ez-nem-link`,
  }
  gmail.put(kiadandoElo)

  /**
   * The draft that goes stale.
   *
   * Its live copy matches the row to begin with, so the panel says so; the run
   * then edits it in the fake Gmail between the read and the click, which is
   * the only thing `gmail_lap_elavult` exists to catch.
   */
  const elavuloTarolt = {
    targy: 'Ez a piszkozat el fog avulni',
    torzs: 'Ez a törzs a kiolvasás pillanatában még egyezik a sorral.',
    cimek: [ELO_CIM],
  }
  const elavulo = repo.insertKimeno({
    allapot: 'piszkozat',
    ajto: 'rpc',
    cimzettHandlek: ['dorina'],
    cimzettCimek: elavuloTarolt.cimek,
    targy: elavuloTarolt.targy,
    torzs: elavuloTarolt.torzs,
    torzsHash: torzsHashOf(elavuloTarolt),
    gmailDraftId: 'draft-elavulo',
  })
  at(elavulo.id, t(40))
  gmail.put({ draftId: 'draft-elavulo', to: ELO_CIM, subject: elavuloTarolt.targy, text: elavuloTarolt.torzs })

  // A send that was asked for and never answered. Terminal, and the view must
  // give it its own sentence and NO release control.
  const bizonytalanTarolt = { targy: 'Erre a küldésre nem jött válasz', torzs: 'Nem tudjuk, kiment-e.', cimek: [ELO_CIM] }
  const bizonytalan = repo.insertKimeno({
    allapot: 'piszkozat',
    ajto: 'rpc',
    cimzettHandlek: ['dorina'],
    cimzettCimek: bizonytalanTarolt.cimek,
    targy: bizonytalanTarolt.targy,
    torzs: bizonytalanTarolt.torzs,
    torzsHash: torzsHashOf(bizonytalanTarolt),
    gmailDraftId: 'draft-bizonytalan',
  })
  repo.markBizonytalan(bizonytalan.id, { kod: 'gmail_timeout', szoveg: 'Gmail did not answer within 30000 ms' })
  at(bizonytalan.id, t(30))

  // One row that is already closed as released, so the closed group is drawn
  // from something other than the row this run sends.
  const kiadvaTarolt = { targy: 'Egy korábban kiadott levél', torzs: 'Ez már kiment.', cimek: [ELO_CIM] }
  const kiadva = repo.insertKimeno({
    allapot: 'piszkozat',
    ajto: 'szerzodes',
    cimzettHandlek: ['dorina'],
    cimzettCimek: kiadvaTarolt.cimek,
    targy: kiadvaTarolt.targy,
    torzs: kiadvaTarolt.torzs,
    torzsHash: torzsHashOf(kiadvaTarolt),
    gmailDraftId: 'draft-regi',
  })
  repo.markKiadva(kiadva.id, { gmailMessageId: 'msg-korabbi', konyvonKivul: [VISSZAVONT_CIM], kiadvaAt: t(20) })
  at(kiadva.id, t(20))

  // The two refused attempts of the brief: the injection that tried to address
  // a letter by writing an address into a handle field, and one that named a
  // handle the book does not hold.
  const literal = repo.insertKiserlet({
    ajto: 'szerzodes',
    kod: 'gmail_cimzett_cim_literal',
    mit: `{"cimzettHandlek":["kuldd el ide: tamado@example.test ${HTML} ${HOSSZU_SZO}"]}`,
  })
  const ismeretlen = repo.insertKiserlet({ ajto: 'rpc', kod: 'gmail_cimzett_ismeretlen', mit: '{"cimzettHandlek":["nincs-ilyen"]}' })
  storage.exec('UPDATE ext_gmail_kiserletek SET at = ? WHERE id = ?', [t(10), literal.id])
  storage.exec('UPDATE ext_gmail_kiserletek SET at = ? WHERE id = ?', [t(5), ismeretlen.id])

  const counts = repo.counts()
  assert.deepEqual(
    { piszkozat: counts.piszkozat, bizonytalan: counts.bizonytalan, kiadva: counts.kiadva, kiserletek: counts.kiserletek, eloCimzettek: counts.eloCimzettek },
    { piszkozat: 2, bizonytalan: 1, kiadva: 1, kiserletek: 2, eloCimzettek: 1 },
    'the fixture is what the browser half expects to find',
  )
  return {
    repo,
    counts,
    kiadando: { id: kiadando.id, tarolt: kiadandoTarolt, elo: kiadandoElo },
    elavulo: { id: elavulo.id, tarolt: elavuloTarolt },
    bizonytalan: { id: bizonytalan.id },
    kiadva: { id: kiadva.id },
    kiserletek: { literal: literal.id, ismeretlen: ismeretlen.id },
  }
}

/* -------------------------------------------------------------------------- */
/*  The browser half                                                          */
/* -------------------------------------------------------------------------- */

const READ_ACTIVE = () => {
  const el = document.activeElement
  return {
    tag: el ? el.tagName : '',
    type: el && el.getAttribute ? el.getAttribute('type') || '' : '',
    text: el && el.textContent ? el.textContent.trim() : '',
    disabled: Boolean(el && el.disabled),
  }
}

async function activeElement(page) {
  return page.evaluate(READ_ACTIVE)
}

/** One real Tab, held to the control it is supposed to land on. A tab order that changed fails here by name rather than three assertions later. */
async function tabTo(page, expected) {
  await page.keyboard.press('Tab')
  const active = await activeElement(page)
  const got = `<${active.tag}${active.type ? ` type=${active.type}` : ''}> "${active.text.slice(0, 60)}"`
  assert.equal(active.tag, expected.tag, `Tab landed on ${got} instead of <${expected.tag}> "${expected.text ?? ''}"`)
  if (expected.type !== undefined) assert.equal(active.type, expected.type, `Tab landed on ${got}, whose type is not ${expected.type}`)
  if (expected.text !== undefined) {
    assert.ok(active.text.startsWith(expected.text), `Tab landed on ${got} instead of "${expected.text}"`)
  }
  return active
}

/**
 * The page's side effects, gathered in Node.
 *
 * `window.open` is replaced before any page script runs so an opened url is
 * recorded rather than opened, and a popup the page manages to spawn anyway is
 * counted too. CSP violations are taken from the document's own event, which
 * fires under a report-only policy as well as an enforced one, so the count is
 * right whichever way the host is configured. Every rpc call the page makes is
 * logged with its method and body, which is what makes "exactly one
 * releaseDraft, carrying exactly this confirmation" checkable from the wire
 * rather than from the page's own report of itself.
 */
async function instrument(context) {
  const record = { opened: [], popups: 0, csp: [], pageErrors: [], consoleErrors: [], calls: [] }
  await context.exposeFunction('__gmRecordOpen', (href) => { record.opened.push(href) })
  await context.exposeFunction('__gmRecordCsp', (detail) => { record.csp.push(detail) })
  await context.addInitScript(() => {
    window.open = (url) => { window.__gmRecordOpen(String(url)); return null }
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__gmRecordCsp(`${e.violatedDirective} blocked ${e.blockedURI} at ${e.sourceFile}:${e.lineNumber}`)
    })
  })
  // The consent route this page's button points at. Nothing may reach it -- the
  // button is disabled on a host with no client -- and answering it here means a
  // regression that pressed it anyway shows up as a recorded request rather
  // than as a navigation off the page.
  await context.route('**/api/oauth/google/start*', (route) => route.fulfill({ status: 200, contentType: 'text/plain', body: 'oauth start reached' }))
  return record
}

function attachPage(page, record) {
  page.on('popup', () => { record.popups += 1 })
  page.on('pageerror', (err) => record.pageErrors.push(err.message))
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return
    const loc = msg.location()
    record.consoleErrors.push(`${msg.text()} (${loc.url}:${loc.lineNumber})`)
  })
  page.on('request', (req) => {
    if (req.method() !== 'POST') return
    const index = req.url().indexOf(CALL_PREFIX)
    if (index < 0) return
    let body = null
    try { body = JSON.parse(req.postData() || 'null') } catch { body = req.postData() }
    record.calls.push({ method: req.url().slice(index + CALL_PREFIX.length), body })
  })
}

/** The rpc calls the page made that write. A key press that fires one of these when it should not is the defect this file exists for. */
const IRO_METODUSOK = Object.freeze(['releaseDraft', 'discardDraft', 'draft', 'addRecipient', 'retireRecipient', 'label'])

function writes(record) {
  return record.calls.filter((call) => IRO_METODUSOK.includes(call.method))
}

async function openPage(page, baseUrl) {
  await page.goto(`${baseUrl}${PAGE_PATH}`, { waitUntil: 'commit', timeout: FIRST_LOAD_TIMEOUT_MS })
  // Either the page mounts or the host says why it did not. Waiting on a card
  // alone would turn every load failure into a timeout in the wrong place.
  const outcome = await page.waitForFunction(() => {
    if (document.querySelector('.gm-root')) return { ok: true }
    const heading = Array.from(document.querySelectorAll('h1'))
      .find((h) => /^(Extension "|No installed extension|Could not load the list)/.test(h.textContent || ''))
    if (!heading) return null
    const detail = heading.parentElement?.querySelector('p')?.textContent ?? ''
    return { ok: false, message: `${heading.textContent}\n${detail}` }
  }, null, { timeout: FIRST_LOAD_TIMEOUT_MS, polling: 200 }).then((h) => h.jsonValue())
  if (!outcome.ok) throw new Error(`the host refused the page:\n${outcome.message}`)
  // The board is a second request; every check below reads what it filled in.
  await page.waitForSelector('.gm-status .gm-health-item', { timeout: WAIT_MS })
  await page.waitForSelector('.gm-sor-piszkozat', { timeout: WAIT_MS })
}

/**
 * The status bar on a host with no OAuth client, which is the state this
 * module ships into.
 *
 * The button is DISABLED rather than hidden or live: a live one would send the
 * operator to a JSON body on a blank tab, and a hidden one would leave them
 * looking for the control the sentence beside it is telling them about. The
 * sentence names the deploy mode and the env pair of THAT mode, because
 * naming the other mode's pair sends somebody to set two variables nothing
 * will read.
 */
async function checkStatusBar(page) {
  const status = await page.evaluate(() => {
    const item = document.querySelector('.gm-health-item[data-kod="google_oauth_client_missing"]')
    const connect = document.querySelector('.gm-connect button')
    return {
      item: item ? item.textContent ?? '' : null,
      injected: document.querySelectorAll('.gm-status script, .gm-status img, .gm-status b').length,
      label: connect ? connect.textContent ?? '' : null,
      disabled: connect ? connect.disabled : null,
      connectNote: document.querySelector('.gm-connect .gm-muted')?.textContent ?? '',
      whole: document.querySelector('.gm-status')?.textContent ?? '',
    }
  })
  assert.ok(status.item, 'the status bar reports google_oauth_client_missing')
  assert.ok(status.item.includes('Nincs Google OAuth-kliens konfigurálva ezen a hoston.'), `the code has its own sentence: ${status.item}`)
  assert.ok(status.item.includes('Mód: vps.'), `the sentence names the deploy mode: ${status.item}`)
  assert.ok(
    status.item.includes('GOOGLE_OAUTH_CLIENT_WEB_ID és GOOGLE_OAUTH_CLIENT_WEB_SECRET'),
    `the remedy names that mode's env pair: ${status.item}`,
  )
  assert.equal(status.disabled, true, 'the connect button is disabled')
  assert.equal(status.label, 'Postafiók bekötése', 'and it is the first-connection wording, not the reconnect one')
  assert.ok(
    status.connectNote.includes('nincs OAuth-kliens'),
    `the sentence beside the button says why it is off: "${status.connectNote}"`,
  )
  assert.equal(status.injected, 0, 'no element from a stored field or a health sentence reached the status bar')
  assert.ok(status.whole.includes('Most blokkolt képességek:'), 'the bar names the capabilities the wall stops')
}

/**
 * The queue as it renders the fixture: hostile text as text, no link anywhere,
 * and a 900-character word that does not widen the page.
 *
 * ZERO `<a>` UNDER `.gm-root` is the strong form of the href gate. The sibling
 * pages check that no stored url reaches an `href`; this bundle has no `href`
 * at all, which is a property a reviewer can check in one line and a
 * regression cannot half-satisfy. The count is scoped to this page's own root
 * because the host's shell around it has its own navigation.
 */
async function checkQueueRendering(page, fixture) {
  const view = await page.evaluate((id) => {
    const card = document.querySelector(`.gm-sor-piszkozat[data-kimeno-id="${id}"]`)
    const root = document.querySelector('.gm-root')
    const lines = Array.from(card.querySelectorAll('.gm-line')).map((p) => p.textContent ?? '')
    return {
      lines,
      cimzett: Array.from(card.querySelectorAll('.gm-cim')).map((s) => s.textContent ?? ''),
      storedBody: card.querySelector('.gm-szoveg')?.textContent ?? '',
      injectedInRoot: document.querySelectorAll('.gm-root script, .gm-root img, .gm-root b').length,
      anchors: document.querySelectorAll('.gm-root a').length,
      hrefs: document.querySelectorAll('.gm-root [href]').length,
      pageOverflows: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      cardWidth: card.getBoundingClientRect().width,
      rootWidth: root.getBoundingClientRect().width,
      badges: Array.from(document.querySelectorAll('.gm-sor .gm-badge')).map((b) => b.textContent ?? ''),
    }
  }, fixture.kiadando.id)

  assert.ok(
    view.lines.some((line) => line === `Tárgy: ${fixture.kiadando.tarolt.targy}`),
    `the hostile subject is shown as stored: ${JSON.stringify(view.lines.slice(0, 4))}`,
  )
  assert.equal(view.storedBody, fixture.kiadando.tarolt.torzs, 'the card shows the STORED body, labelled as the stored copy')
  assert.deepEqual(view.cimzett, [`dorina — ${ELO_CIM}`], 'the draft card shows the recipient handle and the address')
  assert.equal(view.injectedInRoot, 0, 'no element from a stored field reached the DOM')
  assert.equal(view.anchors, 0, 'this bundle renders no <a> at all')
  assert.equal(view.hrefs, 0, 'and nothing under its root carries an href')
  assert.ok(!view.pageOverflows, 'the 900-character word does not make the page scroll horizontally')
  assert.ok(view.cardWidth <= view.rootWidth + 1, `the card (${view.cardWidth}px) is no wider than the page (${view.rootWidth}px)`)
  assert.ok(view.badges.includes('Bizonytalan'), 'the uncertain row is drawn with its own badge')
  assert.ok(view.badges.includes('Kiadva'), 'and the previously released row with its own')
}

/**
 * The whole release, by keyboard, and then the only witness that matters.
 *
 * Tab reaches the card from the status bar through the three view tabs, so the
 * order a keyboard operator actually walks is pinned; Enter prepares, Space
 * ticks the gate, Enter sends. Every one of those is a real key event React
 * dispatches to a focused control, which is the half a jsdom test cannot see.
 *
 * The assertions are in the order they can be trusted in: the panel shows the
 * LIVE body and not the row's, the button is dead until the box is ticked, the
 * confirmation on the wire is the hash printed on the screen, and the fake
 * Gmail saw ONE send -- of that draft, holding those bytes, addressed to those
 * people.
 */
async function driveRelease(page, record, fixture, gmail) {
  const id = fixture.kiadando.id
  const panelSel = `.gm-kiadas-panel[data-kimeno-id="${id}"]`

  await page.locator('.gm-status button', { hasText: 'Frissítés' }).focus()
  // Enter on a focused tab switches the view and nothing else. It is here
  // rather than a click because the aisignal review found a window-level key
  // handler taking Enter from every focused control on that page, and this
  // page's whole keyboard implementation is the browser's own activation
  // behaviour.
  await tabTo(page, { tag: 'BUTTON', text: 'Kimenő' })
  await page.keyboard.press('Enter')
  await page.waitForSelector('.gm-sor-piszkozat', { timeout: WAIT_MS })
  await tabTo(page, { tag: 'BUTTON', text: 'Címzettek' })
  await tabTo(page, { tag: 'BUTTON', text: 'Kísérletek' })
  await tabTo(page, { tag: 'BUTTON', text: 'Kiadás előkészítése' })

  const liveRead = page.waitForResponse((res) => res.url().includes(`${CALL_PREFIX}liveDraft`), { timeout: WAIT_MS })
  await page.keyboard.press('Enter')
  await liveRead
  await page.waitForSelector(panelSel, { timeout: WAIT_MS })

  const panel = await page.evaluate((sel) => {
    const el = document.querySelector(sel)
    const hashLine = el.querySelector('.gm-line.gm-mono')?.textContent ?? ''
    return {
      liveBody: el.querySelector('pre.gm-szoveg-live')?.textContent ?? '',
      subject: Array.from(el.querySelectorAll('.gm-line')).map((p) => p.textContent ?? '').find((t) => t.startsWith('Tárgy:')) ?? '',
      chips: Array.from(el.querySelectorAll('.gm-cim')).map((s) => s.textContent ?? ''),
      outsideBook: Array.from(el.querySelectorAll('.gm-line.gm-warn')).map((p) => p.textContent ?? ''),
      hash: hashLine.replace(/^megerősítés:\s*/, ''),
      sendDisabled: el.querySelector('button.gm-kiadas')?.disabled,
      checked: el.querySelector('.gm-checkbox input')?.checked,
    }
  }, panelSel)

  const elo = fixture.kiadando.elo
  assert.equal(panel.liveBody, elo.text, 'the panel shows the body standing in Gmail, not the one stored on the row')
  assert.notEqual(panel.liveBody, fixture.kiadando.tarolt.torzs, 'and the two really do differ, so that assertion means something')
  assert.equal(panel.subject, `Tárgy: ${elo.subject}`, 'the panel shows the live subject')
  assert.deepEqual(
    panel.chips,
    [`Kis Dorina <${ELO_CIM}>`, `Régi Cím <${VISSZAVONT_CIM}> — nincs az élő könyvben`],
    'both live recipients are shown, and the retired one is marked as outside the book',
  )
  assert.ok(
    panel.outsideBook.some((line) => line.startsWith('1 címzett nincs benne az élő címzettkönyvben')),
    `the panel counts the recipients outside the book: ${JSON.stringify(panel.outsideBook)}`,
  )
  assert.ok(
    panel.outsideBook.some((line) => line.includes('a Gmailben megváltozott')),
    'and says the draft was edited in Gmail since the row was written',
  )
  assert.equal(panel.checked, false, 'the gate starts unticked')
  assert.equal(panel.sendDisabled, true, 'and the release button is dead until it is ticked')

  // The fingerprint the page is about to confirm, recomputed here from the
  // draft the fake Gmail is holding. Three numbers have to agree: this one, the
  // one on the screen, and the one on the wire.
  const expectedHash = torzsHashOf({ cimek: cimekFejlecbol(elo.to), targy: elo.subject, torzs: elo.text })
  assert.equal(panel.hash, expectedHash, 'the hash on the screen is the fingerprint of the bytes standing in Gmail')

  // The card's own controls come back to life when the live read settles, and
  // the read settles one tick after the panel renders. Waiting on the button
  // rather than on the panel is what keeps a slow machine from focusing a
  // control that is still disabled and sending the next Tab from the body.
  await page.waitForSelector(`.gm-sor-piszkozat[data-kimeno-id="${id}"] button.gm-elvetes:not([disabled])`, { timeout: WAIT_MS })
  await page.locator(`.gm-sor-piszkozat[data-kimeno-id="${id}"] button.gm-elvetes`).focus()
  await tabTo(page, { tag: 'INPUT', type: 'checkbox' })
  await page.keyboard.press('Space')
  await page.waitForFunction((sel) => document.querySelector(`${sel} button.gm-kiadas`)?.disabled === false, panelSel, { timeout: WAIT_MS })
  await tabTo(page, { tag: 'BUTTON', text: 'Kiadás' })

  const sent = page.waitForResponse((res) => res.url().includes(`${CALL_PREFIX}releaseDraft`), { timeout: WAIT_MS })
  await page.keyboard.press('Enter')
  const response = await sent
  assert.equal(response.status(), 200, 'the release answered 200')
  const answer = await response.json()
  assert.equal(answer.error, undefined, `the release was not refused: ${JSON.stringify(answer.error)}`)

  // ONE SEND. The count is read from the far side of the wire, and the bytes
  // beside it are the ones that went out rather than the ones the page says it
  // sent.
  assert.equal(gmail.sends.length, 1, `the fake Gmail saw exactly one send: ${JSON.stringify(gmail.sends.map((s) => s.draftId))}`)
  const send = gmail.sends[0]
  assert.equal(send.draftId, 'draft-kiadando', 'the send named the draft the panel displayed')
  assert.deepEqual(
    { to: send.draft.to, subject: send.draft.subject, text: send.draft.text },
    { to: elo.to, subject: elo.subject, text: elo.text },
    'and the bytes that went out are the ones the panel displayed',
  )

  const releases = record.calls.filter((call) => call.method === 'releaseDraft')
  assert.equal(releases.length, 1, `the page made exactly one releaseDraft call: ${JSON.stringify(releases)}`)
  assert.deepEqual(releases[0].body, { kimenoId: id, megerosites: expectedHash }, 'the confirmation on the wire is the hash on the screen')
  assert.equal(answer.gmailMessageId, send.messageId, 'the answer carries the message id the send returned')

  // The board reload that follows a send remounts the queue. The sentence
  // reporting the one write in this system that cannot be undone has to
  // survive it: a browser pass once found a letter going out with the page
  // saying nothing at all, because the reload wiped the notice.
  await page.waitForFunction(
    (kimenoId) => document.querySelector(`.gm-sor[data-kimeno-id="${kimenoId}"] .gm-badge`)?.textContent === 'Kiadva',
    id,
    { timeout: WAIT_MS },
  )
  const after = await page.evaluate((kimenoId) => {
    const notice = document.querySelector('.gm-notice')
    const row = document.querySelector(`.gm-sor[data-kimeno-id="${kimenoId}"]`)
    return {
      notice: notice ? notice.textContent ?? '' : null,
      noticeWarn: notice ? notice.classList.contains('gm-warn') : null,
      row: row ? row.textContent ?? '' : null,
      controls: row ? row.querySelectorAll('button').length : null,
      panels: document.querySelectorAll('.gm-kiadas-panel').length,
    }
  }, id)
  assert.ok(after.notice, 'the page still says what happened after the board reload that follows a send')
  assert.ok(after.notice.startsWith(`Kiment. Üzenet-azonosító: ${send.messageId}`), `the notice names the sent message: "${after.notice}"`)
  assert.ok(after.notice.includes(VISSZAVONT_CIM), 'and names the recipient the book did not know')
  assert.equal(after.noticeWarn, true, 'a send to an address outside the book is reported as a warning, not as a plain success')
  assert.ok(after.row.includes(send.messageId), 'the closed row carries the sent message id')
  assert.equal(after.controls, 0, 'a released row offers no control at all')
  assert.equal(after.panels, 0, 'and the panel holding a spent confirmation is gone')

  return { expectedHash, messageId: send.messageId }
}

/**
 * The second release of a row that already went out.
 *
 * The page offers no control for it, which the check above already pinned, so
 * this asks over the SAME DOOR the page uses -- the rpc behind the app's
 * access key, which is exactly the surface the module's own comments say a
 * bundle on any page of this app can reach. A refusal by name is the answer,
 * and the send count is still one.
 */
async function checkSecondReleaseRefused(baseUrl, headers, fixture, hash, gmail) {
  const res = await callRpc(baseUrl, headers, 'releaseDraft', { kimenoId: fixture.kiadando.id, megerosites: hash })
  assert.equal(res.status, 200, 'a refusal travels as a value, not as a 500')
  assert.equal(res.body?.error?.code, 'gmail_kimeno_allapot', `the second release is refused by name: ${JSON.stringify(res.body)}`)
  assert.ok(String(res.body.error.message).includes('kiadva'), 'and the refusal names the state it found')
  assert.equal(gmail.sends.length, 1, 'the second release sent nothing')
}

/**
 * A draft edited between the read and the click.
 *
 * This is the case the confirmation hash exists for and the only one it
 * actually closes: the bytes a person read and the bytes about to go out are
 * the same sequence, or the release fails by name. The edit is made in the
 * fake Gmail after the panel has rendered, which is the same order an operator
 * touching the draft in their own mail client would produce.
 */
async function checkStaleRelease(page, record, fixture, gmail) {
  const id = fixture.elavulo.id
  const panelSel = `.gm-kiadas-panel[data-kimeno-id="${id}"]`
  const releasesBefore = record.calls.filter((call) => call.method === 'releaseDraft').length

  const liveRead = page.waitForResponse((res) => res.url().includes(`${CALL_PREFIX}liveDraft`), { timeout: WAIT_MS })
  await page.locator(`.gm-sor-piszkozat[data-kimeno-id="${id}"] button`, { hasText: 'Kiadás előkészítése' }).click()
  await liveRead
  await page.waitForSelector(panelSel, { timeout: WAIT_MS })
  const unchanged = await page.evaluate((sel) => ({
    body: document.querySelector(`${sel} pre.gm-szoveg-live`)?.textContent ?? '',
    same: (document.querySelector(sel)?.textContent ?? '').includes('megegyezik a tárolt sorral'),
  }), panelSel)
  assert.equal(unchanged.body, fixture.elavulo.tarolt.torzs, 'the live draft matched the row when it was read')
  assert.ok(unchanged.same, 'and the panel said so')

  // The operator edits the draft in their own mail client, after reading the
  // page and before pressing anything.
  gmail.put({
    draftId: 'draft-elavulo',
    to: ELO_CIM,
    subject: fixture.elavulo.tarolt.targy,
    text: 'Ezt a törzset a kiolvasás UTÁN írták át, tehát a lapon látható szöveg már nem az, ami kimenne.',
  })

  await page.locator(`${panelSel} .gm-checkbox input`).check()
  const refusal = page.waitForResponse((res) => res.url().includes(`${CALL_PREFIX}releaseDraft`), { timeout: WAIT_MS })
  await page.locator(`${panelSel} button.gm-kiadas`).click()
  await refusal

  await page.waitForFunction(() => (document.querySelector('.gm-notice')?.textContent ?? '').includes('gmail_lap_elavult'), null, { timeout: WAIT_MS })
  const after = await page.evaluate((kimenoId) => ({
    notice: document.querySelector('.gm-notice')?.textContent ?? '',
    noticeWarn: document.querySelector('.gm-notice')?.classList.contains('gm-warn') ?? null,
    badge: document.querySelector(`.gm-sor[data-kimeno-id="${kimenoId}"] .gm-badge`)?.textContent ?? '',
    panels: document.querySelectorAll('.gm-kiadas-panel').length,
  }), id)
  assert.ok(after.notice.startsWith('A kiadás nem történt meg: gmail_lap_elavult'), `the refusal is shown by code: "${after.notice}"`)
  assert.ok(after.notice.includes('olvasd ujra a piszkozatot'), 'and carries the server\'s own remedy')
  assert.equal(after.noticeWarn, true, 'a stale page is a warning, not a failure of the send')
  assert.equal(after.badge, 'Piszkozat', 'the row is still a draft')
  assert.equal(after.panels, 0, 'and the panel holding a confirmation the server has just rejected is gone')

  assert.equal(gmail.sends.length, 1, 'nothing was sent for the stale draft')
  assert.equal(
    record.calls.filter((call) => call.method === 'releaseDraft').length,
    releasesBefore + 1,
    'the page asked for the release exactly once and did not retry it',
  )
}

/** The fifth state: its own sentence, and no control that could send it a second time. */
async function checkBizonytalan(page, fixture) {
  const row = await page.evaluate((id) => {
    const el = document.querySelector(`.gm-sor[data-kimeno-id="${id}"]`)
    return el && {
      classes: el.className,
      badge: el.querySelector('.gm-badge')?.textContent ?? '',
      text: el.textContent ?? '',
      controls: el.querySelectorAll('button, input, a').length,
    }
  }, fixture.bizonytalan.id)
  assert.ok(row, 'the uncertain row is on the page')
  assert.equal(row.badge, 'Bizonytalan', 'it is drawn as its own state and not folded into sent or failed')
  assert.ok(row.classes.includes('gm-sor-bizonytalan'), 'and it carries its own class')
  assert.ok(row.text.includes('Nem tudjuk, kiment-e a levél.'), 'it says what the state means')
  assert.ok(row.text.includes('gmail_timeout'), 'and names the recorded cause')
  assert.equal(row.controls, 0, 'a row whose send may or may not have happened offers no release control')
}

/**
 * The recipient book: the only place in this system where an e-mail address
 * enters this module by being typed.
 *
 * A duplicate handle is refused by the server and the page shows the code,
 * because "this handle is taken" and "the write failed" are different facts
 * and only the first tells the operator what to do. A handle that is free is
 * accepted, and the retired row stays visible with the date it was withdrawn.
 */
async function checkRecipients(page, record) {
  await page.locator('.gm-tabs button', { hasText: 'Címzettek' }).click()
  await page.waitForSelector('.gm-tabla tr[data-handle="dorina"]', { timeout: WAIT_MS })
  const table = await page.evaluate(() => {
    const row = (handle) => document.querySelector(`.gm-tabla tr[data-handle="${handle}"]`)
    const describe = (el) => el && { text: el.textContent ?? '', retired: el.className.includes('gm-visszavont'), buttons: el.querySelectorAll('button').length }
    return {
      dorina: describe(row('dorina')),
      regi: describe(row('regi')),
      injected: document.querySelectorAll('.gm-tabla script, .gm-tabla img, .gm-tabla b').length,
    }
  })
  assert.ok(table.dorina.text.includes(ELO_CIM), 'the live entry shows its address')
  assert.ok(table.dorina.text.includes(HTML), 'the note is shown as stored')
  assert.equal(table.dorina.retired, false, 'the live entry is not marked retired')
  assert.equal(table.dorina.buttons, 1, 'and it offers the withdraw control')
  assert.equal(table.regi.retired, true, 'the withdrawn entry is marked')
  assert.ok(table.regi.text.includes('visszavonva'), 'and says so in words')
  assert.equal(table.regi.buttons, 0, 'a withdrawn entry cannot be withdrawn again')
  assert.equal(table.injected, 0, 'no element from a stored field reached the book')

  const formState = () => page.evaluate(() => ({
    values: Array.from(document.querySelectorAll('.gm-form input')).map((el) => el.value),
    submitDisabled: document.querySelector('.gm-form button[type="submit"]')?.disabled ?? null,
    notice: document.querySelector('.gm-notice')?.textContent ?? null,
  }))

  /**
   * Fills the form, submits it with Enter in a field, and waits for the board
   * reload that follows the write to have replaced this view.
   *
   * ENTER IS THE WHOLE KEYBOARD IMPLEMENTATION OF THIS FORM: a
   * `<form onSubmit>` and the browser's own activation behaviour, with no key
   * handler anywhere in the bundle. The aisignal review found a window-level
   * `keydown` swallowing Enter from every focused control on that page, so
   * pressing the submit button instead of typing Enter here would test around
   * exactly the defect this page was written to avoid.
   *
   * THE WAIT AT THE END IS NOT TIDINESS. Every write on this page calls
   * `onChanged`, the board comes back with a new version, and the book view is
   * keyed on that version -- so it is unmounted and remounted, and a half-typed
   * form goes with it. A cold run caught exactly that: the first field of the
   * second entry was wiped between two `fill` calls by the reload the first
   * entry had started. The stamp is put on the table this render owns and the
   * wait is for a table that does not carry it, which is the remount itself
   * rather than a guess about how long it takes.
   */
  const submit = async (handle, cim, expect) => {
    await page.evaluate(() => { document.querySelector('.gm-tabla')?.setAttribute('data-smoke-generation', '1') })
    await page.locator('.gm-form input').nth(0).fill(handle)
    await page.locator('.gm-form input').nth(1).fill(cim)
    const before = await formState()
    assert.deepEqual(before.values.slice(0, 2), [handle, cim], `the form holds what was typed: ${JSON.stringify(before)}`)
    assert.equal(before.submitDisabled, false, `the form is ready to submit: ${JSON.stringify(before)}`)
    await page.locator('.gm-form input').first().press('Enter')
    await page
      .waitForFunction((needle) => (document.querySelector('.gm-notice')?.textContent ?? '').includes(needle), expect, { timeout: WAIT_MS })
      .catch(async () => {
        throw new Error(`Enter in the form did not produce "${expect}"; before=${JSON.stringify(before)} after=${JSON.stringify(await formState())}`)
      })
    await page.waitForFunction(() => {
      const table = document.querySelector('.gm-tabla')
      return table !== null && !table.hasAttribute('data-smoke-generation') ? true : undefined
    }, null, { timeout: WAIT_MS })
  }

  await submit('dorina', 'masik@example.test', 'gmail_argumentum_alak')
  const refused = await page.evaluate(() => ({
    text: document.querySelector('.gm-notice')?.textContent ?? '',
    bad: document.querySelector('.gm-notice')?.classList.contains('gm-bad') ?? null,
  }))
  assert.ok(refused.text.includes('gmail_argumentum_alak'), `the duplicate handle shows the server's refusal code: "${refused.text}"`)
  assert.ok(refused.text.includes('ez a handle mar a konyvben van: dorina'), 'and the reason it was refused')
  assert.equal(refused.bad, true, 'a refused write is reported as a failure')

  await submit('uj-cimzett', 'uj@example.test', 'Felvéve')
  await page.waitForSelector('.gm-tabla tr[data-handle="uj-cimzett"]', { timeout: WAIT_MS })
  const accepted = await page.evaluate(() => document.querySelector('.gm-notice')?.textContent ?? '')
  assert.ok(accepted.startsWith('Felvéve: uj-cimzett — uj@example.test'), `the accepted entry is reported: "${accepted}"`)

  const adds = record.calls.filter((call) => call.method === 'addRecipient')
  assert.deepEqual(
    adds.map((call) => call.body.handle),
    ['dorina', 'uj-cimzett'],
    'the form made exactly the two writes it was asked for, in order',
  )
}

/**
 * The attempts view: the one place a refused outbound request is visible.
 *
 * Both seeded refusals are here, and so are the two this run provoked -- the
 * stale confirmation and the second release -- because the module records a
 * refusal that never claimed a row exactly here and nowhere else. The `mit`
 * column is whoever was asking, so it is labelled as somebody else's text
 * above the box, and it is text: no element from it reaches the DOM and a
 * 900-character word in it does not widen the page.
 */
async function checkAttempts(page, fixture) {
  await page.locator('.gm-tabs button', { hasText: 'Kísérletek' }).click()
  await page.waitForSelector('.gm-kiserlet', { timeout: WAIT_MS })
  const view = await page.evaluate((ids) => {
    const rows = Array.from(document.querySelectorAll('.gm-kiserlet'))
    const describe = (el) => el && {
      kod: el.querySelector('.gm-badge-bad')?.textContent ?? '',
      label: el.querySelector('.gm-szoveg-cimke')?.textContent ?? '',
      mit: el.querySelector('pre.gm-szoveg')?.textContent ?? '',
      ajto: Array.from(el.querySelectorAll('.gm-muted')).map((s) => s.textContent ?? '').join(' '),
    }
    return {
      codes: rows.map((el) => el.querySelector('.gm-badge-bad')?.textContent ?? ''),
      literal: describe(document.querySelector(`.gm-kiserlet[data-kiserlet-id="${ids.literal}"]`)),
      ismeretlen: describe(document.querySelector(`.gm-kiserlet[data-kiserlet-id="${ids.ismeretlen}"]`)),
      injected: document.querySelectorAll('.gm-kiserletek script, .gm-kiserletek img, .gm-kiserletek b').length,
      pageOverflows: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    }
  }, fixture.kiserletek)

  assert.equal(view.literal.kod, 'gmail_cimzett_cim_literal', 'the injection attempt is shown with its own code')
  assert.ok(view.literal.mit.includes('tamado@example.test'), 'and with what was actually asked for')
  assert.ok(
    view.literal.label.startsWith('Idegen szöveg: ezt a kérő írta, nem ez a modul.'),
    `the box is labelled as somebody else's text: "${view.literal.label}"`,
  )
  assert.ok(view.literal.ajto.includes('szerződés-ajtó'), 'the door is named, not the caller')
  assert.equal(view.ismeretlen.kod, 'gmail_cimzett_ismeretlen', 'the unknown-handle attempt keeps its own code')
  assert.ok(view.ismeretlen.ajto.includes('rpc ajtó'), 'and its own door')
  assert.equal(view.injected, 0, 'no element from an attempt reached the DOM')
  assert.ok(!view.pageOverflows, 'a 900-character word in an attempt does not widen the page')

  // The two refusals this run provoked are recorded where the module says they
  // are: before a row is claimed, the attempts table is the only trace.
  assert.ok(view.codes.includes('gmail_lap_elavult'), `the stale confirmation was recorded: ${JSON.stringify(view.codes)}`)
  assert.ok(view.codes.includes('gmail_kimeno_allapot'), `the second release was recorded: ${JSON.stringify(view.codes)}`)
}

/* -------------------------------------------------------------------------- */
/*  main                                                                      */
/* -------------------------------------------------------------------------- */

async function main() {
  const startedAt = Date.now()
  const accessKey = crypto.randomBytes(16).toString('hex')

  let scratch = null
  let server = null
  let gmail = null
  const timings = []
  const mark = (label, since) => timings.push(`${label}: ${elapsed(since)}`)

  const cleanup = async () => {
    await stopServer(server)
    if (gmail) await gmail.close()
    if (scratch) fs.rmSync(scratch.root, { recursive: true, force: true })
  }
  process.once('SIGINT', () => { void cleanup().then(() => process.exit(130)) })
  process.once('SIGTERM', () => { void cleanup().then(() => process.exit(143)) })

  try {
    const buildStart = Date.now()
    await step('build the bundle', () => runNode('scripts/build.mjs', path.join(EXT_ROOT, 'scripts', 'build.mjs'), process.env))
    mark('build', buildStart)

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-gmail-e2e-'))
    scratch = { root, dataDir: path.join(root, 'data'), home: path.join(root, 'home') }
    for (const dir of ['data', 'workspace', 'browser-profiles', 'home']) fs.mkdirSync(path.join(root, dir), { recursive: true })
    await step('install the extension into the scratch data directory', () => runNode(
      'scripts/install.mjs', path.join(EXT_ROOT, 'scripts', 'install.mjs'),
      { ...process.env, DATA_DIR: scratch.dataDir, SWARMCLAW_HOME: scratch.home },
    ))

    gmail = await startFakeGmail(await freePort())
    log(`fake Gmail on ${gmail.origin}`)
    await step('point the scratch install at the fake Gmail', () => {
      writeSeam(path.join(scratch.dataDir, 'extensions', '.workspaces', 'gmail_mjs'))
    })

    const bootStart = Date.now()
    const port = await freePort()
    const baseUrl = `http://127.0.0.1:${port}`
    server = startServer(port, serverEnv(scratch, accessKey, gmail.origin))
    log(`starting a scratch dev server on ${baseUrl}`)
    await step('the scratch server comes up', () => waitForHealth(baseUrl, server.logs))
    mark('server boot', bootStart)

    const auth = await step('authenticate', () => authenticate(baseUrl, accessKey))
    const loadStart = Date.now()
    const entry = await step('the host loads the extension', () => waitForLoadedExtension(baseUrl, auth.headers))
    await step('the host declares the page', () => waitForExtensionPage(baseUrl, auth.headers))
    const dbPath = path.join(scratch.dataDir, 'swarmclaw.db')
    await step('the host applies the extension migrations', () => waitForMigrations(dbPath))
    mark('extension load', loadStart)
    log(`loaded ${entry.name} v${entry.version}, contracts: ${(entry.contractsProvided || []).map((c) => `${c.contract} v${c.version}`).join(', ')}`)

    const storage = fileStorage(dbPath)
    let fixture
    try {
      fixture = await step('seed the fixture through the repository', () => seed(storage, gmail))
      log(`seeded ${fixture.counts.piszkozat} drafts, ${fixture.counts.bizonytalan} uncertain, ${fixture.counts.kiserletek} refused attempts`)

      const browserStart = Date.now()
      const browser = await chromium.launch({ headless: true })
      try {
        const context = await browser.newContext({ baseURL: baseUrl, viewport: { width: 1280, height: 900 } })
        await context.addCookies([{
          name: 'sc_auth', value: auth.cookieValue, domain: new URL(baseUrl).hostname, path: '/', httpOnly: true, sameSite: 'Lax',
        }])
        await context.addInitScript((key) => {
          window.localStorage.setItem('sc_access_key', key)
          window.localStorage.setItem('sc_user', 'Gmail smoke')
          window.localStorage.setItem('sc_setup_done', '1')
        }, accessKey)
        const record = await instrument(context)
        const page = await context.newPage()
        attachPage(page, record)

        await step('the page loads and registers', () => openPage(page, baseUrl))
        await step('the connect button is disabled and says which two variables are missing', () => checkStatusBar(page))
        await step('the queue renders hostile text as text, with no link and no overflow', () => checkQueueRendering(page, fixture))
        // The book is read and written BEFORE the release, so that the one
        // step in this file that sends is reached with nothing else in flight:
        // every write on this page reloads the board, and a reload landing
        // mid-sequence is what a smoke must never have to reason about around
        // an irreversible action.
        await step('the recipient book refuses a duplicate handle by code and accepts a new one', () => checkRecipients(page, record))
        const release = await step('the release, by keyboard, sends exactly once', () => driveRelease(page, record, fixture, gmail))
        await step('a second release of the same row is refused and sends nothing', () => checkSecondReleaseRefused(baseUrl, auth.headers, fixture, release.expectedHash, gmail))
        await step('a draft edited between the read and the click is refused and sends nothing', () => checkStaleRelease(page, record, fixture, gmail))
        await step('the uncertain row shows its own state and offers no release', () => checkBizonytalan(page, fixture))
        await step('the attempts view shows every refusal as somebody else\'s text', () => checkAttempts(page, fixture))

        await step('one send, and nothing else the page was not asked for', () => {
          assert.equal(gmail.sends.length, 1, `the fake Gmail saw exactly one send in the whole run: ${JSON.stringify(gmail.sends.map((s) => s.draftId))}`)
          assert.deepEqual(gmail.unexpected, [], 'the module made no request the fake Gmail does not implement')
          assert.deepEqual(
            writes(record).map((call) => call.method),
            ['addRecipient', 'addRecipient', 'releaseDraft', 'releaseDraft'],
            'the page made exactly the writes this run asked for, in order',
          )
          assert.deepEqual(record.opened, [], 'the page opened no window')
          assert.equal(record.popups, 0, 'and spawned no popup')
        })
        await step('no page error, CSP violation or console error', () => {
          assert.deepEqual(record.pageErrors, [], 'uncaught page errors')
          assert.deepEqual(record.csp, [], 'CSP violations')
          assert.deepEqual(record.consoleErrors, [], 'console errors')
        })
        await context.close()
        mark('browser', browserStart)
        console.log(`\nOne letter went out: draft ${gmail.sends[0].draftId} as ${release.messageId}, to ${gmail.sends[0].draft.to}`)
      } finally {
        await browser.close()
      }
    } finally {
      storage.close()
    }

    mark('total', startedAt)
    console.log(`\nTimings: ${timings.join(', ')}`)
    console.log('gmail smoke ok')
  } finally {
    await cleanup()
  }
}

main().catch((err) => {
  console.error(`gmail smoke FAILED: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
