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

/**
 * The AI Signal page, driven in a real browser.
 *
 * Everything the unit suite pins is pinned without a DOM: the deck's state,
 * the wording, the href gate, the built bundle's shape. What that suite cannot
 * see is the page as the host actually serves it -- the bundle loaded through
 * the shell, its hooks running against the host's React, the CSP the shell
 * sends, a keydown that React dispatches to a focused control -- and that is
 * what this file is for. It is a smoke test: one path through the page that
 * fails loudly for a real break and never for a slow machine.
 *
 * What it does, in order:
 *
 *   1. builds the bundle and installs the extension into a scratch data
 *      directory the way `scripts/install.mjs` does for an operator;
 *   2. starts a dev server on a free port with DATA_DIR, WORKSPACE_DIR and
 *      SWARMCLAW_HOME pointed at that scratch directory, and waits for the
 *      host to load the extension and run its migrations;
 *   3. seeds the extension's own tables through `createRepo` -- the same code
 *      the sweep tools write through -- so a UI break cannot produce an empty
 *      fixture and a green run. The fixture is hostile on purpose: HTML and
 *      script tags in every text field, `javascript:`, `data:` and
 *      leading-space urls, a 3000-character headline, a 4000-character url,
 *      statuses outside the vocabulary, more undecided rows than the deck cap,
 *      more rows than the list cap, and sweeps in each of the four outcomes;
 *   4. opens `/x/aisignal` and checks what the previous review confirmed by
 *      hand: the page registers and renders, every hostile field arrives as
 *      text, no hostile url becomes a link target, long content does not widen
 *      the page, both caps report themselves, a refused query shows the
 *      server's refusal, `unavailable` and `unasked` are worded apart;
 *   5. drives the five keyboard sequences the key fix was made for, with the
 *      deck mounted and a real control focused, and then the deck's own keys
 *      with the card itself under the pointer;
 *   6. fails on any uncaught page error, any CSP violation, any console error
 *      and any window the page tried to open.
 *
 * Every wait is on a condition, never a sleep. A negative ("no card url
 * opened", "no decision written") is asserted after a later positive has
 * landed, so a stray action would have shown up in the log before it.
 *
 * Run locally from the repo root:
 *
 *   node extensions/aisignal/test/e2e.smoke.mjs
 *
 * or `npm run test:e2e` inside extensions/aisignal. Needs Playwright's
 * Chromium (`npx playwright install chromium` once). To point it at a server
 * that is already running, set SWARMCLAW_E2E_BASE_URL, SWARMCLAW_E2E_ACCESS_KEY
 * and DATA_DIR (the directory holding that server's swarmclaw.db, which the
 * fixture is written into). The key is read from the environment or minted
 * for the scratch server; it is never printed and never written anywhere but
 * the scratch directory, which is removed on exit.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const EXT_ROOT = path.resolve(here, '..')
const REPO_ROOT = path.resolve(EXT_ROOT, '..', '..')
const EXTENSION_ID = 'aisignal.mjs'
const PAGE_PATH = '/x/aisignal'

/** The first load compiles the route on a dev server; every later wait is on an already compiled page. */
const HEALTH_TIMEOUT_MS = 120_000
const FIRST_LOAD_TIMEOUT_MS = 180_000
const WAIT_MS = 30_000

/** Longer than `MAX_QUERY` in reads.mjs, so the server refuses it by name. */
const REFUSED_QUERY_LENGTH = 201

/** The top card. The two behind it are `.ais-card` too, empty and first in DOM order. */
const TOP_CARD = '.ais-card:not(.ais-card-behind)'

const HTML = '<script>alert(1)</script><img src=x onerror=alert(2)><b>félkövér</b>'
const TOP_URL = 'https://example.test/top-card'

