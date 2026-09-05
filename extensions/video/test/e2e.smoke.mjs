import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright'

import { MIGRATIONS, createRepo } from '../src/db.mjs'
import { SZABALYKESZLET } from '../src/qa.mjs'

/**
 * The video page, driven in a real browser.
 *
 * The unit suite pins everything that can be pinned without a DOM: the board
 * reader's refusals, the timeline arithmetic, the wording of every sentence,
 * the href gate, the built bundle's shape. What it cannot see is the page as
 * the host actually serves it -- the bundle loaded through the shell, its
 * hooks running against the host's React, the CSP the shell sends, a keydown
 * that React dispatches to a focused control, a pointer landing on a strip
 * that has finally been laid out. That is what this file is for. It is a
 * smoke test: one path through the page that fails loudly for a real break
 * and never for a slow machine.
 *
 * What it does, in order:
 *
 *   1. builds the bundle and installs the extension into a scratch data
 *      directory the way `scripts/install.mjs` does for an operator, and
 *      writes a throwaway Remotion project beside it (package.json, the
 *      three source files health checks for, and the catalogue fixture) so
 *      the Sablonok table has a catalogue to be a table of;
 *   2. starts a dev server on a free port with DATA_DIR, WORKSPACE_DIR and
 *      SWARMCLAW_HOME pointed at that scratch directory, waits for the host
 *      to load the extension and run its migrations, and points the
 *      `remotionDir` setting at the throwaway project through the host's own
 *      settings route -- the setting lives in the host's database, not in a
 *      file this script could write;
 *   3. seeds the extension's own tables through `createRepo` -- the same code
 *      the tools write through -- so a UI break cannot produce an empty
 *      fixture and a green run. The fixture is hostile on purpose: script and
 *      image tags in every text field, a `javascript:` url as a source's last
 *      paragraph, a 900-character unbroken word in a title, and a finished
 *      render whose nine scene bounds the timeline is drawn from;
 *   4. opens `/x/video` and checks what the page's own review confirmed by
 *      hand: the status bar showing each broken condition as its own
 *      sentence, every hostile field arriving as text, no `javascript:` url
 *      becoming a link target, the long word not widening the page, and the
 *      never-reconciled install saying so rather than showing an empty queue;
 *   5. drives the keyboard through the status bar, the tabs, a queue card and
 *      the feedback form. The aisignal page's review found a window-level key
 *      handler swallowing Enter from every focused control, so every Enter
 *      here is checked for what it activated AND for what it did not: the rpc
 *      writes the page made are compared against the list it should have
 *      made, in order;
 *   6. picks a point on the timeline with the pointer and another with the
 *      keyboard, files the note, files it again (deduplicated), and files one
 *      the server refuses -- each read back from the page and from the
 *      database;
 *   7. accepts one proposal and rejects another, and reads the Sablonok
 *      table;
 *   8. fails on any uncaught page error, any CSP violation, any console error
 *      and any window the page tried to open.
 *
 * Every wait is on a condition, never a sleep. A negative ("no write was
 * made") is asserted after a later positive has landed, so a stray action
 * would have shown up in the log before it.
 *
 * Run locally from the repo root:
 *
 *   npm run test:e2e:video
 *
 * or `node extensions/video/test/e2e.smoke.mjs`. Needs Playwright's Chromium
 * (`npx playwright install chromium` once). To point it at a server that is
 * already running, set SWARMCLAW_E2E_BASE_URL, SWARMCLAW_E2E_ACCESS_KEY and
 * DATA_DIR (the directory holding that server's swarmclaw.db, which the
 * fixture is written into). That mode is a debugging aid and it WRITES: the
 * fixture rows go into that server's database and its `remotionDir` setting
 * is pointed at the throwaway project, so do not aim it at an install anyone
 * is using. The key is read from the environment or minted for the scratch
 * server; it is never printed and never written anywhere but the scratch
 * directory, which is removed on exit.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const EXT_ROOT = path.resolve(here, '..')
const REPO_ROOT = path.resolve(EXT_ROOT, '..', '..')
const EXTENSION_ID = 'video.mjs'
const PAGE_PATH = '/x/video'
const CALL_PREFIX = `/api/extensions/${encodeURIComponent(EXTENSION_ID)}/call/`

/** The first load compiles the route on a dev server; every later wait is on an already compiled page. */
const HEALTH_TIMEOUT_MS = 120_000
const FIRST_LOAD_TIMEOUT_MS = 180_000
const WAIT_MS = 30_000

/** The rpc methods that write. A key press that fires one of these when it should not is the defect this file exists for. */
const IRO_METODUSOK = Object.freeze(['feedback', 'decideProposal', 'retireLesson', 'lezar', 'cancelRender', 'cleanup'])

/** Nine scenes of one second each: `jelenet` runs 0..8 and the arithmetic stays readable in an assertion message. */
const JELENET_HOSSZ_MS = 1000
const JELENET_DB = 9
const TELJES_MS = JELENET_HOSSZ_MS * JELENET_DB
const HATAROK = Array.from({ length: JELENET_DB }, (_, i) => ({
  jelenet: i, kezdetMs: i * JELENET_HOSSZ_MS, vegMs: (i + 1) * JELENET_HOSSZ_MS,
}))

/** Larger than `AT_MS_MAX` in rpc.mjs, so the server refuses it by name. */
const ELUTASITOTT_AT_MS = '99999999'

const HTML = '<script>alert(1)</script><img src=x onerror=alert(2)><b>félkövér</b>'
/** 900 characters with no space in them: the layout check's whole point is that this cannot widen the page. */
const HOSSZU_SZO = 'árvíztűrő'.repeat(100)
const FORRAS_URL = 'https://example.test/forras-a'

function log(message) {
  console.log(`[video smoke] ${message}`)
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
/*  The scratch server                                                        */
/* -------------------------------------------------------------------------- */

function runNode(label, script, env) {
  const result = spawnSync(process.execPath, [script], { cwd: path.dirname(script), env, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`${label} failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`)
  }
}

function startServer(port, scratch, accessKey) {
  const env = {
    ...process.env,
    ACCESS_KEY: accessKey,
    CREDENTIAL_SECRET: process.env.CREDENTIAL_SECRET || crypto.randomBytes(32).toString('hex'),
    DATA_DIR: scratch.dataDir,
    WORKSPACE_DIR: path.join(scratch.root, 'workspace'),
    SWARMCLAW_HOME: scratch.home,
    BROWSER_PROFILES_DIR: path.join(scratch.root, 'browser-profiles'),
    NEXT_TELEMETRY_DISABLED: '1',
    SWARMCLAW_DAEMON_AUTOSTART: '0',
  }
  const nextBin = path.join(REPO_ROOT, 'node_modules', 'next', 'dist', 'bin', 'next')
  // `next dev` forks the actual server as a child of its own. Signalling the
  // parent alone leaves that child alive after a run, still writing into the
  // scratch directory as it shuts down, which re-creates the directory after
  // it has been removed. Its own process group makes the whole tree one
  // target for `stopServer`.
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

/** Signals the server's whole process group, then waits until nothing in it is left. */
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
/*  Auth and the host's own state                                             */
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
    body: JSON.stringify({ setupCompleted: true, userName: 'Video smoke' }),
  })
  if (!settings.ok) throw new Error(`PUT /api/settings answered ${settings.status}`)
  return { cookieValue: cookie.slice('sc_auth='.length), headers }
}

