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
 * WHY PLAIN `node` AND NOT `tsx`. The rest of this suite runs under `tsx`,
 * which brings its own loader. The host imports an extension with Node's own
 * ESM loader, in the desktop app's embedded Node and in the container's. What
 * passes here passes there; what passes under a loader nobody ships proves
 * nothing about either.
 *
 * WHY THE TIME MATTERS. The host gives an import 30 seconds and then gives up.
 * An entry that does work at import -- a file read, a network call, a top-level
 * `await` on a promise nothing settles -- does not merely load slowly: a
 * promise that never settles holds the module's evaluation open until the
 * deadline, and on the loading path this blocks the host's boot for that whole
 * time. So the two cases here are one subject from two sides: the entry must
 * import quickly, and the source must contain nothing that could make it not.
 *
 * WHY THE WHOLE SHAPE. An extension that imports is not yet an extension that
 * works. The host reads the declarations off the module object -- tools, rpc,
 * contracts, hooks, managed resources, migrations -- and a missing one is
 * silent: the card shows fewer tools, the page shows nothing, no schedule is
 * ever created. Two of this module's declarations are absences rather than
 * lists, and an absence is the easiest thing to lose without noticing: there is
 * no `hooks` and there is no `consumes`, and both are load-bearing. No hook
 * means the host's failure counter can only be moved by a method call, and
 * nothing this module declares runs on somebody else's turn. No `consumes`
 * means this module is nobody's dependant: it is the provider, and a `consumes`
 * appearing here would make the mailbox refuse to load whenever whatever it
 * named was missing.
 *
 * WHAT THIS FILE DOES NOT CHECK. That the host actually loads it. A module can
 * import in 40 ms here and still be rejected at `load.contracts` on a real host
 * -- a contract `summary` one character over the cap did exactly that on this
 * branch, silently, three times in a row until the extension auto-disabled.
 * Only a running host answers that, and `test/deploy.smoke.mjs` is where it is
 * asked.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const entry = path.join(root, 'index.mjs')

/** Well under the host's 30 s import deadline; a module that needs more than this at import is doing work that belongs in a method. */
const MAX_IMPORT_MS = 5000

/** The rpc surface of Task 8, written out: this list is what the page and the MCP shim may call. */
const RPC_METODUSOK = [
  'addRecipient', 'attempts', 'board', 'discardDraft', 'draft', 'health', 'label', 'labels',
  'liveDraft', 'mcpConfig', 'outbox', 'read', 'releaseDraft', 'retireRecipient', 'search',
]

test('index.mjs imports under plain node well inside the host deadline and declares the whole shape', () => {
  const script = `
    const t = performance.now()
    const mod = await import(${JSON.stringify(pathToFileURL(entry).href)})
    const ext = mod.default
    console.log(JSON.stringify({
      ms: performance.now() - t,
      name: ext.name,
      version: ext.version,
      tools: ext.tools.length,
      rpc: Object.keys(ext.rpc),
      provides: Object.keys(ext.provides),
      // Present as a key at all, not merely falsy: an empty array declared is a
      // different statement from nothing declared, and only the second is what
      // this module means.
      hasConsumes: Object.prototype.hasOwnProperty.call(ext, 'consumes'),
      hasHooks: Object.prototype.hasOwnProperty.call(ext, 'hooks'),
      managed: ext.managedResources === undefined
        ? 'absent'
        : [ext.managedResources.agents, ext.managedResources.schedules, ext.managedResources.setupChecks]
            .map((list) => (list || []).length).join(','),
      migrations: ext.migrations.length,
      setup: typeof ext.setup,
      pages: ext.ui.pages.map((p) => p.path),
    }))
  `
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const out = JSON.parse(r.stdout.trim().split('\n').at(-1))
  assert.ok(out.ms < MAX_IMPORT_MS, `import took ${out.ms} ms`)
  assert.equal(out.name, 'Gmail')
  assert.equal(out.version, '0.1.0')
  // Zero tools is the design (spec 2.4), not an oversight: an agent reaches
  // this mailbox through the MCP shim, and a tool set beside it would be a
  // second surface over one implementation with a refusal translation of its
  // own to keep in step.
  assert.equal(out.tools, 0, 'this extension declares no tools by design')
  assert.deepEqual(out.rpc.slice().sort(), RPC_METODUSOK)
  assert.deepEqual(out.provides, ['mailbox'])
  assert.equal(out.hasConsumes, false, 'this module provides the mailbox and consumes nothing')
  assert.equal(out.hasHooks, false, 'a hook would let a turn this module did not start move the host failure counter')
  // No managed agent and no managed schedule (spec 11.10), which is why no
  // install of this module ever needs a Reconcile. Absent or empty are both
  // that statement; a non-empty one is a different module.
  assert.ok(out.managed === 'absent' || out.managed === '0,0,0', `managedResources: ${out.managed}`)
  assert.equal(out.migrations, 1)
  assert.equal(out.setup, 'function')
  assert.deepEqual(out.pages, ['/x/gmail'])
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
  const { default: gmail, state } = await import(pathToFileURL(entry).href)
  const settings = () => ({})
  const log = { info() {}, warn() {}, error() {} }
  const storage = { exec() {}, all: () => [], get: () => undefined, transaction: (fn) => fn() }
  const oauth = { getGoogleAccessToken: async () => '', hasGoogleCredential: () => false, googleClientConfigured: () => false }
  const ctx = { extensionId: 'gmail.mjs', tablePrefix: 'ext_gmail_', storage, settings, log, oauth }
  const before = process.getActiveResourcesInfo().length
  assert.equal(gmail.setup(ctx), undefined, 'setup() returned something; it must be synchronous and return nothing')
  gmail.setup(ctx)
  assert.equal(process.getActiveResourcesInfo().length, before, 'setup() left an active handle behind')
  assert.equal(state.storage, storage)
  assert.equal(state.settings, settings)
  assert.equal(state.log, log)
  assert.equal(state.oauth, oauth)
  assert.equal(typeof state.repo, 'object')
  // The two seams a test injects are the host's to leave alone. A setup that
  // wrote them would make a doubled client survive into the next load.
  assert.equal(state.clientFactory, null)
  assert.equal(state.fetchImpl, null)
})