function log(message) {
  console.log(`[aisignal smoke] ${message}`)
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
  // parent alone left that child alive after a run, still writing into the
  // scratch directory as it shut down, which re-created the directory after
  // it had been removed. Its own process group makes the whole tree one
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
/*  Auth                                                                      */
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
    body: JSON.stringify({ setupCompleted: true, userName: 'AI Signal smoke' }),
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
 * The rows, and what each one is there to catch. Returned so the browser
 * half can compare what the page shows against what was stored.
 */
function seed(storage, { deckLimit, listLimit }) {
  const repo = createRepo(storage)
  const label = 'AI hírlevél'
  const source = { account: 'smoke@example.test', sourceId: 'Label_smoke' }
  const t = (minutes) => new Date(Date.UTC(2026, 8, 1, 10, minutes)).toISOString()

  // Four sweeps, oldest first, one per outcome the status bar words apart.
  // The newest is the unfinished one so the "Utolsó sweep" line carries both
  // note segments; the other three sit under "Korábbi futások".
  const failed = repo.openSweep({ label, since: t(0), fetchedIds: [], skipped: 0, leftover: 0, ranAt: t(1) })
  repo.failSweep(failed.id, 'gmail_error', HTML)
  const nothing = repo.openSweep({ label, source, since: t(0), fetchedIds: [], skipped: 0, leftover: 0, drained: true, ranAt: t(2) })
  repo.finishSweep({ sweepId: nothing.id, ok: true })
  const found = repo.openSweep({ label, source, since: t(0), fetchedIds: [], skipped: 2, leftover: 3, ranAt: t(3) })
  repo.openSweep({
    label, kind: 'research', idSpace: { account: 'open-web' }, since: t(0), fetchedIds: [], skipped: 0, leftover: 0,
    note: 'unavailable=hn,reddit; unasked=github', ranAt: t(4),
  })

  const items = []
  const insert = (fields) => {
    const messageId = `m${items.length + 1}`
    const it = {
      sweepId: found.id, messageId, headline: `Cím ${messageId}`, summary: `Összefoglaló ${messageId}`,
      url: `https://example.test/${messageId}`, sourceName: 'Forrás', sourceEmail: 'src@example.test',
      sentAt: t(3), score: 0.3, applyScore: 0.5, why: 'mert', linkRead: true, ...fields,
    }
    const { id, merged } = repo.insertItem(it)
    assert.equal(merged, false, `fixture row ${messageId} merged into an existing row`)
    items.push({ id, ...it })
    return { id, ...it }
  }

  // More decided rows than the list cap, so the list has to say it is capped.
  // Decided through the repository, the way a decision from the page lands.
  const decidedCount = listLimit + 1
  for (let i = 0; i < decidedCount; i += 1) {
    const row = insert({ applyScore: 0.2 })
    repo.decide(row.id, i % 2 === 0 ? 'save' : 'archive')
  }
  // Two rows whose status is outside the vocabulary: one the page has never
  // heard of and one blank. The repository has no write for that -- nothing
  // in the extension produces such a row -- so the column is set directly.
  const weird = insert({ applyScore: 0.2, headline: 'Ismeretlen státuszú sor' })
  storage.exec('UPDATE ext_aisignal_items SET status = ? WHERE id = ?', ['weird', weird.id])
  const blank = insert({ applyScore: 0.2, headline: 'Üres státuszú sor' })
  storage.exec("UPDATE ext_aisignal_items SET status = '' WHERE id = ?", [blank.id])

  // More undecided rows than the deck cap, so the deck has to say it is capped.
  // The hostile ones carry the highest scores and are inserted last: highest
  // score puts them at the top of the deck, last insertion puts them at the
  // top of the list, so both views show them inside their caps.
  const fillerCount = deckLimit + 4
  for (let i = 0; i < fillerCount; i += 1) insert({ applyScore: 0.5 - i * 0.001 })
  const longUrl = insert({ applyScore: 0.94, headline: 'Négyezer karakteres url', url: `https://example.test/${'a'.repeat(4000 - 'https://example.test/'.length)}` })
  const longHeadline = insert({ applyScore: 0.95, headline: 'Háromezer karakteres címsor '.repeat(120).slice(0, 3000) })
  const leadingSpace = insert({ applyScore: 0.96, headline: 'Szóközzel kezdődő javascript url', url: ' javascript:alert(1)' })
  const dataUrl = insert({ applyScore: 0.97, headline: 'data: url', url: 'data:text/html,<script>alert(1)</script>' })
  const jsUrl = insert({ applyScore: 0.98, headline: 'javascript: url', url: 'javascript:alert(1)' })
  const top = insert({
    applyScore: 0.99, headline: `Legfelső kártya ${HTML}`, summary: `Összefoglaló ${HTML}`, why: `Miért ${HTML}`,
    sourceName: `Forrás ${HTML}`, url: TOP_URL,
  })
  repo.finishSweep({ sweepId: found.id, ok: true })

  const counts = repo.counts()
  assert.equal(counts.undecided, fillerCount + 6)
  assert.ok(counts.undecided > deckLimit, 'the fixture must overflow the deck cap')
  assert.ok(counts.items > listLimit, 'the fixture must overflow the list cap')
  return { repo, counts, top, jsUrl, dataUrl, leadingSpace, longHeadline, longUrl, weird, blank }
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
  assert.equal(active.tag, expected.tag, `Tab landed on <${active.tag}> "${active.text}" instead of <${expected.tag}> "${expected.text}"`)
  assert.ok(active.text.startsWith(expected.text), `Tab landed on "${active.text}" instead of "${expected.text}"`)
}

async function topHeadline(page) {
  return page.evaluate((sel) => document.querySelector(`${sel} h2`)?.textContent ?? null, TOP_CARD)
}

async function waitForTopHeadline(page, headline, what) {
  await page.waitForFunction(([sel, h]) => document.querySelector(`${sel} h2`)?.textContent === h, [TOP_CARD, headline], { timeout: WAIT_MS })
    .catch(async () => { throw new Error(`${what}: the top card is "${(await topHeadline(page) ?? '').slice(0, 60)}", not "${headline.slice(0, 60)}"`) })
}

/**
 * The page's side effects, gathered in Node.
 *
 * `window.open` is replaced before any page script runs so an opened url is
 * recorded rather than opened, and a popup the page manages to spawn anyway
 * is counted too. CSP violations are taken from the document's own event,
 * which fires under a report-only policy as well as an enforced one, so the
 * count is right whichever way the host is configured. Every `decide` call
 * the page makes is logged with its body, so a decision that should not have
 * been written is visible as a log entry rather than as a silent row change.
 */
async function instrument(context) {
  const record = { opened: [], popups: 0, csp: [], pageErrors: [], consoleErrors: [], decides: [] }
  await context.exposeFunction('__aisRecordOpen', (href) => { record.opened.push(href) })
  await context.exposeFunction('__aisRecordCsp', (detail) => { record.csp.push(detail) })
  await context.addInitScript(() => {
    window.open = (url) => { window.__aisRecordOpen(String(url)); return null }
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__aisRecordCsp(`${e.violatedDirective} blocked ${e.blockedURI} at ${e.sourceFile}:${e.lineNumber}`)
    })
  })
  // Nothing on this page starts an OAuth flow any more -- the consent moved to
  // the `gmail` extension's own page with the credential -- but the route is
  // still answered here so that a regression which brought the old link back
  // shows up as a failed assertion rather than as a request leaving the
  // machine.
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
    if (req.method() !== 'POST' || !req.url().includes(`/api/extensions/${encodeURIComponent(EXTENSION_ID)}/call/decide`)) return
    let body = null
    try { body = JSON.parse(req.postData() || 'null') } catch { body = req.postData() }
    record.decides.push(body)
  })
}