async function waitForExtensionPage(baseUrl, headers) {
  return until(`the host to list ${PAGE_PATH} among its extension pages`, async () => {
    const res = await fetchJson(`${baseUrl}/api/extensions/ui?type=pages`, { headers })
    if (!res.ok || !Array.isArray(res.body)) return undefined
    const page = res.body.find((p) => p?.path === PAGE_PATH)
    return page ? page : undefined
  }, HEALTH_TIMEOUT_MS, 1_000)
}

/**
 * Points `remotionDir` at the throwaway project through the host's own route.
 *
 * The setting lives in the host's SQLite settings singleton, not in a file
 * this script could write, and `katalogus.mjs` reads it on every call. Without
 * it `templates` answers `remotion_dir_hianyzik` and the Sablonok view is a
 * refusal code instead of the table this test is here to check.
 */
async function setRemotionDir(baseUrl, headers, remotionDir) {
  const res = await fetchJson(`${baseUrl}/api/extensions/settings?extensionId=${encodeURIComponent(EXTENSION_ID)}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ remotionDir }),
  })
  assert.ok(res.ok, `PUT /api/extensions/settings answered ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`)
  assert.equal(res.body?.values?.remotionDir, remotionDir, 'the host stored the remotionDir it was given')
}

/* -------------------------------------------------------------------------- */
/*  The fixture, written through the extension's own repository               */
/* -------------------------------------------------------------------------- */

/**
 * The storage handle `createRepo` expects, over the host's database file.
 *
 * The same surface `test/helpers.mjs` copies for the unit suite, opened on the
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
 * A throwaway Remotion project: the four files `health.mjs` requires, the
 * catalogue the unit suite already ships as a fixture, and one 200 kB file
 * standing in for a finished render's mp4.
 *
 * Nothing renders here and Remotion is never invoked; the module reads the
 * catalogue file and checks that the other three exist, and that is the whole
 * of what this directory has to satisfy.
 */
function makeRemotionProject(root) {
  const dir = path.join(root, 'remotion')
  fs.mkdirSync(path.join(dir, 'src', 'kit'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'out', 'swarmclaw'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), '{}\n')
  fs.writeFileSync(path.join(dir, 'src', 'index.ts'), '')
  fs.writeFileSync(path.join(dir, 'src', 'FosVideo.tsx'), '')
  fs.copyFileSync(path.join(here, 'fixtures', 'katalogus.generated.json'), path.join(dir, 'src', 'kit', 'katalogus.generated.json'))
  const katalogus = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'katalogus.generated.json'), 'utf8'))

  const outPath = path.join(dir, 'out', 'swarmclaw', 'smoke.mp4')
  const logPath = path.join(dir, 'out', 'swarmclaw', 'smoke.log')
  const bytes = Buffer.alloc(200 * 1024, 7)
  fs.writeFileSync(outPath, bytes)
  fs.writeFileSync(logPath, 'render log\n')
  const fileSha256 = crypto.createHash('sha256').update(bytes).digest('hex')
  return { dir, outPath, logPath, fileSha256, tipusok: katalogus.tipusok }
}

/**
 * The rows, and what each one is there to catch. Returned so the browser half
 * can compare what the page shows against what was stored.
 *
 * Everything goes in through `createRepo`, the same object the tools write
 * through, so the fixture cannot be shaped by anything the page does not have
 * to survive in production. The two statuses are set with `setVideoStatus`,
 * which refuses anything outside `VIDEO_STATUSOK`.
 */
function seed(storage, project) {
  const repo = createRepo(storage)
  const cimA = `Kilenc jelenetes videó ${HTML}`
  const forrasA = `Első bekezdés ${HTML}\n\nMásodik bekezdés ${HTML}\n\n${FORRAS_URL}`
  const cimB = `${HTML} ${HOSSZU_SZO}`
  // The last paragraph is a `javascript:` url with a leading space, which is
  // exactly the shape `safeHref` trims before refusing.
  const forrasB = `Kézi forrás ${HTML}\n\n javascript:alert(1)`
  const tanulsagSzoveg = `A gyártó ügynök hosszabb címlapot ír a kelleténél ${HTML}`

  // A recorded turn first: the proposal below cites it, and `bizonyitekLetezik`
  // only accepts an id that names a row.
  const fordulo = repo.insertFordulo({
    sessionId: 'smoke-session-1', agentId: 'video-gyarto', forras: 'schedule',
    uzenet: `Kérés ${HTML}`, valasz: `Válasz ${HTML}`, toolok: ['videoDraft'],
  })

  // --- the finished video the timeline is drawn from ---
  // `forrasUrl` offers the last paragraph and only if the whole of it is an
  // http(s) url, so this text has a safe one at the end and hostile markup
  // before it.
  const a = repo.openVideo({
    cim: cimA, forrasTipus: 'signal', forrasId: 'sig-smoke-1', forrasSzoveg: forrasA, nyitottaAgentId: 'video-gyarto',
  })
  const jelenetek = HATAROK.map((h) => ({ tipus: h.jelenet === 0 ? 'cimlap' : 'allitas', mondat: `${h.jelenet}. jelenet ${HTML}` }))
  const narracio = HATAROK.map((h) => ({ jelenet: h.jelenet, szoveg: `${h.jelenet}. mondat.` }))
  const terv = repo.insertTerv({
    videoId: a.id, jelenetek, narracio, assetUjjlenyomatok: [], katalogusHash: 'kat-smoke',
    szerzoAgentId: 'video-gyarto', szerzoSessionId: 'smoke-session-1', ellenorzes: { ok: true },
  })
  const verdikt = repo.insertVerdikt({
    tervId: terv.id, tervHash: terv.tervHash, lektorAgentId: 'video-lektor', lektorSessionId: 'smoke-session-2',
    verdikt: 'atmegy', talalatok: [{ jelenet: 1, kod: 'L3', szoveg: `Lektori találat ${HTML}` }],
  })
  const renderId = crypto.randomBytes(8).toString('hex')
  const claimed = repo.claimRender({
    id: renderId, videoId: a.id, tervId: terv.id, tervHash: terv.tervHash, verdiktId: verdikt.id,
    hostBootAt: Math.floor(Date.now() / 1000), jelenetHatarok: HATAROK,
    propsPath: path.join(project.dir, 'out', 'swarmclaw', 'smoke.props.json'),
    outPath: project.outPath, logPath: project.logPath, platform: 'darwin',
  })
  assert.equal(claimed.error, undefined, 'the fixture render row was claimed')
  assert.equal(repo.finishRender(renderId, { status: 'kesz', fileSha256: project.fileSha256 }), true, 'the fixture render row was closed as kesz')
  const qa = repo.insertQa({
    renderId, fileSha256: project.fileSha256, szabalykeszlet: SZABALYKESZLET, ok: true,
    meresek: { hossz_mp: TELJES_MS / 1000, meret_byte: 200 * 1024 }, bukasok: [],
  })
  assert.equal(qa.ok, 1, 'the fixture QA row passed')
  repo.setVideoStatus(a.id, 'qa_ok')
  // One note already on the timeline, so a mark that is drawn from a stored
  // row is told apart from the one the browser is about to file.
  const seededFeedback = repo.insertFeedback({
    videoId: a.id, renderId, atMs: 2500, jelenet: 2, szoveg: `Importált megjegyzés ${HTML}`, forras: 'import',
  })
  assert.equal(seededFeedback.uj, true, 'the seeded note is new')
  repo.upsertRetention([
    { videoId: a.id, platform: 'tiktok', tS: 0, arany: 1 },
    { videoId: a.id, platform: 'tiktok', tS: 3, arany: 0.72 },
    { videoId: a.id, platform: 'tiktok', tS: 6, arany: 0.41 },
  ])

  // --- the unfinished video whose title is hostile and 900 characters long ---
  const b = repo.openVideo({
    cim: cimB, forrasTipus: 'kezi', forrasId: '', forrasSzoveg: forrasB, nyitottaAgentId: 'video-gyarto',
  })
  repo.insertTerv({
    videoId: b.id, jelenetek: [{ tipus: 'cimlap', sorok: ['Egy'] }], narracio: [{ jelenet: 0, szoveg: 'Egy.' }],
    assetUjjlenyomatok: [], katalogusHash: 'kat-smoke', szerzoAgentId: 'video-gyarto',
    szerzoSessionId: 'smoke-session-1', ellenorzes: { ok: true },
  })
  repo.setVideoStatus(b.id, 'terv')

  // --- the two open proposals ---
  const tanulsag = repo.insertJavaslat({
    cel: 'agent:gyarto', fajta: 'tanulsag', cim: `Tanulság ${HTML}`, szoveg: tanulsagSzoveg,
    // A turn id, which nothing on the page can open, and a video id, which the
    // board knows: the two render differently and both are checked.
    bizonyitek: [fordulo.id, a.id],
    javasoltaAgentId: 'video-lektor', futasSessionId: 'smoke-session-3',
  })
  const szabaly = repo.insertJavaslat({
    cel: 'szabaly', fajta: 'szabaly', cim: `Szabály ${HTML}`,
    szoveg: 'Legyen időkódos QA-szabály a jelenethatárokra.',
    bizonyitek: [renderId],
    javasoltaAgentId: 'video-lektor', futasSessionId: 'smoke-session-3',
  })

  const counts = repo.counts()
  assert.equal(counts.videos, 2, 'the fixture holds exactly the two videos')
  assert.equal(counts.qaOk, 1)
  assert.equal(counts.nyitottJavaslatok, 2)
  return {
    repo,
    counts,
    fordulo,
    a: { id: a.id, cim: cimA, forrasSzoveg: forrasA },
    b: { id: b.id, cim: cimB, forrasSzoveg: forrasB },
    renderId,
    tanulsag: { id: tanulsag.id, cim: `Tanulság ${HTML}`, szoveg: tanulsagSzoveg },
    szabaly: { id: szabaly.id, cim: `Szabály ${HTML}` },
  }
}

/* -------------------------------------------------------------------------- */
/*  The browser half                                                          */
/* -------------------------------------------------------------------------- */

const READ_ACTIVE = () => {
  const el = document.activeElement
  return { tag: el ? el.tagName : '', text: el && el.textContent ? el.textContent.trim() : '' }
}

async function activeElement(page) {
  return page.evaluate(READ_ACTIVE)
}

async function tabTo(page, expected) {
  await page.keyboard.press('Tab')
  const active = await activeElement(page)
  assert.equal(active.tag, expected.tag, `Tab landed on <${active.tag}> "${active.text.slice(0, 60)}" instead of <${expected.tag}> "${expected.text}"`)
  assert.ok(active.text.startsWith(expected.text), `Tab landed on "${active.text.slice(0, 60)}" instead of "${expected.text}"`)
}

/**
 * The page's side effects, gathered in Node.
 *
 * `window.open` is replaced before any page script runs so an opened url is
 * recorded rather than opened, and a popup the page manages to spawn anyway is
 * counted too. CSP violations are taken from the document's own event, which
 * fires under a report-only policy as well as an enforced one, so the count is
 * right whichever way the host is configured. Every rpc call the page makes is
 * logged with its method and body, so a write that should not have happened is
 * visible as a log entry rather than as a silent row change.
 */
async function instrument(context) {
  const record = { opened: [], popups: 0, csp: [], pageErrors: [], consoleErrors: [], calls: [] }
  await context.exposeFunction('__vidRecordOpen', (href) => { record.opened.push(href) })
  await context.exposeFunction('__vidRecordCsp', (detail) => { record.csp.push(detail) })
  await context.addInitScript(() => {
    window.open = (url) => { window.__vidRecordOpen(String(url)); return null }
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__vidRecordCsp(`${e.violatedDirective} blocked ${e.blockedURI} at ${e.sourceFile}:${e.lineNumber}`)
    })
  })
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
    const at = req.url().indexOf(CALL_PREFIX)
    if (at === -1) return
    let body = null
    try { body = JSON.parse(req.postData() || 'null') } catch { body = req.postData() }
    record.calls.push({ method: req.url().slice(at + CALL_PREFIX.length), body })
  })
}

/** The write calls the page made since `from`, as `method` names, for an exact comparison. */
function writesSince(record, from) {
  return record.calls.slice(from).filter((c) => IRO_METODUSOK.includes(c.method)).map((c) => c.method)
}

/** Resolves with the response to one rpc method, and fails the step if it never comes. */
function callLanded(page, method) {
  return page.waitForResponse((res) => res.request().method() === 'POST' && res.url().includes(`${CALL_PREFIX}${method}`), { timeout: WAIT_MS })
}

async function openPage(page, baseUrl) {
  await page.goto(`${baseUrl}${PAGE_PATH}`, { waitUntil: 'commit', timeout: FIRST_LOAD_TIMEOUT_MS })
  // Either the page mounts or the host says why it did not. Waiting on the
  // queue alone would turn every load failure into a timeout in the wrong place.
  const outcome = await page.waitForFunction(() => {
    if (document.querySelector('.vid-card')) return { ok: true }
    const heading = Array.from(document.querySelectorAll('h1'))
      .find((h) => /^(Extension "|No installed extension|Could not load the list)/.test(h.textContent || ''))
    if (!heading) return null
    const detail = heading.parentElement?.querySelector('p')?.textContent ?? ''
    return { ok: false, message: `${heading.textContent}\n${detail}` }
  }, undefined, { timeout: FIRST_LOAD_TIMEOUT_MS, polling: 200 }).then((h) => h.jsonValue())
  if (!outcome.ok) throw new Error(`the host refused the page:\n${outcome.message}`)
}

/** Nothing a stored field carried may reach the DOM as markup, and no url outside http(s) may reach an href. */
async function assertNothingInjected(page, where) {
  const found = await page.evaluate(() => ({
    elements: document.querySelectorAll('.vid-root script, .vid-root img, .vid-root b').length,
    hostileHrefs: document.querySelectorAll('.vid-root a[href^="javascript:" i], .vid-root a[href^="data:" i], .vid-root a[href^="vbscript:" i]').length,
    overflows: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  }))
  assert.equal(found.elements, 0, `${where}: no element from a stored field reached the DOM`)
  assert.equal(found.hostileHrefs, 0, `${where}: no javascript:, data: or vbscript: href anywhere on the page`)
  assert.ok(!found.overflows, `${where}: the page does not scroll horizontally`)
}

async function checkQueue(page, fixture) {
  const queue = await page.evaluate(() => ({
    titles: Array.from(document.querySelectorAll('.vid-card .vid-card-title')).map((el) => el.textContent),
    ids: Array.from(document.querySelectorAll('.vid-card')).map((el) => el.getAttribute('data-video-id')),
    columns: Array.from(document.querySelectorAll('.vid-column')).map((el) => el.getAttribute('data-status')),
    empty: document.querySelector('.vid-ures')?.textContent ?? '',
    caps: document.querySelector('.vid-sor .vid-sapkak')?.textContent ?? '',
    badges: Array.from(document.querySelectorAll('.vid-card .vid-badge')).map((el) => el.textContent),
    badBadges: document.querySelectorAll('.vid-card .vid-badge-bad').length,
  }))
  assert.deepEqual(queue.columns, ['terv', 'qa_ok'], 'the two non-empty columns are in the vocabulary\'s own order')
  assert.deepEqual(queue.ids, [fixture.b.id, fixture.a.id], 'each card carries its video id')
  assert.deepEqual(queue.titles, [fixture.b.cim, fixture.a.cim], 'both hostile titles are shown as stored, byte for byte')
  assert.deepEqual(queue.badges, ['Terv', 'QA rendben'], 'both statuses are in the vocabulary and worded')
  assert.equal(queue.badBadges, 0, 'no card is flagged as an unknown status')
  assert.ok(queue.empty.startsWith('Üres: '), `the empty columns are named rather than dropped: "${queue.empty}"`)
  assert.ok(queue.caps.includes(`Videó: ${fixture.counts.videos} · terv: ${fixture.counts.tervek} · render: ${fixture.counts.renderek} · QA ok: ${fixture.counts.qaOk}`), `the queue reports the stored counts: "${queue.caps}"`)
  await assertNothingInjected(page, 'the queue')
}

/**
 * Each condition its own sentence, and the never-reconciled install saying so.
 *
 * The tool sentence is checked for its opening only: whether ffmpeg, ffprobe
 * and npx exist is a fact about the machine running this, and asserting a
 * particular answer would make the test fail on a machine rather than on a
 * defect. Everything else here is decided by the fixture and is exact.
 */
async function checkStatusBar(page) {
  // Two of the bar's three requests are still in flight when the queue has
  // drawn: `health` runs a version probe of three binaries and the schedule
  // check is a second round trip to the host. Both say so in words while they
  // are outstanding, and both are waited for by their absence rather than by a
  // sleep -- otherwise a slow machine would read as a bar with missing lines.
  await page.waitForFunction(() => {
    const text = document.querySelector('.vid-status')?.textContent ?? ''
    return !text.includes('Az állapot lekérdezése folyamatban') && !text.includes('az ellenőrzés folyamatban')
  }, undefined, { timeout: WAIT_MS })
  const bar = await page.evaluate(() => ({
    lines: Array.from(document.querySelectorAll('.vid-status .vid-line')).map((el) => el.textContent ?? ''),
    reconcile: document.querySelector('.vid-reconcile-warning')?.textContent ?? null,
    turns: Array.from(document.querySelectorAll('.vid-fordulok li')).map((el) => el.textContent ?? ''),
    summary: document.querySelector('.vid-uninstall summary')?.textContent ?? '',
    injected: document.querySelectorAll('.vid-status script, .vid-status img, .vid-status b').length,
  }))
  assert.equal(bar.injected, 0, 'no element from a recorded turn reached the status bar')
  const starting = (prefix) => bar.lines.filter((line) => line.startsWith(prefix))
  for (const prefix of ['Remotion-könyvtár: ', 'Eszközök: ', 'Chrome Headless Shell: ', 'Render: ', 'tts.narration: ', 'aisignal.signals: ', 'Ütemezés: ', 'Fordulók rögzítése: ', 'Ezekre a health nem tud válaszolni', 'Most blokkolt: ']) {
    assert.equal(starting(prefix).length, 1, `exactly one sentence starts with "${prefix}"; the bar has ${JSON.stringify(bar.lines)}`)
  }
  assert.equal(starting('Remotion-könyvtár: ')[0], 'Remotion-könyvtár: rendben', 'the throwaway project satisfies the four required files')
  assert.ok(starting('Chrome Headless Shell: ')[0].startsWith('Chrome Headless Shell: a könyvtár hiányzik'), 'the browser directory is missing and the sentence says so')
  assert.ok(starting('tts.narration: ')[0].startsWith('tts.narration: provider_missing'), `the missing contract carries the host's own word: "${starting('tts.narration: ')[0]}"`)
  assert.ok(starting('aisignal.signals: ')[0].startsWith('aisignal.signals: provider_missing'), 'the limiting contract is reported the same way')
  const blocked = starting('Most blokkolt: ')[0]
  assert.ok(blocked.includes('narracio') && blocked.includes('render'), `the blocked capabilities are named: "${blocked}"`)
  assert.ok(starting('Ezekre a health nem tud válaszolni')[0].includes('reconcile_hianyzik'), 'the one code health cannot answer is named as unanswered')

  // The scratch install was never reconciled, so the host has none of the
  // three schedules, and the page has to say that rather than let an empty
  // queue stand for it. This is the host's own managed-resources endpoint
  // answering the real page, over the cookie the page was served with.
  const schedule = starting('Ütemezés: ')[0]
  assert.ok(schedule.includes('nincs ütemezés — Reconcile kell (3 a 3 ütemezésből hiányzik'), `the never-reconciled install says all three schedules are missing: "${schedule}"`)
  assert.ok(schedule.includes('swarmclaw extensions reconcile --extension-id video.mjs'), 'and names the remedy on both surfaces')
  assert.equal(bar.reconcile, 'nincs ütemezés — Reconcile kell', 'the short warning is its own element')
  assert.equal(bar.turns.length, 1, 'the one recorded turn is listed')
  assert.ok(bar.turns[0].startsWith('A modul fordulói szerint: video-gyarto schedule'), `the turn is worded as this module's own record: "${bar.turns[0]}"`)
  assert.equal(bar.summary, 'Uninstall előtt')
}

/**
 * The keyboard, from the status bar down to the queue.
 *
 * Every control is reached with a real Tab from the previous control in the
 * extension's own DOM, and every key is a real keydown React dispatches. The
 * aisignal page's review found a window-level handler swallowing Enter from
 * every focused control, so each Enter is checked for two things: that it
 * activated the control that had focus, and that no rpc write went out.
 */
async function driveKeyboardToProposals(page, record) {
  const before = record.calls.length
  const results = []

  await page.locator('.vid-status button', { hasText: 'Frissítés' }).focus()
  await tabTo(page, { tag: 'SUMMARY', text: 'Uninstall előtt' })
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => document.querySelector('details.vid-uninstall')?.open === true, undefined, { timeout: WAIT_MS })
    .catch(() => { throw new Error('Enter on "Uninstall előtt" did not open the details') })
  results.push('Enter on the focused "Uninstall előtt": the details opened')
  // Closed again so the Tisztítás button inside it leaves the tab order; the
  // next Tab is meant to reach the tabs, and this test does not delete files.
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => document.querySelector('details.vid-uninstall')?.open === false, undefined, { timeout: WAIT_MS })

  await tabTo(page, { tag: 'BUTTON', text: 'Sor' })
  await tabTo(page, { tag: 'BUTTON', text: 'Javaslatok' })
  // An arrow on a focused tab does nothing: this page installs no key handler
  // of its own, and the assertion below is what proves it rather than the
  // absence of a listener in the source.
  await page.keyboard.press('ArrowRight')
  const stillQueue = await page.evaluate(() => Boolean(document.querySelector('.vid-card')))
  assert.ok(stillQueue, 'the queue is still mounted after ArrowRight on the focused tab')
  results.push('ArrowRight on the focused "Javaslatok" tab: nothing happened')

  await page.keyboard.press('Enter')
  await page.waitForSelector('.vid-javaslatok', { timeout: WAIT_MS })
  const selected = await page.evaluate(() => document.querySelector('.vid-tab-active')?.textContent)
  assert.equal(selected, 'Javaslatok', 'Enter on the focused tab switched to it')
  assert.deepEqual(writesSince(record, before), [], `no rpc write was made by any of those keys: ${JSON.stringify(record.calls.slice(before))}`)
  results.push('Enter on the focused "Javaslatok" tab: the view switched; no rpc write was made')
  return results
}

