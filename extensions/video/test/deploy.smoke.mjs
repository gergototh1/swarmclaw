import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { MIGRATIONS, createRepo } from '../src/db.mjs'

/**
 * The video extension on a deployed host, checked over the wire.
 *
 * The unit suite runs this module's code under `tsx` in this checkout. What it
 * cannot see is the runtime the product ships: the desktop app's server under
 * Electron's embedded Node with `better-sqlite3` rebuilt for Electron's ABI,
 * and the Linux container under the image's Node with the module compiled
 * there. An extension that loads in one and not the other is listed as
 * installed and enabled in both -- the host reports an external file as
 * `enabled: true` whether or not it ever loaded -- so "it is in the list"
 * proves nothing. This script asks the questions only a loaded extension can
 * answer.
 *
 * It takes a server that is already running and, in order:
 *
 *   1. waits for `/api/healthz` and signs in with the server's access key;
 *   2. reads `/api/extensions` and requires the fields only a *loaded*
 *      extension has -- the declared name and version, `hasUI`, the tool count,
 *      the managed agent and schedule counts, both contract lists -- and no
 *      recorded failure;
 *   3. requires the page in `/api/extensions/ui?type=pages`, and that its
 *      script and stylesheet are served from the workspace's `dist`;
 *   4. requires `/x/video` to answer with the shell rather than a redirect;
 *   5. calls `health`, `board` and `templates` over rpc, checks their shape,
 *      checks that no key or access-key value is anywhere in the answers, and
 *      that an unknown method is a 404 rather than a crash;
 *   6. with DATA_DIR set: requires every migration db.mjs declares to have been
 *      applied through the host's own database driver, the schema to match what
 *      those migrations produce on an empty database, the installed workspace
 *      to hold no native module, and then writes one video through the
 *      extension's own repository and reads it back over rpc with its source
 *      text intact -- so the write path is exercised on that runtime's SQLite
 *      build rather than assumed.
 *
 * Run it against a server on any host:
 *
 *   SWARMCLAW_DEPLOY_BASE_URL=http://127.0.0.1:3518 \
 *   SWARMCLAW_DEPLOY_ACCESS_KEY=... DATA_DIR=/path/to/data \
 *   node extensions/video/test/deploy.smoke.mjs
 *
 * DATA_DIR is the directory holding that server's `swarmclaw.db`. In a
 * container, run the script inside the container so the file is local to it;
 * SQLite's WAL locking does not survive a bind mount shared with another
 * process on the host. Without DATA_DIR step 6 is skipped and reported as
 * skipped, never as passed.
 *
 * The key is never printed and never written anywhere.
 */

const EXTENSION_ID = 'video.mjs'
const PAGE_PATH = '/x/video'
const HEALTH_TIMEOUT_MS = 120_000
const LOAD_TIMEOUT_MS = 120_000

/** Tools index.mjs declares (see extensions/video/test/import-time.test.mjs for the names). */
const EXPECTED_TOOL_COUNT = 13
const EXPECTED_AGENT_COUNT = 2
const EXPECTED_SCHEDULE_COUNT = 3

const baseUrl = (process.env.SWARMCLAW_DEPLOY_BASE_URL || '').replace(/\/+$/, '')
const accessKey = process.env.SWARMCLAW_DEPLOY_ACCESS_KEY || process.env.ACCESS_KEY || ''
const dataDir = process.env.DATA_DIR || ''

if (!baseUrl) throw new Error('SWARMCLAW_DEPLOY_BASE_URL is required: the base url of the running server')
if (!accessKey) throw new Error('SWARMCLAW_DEPLOY_ACCESS_KEY (or ACCESS_KEY) is required: the running server\'s access key')