/** Resolves with the `decide` response for `id` and `decision`, or fails the step if none arrives. */
function decideLanded(page, id, decision) {
  return page.waitForResponse((res) => {
    const req = res.request()
    if (req.method() !== 'POST' || !res.url().includes('/call/decide')) return false
    try {
      const body = JSON.parse(req.postData() || 'null')
      return body?.id === id && body?.decision === decision
    } catch {
      return false
    }
  }, { timeout: WAIT_MS }).then(async (res) => {
    assert.equal(res.status(), 200, `decide ${decision} for ${id} answered ${res.status()}`)
    const body = await res.json()
    assert.equal(body.ok, true, `decide ${decision} for ${id} answered ok: ${body.ok}`)
  })
}

async function openPage(page, baseUrl) {
  await page.goto(`${baseUrl}${PAGE_PATH}`, { waitUntil: 'commit', timeout: FIRST_LOAD_TIMEOUT_MS })
  // Either the page mounts or the host says why it did not. Waiting on the
  // card alone would turn every load failure into a timeout in the wrong place.
  const outcome = await page.waitForFunction((sel) => {
    if (document.querySelector(sel)) return { ok: true }
    const heading = Array.from(document.querySelectorAll('h1'))
      .find((h) => /^(Extension "|No installed extension|Could not load the list)/.test(h.textContent || ''))
    if (!heading) return null
    const detail = heading.parentElement?.querySelector('p')?.textContent ?? ''
    return { ok: false, message: `${heading.textContent}\n${detail}` }
  }, TOP_CARD, { timeout: FIRST_LOAD_TIMEOUT_MS, polling: 200 }).then((h) => h.jsonValue())
  if (!outcome.ok) throw new Error(`the host refused the page:\n${outcome.message}`)
}

async function checkDeckRendering(page, fixture, deckLimit) {
  const card = await page.evaluate((sel) => {
    const el = document.querySelector(sel)
    const root = document.querySelector('.ais-root')
    return {
      headline: el.querySelector('h2')?.textContent,
      summary: el.querySelector('p')?.textContent,
      why: el.querySelector('.ais-why')?.textContent,
      source: el.querySelector('.ais-meta span')?.textContent,
      href: el.querySelector('a.ais-link')?.getAttribute('href'),
      injected: el.querySelectorAll('script, img, b').length,
      cardWidth: el.getBoundingClientRect().width,
      rootWidth: root.getBoundingClientRect().width,
      pageOverflows: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      counter: document.querySelector('.ais-deck .ais-muted')?.textContent,
    }
  }, TOP_CARD)
  assert.equal(card.headline, fixture.top.headline, 'the hostile headline is shown as stored')
  assert.equal(card.summary, fixture.top.summary, 'the hostile summary is shown as stored')
  assert.equal(card.why, fixture.top.why, 'the hostile why is shown as stored')
  assert.equal(card.source, fixture.top.sourceName, 'the hostile source is shown as stored')
  assert.equal(card.href, TOP_URL)
  assert.equal(card.injected, 0, 'no element from a stored field reached the DOM')
  assert.ok(!card.pageOverflows, 'the page does not scroll horizontally')
  assert.ok(card.cardWidth <= card.rootWidth + 1, `the card (${card.cardWidth}px) is no wider than the page (${card.rootWidth}px)`)
  assert.match(card.counter ?? '', new RegExp(`Még ${deckLimit} a pakliban · ${fixture.counts.undecided} eldöntetlen összesen · a pakli ${deckLimit} kártyás`))
}

async function checkStatusBar(page, fixture) {
  const status = await page.evaluate(() => ({
    text: document.querySelector('.ais-status')?.textContent ?? '',
    injected: document.querySelectorAll('.ais-status script, .ais-status img, .ais-status b').length,
    gmailLink: document.querySelector('.ais-status a.ais-gmail-page')?.getAttribute('href') ?? null,
    summary: document.querySelector('.ais-status summary')?.textContent,
  }))
  assert.equal(status.injected, 0, 'no element from a sweep note or the label reached the DOM')
  assert.ok(status.text.includes('nem válaszolt: hn, reddit'), 'unavailable is worded as not answering')
  assert.ok(status.text.includes('meg sem lett kérdezve: github'), 'unasked is worded as never asked')
  assert.ok(status.text.includes('nincs lezárva'), 'the unfinished sweep says so')
  assert.ok(status.text.includes(`hiba: gmail_error: ${HTML}`), 'the failed sweep shows its note as text')
  assert.ok(status.text.includes('lefutott, 0 új sort talált'), 'the sweep that found nothing says so')
  assert.ok(status.text.includes('3 levél kimaradt a sapka miatt'), 'the leftover is reported')
  // The scratch install has AI Signal and nothing else, so the `gmail`
  // extension that provides the mailbox is not there. That is one of the four
  // named reasons and the page says which -- it does not say "not connected",
  // which would be a claim about a credential this extension can no longer see.
  assert.ok(status.text.includes('a gmail extension nincs telepítve'), `the missing provider is named: ${status.text}`)
  // And no link: the page it would point at belongs to the extension that is
  // not installed, so it would land on the extension route's "no such page".
  // The remedy the sentence names is the Extensions screen instead.
  assert.equal(status.gmailLink, null, 'no link is offered to a page the missing extension would have contributed')
  assert.equal(status.text.includes('nincs bekötve'), false, 'and nothing here claims to know about a credential')
  assert.equal(status.summary, `Korábbi futások (${fixture.counts.sweeps})`)
  // The scratch install was never reconciled, so the host has neither
  // schedule, and the page has to say so rather than let "no sweep has run
  // yet" stand for it. This is the real host's summary endpoint answering the
  // real page, over the cookie the page was served with.
  await page.waitForFunction(() => !(document.querySelector('.ais-status')?.textContent ?? '').includes('ellenőrzés folyamatban'), null, { timeout: WAIT_MS })
  const scheduleLine = await page.evaluate(() => Array.from(document.querySelectorAll('.ais-status-row span')).map((s) => s.textContent).find((t) => t?.startsWith('Ütemezés:')) ?? '')
  assert.ok(scheduleLine.includes('2 a 2 futásból nincs beállítva'), `the never-reconciled install says its schedules are missing: ${scheduleLine}`)
  assert.ok(scheduleLine.includes('Reconcile'), 'and names the remedy')
}

async function checkListRendering(page, fixture, listLimit) {
  await page.waitForSelector('.ais-row', { timeout: WAIT_MS })
  const list = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.ais-row'))
    const row = (headline) => rows.find((r) => r.querySelector('strong')?.textContent === headline)
    const describe = (r) => r && {
      href: r.querySelector('a.ais-link')?.getAttribute('href') ?? null,
      warn: r.querySelector('.ais-warn')?.textContent ?? null,
      badge: r.querySelector('.ais-badge')?.textContent ?? null,
      badBadge: Boolean(r.querySelector('.ais-badge-bad')),
    }
    return {
      count: rows.length,
      hostileHrefs: document.querySelectorAll('.ais-root a[href^="javascript:" i], .ais-root a[href^="data:" i]').length,
      injected: document.querySelectorAll('.ais-list script, .ais-list img, .ais-list b').length,
      capped: document.querySelector('.ais-capped')?.textContent ?? '',
      total: Array.from(document.querySelectorAll('.ais-chips .ais-mono')).map((s) => s.textContent).join(' '),
      pageOverflows: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      byHeadline: Object.fromEntries(['javascript: url', 'data: url', 'Szóközzel kezdődő javascript url', 'Ismeretlen státuszú sor', 'Üres státuszú sor']
        .map((h) => [h, describe(row(h))])),
      top: rows[0]?.querySelector('strong')?.textContent,
    }
  })
  assert.equal(list.count, listLimit, `the list shows exactly the cap (${listLimit}) of ${fixture.counts.items} rows`)
  assert.ok(list.capped.startsWith(`${listLimit} sor látszik, összesen ${fixture.counts.items}`), `the list says it is capped: "${list.capped}"`)
  assert.ok(list.total.includes(`${fixture.counts.items} sor`), 'the list reports the total behind the page')
  assert.equal(list.hostileHrefs, 0, 'no javascript: or data: href anywhere on the page')
  assert.equal(list.injected, 0, 'no element from a stored field reached the list')
  assert.ok(!list.pageOverflows, 'the list does not scroll horizontally')
  assert.equal(list.top, fixture.top.headline, 'the newest row is first')
  for (const headline of ['javascript: url', 'data: url', 'Szóközzel kezdődő javascript url']) {
    const row = list.byHeadline[headline]
    assert.ok(row, `the "${headline}" row is on the page`)
    assert.equal(row.href, null, `"${headline}" has no link`)
    assert.ok(row.warn?.startsWith('A link nem megnyitható (nem http/https)'), `"${headline}" is flagged as not openable`)
  }
  assert.deepEqual(
    { badge: list.byHeadline['Ismeretlen státuszú sor']?.badge, bad: list.byHeadline['Ismeretlen státuszú sor']?.badBadge },
    { badge: 'weird', bad: true }, 'an unknown status is shown as stored and flagged',
  )
  assert.deepEqual(
    { badge: list.byHeadline['Üres státuszú sor']?.badge, bad: list.byHeadline['Üres státuszú sor']?.badBadge },
    { badge: '(üres státusz)', bad: true }, 'a blank status is named and flagged',
  )
}