async function checkProposals(page, record, fixture) {
  const results = []
  await page.waitForSelector('.vid-proposal', { timeout: WAIT_MS })
  const listed = await page.evaluate(() => ({
    ids: Array.from(document.querySelectorAll('.vid-proposal')).map((el) => el.getAttribute('data-id')),
    caps: document.querySelector('.vid-javaslatok .vid-sapkak')?.textContent ?? '',
    rejectDisabled: Array.from(document.querySelectorAll('.vid-proposal .vid-reject')).map((el) => el.disabled),
    acceptCount: document.querySelectorAll('.vid-proposal .vid-accept').length,
    hint: Array.from(document.querySelectorAll('.vid-proposal-actions .vid-muted')).map((el) => el.textContent),
  }))
  assert.equal(listed.ids.length, 2, 'both open proposals are listed')
  assert.deepEqual(listed.rejectDisabled, [true, true], 'Elutasít is disabled while the note is empty')
  assert.equal(listed.acceptCount, 2, 'neither cap is full, so both Elfogad buttons are there')
  assert.deepEqual(listed.hint, ['az elutasításhoz megjegyzés kell', 'az elutasításhoz megjegyzés kell'], 'and the reason is beside each button')
  assert.ok(listed.caps.includes('Tanulságok agent:gyarto 0/12'), `the lesson cap starts empty: "${listed.caps}"`)
  results.push('Elutasít with an empty note: disabled, with the reason beside it')

  // Evidence: the turn id is text, the video id is a button, and which is
  // which is decided by the board rather than guessed from the id.
  const evidence = await page.evaluate((sel) => {
    const el = document.querySelector(`.vid-proposal[data-id="${sel}"] .vid-bizonyitek`)
    return {
      buttons: Array.from(el?.querySelectorAll('button') ?? []).map((b) => b.textContent),
      plain: Array.from(el?.querySelectorAll('span.vid-mono') ?? []).map((s) => s.textContent),
    }
  }, fixture.tanulsag.id)
  assert.deepEqual(evidence.buttons, [fixture.a.id], 'the evidence id the board knows as a video is openable')
  assert.deepEqual(evidence.plain, [fixture.fordulo.id], 'the evidence id nothing on the page can open stays text')
  results.push('Evidence: the video id became a button, the turn id stayed text')

  // Reject the rule proposal with a note.
  const megjegyzes = `Már van ilyen szabály ${HTML}`
  const rejectBefore = record.calls.length
  const rejectRow = page.locator(`.vid-proposal[data-id="${fixture.szabaly.id}"]`)
  await rejectRow.locator('textarea').fill(megjegyzes)
  await page.waitForFunction((id) => document.querySelector(`.vid-proposal[data-id="${id}"] .vid-reject`)?.disabled === false, fixture.szabaly.id, { timeout: WAIT_MS })
  const rejected = callLanded(page, 'decideProposal')
  await rejectRow.locator('.vid-reject').click()
  assert.equal((await rejected).status(), 200, 'the rejection was accepted by the server')
  await page.waitForFunction((id) => document.querySelector(`.vid-proposal[data-id="${id}"]`) === null, fixture.szabaly.id, { timeout: WAIT_MS })
  const afterReject = await page.evaluate(() => ({
    open: document.querySelectorAll('.vid-proposal').length,
    rejected: Array.from(document.querySelectorAll('.vid-rejected li')).map((el) => el.textContent ?? ''),
    notice: document.querySelector('.vid-notice')?.textContent ?? '',
  }))
  assert.equal(afterReject.open, 1, 'the rejected proposal left the open list')
  assert.equal(afterReject.rejected.length, 1, 'and appeared among the rejected')
  assert.ok(afterReject.rejected[0].startsWith(fixture.szabaly.cim), 'under its own title, shown as stored')
  assert.ok(afterReject.rejected[0].endsWith(megjegyzes), `with the note it was rejected with: "${afterReject.rejected[0].slice(-80)}"`)
  assert.equal(afterReject.notice, 'Elutasítva.')
  assert.deepEqual(writesSince(record, rejectBefore), ['decideProposal'], 'the rejection was one write and no other')
  results.push('Elutasít with a note: the proposal left the open list and appeared among the rejected, with its note')

  // Accept the lesson proposal.
  const acceptBefore = record.calls.length
  const accepted = callLanded(page, 'decideProposal')
  await page.locator(`.vid-proposal[data-id="${fixture.tanulsag.id}"] .vid-accept`).click()
  assert.equal((await accepted).status(), 200, 'the acceptance was accepted by the server')
  await page.waitForSelector('.vid-lesson', { timeout: WAIT_MS })
  const afterAccept = await page.evaluate(() => ({
    open: document.querySelectorAll('.vid-proposal').length,
    lessons: Array.from(document.querySelectorAll('.vid-lesson p')).map((el) => el.textContent ?? ''),
    headings: Array.from(document.querySelectorAll('.vid-javaslatok h4')).map((el) => el.textContent ?? ''),
    caps: document.querySelector('.vid-javaslatok .vid-sapkak')?.textContent ?? '',
    notice: document.querySelector('.vid-notice')?.textContent ?? '',
  }))
  assert.equal(afterAccept.open, 0, 'no open proposal is left')
  assert.ok(afterAccept.lessons.includes(fixture.tanulsag.szoveg), `the lesson carries the proposal's text: ${JSON.stringify(afterAccept.lessons)}`)
  assert.ok(afterAccept.headings.includes('agent:gyarto (1/12)'), `the target's counter moved to 1/12: ${JSON.stringify(afterAccept.headings)}`)
  assert.ok(afterAccept.caps.includes('Tanulságok agent:gyarto 1/12'), 'and the cap line agrees with it')
  assert.equal(afterAccept.notice, 'Elfogadva.')
  assert.deepEqual(writesSince(record, acceptBefore), ['decideProposal'], 'the acceptance was one write and no other')
  assert.equal(fixture.repo.countActiveTanulsagok('agent:gyarto'), 1, 'the lesson is in the database')
  assert.equal(fixture.repo.javaslat(fixture.szabaly.id).status, 'elutasitva', 'and so is the rejection')
  results.push('Elfogad on the lesson proposal: the lesson appeared with its text and the counter moved to 1/12')

  await assertNothingInjected(page, 'the proposals view')
  return results
}

