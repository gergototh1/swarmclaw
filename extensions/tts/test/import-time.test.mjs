import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * What the entry module costs to import, and what it declares once imported,
 * measured on the runtime the product ships rather than on the test runner's.
 *
 * WHY plain `node` AND NOT `tsx`. The rest of this suite runs under `tsx`,
 * which brings its own loader. The host imports an extension with Node's own
 * ESM loader, in the desktop app's embedded Node and in the container's. What
 * passes here passes there.
 *
 * WHY THE TIME MATTERS. The host gives an import 30 seconds and then gives up.
 * A top-level `await` on a promise that never settles holds the module's
 * evaluation open for that whole time and blocks the host's boot with it, so
 * the source check below is not a style rule.
 *
 * WHAT THIS EXTENSION IS. Zero tools by design: agents reach it through the
 * MCP shim and other extensions through the `narration` contract, so a tool
 * appearing here would be a third, unreviewed route to a paid provider call.
 * The count is pinned at zero for that reason and not for tidiness.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const entry = path.join(root, 'index.mjs')

/** Well under the host's 30 s import deadline; a module that needs more than this at import is doing work that belongs in a call. */
const MAX_IMPORT_MS = 5000

test('index.mjs imports under plain node well inside the host deadline and declares the whole shape', () => {
  const script = `
    const t = performance.now()
    const mod = await import(${JSON.stringify(pathToFileURL(entry).href)})
    const ext = mod.default
    console.log(JSON.stringify({
      ms: performance.now() - t,
      name: ext.name,
      version: ext.version,
      tools: ext.tools.map((x) => x.name),
      rpc: Object.keys(ext.rpc),
      provides: Object.keys(ext.provides),
      consumes: (ext.consumes || []).map((c) => c.extension + '.' + c.contract),
      hooks: typeof ext.hooks,
      managedResources: typeof ext.managedResources,
      migrations: ext.migrations.length,
      setup: typeof ext.setup,
      pages: (ext.ui.pages ?? []).map((p) => p.path),
    }))
  `
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const out = JSON.parse(r.stdout.trim().split('\n').at(-1))
  assert.ok(out.ms < MAX_IMPORT_MS, `import took ${out.ms} ms`)
  assert.equal(out.name, 'Narráció (TTS)')
  assert.equal(out.version, '0.1.0')
  assert.deepEqual(out.tools, [], 'this extension declares no tools; the MCP shim and the contract are its two routes')
  assert.deepEqual(out.rpc.slice().sort(), ['health', 'importCache', 'kerelmek', 'mcpConfig', 'status', 'synthesize'])
  assert.deepEqual(out.provides, ['narration'])
  assert.deepEqual(out.consumes, [])
  // A modul nem hoz lapot: az ügynökök az mcp/ shimen, a kód a
  // szerződésen át éri el. A rail-bejegyzés szándékosan nincs.
  assert.deepEqual(out.pages, [])
  assert.equal(out.hooks, 'undefined', 'this extension registers no hooks')
  assert.equal(out.managedResources, 'undefined', 'this extension declares no managed agents or schedules')
  assert.equal(out.migrations, 2)
  assert.equal(out.setup, 'function')
})

test('the entry does no work at import: no top-level await, no file read, no timer, no fetch', () => {
  const text = fs.readFileSync(entry, 'utf8')
  assert.equal(/^\s*await\s/m.test(text), false, 'top-level await in index.mjs')
  for (const banned of ['readFileSync', 'readdirSync', 'setInterval(', 'setTimeout(', 'fetch(']) {
    assert.equal(text.includes(banned), false, `${banned} in index.mjs`)
  }
})

test('setup() is synchronous and idempotent: it fills state and starts nothing', async () => {
  const { default: tts, state } = await import(pathToFileURL(entry).href)
  const settings = () => ({})
  const log = { info() {}, warn() {}, error() {} }
  const storage = { exec() {}, all: () => [], get: () => undefined, transaction: (fn) => fn() }
  const ctx = {
    extensionId: 'tts.mjs',
    tablePrefix: 'ext_tts_',
    storage,
    settings,
    log,
    oauth: { getGoogleAccessToken: async () => '', hasGoogleCredential: () => false },
    resolveBinary: (name) => `/opt/homebrew/bin/${name}`,
    contracts: { get: () => null, why: () => 'not_installed' },
  }
  const before = process.getActiveResourcesInfo().length
  assert.equal(tts.setup(ctx), undefined, 'setup() returned something; it must be synchronous and return nothing')
  tts.setup(ctx)
  assert.equal(process.getActiveResourcesInfo().length, before, 'setup() left an active handle behind')
  assert.equal(state.storage, storage)
  assert.equal(state.resolveBinary, ctx.resolveBinary, 'the host binary resolver did not reach state')
  assert.equal(typeof state.repo, 'object')
})

test('setup() on a host with no resolveBinary leaves the seam null rather than storing a non-function', async () => {
  const { default: tts, state } = await import(pathToFileURL(entry).href)
  tts.setup({
    extensionId: 'tts.mjs',
    tablePrefix: 'ext_tts_',
    storage: { exec() {}, all: () => [], get: () => undefined, transaction: (fn) => fn() },
    settings: () => ({}),
    log: { info() {}, warn() {}, error() {} },
    oauth: { getGoogleAccessToken: async () => '', hasGoogleCredential: () => false },
    contracts: { get: () => null, why: () => 'not_installed' },
  })
  assert.equal(state.resolveBinary, null)
})
