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
 * Modelled on `extensions/video/test/import-time.test.mjs`, on the brief's own
 * instruction (1.4's TDD note and the task's file list both point at it). Read
 * that file for the full "why plain node, why the time matters" reasoning;
 * this copy keeps the same two tests and the same setup() checks, and pins
 * only what Task 1 and Task 3 actually declare -- no tools yet, no
 * `provides`, no `ui.pages`, no managed agents, exactly one managed schedule
 * -- rather than a shape later tasks have not built.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const entry = path.join(root, 'index.mjs')

/** Well under the host's 30 s import deadline; a module that needs more than this at import is doing work that belongs in a tool. */
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
      provides: ext.provides ? Object.keys(ext.provides) : null,
      consumes: ext.consumes.map((c) => c.extension + '.' + c.contract),
      migrations: ext.migrations.length,
      setup: typeof ext.setup,
      ui: ext.ui ?? null,
      schedules: (ext.managedResources?.schedules ?? []).map((s) => ({
        scheduleKey: s.scheduleKey,
        scheduleType: s.scheduleType,
        intervalMs: s.intervalMs,
        agentRefKey: s.agentRef?.resourceKey,
      })),
      managedAgents: ext.managedResources?.agents ?? null,
    }))
  `
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const out = JSON.parse(r.stdout.trim().split('\n').at(-1))
  assert.ok(out.ms < MAX_IMPORT_MS, `import took ${out.ms} ms`)
  assert.equal(out.name, 'Publikálás')
  assert.equal(out.version, '0.1.0')
  // No tools yet (brief: "Nothing publishes anything yet"). A later task's
  // list here is a decision, not a drift this test should absorb silently.
  assert.deepEqual(out.tools, [])
  // The MCP shim's two methods, and nothing else: this task adds no rpc.mjs,
  // so the whole page/rpc surface is the bridge extensions/*/src/mcp-bridge.mjs
  // gives every extension that fronts its tools over MCP.
  assert.deepEqual(out.rpc.slice().sort(), ['mcpCall', 'mcpTools'])
  // Nothing provided yet: this task is a consumer of `video.videos`, not yet
  // a provider of anything to a third module.
  assert.equal(out.provides, null)
  assert.deepEqual(out.consumes, ['video.videos'])
  assert.equal(out.migrations, 1)
  assert.equal(out.setup, 'function')
  // No page yet (design spec 10 lists ui/ as a later task's file).
  assert.deepEqual(out.ui, null)
  // Task 3: exactly one fixed-cadence run (design spec 7), pointed at an
  // agent key Task 4 has not declared yet (see index.mjs's own SCHEDULES
  // docblock for why that is a graceful host-side skip, not a bug). Adding
  // or changing a schedule is a real decision -- this pin exists so that
  // decision shows up as a diff here, not a silent shape change.
  assert.deepEqual(out.schedules, [
    { scheduleKey: 'publish-kikuldes', scheduleType: 'interval', intervalMs: 15 * 60 * 1000, agentRefKey: 'publish-kuldo' },
  ])
  // No agents declared by this task (Task 4 owns `src/agents.mjs`).
  assert.equal(out.managedAgents, null)
})

test('the entry does no work at import: no top-level await, no file read, no timer, no fetch', () => {
  const text = fs.readFileSync(entry, 'utf8')
  assert.equal(/^\s*await\s/m.test(text), false, 'top-level await in index.mjs')
  for (const banned of ['readFileSync', 'readdirSync', 'setInterval(', 'setTimeout(', 'fetch(']) {
    assert.equal(text.includes(banned), false, `${banned} in index.mjs`)
  }
})

test('setup() is synchronous and idempotent: it fills state and starts nothing', async () => {
  const { default: publish, state } = await import(pathToFileURL(entry).href)
  const settings = () => ({})
  const log = { info() {}, warn() {}, error() {} }
  const storage = { exec() {}, all: () => [], get: () => undefined, transaction: (fn) => fn() }
  const ctx = {
    extensionId: 'publish.mjs',
    tablePrefix: 'ext_publish_',
    storage,
    settings,
    log,
    oauth: { getGoogleAccessToken: async () => '', hasGoogleCredential: () => false, googleClientConfigured: () => false },
    resolveBinary: (name) => `/opt/homebrew/bin/${name}`,
    contracts: { get: () => null, why: () => 'not_installed' },
  }
  const before = process.getActiveResourcesInfo().length
  assert.equal(publish.setup(ctx), undefined, 'setup() returned something; it must be synchronous and return nothing')
  publish.setup(ctx)
  assert.equal(process.getActiveResourcesInfo().length, before, 'setup() left an active handle behind')
  assert.equal(state.storage, storage)
  assert.equal(state.settings, settings)
  assert.equal(state.log, log)
  assert.equal(state.contracts, ctx.contracts)
  assert.equal(typeof state.repo, 'object')
})