/**
 * The Sablonok table: one row per catalogue type, and the two sentinel words.
 *
 * `nincs_idokodos_szabaly` and `meretlen` are the module's own words for "no
 * rule could have attributed a QA failure to a template" and "no retention
 * point fell inside this type's scenes". A 0 in either column would be a
 * measurement nobody made, so both are checked literally.
 */
async function checkTemplates(page, project) {
  await page.locator('.vid-tabs button', { hasText: 'Sablonok' }).click()
  await page.waitForSelector('.vid-sablonok .vid-tabla', { timeout: WAIT_MS })
  const table = await page.evaluate(() => {
    const first = document.querySelector('.vid-sablonok .vid-tabla')
    const rows = Array.from(first?.querySelectorAll('tbody tr') ?? [])
    const cells = (r) => Array.from(r.querySelectorAll('td')).map((c) => c.textContent ?? '')
    return {
      rows: rows.length,
      types: rows.map((r) => r.querySelector('th')?.textContent ?? ''),
      byType: Object.fromEntries(rows.map((r) => [r.querySelector('th')?.textContent ?? '', cells(r)])),
      hash: document.querySelector('.vid-sablonok .vid-mono')?.textContent ?? '',
      error: document.querySelector('.vid-sablonok .vid-bad')?.textContent ?? null,
      weekly: document.querySelectorAll('.vid-sablonok .vid-tabla')[1]?.querySelectorAll('tbody tr').length ?? 0,
    }
  })
  assert.equal(table.error, null, 'the catalogue was readable')
  assert.equal(table.rows, project.tipusok.length, `the table has one row per catalogue type (${project.tipusok.length})`)
  assert.equal(table.rows, 24, 'and the shipped catalogue fixture has 24 of them')
  assert.deepEqual(table.types, [...project.tipusok].sort(), 'the rows are the catalogue\'s own types, sorted')
  const column = (i) => table.types.map((t) => table.byType[t][i])
  assert.deepEqual(new Set(column(2)), new Set(['nincs_idokodos_szabaly']), 'every QA cell carries the module\'s own sentinel word rather than a 0')
  const measured = table.types.filter((t) => table.byType[t][4] !== 'meretlen')
  assert.deepEqual(measured.sort(), ['allitas', 'cimlap'], 'only the two types a retention point fell inside are measured; the other 22 say meretlen')
  assert.ok(table.byType.cimlap[4].startsWith('+'), `the opening scene held above the video's average: "${table.byType.cimlap[4]}"`)
  assert.ok(table.byType.allitas[4].startsWith('-'), `the later scenes fell below it: "${table.byType.allitas[4]}"`)
  // The two plans between them use cimlap twice and allitas eight times, the
  // one finding sits on an allitas scene, and so does the one stored note.
  assert.deepEqual(table.byType.cimlap.slice(0, 4), ['2', '—', 'nincs_idokodos_szabaly', '0'])
  assert.deepEqual(table.byType.allitas.slice(0, 4), ['8', 'L3 ×1', 'nincs_idokodos_szabaly', '1'])
  assert.ok(table.hash.startsWith('katalógus-hash: '), `the catalogue hash is shown: "${table.hash}"`)
  assert.equal(table.weekly, 1, 'the weekly row exists because a render, a QA row and a verdict do')
  await assertNothingInjected(page, 'the templates view')
  return `Sablonok: ${table.rows} rows, "nincs_idokodos_szabaly" in every QA cell, "meretlen" in 22 retention cells`
}

