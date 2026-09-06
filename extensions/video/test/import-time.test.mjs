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
 * passes here passes there; what passes under a loader nobody ships proves
 * nothing about either.
 *
 * WHY THE TIME MATTERS. The host gives an import 30 seconds and then gives up.
 * An entry that does work at import -- a catalogue read from a directory that
 * is not there, a network call, a top-level `await` on a promise nothing
 * settles -- does not merely load slowly: a promise that never settles holds
 * the module's evaluation open until the deadline, and on the loading path this
 * blocks the host's boot for that whole time. So the two tests here are one
 * subject from two sides: the entry must import quickly, and the source must
 * contain nothing that could make it not.
 *
 * WHY THE WHOLE SHAPE. An extension that imports is not yet an extension that
 * works. The host reads the declarations off the module object -- tools, rpc,
 * contracts, hooks, managed resources, migrations -- and a missing one is
 * silent: the card shows fewer tools, the page shows nothing, no schedule is
 * ever created. Pinning the counts and the names here is what turns a dropped
 * export into a failing test instead of an operator's afternoon.
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
      provides: Object.keys(ext.provides),
      consumes: ext.consumes.map((c) => c.extension + '.' + c.contract),
      hook: typeof ext.hooks?.afterChatTurn,
      agents: ext.managedResources.agents.length,
      schedules: ext.managedResources.schedules.length,
      checks: ext.managedResources.setupChecks.length,
      migrations: ext.migrations.length,
      setup: typeof ext.setup,
      pages: ext.ui.pages.map((p) => p.path),
    }))
  `
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const out = JSON.parse(r.stdout.trim().split('\n').at(-1))
  assert.ok(out.ms < MAX_IMPORT_MS, `import took ${out.ms} ms`)
  assert.equal(out.name, 'Videó')
  assert.equal(out.version, '0.1.0')
  assert.deepEqual(out.tools.slice().sort(), [
    'videoCatalog', 'videoDraft', 'videoLessons', 'videoNarrate', 'videoOpen', 'videoPlan', 'videoPropose',
    'videoQueue', 'videoRender', 'videoRenderStatus', 'videoReviewClose', 'videoReviewMaterial', 'videoVerdict',
  ])
  // The page's methods, plus the two the MCP shim reaches. `mcpCall` and
  // `mcpTools` are not page methods: an agent on a CLI provider never receives
  // the extension tool layer, and MCP is the only layer that crosses into a
  // CLI's own tool loop, so these are how the thirteen tools above reach the
  // producer and the reviewer at all. Listed here so a third one is a decision.
  assert.deepEqual(out.rpc.slice().sort(), [
    'board', 'cancelRender', 'cleanup', 'decideProposal', 'feedback', 'health', 'importFeedback',
    'importRetention', 'lezar', 'mcpCall', 'mcpTools', 'narral', 'nyit', 'proposals', 'renderel',
    'retireLesson', 'templatePreview', 'templatePreviewCancel', 'templatePreviewStart',
    'templatePreviewStatus', 'templates', 'video', 'youtubeOtletek',
  ])
  assert.deepEqual(out.provides, ['videos'])
  assert.deepEqual(out.consumes, ['aisignal.signals', 'tts.narration'])
  assert.deepEqual(out.pages, ['/x/video'])
  assert.equal(out.hook, 'function')
  assert.equal(out.agents, 2)
  assert.equal(out.schedules, 3)
  assert.equal(out.checks, 9)
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
  // The host calls setup() again on every reload, which is every write under
  // data/extensions. A setup that returned a promise, or that armed a timer or
  // a listener, would leak one per load; the host awaits nothing here and would
  // never see the promise settle either.
  const { default: video, state } = await import(pathToFileURL(entry).href)
  const settings = () => ({})
  const log = { info() {}, warn() {}, error() {} }
  const storage = { exec() {}, all: () => [], get: () => undefined, transaction: (fn) => fn() }
  const ctx = {
    extensionId: 'video.mjs',
    tablePrefix: 'ext_video_',
    storage,
    settings,
    log,
    oauth: { getGoogleAccessToken: async () => '', hasGoogleCredential: () => false },
    resolveBinary: (name) => `/opt/homebrew/bin/${name}`,
    contracts: { get: () => null, why: () => 'not_installed' },
  }
  const before = process.getActiveResourcesInfo().length
  assert.equal(video.setup(ctx), undefined, 'setup() returned something; it must be synchronous and return nothing')
  video.setup(ctx)
  assert.equal(process.getActiveResourcesInfo().length, before, 'setup() left an active handle behind')
  assert.equal(state.storage, storage)
  assert.equal(state.settings, settings)
  assert.equal(state.log, log)
  assert.equal(state.resolveBinary, ctx.resolveBinary, 'the host binary resolver did not reach state')
  assert.equal(typeof state.repo, 'object')
})

test('setup() on a host with no resolveBinary leaves the seam null rather than storing a non-function', () => {
  // An extension file can be installed on a host older than the one it ships
  // with. Storing whatever arrived would put a non-callable on the seam and
  // turn every spawn into a TypeError; null is the value src/binaries.mjs
  // reads as "fall back to the bare name".
  return import(pathToFileURL(entry).href).then(({ default: video, state }) => {
    video.setup({
      extensionId: 'video.mjs',
      tablePrefix: 'ext_video_',
      storage: { exec() {}, all: () => [], get: () => undefined, transaction: (fn) => fn() },
      settings: () => ({}),
      log: { info() {}, warn() {}, error() {} },
      oauth: { getGoogleAccessToken: async () => '', hasGoogleCredential: () => false },
      contracts: { get: () => null, why: () => 'not_installed' },
    })
    assert.equal(state.resolveBinary, null)
  })
})