/**
 * A query the server refuses. The rpc route answers a refusal with an error
 * status, and the browser logs every error-status resource to the console,
 * so the one console line this step provokes is claimed here and nothing
 * else is: the final check still fails on any other console error.
 */
async function checkRefusedQuery(page, record) {
  const consoleBefore = record.consoleErrors.length
  const refusal = page.waitForResponse((res) => res.url().includes('/call/items') && !res.ok(), { timeout: WAIT_MS })
  await page.fill('.ais-search', 'x'.repeat(REFUSED_QUERY_LENGTH))
  const response = await refusal
  await page.waitForSelector('.ais-list .ais-error', { timeout: WAIT_MS })
  const refused = await page.evaluate(() => ({
    message: document.querySelector('.ais-list .ais-error')?.textContent ?? '',
    rows: document.querySelectorAll('.ais-row').length,
    empty: (document.querySelector('.ais-list')?.textContent ?? '').includes('Nincs ilyen sor'),
  }))
  assert.ok(refused.message.startsWith('A lekérdezést a szerver elutasította'), `the refusal is shown: "${refused.message}"`)
  assert.ok(refused.message.includes('q must be at most'), 'the refusal carries the server\'s own reason')
  assert.equal(refused.rows, 0, 'a refused query shows no rows')
  assert.ok(!refused.empty, 'a refused query is not shown as an empty list')
  await page.fill('.ais-search', '')
  await page.waitForSelector('.ais-row', { timeout: WAIT_MS })
  const provoked = record.consoleErrors.splice(consoleBefore)
  const expected = new RegExp(`^Failed to load resource: the server responded with a status of ${response.status()} .*\\/call\\/items`)
  assert.equal(provoked.length, 1, `the refused query provoked exactly one console line: ${JSON.stringify(provoked)}`)
  assert.match(provoked[0], expected, 'the console line is the browser reporting the refused items call')
}