/** The unfinished video: a hostile title 900 characters long, and a source whose url may not become a link. */
async function checkUnfinishedVideo(page, fixture) {
  const view = await page.evaluate(() => ({
    id: document.querySelector('.vid-video')?.getAttribute('data-video-id'),
    title: document.querySelector('.vid-video h2')?.textContent ?? '',
    forras: document.querySelector('.vid-forras')?.textContent ?? '',
    anchors: document.querySelectorAll('.vid-video a').length,
    noLink: Array.from(document.querySelectorAll('.vid-video .vid-muted')).map((el) => el.textContent ?? ''),
    timeline: document.querySelectorAll('.vid-timeline').length,
    titleWidth: document.querySelector('.vid-video h2')?.getBoundingClientRect().width ?? 0,
    rootWidth: document.querySelector('.vid-root')?.getBoundingClientRect().width ?? 0,
  }))
  assert.equal(view.id, fixture.b.id, 'the card that was activated is the video that opened')
  assert.equal(view.title, fixture.b.cim, 'the 900-character hostile title is shown byte for byte')
  assert.equal(view.forras, fixture.b.forrasSzoveg, 'the source text is shown byte for byte')
  assert.equal(view.anchors, 0, 'a javascript: source url produces no link at all')
  assert.ok(view.noLink.includes('A forrás utolsó bekezdése nem http(s) url, ezért nincs megnyitható link.'), `the reason is a sentence: ${JSON.stringify(view.noLink.slice(0, 4))}`)
  assert.equal(view.timeline, 0, 'a video with no finished render has no timeline')
  assert.ok(view.noLink.includes('Nincs kész render, így nincs idővonal. A visszajelzéshez az időpontot és a jelenetet kézzel is megadhatod.'), 'and says so rather than drawing an empty strip')
  assert.ok(view.titleWidth <= view.rootWidth + 1, `the 900-character word stays inside the page (${view.titleWidth}px against ${view.rootWidth}px)`)
  await assertNothingInjected(page, 'the unfinished video')
}

