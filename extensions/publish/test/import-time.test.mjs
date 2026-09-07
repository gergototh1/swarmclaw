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
 * this copy keeps the same two tests and the same setup() checks.
 *
 * Task 4 widens the pin: five tools (src/szoveg.mjs) and three managed
 * agents (src/agents.mjs), on top of what Task 1 and Task 3 already
 * declared. Adding a tool or an agent is a real decision -- this test exists
 * so that decision shows up here as a diff, not a silent shape change; the
 * brief's own words for this ("update the pin, do not weaken it").
 *
 * Task 5 widens it again: `setup()` now also stores `ctx.oauth` (the seam
 * `src/platform/youtube.mjs`'s `createYoutubeAdapter` reads at call time),
 * and the module registers a real `youtube` sender in `state.adapterek` at
 * import time rather than leaving that registry empty for a later task. Its
 * fix round widens it once more, with two settings fields that are not
 * conveniences: `lathatosag` (default `private`) and `gyerekeknek` (NO
 * default) are the two statements about a video this module refuses to make
 * on the operator's behalf, and the `ui` pin below is where a later task
 * quietly restoring a default shows up as a diff.
 *
 * Task 6 widens both halves of `out.rpc` and `out.ui` at once: six new page
 * methods (`src/rpc.mjs`: `naptar`, `kiadas`, `fiokok`, `jovahagy`,
 * `atutemez`, `fiokotOsszekot`) alongside the MCP bridge's two, and the
 * calendar's `ui.pages` entry -- the first this module has ever declared.
 * `pages` is pinned WHOLE, the same discipline `settingsFields` already had:
 * a wrong `entry`/`css` path here is a page that 404s on both assets in a
 * way this test is the only thing that would ever notice.
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
        timezone: s.timezone,
        agentRefKey: s.agentRef?.resourceKey,
      })),
      managedAgents: (ext.managedResources?.agents ?? null)?.map((a) => ({
        agentKey: a.agentKey,
        displayName: a.displayName,
        skills: a.skills,
        tools: a.tools,
        heartbeatEnabled: a.heartbeatEnabled,
      })) ?? null,
    }))
  `
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const out = JSON.parse(r.stdout.trim().split('\n').at(-1))
  assert.ok(out.ms < MAX_IMPORT_MS, `import took ${out.ms} ms`)
  assert.equal(out.name, 'Publikálás')
  assert.equal(out.version, '0.1.0')
  // Task 4's five tools (src/szoveg.mjs), in the order `createSzovegTools`
  // declares them.
  assert.deepEqual(out.tools, ['publishOpen', 'publishQueue', 'publishDraft', 'publishVerdict', 'publishDue'])
  // Task 6: `src/rpc.mjs`'s six page methods (`naptar`, `kiadas`, `fiokok`,
  // `jovahagy`, `atutemez`, `fiokotOsszekot`), plus the MCP shim's two
  // methods that every extension fronting its tools over MCP carries
  // (extensions/*/src/mcp-bridge.mjs).
  assert.deepEqual(out.rpc.slice().sort(), ['atutemez', 'fiokok', 'fiokotOsszekot', 'jovahagy', 'kiadas', 'mcpCall', 'mcpTools', 'naptar'])
  // Nothing provided yet: this task is a consumer of `video.videos`, not yet
  // a provider of anything to a third module.
  assert.equal(out.provides, null)
  assert.deepEqual(out.consumes, ['video.videos'])
  assert.equal(out.migrations, 1)
  assert.equal(out.setup, 'function')
  // No page yet (design spec 10 lists ui/ as a later task's file) -- three
  // settings fields. A slot's `nap`/`ora`/`perc` is a WALL CLOCK in the
  // `idozona` zone (src/utemezes.mjs), so that field is the one place the
  // operator can say which wall. Pinned WHOLE rather than by key count: a
  // lost `defaultValue` would ship an install whose slots mean nothing in
  // particular, and that is exactly the kind of drift this file exists to
  // surface as a diff.
  //
  // The two YouTube fields are pinned for a stronger reason than drift. Both
  // are decisions src/platform/youtube.mjs deliberately refuses to make on
  // the operator's behalf, and the pin is what makes each one visible as a
  // diff if a later task quietly restores a default:
  //   - `lathatosag` MUST default to 'private'. A `defaultValue: 'public'`
  //     here would mean the first execution of never-run code goes live on a
  //     real channel with agent-written copy -- the one irreversible step in
  //     the whole chain.
  //   - `gyerekeknek` MUST have NO `defaultValue` at all, and its first
  //     option MUST carry the empty value. It is a COPPA declaration of fact:
  //     a default -- including a settings page that silently preselects the
  //     first option -- would have this module state something nobody
  //     observed. Until it is set, `feltolt` refuses by name.
  assert.deepEqual(out.ui, {
    pages: [{
      id: 'publish',
      label: 'Publikálás',
      icon: 'Calendar',
      path: '/x/publish',
      entry: 'dist/index.js',
      css: 'dist/style.css',
      position: 'end',
    }],
    settingsFields: [
      {
        key: 'idozona',
        label: 'Publikálási időzóna',
        type: 'text',
        defaultValue: 'Europe/Budapest',
        placeholder: 'Europe/Budapest',
        help: 'IANA-zónanév. A publikálási sávok "hétfő 9:00"-ja ennek a zónának a fali óráján értendő, nyári időszámítással együtt -- nem UTC-ben.',
      },
      {
        key: 'lathatosag',
        label: 'YouTube láthatóság',
        type: 'select',
        defaultValue: 'private',
        options: [
          { value: 'private', label: 'Privát -- csak te látod (alapértelmezett)' },
          { value: 'unlisted', label: 'Nem listázott -- linkkel megnyitható' },
          { value: 'public', label: 'Nyilvános -- azonnal kimegy a csatornára' },
        ],
        help: 'Az újonnan feltöltött videók láthatósága a YouTube-on. Alapból privát, hogy a feltöltést a YouTube Studióban meg tudd nézni, mielőtt bárki látná; a nyilvánosra kapcsolás visszafordíthatatlan lépés, ezért ez a te döntésed, nem a modulé.',
      },
      {
        key: 'gyerekeknek',
        label: 'Gyerekeknek készült tartalom (COPPA)',
        type: 'select',
        options: [
          { value: '', label: 'Nincs beállítva -- a feltöltés eddig elutasít' },
          { value: 'nem', label: 'Nem gyerekeknek készült' },
          { value: 'igen', label: 'Gyerekeknek készült' },
        ],
        help: 'A YouTube minden feltöltésnél megköveteli ezt a nyilatkozatot (COPPA). A modul nem tudja eldönteni helyetted, és nem is állít olyat, amit nem figyelt meg: amíg nem választasz, a feltöltés elutasít, és erre a mezőre mutat.',
      },
    ],
  })
  // Said again as its own assertion, because a `deepEqual` over three fields
  // reads as one shape check and this is the single most consequential fact
  // in it: no default means no declaration, and no declaration means no
  // upload.
  const gyerekeknek = out.ui.settingsFields.find((f) => f.key === 'gyerekeknek')
  assert.equal(Object.prototype.hasOwnProperty.call(gyerekeknek, 'defaultValue'), false)
  assert.equal(gyerekeknek.options[0].value, '')
  assert.equal(out.ui.settingsFields.find((f) => f.key === 'lathatosag').defaultValue, 'private')
  // Task 3: exactly one fixed-cadence run (design spec 7), pointed at
  // `publish-kuldo` -- Task 4's own agent key below, the KÖTÖTT NÉV
  // `test/agents.test.mjs` also pins directly against `src/agents.mjs`.
  // `timezone` is pinned too: it does nothing for an `interval` schedule
  // today, and it is the ONLY place the operator's publishing zone is written
  // where the host can see it (the sibling module states it on all three of
  // its own declarations). Dropping it would be silent.
  assert.deepEqual(out.schedules, [
    { scheduleKey: 'publish-kikuldes', scheduleType: 'interval', intervalMs: 15 * 60 * 1000, timezone: 'Europe/Budapest', agentRefKey: 'publish-kuldo' },
  ])
  // Task 4's three managed agents (src/agents.mjs): the writer, the
  // reviewer, and the sender the schedule above now resolves to. `systemPrompt`
  // is deliberately left out of this projection -- its content is
  // `test/agents.test.mjs`'s job, not this file's -- but every other field
  // the host reads to build a real agent is pinned here.
  assert.deepEqual(out.managedAgents, [
    { agentKey: 'publish-iro', displayName: 'Publikálás Író', skills: ['publikalas-szoveg'], tools: ['publishQueue', 'publishOpen', 'publishDraft', 'memory'], heartbeatEnabled: false },
    { agentKey: 'publish-lektor', displayName: 'Publikálás Lektor', skills: ['publikalas-lektoralas'], tools: ['publishQueue', 'publishVerdict', 'memory'], heartbeatEnabled: false },
    { agentKey: 'publish-kuldo', displayName: 'Publikálás Kiküldő', skills: [], tools: ['publishDue'], heartbeatEnabled: false },
  ])
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
  assert.equal(state.oauth, ctx.oauth, 'Task 5: setup() stores the host oauth seam, the same way extensions/gmail/index.mjs does')
  assert.equal(typeof state.repo, 'object')
})

test('Task 5: a real youtube sender is registered at import time, not left for a later task', async () => {
  const { state } = await import(pathToFileURL(entry).href)
  assert.deepEqual(Object.keys(state.adapterek), ['youtube'])
  assert.equal(typeof state.adapterek.youtube, 'function')
})