/**
 * The five sequences the key fix was made for, and then the deck's own keys.
 *
 * Every control is reached with a real Tab from the previous control in the
 * extension's own DOM, and the key is a real keydown that React dispatches.
 * The order is chosen so each negative is followed by a positive that would
 * have exposed it: the arrow on the tab is followed by Enter on the same tab,
 * whose `items` call lands after any `decide` the arrow could have sent.
 */
async function driveKeys(page, record, fixture) {
  const decidesBefore = record.decides.length
  const openedBefore = record.opened.length
  const results = []

  // Sequence 4: Tab to "Korábbi futások", Enter -> it opens.
  await page.locator('.ais-status button', { hasText: 'Frissítés' }).focus()
  await tabTo(page, { tag: 'SUMMARY', text: 'Korábbi futások' })
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => document.querySelector('details.ais-sweeps')?.open === true, undefined, { timeout: WAIT_MS })
    .catch(() => { throw new Error(`Enter on "Korábbi futások" did not open the history; urls opened instead: ${JSON.stringify(record.opened)}`) })
  results.push('Enter on "Korábbi futások": the history opened; no card url opened, no decision written')

  // Sequence 5: Tab on to the "Lista" tab, ArrowRight -> no decision.
  await tabTo(page, { tag: 'A', text: 'Gmail bekötése' })
  await tabTo(page, { tag: 'BUTTON', text: 'Pakli' })
  await tabTo(page, { tag: 'BUTTON', text: 'Lista' })
  await page.keyboard.press('ArrowRight')
  const stillDeck = await page.evaluate((sel) => Boolean(document.querySelector(sel)), TOP_CARD)
  assert.ok(stillDeck, 'the deck is still mounted after ArrowRight on the tab')

  // Sequence 1: Enter on the focused "Lista" tab -> the tab switches.
  await page.keyboard.press('Enter')
  await page.waitForSelector('.ais-row', { timeout: WAIT_MS })
  const selected = await page.evaluate(() => document.querySelector('.ais-tab-active')?.textContent)
  assert.equal(selected, 'Lista')
  assert.equal(record.decides.length, decidesBefore, `no decision was written by the arrow or the Enter on the tab: ${JSON.stringify(record.decides.slice(decidesBefore))}`)
  assert.equal(record.opened.length, openedBefore, `no card url opened: ${JSON.stringify(record.opened.slice(openedBefore))}`)
  results.push('ArrowRight on the focused "Lista" tab: no decision written for any card')
  results.push('Enter on the focused "Lista" tab: the tab switched to the list; no card url opened')

  await checkListRendering(page, fixture, fixture.listLimit)
  await checkRefusedQuery(page, record)

  // Back to the deck. The board was not reloaded, so the same top card is up.
  await page.locator('.ais-tabs button', { hasText: 'Pakli' }).click()
  await waitForTopHeadline(page, fixture.top.headline, 'returning to the deck')

  // The deck's own keys, with the card itself under the pointer. The card is
  // not focusable, so a press on it leaves focus on the body, which is where
  // the deck's keys are meant to work. Enter first: it opens the top url,
  // which proves the open detector sees a real open before the sequences
  // below rely on it seeing none.
  await page.locator(`${TOP_CARD} h2`).click({ position: { x: 8, y: 8 } })
  assert.equal((await activeElement(page)).tag, 'BODY', 'a press on the card leaves focus on the body')
  assert.equal(record.decides.length, decidesBefore, 'a press without a drag decides nothing')
  await page.keyboard.press('Enter')
  await until('Enter on the card to open the top url', () => (record.opened.length > openedBefore ? true : undefined))
  assert.deepEqual(record.opened.slice(openedBefore), [TOP_URL], 'Enter on the card opened exactly the top url')

  const [a, b, c] = [fixture.top, fixture.jsUrl, fixture.dataUrl]
  let landed = decideLanded(page, a.id, 'save')
  await page.keyboard.press('ArrowRight')
  await waitForTopHeadline(page, b.headline, 'ArrowRight on the card')
  await landed
  landed = decideLanded(page, b.id, 'archive')
  await page.keyboard.press('ArrowLeft')
  await waitForTopHeadline(page, c.headline, 'ArrowLeft on the card')
  await landed
  assert.deepEqual(
    [fixture.repo.itemById(a.id).status, fixture.repo.itemById(b.id).status], ['saved', 'archived'],
    'the two decisions are in the database',
  )
  landed = decideLanded(page, b.id, 'undo')
  await page.keyboard.press('u')
  await waitForTopHeadline(page, b.headline, 'u on the card')
  await landed
  landed = decideLanded(page, a.id, 'undo')
  await page.keyboard.press('ControlOrMeta+z')
  await waitForTopHeadline(page, a.headline, 'Cmd/Ctrl+Z on the card')
  await landed
  assert.deepEqual(
    [fixture.repo.itemById(a.id), fixture.repo.itemById(b.id)].map((row) => [row.status, row.decided_at]),
    [['new', null], ['new', null]],
    'both undos are in the database',
  )
  assert.deepEqual(
    record.decides.slice(decidesBefore).map((d) => [d.id, d.decision]),
    [[a.id, 'save'], [b.id, 'archive'], [b.id, 'undo'], [a.id, 'undo']],
    'the deck wrote exactly the four decisions, in order',
  )
  results.push('ArrowRight, ArrowLeft, u and Cmd/Ctrl+Z with the card under the pointer: save, archive, undo, undo written in order and undone in the database')

  // Sequence 3: Tab to "Ment →", Enter -> a decision is written, no url opened.
  // The top card's link is in the tab order before the buttons, and undo is
  // disabled again after the two undos, so Tab skips it.
  await page.locator('.ais-tabs button', { hasText: 'Pakli' }).focus()
  await tabTo(page, { tag: 'BUTTON', text: 'Lista' })
  await tabTo(page, { tag: 'A', text: TOP_URL })
  await tabTo(page, { tag: 'BUTTON', text: '← Archivál' })
  await tabTo(page, { tag: 'BUTTON', text: 'Ment →' })
  const openedBeforeSave = record.opened.length
  landed = decideLanded(page, a.id, 'save')
  await page.keyboard.press('Enter')
  await waitForTopHeadline(page, b.headline, 'Enter on "Ment →"')
  await landed
  assert.equal(fixture.repo.itemById(a.id).status, 'saved', 'Enter on "Ment →" wrote the decision')
  assert.equal(record.opened.length, openedBeforeSave, `no card url opened: ${JSON.stringify(record.opened.slice(openedBeforeSave))}`)
  results.push('Enter on the focused "Ment →": the decision was written to the database; no card url opened')

  // Sequence 2: Tab to the "Korábbi futások" summary, Enter -> the details
  // opens and the card underneath is untouched. This used to press Enter on
  // "Gmail bekötése"; that link is gone with the OAuth flow it started, and on
  // this scratch install -- which has AI Signal and not the `gmail` extension
  // -- the status bar offers no link at all. The summary is the control the
  // status bar still has, and it exercises the same rule: a focused control in
  // the status bar takes Enter, and the deck's own key listener does not.
  await page.locator('.ais-status button', { hasText: 'Frissítés' }).focus()
  await tabTo(page, { tag: 'SUMMARY', text: 'Korábbi futások' })
  const decidesBeforeSummary = record.decides.length
  const openedBeforeSummary = record.opened.length
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => document.querySelector('.ais-status details')?.open === true, null, { timeout: WAIT_MS })
  assert.equal(record.decides.length, decidesBeforeSummary, 'Enter on the summary decided nothing')
  assert.equal(record.opened.length, openedBeforeSummary, `no card url opened: ${JSON.stringify(record.opened.slice(openedBeforeSummary))}`)
  // And the OAuth route this page used to link to was never asked for.
  assert.equal(record.opened.some((href) => String(href).includes('/api/oauth/google/start')), false, 'no OAuth flow was started from this page')
  results.push('Enter on the focused "Korábbi futások" summary: the history opened; no card url opened, no decision written')

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
    if (!baseUrl) {
      const buildStart = Date.now()
      await step('build the bundle', () => runNode('scripts/build.mjs', path.join(EXT_ROOT, 'scripts', 'build.mjs'), process.env))
      mark('build', buildStart)

      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-aisignal-e2e-'))
      scratch = { root, dataDir: path.join(root, 'data'), home: path.join(root, 'home') }
      for (const dir of ['data', 'workspace', 'browser-profiles', 'home']) fs.mkdirSync(path.join(root, dir), { recursive: true })
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
    mark('extension load', loadStart)

    const limits = await step('read the caps from the board', async () => {
      const res = await fetchJson(`${baseUrl}/api/extensions/${encodeURIComponent(EXTENSION_ID)}/call/board`, { method: 'POST', headers: auth.headers, body: '{}' })
      assert.ok(res.ok, `board answered ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`)
      if (scratch) assert.equal(res.body?.counts?.items, 0, 'the scratch install starts empty')
      return { deckLimit: res.body.deckLimit, listLimit: res.body.allLimit }
    })

    const storage = fileStorage(dbPath)
    let fixture
    try {
      fixture = await step('seed the fixture through the repository', () => ({ ...seed(storage, limits), ...limits }))
      log(`seeded ${fixture.counts.items} rows (${fixture.counts.undecided} undecided) and ${fixture.counts.sweeps} sweeps`)

      const browserStart = Date.now()
      const browser = await chromium.launch({ headless: true })
      try {
        const context = await browser.newContext({ baseURL: baseUrl, viewport: { width: 1280, height: 900 } })
        await context.addCookies([{
          name: 'sc_auth', value: auth.cookieValue, domain: new URL(baseUrl).hostname, path: '/', httpOnly: true, sameSite: 'Lax',
        }])
        await context.addInitScript((key) => {
          window.localStorage.setItem('sc_access_key', key)
          window.localStorage.setItem('sc_user', 'AI Signal smoke')
          window.localStorage.setItem('sc_setup_done', '1')
        }, accessKey)
        const record = await instrument(context)
        const page = await context.newPage()
        attachPage(page, record)

        await step('the page loads and registers', () => openPage(page, baseUrl))
        await step('the deck renders the hostile top card as text and reports its cap', () => checkDeckRendering(page, fixture, limits.deckLimit))
        await step('the status bar words the four sweeps apart and shows notes as text', () => checkStatusBar(page, fixture))
        const sequences = await step('keyboard', () => driveKeys(page, record, fixture))

        await step('no page error, CSP violation, console error or popup', () => {
          assert.deepEqual(record.pageErrors, [], 'uncaught page errors')
          assert.deepEqual(record.csp, [], 'CSP violations')
          assert.deepEqual(record.consoleErrors, [], 'console errors')
          assert.equal(record.popups, 0, 'popups')
        })
        await context.close()
        mark('browser', browserStart)
        console.log('\nKey sequences:')
        for (const line of sequences) console.log(`  - ${line}`)
      } finally {
        await browser.close()
      }
    } finally {
      storage.close()
    }

    mark('total', startedAt)
    console.log(`\nTimings: ${timings.join(', ')}`)
    console.log('aisignal smoke ok')
  } finally {
    await cleanup()
  }
}

main().catch((err) => {
  console.error(`aisignal smoke FAILED: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