/** The finished video: paths as text, the timeline drawn from the stored bounds, the one link the page may show. */
async function checkFinishedVideo(page, fixture, project) {
  const view = await page.evaluate(() => ({
    id: document.querySelector('.vid-video')?.getAttribute('data-video-id'),
    title: document.querySelector('.vid-video h2')?.textContent ?? '',
    paths: Array.from(document.querySelectorAll('.vid-path')).map((el) => el.textContent ?? ''),
    pathAnchors: document.querySelectorAll('.vid-path a').length,
    links: Array.from(document.querySelectorAll('.vid-video a')).map((el) => ({ href: el.getAttribute('href'), rel: el.getAttribute('rel'), target: el.getAttribute('target') })),
    scenes: document.querySelectorAll('.vid-timeline-scene').length,
    marks: document.querySelectorAll('.vid-timeline-mark').length,
    curves: document.querySelectorAll('.vid-timeline-curve polyline').length,
    legend: document.querySelector('.vid-timeline-legend')?.textContent ?? '',
    qa: Array.from(document.querySelectorAll('.vid-qa p')).map((el) => el.textContent ?? ''),
    planScenes: document.querySelectorAll('.vid-scene').length,
    findings: Array.from(document.querySelectorAll('.vid-finding')).map((el) => el.textContent ?? ''),
  }))
  assert.equal(view.id, fixture.a.id)
  assert.equal(view.title, fixture.a.cim, 'the hostile title is shown byte for byte')
  assert.ok(view.paths.includes(project.outPath), `the render's output path is on the page as text: ${JSON.stringify(view.paths)}`)
  assert.ok(view.paths.includes(project.logPath), 'and so is its log path')
  assert.equal(view.pathAnchors, 0, 'a file path is never a link')
  assert.deepEqual(view.links, [{ href: FORRAS_URL, rel: 'noopener noreferrer', target: '_blank' }], 'the source url is the one link on the page')
  assert.equal(view.scenes, JELENET_DB, 'the timeline is drawn from the nine stored scene bounds')
  assert.equal(view.marks, 1, 'the one stored note is a mark on it')
  assert.equal(view.curves, 1, 'the retention points drew one polyline')
  assert.ok(view.legend.startsWith('Teljes hossz: 9.0 mp · 9 jelenet · 1 visszajelzés az idővonalon'), `the legend reports the same numbers: "${view.legend}"`)
  assert.ok(view.qa.includes('QA: átment'), `the passing QA row is reported as passing: ${JSON.stringify(view.qa)}`)
  assert.equal(view.planScenes, 9, 'the plan panel lists all nine scenes')
  assert.equal(view.findings.length, 1, 'the reviewer\'s one finding is shown')
  assert.ok(view.findings[0].includes(HTML), 'as text, hostile markup and all')
  await assertNothingInjected(page, 'the finished video')
}