let passed = 0
function log(message) {
  console.log(`[video deploy] ${message}`)
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
    body: JSON.stringify({ setupCompleted: true, userName: 'Video deploy smoke' }),
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
 * Two separate worries. The access key is a real value this script holds, so
 * its presence in a response body would be a live leak. `apiKey` and
 * `ACCESS_KEY` are field names: an answer that carries either has grown a path
 * for a key value to ride out on, whatever it holds today. Both are checked on
 * the raw text rather than the parsed object, because a nested field is still
 * a field.
 */
function assertNoSecret(what, text) {
  assert.ok(!text.includes(accessKey), `${what} carries the access key`)
  for (const forbidden of ['apiKey', 'ACCESS_KEY']) {
    assert.ok(!text.includes(forbidden), `${what} carries a ${forbidden} field`)
  }
}

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

/** The extension's own tables in `storage`, sorted. */
function extensionTables(storage) {
  return storage.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'ext_video_%' ORDER BY name").map((r) => r.name)
}

/** The tables `MIGRATIONS` leave behind when applied, in order, to an empty database. */
function expectedExtensionTables() {
  const db = new DatabaseSync(':memory:')
  try {
    for (const migration of [...MIGRATIONS].sort((a, b) => a.version - b.version)) {
      assert.equal(typeof migration.sql, 'string', `migration v${migration.version} is not plain SQL`)
      db.exec(migration.sql)
    }
    return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'ext_video_%' ORDER BY name").all().map((r) => r.name)
  } finally {
    db.close()
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
      // A listed-but-never-loaded file has hasUI false and toolCount 0; keep polling
      // for a while, since the first list call is what triggers the load.
      return found.hasUI === true && found.toolCount > 0 ? found : undefined
    }, LOAD_TIMEOUT_MS).catch(async (err) => {
      const res = await fetchJson(`${baseUrl}/api/extensions`, { headers })
      const found = Array.isArray(res.body) ? res.body.find((m) => m?.filename === EXTENSION_ID) : null
      throw new Error(`${err.message}; last listing: ${JSON.stringify(found)}`)
    })
    assert.equal(entry.enabled, true, 'enabled')
    assert.equal(entry.name, 'Videó', 'name is the one index.mjs declares, not the filename')
    assert.equal(entry.version, '0.1.0', 'version is the one index.mjs declares')
    assert.equal(entry.hasUI, true, 'hasUI')
    assert.equal(entry.toolCount, EXPECTED_TOOL_COUNT, 'toolCount')
    assert.equal(entry.managedAgentCount, EXPECTED_AGENT_COUNT, 'managedAgentCount')
    assert.equal(entry.managedScheduleCount, EXPECTED_SCHEDULE_COUNT, 'managedScheduleCount')
    assert.equal(entry.autoDisabled, false, 'autoDisabled')
    assert.equal(entry.lastFailureError, undefined, `a failure is recorded: ${entry.lastFailureStage} ${entry.lastFailureError}`)
    assert.deepEqual(
      (entry.contractsProvided || []).map((c) => ({ contract: c.contract, version: c.version })),
      [{ contract: 'videos', version: 1 }],
      'contractsProvided',
    )
    // Both consumptions are listed with the sentence the operator reads before
    // granting access. They are listed whether or not a provider is installed:
    // an unmet consumption is answered at call time, never at load time, so the
    // grant showing up here says nothing about tts or aisignal being present.
    const consumed = (entry.contractsConsumed || []).map((c) => `${c.extension}.${c.contract}`)
    assert.deepEqual(consumed.slice().sort(), ['aisignal.signals', 'tts.narration'], 'contractsConsumed')
    for (const c of entry.contractsConsumed) {
      assert.ok(typeof c.reason === 'string' && c.reason.length > 0, `${c.extension}.${c.contract} has no reason`)
    }
    return `name=${entry.name} tools=${entry.toolCount} agents=${entry.managedAgentCount} schedules=${entry.managedScheduleCount}`
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
    assert.match(style.headers.get('content-type') || '', /text\/css/, 'stylesheet content-type')
    return `entry=${found.entry} (${script.text.length} bytes) css=${style.text.length} bytes`
  })

  await check(`${PAGE_PATH} answers with the shell`, async () => {
    const res = await fetchRaw(`${baseUrl}${PAGE_PATH}`, { headers: { Cookie: headers.Cookie } })
    assert.equal(res.status, 200, `answered ${res.status}${res.headers.get('location') ? ` -> ${res.headers.get('location')}` : ''}`)
    assert.match(res.headers.get('content-type') || '', /text\/html/, 'content-type')
    assert.ok(res.text.includes('<div'), 'the html is not a shell')
    // Answering 200 here is not the same as the page appearing in a browser
    // that is already open: the client asked for the page list when it loaded
    // and does not ask again by itself. That is a client reload, not a server
    // fault, and the install script says so.
    const enforced = res.headers.get('content-security-policy') || ''
    const reportOnly = res.headers.get('content-security-policy-report-only') || ''
    assert.ok(enforced.includes("'nonce-") || reportOnly.includes("'nonce-"), 'the page is served with a nonce-bearing CSP')
    return `${res.text.length} bytes, ${enforced ? 'enforced' : 'report-only'} CSP with nonce`
  })

  const health = await check('rpc health answers with the module conditions and no key', async () => {
    const res = await rpc(headers, 'health')
    assert.equal(res.status, 200, `answered ${res.status}: ${JSON.stringify(res.body)}`)
    assert.ok(Array.isArray(res.body?.hibak), 'hibak')
    assert.ok(Array.isArray(res.body?.figyelmeztetesek), 'figyelmeztetesek')
    assert.ok(Array.isArray(res.body?.blokkolt), 'blokkolt')
    // reconcile is the one condition the module structurally cannot answer, so
    // it must be named here rather than being absent from `hibak` and read as
    // a pass.
    assert.ok(res.body?.nemValaszolt?.includes('reconcile_hianyzik'), 'reconcile_hianyzik is not reported as unanswered')
    assert.equal(typeof res.body?.counts?.videos, 'number', 'counts.videos')
    assertNoSecret('health', res.text)
    return `hibak=${res.body.hibak.join(',') || 'none'} blokkolt=${res.body.blokkolt.join(',') || 'none'}`
  })

  await check('rpc board answers with the columns, the statuses and the caps', async () => {
    const res = await rpc(headers, 'board')
    assert.equal(res.status, 200, `answered ${res.status}: ${JSON.stringify(res.body)}`)
    assert.ok(Array.isArray(res.body?.statusok) && res.body.statusok.length > 0, 'statusok')
    assert.equal(typeof res.body?.oszlopok, 'object', 'oszlopok')
    for (const status of res.body.statusok) {
      assert.ok(Array.isArray(res.body.oszlopok[status]), `oszlopok has no column for ${status}`)
    }
    assert.equal(typeof res.body?.sapkak, 'object', 'sapkak')
    assertNoSecret('board', res.text)
    return `statusok=${res.body.statusok.length}`
  })

  await check('rpc templates answers', async () => {
    const res = await rpc(headers, 'templates')
    assert.equal(res.status, 200, `answered ${res.status}: ${JSON.stringify(res.body)}`)
    assert.ok('katalogusHash' in res.body, 'katalogusHash')
    assert.ok(Array.isArray(res.body?.hetiSor), 'hetiSor')
    assertNoSecret('templates', res.text)
    return res.body.hiba ? `no catalogue on this host: ${res.body.hiba}` : `katalogusHash=${String(res.body.katalogusHash).slice(0, 12)}`
  })

  await check('rpc refuses an unknown method with 404', async () => {
    const res = await rpc(headers, 'no-such-method')
    assert.equal(res.status, 404, `answered ${res.status}`)
    assert.equal(res.body?.error?.code, 'not_found')
  })

  if (!dataDir) {
    log('skip migrations, native-module and write-path checks: DATA_DIR not set')
  } else {
    const dbPath = path.join(dataDir, 'swarmclaw.db')

    await check('every migration was applied through the host database', async () => {
      const latest = Math.max(...MIGRATIONS.map((m) => m.version))
      assert.ok(fs.existsSync(dbPath), `${dbPath} does not exist`)
      const storage = fileStorage(dbPath)
      try {
        const row = storage.get('SELECT MAX(version) AS v FROM ext_migrations WHERE extension_id = ?', [EXTENSION_ID])
        assert.equal(row?.v, latest, `ext_migrations holds v${row?.v}, db.mjs declares v${latest}`)
        const tables = extensionTables(storage)
        // The expected set is computed by applying the same migrations to an
        // empty database here, not typed in, so a table added or renamed by a
        // later migration cannot leave this check asserting an old list.
        assert.deepEqual(tables, expectedExtensionTables(), 'tables differ from what MIGRATIONS produce on an empty database')
        return `v${latest}, ${tables.length} tables`
      } finally {
        storage.close()
      }
    })

    await check('installed workspace carries no native module', async () => {
      const workspace = path.join(dataDir, 'extensions', '.workspaces', 'video_mjs')
      assert.ok(fs.existsSync(path.join(dataDir, 'extensions', EXTENSION_ID)), 'the shim is missing')
      assert.ok(fs.existsSync(path.join(workspace, 'index.js')), 'the workspace entry is missing')
      const natives = nativeModulesUnder(workspace)
      assert.deepEqual(natives, [], `native modules found: ${natives.join(', ')}`)
      return workspace
    })

    await check('a video written through the repository reads back over rpc with its source text intact', async () => {
      const storage = fileStorage(dbPath)
      let id
      // Source text is what a stranger wrote -- a newsletter body, a forum
      // post. It is stored raw and must come back raw, so the markup below is
      // deliberate: a module that sanitised on the way in or out would fail
      // here, and the page is what has to render it as text.
      const forras = '<script>alert(1)</script> & "idézet" — deploy smoke'
      try {
        const repo = createRepo(storage)
        const opened = repo.openVideo({
          cim: `Deploy smoke ${crypto.randomBytes(4).toString('hex')}`,
          forrasTipus: 'kezi',
          forrasId: '',
          forrasSzoveg: forras,
          nyitottaAgentId: 'deploy-smoke',
        })
        id = opened.id
      } finally {
        storage.close()
      }

      const read = await rpc(headers, 'video', { id })
      assert.equal(read.status, 200, `video answered ${read.status}: ${JSON.stringify(read.body)}`)
      assert.equal(read.body?.id, id)
      assert.equal(read.body?.status, 'nyitott')
      assert.equal(read.body?.forrasTipus, 'kezi')
      assert.equal(read.body?.forrasSzoveg, forras, 'the source text came back changed')
      assert.deepEqual(read.body?.tervek, [], 'a freshly opened video has no plan')
      assert.deepEqual(read.body?.renderek, [], 'a freshly opened video has no render')

      const board = await rpc(headers, 'board')
      assert.ok(board.body?.oszlopok?.nyitott?.some((c) => c?.id === id), 'the new video is not in the nyitott column')
      return `id=${id}, source text round-tripped byte for byte`
    })
  }

  log(`${passed} checks passed against ${baseUrl} in ${((Date.now() - started) / 1000).toFixed(1)}s`)
  return { meta, page, health }
}

main().catch((err) => {
  console.error(`[video deploy] ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