/**
 * The timeline, picked with the pointer and with the keyboard.
 *
 * The pointer half is checked against the arithmetic the strip actually did:
 * the click's own x is compared with the element's own rect, so a machine that
 * lays the page out a pixel differently does not change the answer. A tolerance
 * of 30 ms covers the subpixel rounding between a dispatched mouse position and
 * `clientX`, and is a thousandth of the distance any real mapping break would
 * move the number.
 *
 * The keyboard half is exact: a keyboard activation reports `detail === 0`, so
 * the scene answers with its own first millisecond rather than a pixel nobody
 * pointed at.
 */
async function pickOnTimeline(page) {
  const results = []
  // The strip sits below the plan and the render panels, so it has to be
  // brought into the viewport before a mouse position means anything:
  // `boundingBox` answers in frame coordinates and the mouse takes viewport
  // ones, and a click at a y past the fold would land on nothing at all.
  const strip = page.locator('.vid-timeline')
  await strip.scrollIntoViewIfNeeded()
  const box = await strip.boundingBox()
  assert.ok(box && box.width > 100, `the timeline has been laid out and is in the viewport: ${JSON.stringify(box)}`)

  const readForm = () => page.evaluate(() => ({
    atMs: document.querySelector('.vid-feedback-form input[type="number"]')?.value ?? '',
    jelenet: document.querySelectorAll('.vid-feedback-form input[type="number"]')[1]?.value ?? '',
  }))
  // The scene field, not the ms field, is what each step waits on: consecutive
  // picks land on different scenes, so a wait on the scene cannot be satisfied
  // by the value the previous pick left in the form.
  const awaitScene = (jelenet, what) => page.waitForFunction(
    (j) => document.querySelectorAll('.vid-feedback-form input[type="number"]')[1]?.value === j,
    String(jelenet), { timeout: WAIT_MS },
  ).catch(async () => { throw new Error(`${what}: the form holds ${JSON.stringify(await readForm())}, not scene ${jelenet}`) })

  for (const [arany, vartJelenet] of [[0.5, 4], [0.02, 0], [0.97, 8]]) {
    const szazalek = Math.round(arany * 100)
    await page.mouse.click(box.x + box.width * arany, box.y + box.height / 2)
    await awaitScene(vartJelenet, `a pointer click at ${szazalek}% of the timeline`)
    const atMs = Number((await readForm()).atMs)
    const varhato = Math.round(arany * TELJES_MS)
    assert.ok(Math.abs(atMs - varhato) <= 30, `a click at ${szazalek}% of a ${TELJES_MS} ms timeline became ${atMs} ms, not ${varhato} ms`)
    results.push(`pointer at ${szazalek}%: ${atMs} ms, scene ${vartJelenet}`)
  }

  await page.locator('.vid-timeline-scene').nth(6).focus()
  await page.keyboard.press('Enter')
  await awaitScene(6, 'Enter on the focused scene 6')
  const keyboard = await readForm()
  assert.equal(keyboard.atMs, String(6 * JELENET_HOSSZ_MS), 'a keyboard activation picks the scene\'s own first millisecond, not a pixel nobody pointed at')
  results.push(`Enter on scene 6: ${keyboard.atMs} ms, scene ${keyboard.jelenet}`)
  return results
}

/**
 * The note: filed, filed again, and refused.
 *
 * The refusal is the one console line this test provokes on purpose -- the rpc
 * route answers a refusal with a 500 and the browser logs every error-status
 * resource -- so it is claimed here by name and nothing else is: the final
 * check still fails on any other console error.
 */
async function fileFeedback(page, record, fixture) {
  const results = []
  const form = page.locator('.vid-feedback-form')
  const szoveg = `Operátori megjegyzés ${HTML}`
  const marks = () => page.evaluate(() => document.querySelectorAll('.vid-timeline-mark').length)
  const notice = () => page.evaluate(() => document.querySelector('.vid-notice')?.textContent ?? '')

  assert.equal(await marks(), 1, 'one mark before the note is filed')

  // Enter on the focused submit button, not a click: this is the sequence the
  // aisignal defect broke, on the one control on this page that writes.
  const submitBefore = record.calls.length
  await form.locator('textarea').fill(szoveg)
  await form.locator('button[type="submit"]').focus()
  const filed = callLanded(page, 'feedback')
  await page.keyboard.press('Enter')
  assert.equal((await filed).status(), 200, 'the note was accepted')
  await until('the new note to become a second mark', async () => ((await marks()) === 2 ? true : undefined))
  assert.equal(await notice(), 'A visszajelzés elmentve.')
  assert.deepEqual(writesSince(record, submitBefore), ['feedback'], 'Enter on the focused "Küld" wrote exactly one note')
  const stored = fixture.repo.feedbackFor(fixture.a.id).filter((row) => row.forras === 'operator')
  assert.equal(stored.length, 1, 'exactly one operator row is in the database')
  assert.equal(stored[0].szoveg, szoveg, 'with the text as typed')
  assert.equal(stored[0].at_ms, 6000, 'and the timeline point the keyboard pick put in the form')
  assert.equal(stored[0].jelenet, 6)
  results.push('Enter on the focused "Küld": one note written, at the point the timeline pick put in the form')

  // The same note again: deduplicated by the repository, and the page says
  // which of the two happened rather than claiming a new row.
  await form.locator('textarea').fill(szoveg)
  const again = callLanded(page, 'feedback')
  await form.locator('button[type="submit"]').click()
  assert.equal((await again).status(), 200)
  await until('the page to report the duplicate', async () => ((await notice()).includes('új sor nem keletkezett') ? true : undefined))
  assert.equal(await marks(), 2, 'the duplicate added no mark')
  assert.equal(fixture.repo.feedbackFor(fixture.a.id).filter((row) => row.forras === 'operator').length, 1, 'and no row')
  results.push('The same note twice: reported as a duplicate, no second row and no second mark')

  // A point the server refuses by name.
  const consoleBefore = record.consoleErrors.length
  await form.locator('input[type="number"]').first().fill(ELUTASITOTT_AT_MS)
  await form.locator('textarea').fill(`Elutasítandó megjegyzés ${HTML}`)
  const refused = callLanded(page, 'feedback')
  await form.locator('button[type="submit"]').click()
  const refusal = await refused
  assert.equal(refusal.status(), 500, 'a refused rpc call answers with an error status')
  await until('the page to show the refusal', async () => ((await notice()).startsWith('A visszajelzés nem mentődött el:') ? true : undefined))
  const text = await notice()
  assert.ok(text.includes('atMs'), `the refusal names the field the server refused: "${text}"`)
  assert.equal(await marks(), 2, 'a refused note adds no mark')
  assert.equal(fixture.repo.feedbackFor(fixture.a.id).filter((row) => row.forras === 'operator').length, 1, 'and no row')
  const provoked = record.consoleErrors.splice(consoleBefore)
  assert.equal(provoked.length, 1, `the refusal provoked exactly one console line: ${JSON.stringify(provoked)}`)
  assert.match(provoked[0], new RegExp(`^Failed to load resource: the server responded with a status of ${refusal.status()} .*\\/call\\/feedback`), 'and it is the browser reporting the refused call')
  results.push('A refused note: shown as a refusal carrying the server\'s own reason; no row, no mark')
  return results
}

/* -------------------------------------------------------------------------- */
/*  main                                                                      */
/* -------------------------------------------------------------------------- */

async function main() {
  const startedAt = Date.now()
  const externalBaseUrl = (process.env.SWARMCLAW_E2E_BASE_URL || '').replace(/\/+$/, '')
  const accessKey = process.env.SWARMCLAW_E2E_ACCESS_KEY || process.env.ACCESS_KEY || crypto.randomBytes(16).toString('hex')
  if (externalBaseUrl && !(process.env.SWARMCLAW_E2E_ACCESS_KEY || process.env.ACCESS_KEY)) {
    throw new Error('SWARMCLAW_E2E_BASE_URL is set: pass the server\'s key as SWARMCLAW_E2E_ACCESS_KEY too')
  }
  if (externalBaseUrl && !process.env.DATA_DIR) {
    throw new Error('SWARMCLAW_E2E_BASE_URL is set: pass DATA_DIR (the directory holding that server\'s swarmclaw.db) so the fixture can be written')
  }

  let scratch = null
  let server = null
  let baseUrl = externalBaseUrl
  let dataDir = process.env.DATA_DIR || ''
  const timings = []
  const mark = (label, since) => timings.push(`${label}: ${elapsed(since)}`)

  const cleanup = async () => {
    await stopServer(server)
    if (scratch) fs.rmSync(scratch.root, { recursive: true, force: true })
  }
  process.once('SIGINT', () => { void cleanup().then(() => process.exit(130)) })
  process.once('SIGTERM', () => { void cleanup().then(() => process.exit(143)) })

  try {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-video-e2e-'))
    scratch = { root, dataDir: path.join(root, 'data'), home: path.join(root, 'home') }
    for (const dir of ['data', 'workspace', 'browser-profiles', 'home']) fs.mkdirSync(path.join(root, dir), { recursive: true })
    const project = makeRemotionProject(root)

    if (!baseUrl) {
      const buildStart = Date.now()
      await step('build the bundle', () => runNode('scripts/build.mjs', path.join(EXT_ROOT, 'scripts', 'build.mjs'), process.env))
      mark('build', buildStart)

      dataDir = scratch.dataDir
      await step('install the extension into the scratch data directory', () => runNode(
        'scripts/install.mjs', path.join(EXT_ROOT, 'scripts', 'install.mjs'),
        { ...process.env, DATA_DIR: scratch.dataDir, SWARMCLAW_HOME: scratch.home },
      ))

      const bootStart = Date.now()
      const port = await freePort()
      baseUrl = `http://127.0.0.1:${port}`
      server = startServer(port, scratch, accessKey)
      log(`starting a scratch dev server on ${baseUrl}`)
      await step('the scratch server comes up', () => waitForHealth(baseUrl, server.logs))
      mark('server boot', bootStart)
    }

    const auth = await step('authenticate', () => authenticate(baseUrl, accessKey))
    const loadStart = Date.now()
    await step('the host loads the extension', () => waitForExtensionPage(baseUrl, auth.headers))
    const dbPath = path.join(dataDir, 'swarmclaw.db')
    await step('the host applies the extension migrations', () => waitForMigrations(dbPath))
    await step('point remotionDir at the throwaway project', () => setRemotionDir(baseUrl, auth.headers, project.dir))
    mark('extension load', loadStart)

    await step('the scratch install starts empty', async () => {
      const res = await fetchJson(`${baseUrl}/api/extensions/${encodeURIComponent(EXTENSION_ID)}/call/board`, { method: 'POST', headers: auth.headers, body: '{}' })
      assert.ok(res.ok, `board answered ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`)
      if (scratch) assert.equal(res.body?.counts?.videos, 0, 'no video is in the scratch database before the fixture')
    })

    const storage = fileStorage(dbPath)
    let fixture
    try {
      fixture = await step('seed the fixture through the repository', () => seed(storage, project))
      log(`seeded ${fixture.counts.videos} videos, ${fixture.counts.renderek} render, ${fixture.counts.nyitottJavaslatok} proposals`)

      const browserStart = Date.now()
      const browser = await chromium.launch({ headless: true })
      try {
        const context = await browser.newContext({ baseURL: baseUrl, viewport: { width: 1280, height: 900 } })
        await context.addCookies([{
          name: 'sc_auth', value: auth.cookieValue, domain: new URL(baseUrl).hostname, path: '/', httpOnly: true, sameSite: 'Lax',
        }])
        await context.addInitScript((key) => {
          window.localStorage.setItem('sc_access_key', key)
          window.localStorage.setItem('sc_user', 'Video smoke')
          window.localStorage.setItem('sc_setup_done', '1')
        }, accessKey)
        const record = await instrument(context)
        const page = await context.newPage()
        attachPage(page, record)
        const steps = []

        await step('the page loads and registers', () => openPage(page, baseUrl))
        await step('the queue shows both hostile titles as text', () => checkQueue(page, fixture))
        await step('the status bar words every condition apart', () => checkStatusBar(page))
        steps.push(...await step('keyboard: the status bar and the tabs', () => driveKeyboardToProposals(page, record)))
        steps.push(...await step('proposals: accept, reject, evidence', () => checkProposals(page, record, fixture)))
        steps.push(await step('templates', () => checkTemplates(page, project)))

        // Back to the queue, and into the unfinished video with the keyboard:
        // a card is a button, and Enter on it must open that card's video.
        await step('keyboard: Enter on a focused queue card', async () => {
          const before = record.calls.length
          await page.locator('.vid-tabs button', { hasText: 'Sor' }).click()
          await page.waitForSelector('.vid-card', { timeout: WAIT_MS })
          await page.locator('.vid-tabs button', { hasText: 'Sablonok' }).focus()
          await tabTo(page, { tag: 'BUTTON', text: fixture.b.cim.slice(0, 40) })
          await page.keyboard.press('Enter')
          await page.waitForSelector('.vid-video', { timeout: WAIT_MS })
          assert.deepEqual(writesSince(record, before), [], 'opening a video wrote nothing')
          steps.push('Enter on the focused queue card: that card\'s video opened; no rpc write was made')
        })
        await step('the unfinished video refuses to link a javascript: source', () => checkUnfinishedVideo(page, fixture))

        await step('open the finished video', async () => {
          await page.locator('.vid-video button', { hasText: 'Vissza' }).click()
          await page.waitForSelector('.vid-card', { timeout: WAIT_MS })
          await page.locator(`.vid-card[data-video-id="${fixture.a.id}"]`).click()
          await page.waitForSelector('.vid-timeline', { timeout: WAIT_MS })
        })
        await step('the finished video shows its paths as text and its timeline to scale', () => checkFinishedVideo(page, fixture, project))
        steps.push(...await step('timeline picks', () => pickOnTimeline(page)))
        steps.push(...await step('feedback: filed, deduplicated, refused', () => fileFeedback(page, record, fixture)))

        await step('no page error, CSP violation, console error or popup', () => {
          assert.deepEqual(record.pageErrors, [], 'uncaught page errors')
          assert.deepEqual(record.csp, [], 'CSP violations')
          assert.deepEqual(record.consoleErrors, [], 'console errors')
          assert.equal(record.popups, 0, 'popups')
          assert.deepEqual(record.opened, [], 'urls the page tried to open')
        })
        await context.close()
        mark('browser', browserStart)
        console.log('\nWhat was driven:')
        for (const line of steps) console.log(`  - ${line}`)
      } finally {
        await browser.close()
      }
    } finally {
      storage.close()
    }

    mark('total', startedAt)
    console.log(`\nTimings: ${timings.join(', ')}`)
    console.log('video smoke ok')
  } finally {
    await cleanup()
  }
}

main().catch((err) => {
  console.error(`video smoke FAILED: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
