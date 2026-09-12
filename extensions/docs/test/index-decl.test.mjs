import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'

import docs, { rootSetting, runFolderMigration, sharedFolder, state, vaultOf, versionsKept, watchEnabled, watcherControl } from '../index.mjs'

/**
 * setup() now starts a real watcher, and an open fs.watch handle keeps the
 * Node process alive after the last test has passed. Every suite that calls
 * setup() has to hand it back.
 */
after(() => { watcherControl.stop() })

/** The smallest ctx the host could hand over. */
/**
 * The settings readers with nothing else that setup() does.
 *
 * Deliberately NOT setup(): setup() runs the folder migration against the
 * configured root, so a settings test that leaves the root unset would run it
 * against the operator's real ~/SwarmClaw/docs -- which is exactly what
 * happened once. A default belongs to the reader, not to a full load.
 */
function withSettings(settings = {}) {
  state.settings = () => settings
}

function fakeCtx(settings = {}) {
  // Regression guard for a real incident: a rootless setup call once ran the
  // folder migration against the operator's REAL ~/SwarmClaw/docs and moved
  // live documents. Every caller of this helper feeds a docs.setup() call, so
  // a missing or empty root has to fail loudly here, not just in the
  // source-scanning guard in english-only.test.mjs.
  if (typeof settings.root !== 'string' || settings.root.trim() === '') {
    throw new Error('fakeCtx() requires an explicit settings.root that is not blank')
  }
  return {
    extensionId: 'docs.mjs',
    tablePrefix: 'ext_docs_',
    storage: { exec() {}, all: () => [], get: () => undefined, transaction: (fn) => fn() },
    settings: () => settings,
    log: { info() {}, warn() {}, error() {} },
  }
}

test('the declaration names the module the way the host expects', () => {
  assert.equal(docs.name, 'Docs')
  assert.equal(typeof docs.setup, 'function')
  assert.ok(Array.isArray(docs.migrations) && docs.migrations.length >= 1)
  assert.ok(docs.description.length > 0)
})

test('every migration table carries the ext_docs_ prefix, lower case', () => {
  for (const m of docs.migrations) {
    for (const t of m.sql.matchAll(/CREATE (?:VIRTUAL )?TABLE IF NOT EXISTS (\w+)/g)) {
      assert.ok(t[1].startsWith('ext_docs_'), `wrong prefix: ${t[1]}`)
      assert.equal(t[1], t[1].toLowerCase())
    }
  }
})

test('the module declares the one contract it reaches for, with a reason the operator reads', () => {
  // The declaration IS the access: there is no approve and no revoke. If this
  // entry is lost, docs_video_script gets not_declared, and the seventh tool
  // refuses every caller.
  // The `reason` field used to be compared against itself: that line was true
  // for any text, including an empty one. Here the REST compares exactly, and
  // the wording is measured separately, because the operator reads it on the
  // Extensions page when deciding whether this access is appropriate.
  assert.equal(docs.consumes.length, 1, 'this module reaches for exactly one contract')
  const [{ reason, ...declaration }] = docs.consumes
  assert.deepEqual(declaration, { extension: 'video', contract: 'videos', version: 1 })
  assert.equal(typeof reason, 'string')
  assert.ok(reason.length > 30, 'the reason is too short to tell the operator anything')
  // Names the tool that needs the access and what it brings in: a sentence
  // like "needed for the Video module" is just as long, and says nothing.
  assert.match(reason, /docs_video_script/)
  assert.match(reason, /video/i)
})

test('the page declaration satisfies the host validator rules', () => {
  const [page] = docs.ui.pages
  assert.equal(page.id, 'docs')
  assert.equal(page.label, 'Docs')
  assert.match(page.path, /^\/x\/[a-z0-9][a-z0-9-]*$/)
  assert.match(page.entry, /^dist\/[A-Za-z0-9_./-]+\.js$/)
  assert.match(page.css, /^dist\/[A-Za-z0-9_./-]+\.css$/)
  assert.equal(page.icon, 'FileText')
  assert.equal(page.position, 'after:tasks')
})

test('every settings field has a key, a label and a known type', () => {
  const keys = docs.ui.settingsFields.map((f) => f.key)
  assert.deepEqual(keys, ['root', 'watchEnabled', 'versionsKept', 'sharedFolderName'])
  for (const f of docs.ui.settingsFields) {
    assert.ok(f.label, `no label: ${f.key}`)
    assert.ok(['text', 'number', 'boolean', 'select', 'secret'].includes(f.type))
  }
})

/**
 * Regression guard for the same real incident `fakeCtx()` above guards
 * against, but at the layer that cannot be walked around: the
 * english-only.test.mjs source scan for a setup call feeding a fake ctx (and
 * `fakeCtx()`'s own runtime check) only catches callers that go through that
 * one helper. `runFolderMigration()` itself has to refuse a rootless call
 * however it was reached, or a different helper -- or an inline ctx object --
 * would run the migration against the operator's real ~/SwarmClaw/docs
 * again.
 *
 * `HOME` is pointed at a throwaway temp directory for the duration of the
 * test precisely so this test can never touch the real one, even if the
 * guard under test were broken: os.homedir() (and so the '~/SwarmClaw/docs'
 * default) resolves from `process.env.HOME` on every call, not once at
 * process start.
 */
test('runFolderMigration refuses a rootless call under the test runner instead of touching the real default root', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-fakehome-'))
  const originalHome = process.env.HOME
  const originalSettings = state.settings
  const originalLog = state.log
  process.env.HOME = fakeHome
  try {
    withSettings({}) // no root configured -> rootSetting() falls back to the default
    state._vault = null
    state._writer = null
    state._service = null
    state._root = null
    const warnings = []
    state.log = { info() {}, warn: (msg, meta) => warnings.push([msg, meta]), error() {} }

    const before = state.migration
    const result = runFolderMigration()

    const defaultRoot = path.join(fakeHome, 'SwarmClaw', 'docs')
    assert.equal(fs.existsSync(defaultRoot), false, 'the guard must never create the default root under a test run')
    assert.equal(result, before, 'a refused call must not overwrite the previous migration state')
    assert.ok(
      warnings.some(([msg]) => /refused/.test(msg)),
      `expected a refusal warning, got: ${JSON.stringify(warnings)}`,
    )
  } finally {
    process.env.HOME = originalHome
    state.settings = originalSettings
    state.log = originalLog
    state._vault = null
    state._writer = null
    state._service = null
    state._root = null
  }
})

test('the root folder is declared as a managed local folder', () => {
  const [folder] = docs.managedResources.localFolders
  assert.equal(folder.access, 'readWrite')
  assert.ok(folder.displayName)
  assert.equal(docs.managedResources.setupChecks.length, 1)
})

test('setup() can run twice, and the second run follows the new root', () => {
  // setup() reruns on every write under data/extensions, so repeatability is
  // not a matter of convenience. The point is that nothing after the second
  // run still points at the previous root.
  //
  // The vault resolves the root through realpath -- on macOS /tmp is itself a
  // symlink -- so we compare against the canonical form, not the one typed in.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-two-'))
  const a = path.join(base, 'a')
  const b = path.join(base, 'b')
  try {
    docs.setup(fakeCtx({ root: a }))
    assert.equal(vaultOf().root, fs.realpathSync(a))

    docs.setup(fakeCtx({ root: b }))
    assert.equal(vaultOf().root, fs.realpathSync(b))
    assert.equal(state._root, b)
  } finally {
    watcherControl.stop()
    fs.rmSync(base, { recursive: true, force: true })
  }
})

test('setup() creates the root so the first watch does not fail on ENOENT', () => {
  // This broke in production: setup() started the watcher on a root that did
  // not exist yet, fs.watch died with ENOENT, and watching stayed down after
  // install until the operator restarted it by hand.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-setup-')) + '/fresh'
  try {
    docs.setup(fakeCtx({ root }))
    assert.equal(fs.existsSync(root), true, 'setup() did not create the root')
    assert.equal(watcherControl.status().running, true, 'the watcher did not start')
    assert.equal(watcherControl.status().error, null)
  } finally {
    watcherControl.stop()
    fs.rmSync(path.dirname(root), { recursive: true, force: true })
  }
})

test('setup() starts at most one watcher however often it runs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-one-'))
  try {
    docs.setup(fakeCtx({ root }))
    const first = watcherControl.status()
    docs.setup(fakeCtx({ root }))
    docs.setup(fakeCtx({ root }))
    assert.deepEqual(watcherControl.status(), first)
  } finally {
    watcherControl.stop()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('settings readers fall back rather than returning undefined', () => {
  withSettings({})
  assert.equal(rootSetting(), '~/SwarmClaw/docs')
  assert.equal(sharedFolder(), 'shared')
  assert.equal(versionsKept(), 50)
  assert.equal(watchEnabled(), true)
})

test('a cleared text setting falls back instead of becoming an empty path', () => {
  // A field the operator cleared stores '', not undefined, so the host's
  // defaultValue no longer kicks in: the fallback here is the only guard left.
  withSettings({ root: '   ', sharedFolderName: '', versionsKept: 0 })
  assert.equal(rootSetting(), '~/SwarmClaw/docs')
  assert.equal(sharedFolder(), 'shared')
  assert.equal(versionsKept(), 50)
})

test('watching is on unless the operator turned it off', () => {
  withSettings({ watchEnabled: false })
  assert.equal(watchEnabled(), false)
  withSettings({ watchEnabled: true })
  assert.equal(watchEnabled(), true)
})

test('settings are read from the English keys', () => {
  withSettings({ root: '/tmp/docs-a', watchEnabled: false, versionsKept: 7, sharedFolderName: 'team' })
  assert.equal(rootSetting(), '/tmp/docs-a')
  assert.equal(watchEnabled(), false)
  assert.equal(versionsKept(), 7)
  assert.equal(sharedFolder(), 'team')
})

test('a setting stored under the old Hungarian key still counts', () => {
  withSettings({ gyoker: '/tmp/docs-b', figyelesBe: false, verzioMegtartas: 9, kozosMappaNev: 'csapat' })
  assert.equal(rootSetting(), '/tmp/docs-b')
  assert.equal(watchEnabled(), false)
  assert.equal(versionsKept(), 9)
  assert.equal(sharedFolder(), 'csapat')
})

test('the old default shared folder name does not pin the old folder', () => {
  // A stored "kozos" is what the settings form wrote as the default. Honouring
  // it would stop the kozos -> shared migration from ever running.
  withSettings({ kozosMappaNev: 'kozos' })
  assert.equal(sharedFolder(), 'shared')
})

test('with nothing configured the defaults are English', () => {
  withSettings({})
  assert.equal(rootSetting(), '~/SwarmClaw/docs')
  assert.equal(sharedFolder(), 'shared')
  assert.equal(versionsKept(), 50)
  assert.equal(watchEnabled(), true)
})

test('the settings form offers the English keys', () => {
  const keys = docs.ui.settingsFields.map((f) => f.key)
  assert.deepEqual(keys, ['root', 'watchEnabled', 'versionsKept', 'sharedFolderName'])
  assert.equal(docs.ui.settingsFields.find((f) => f.key === 'sharedFolderName').defaultValue, 'shared')
})

test('the doc panel is declared for the tools that write docs, old names included', () => {
  assert.deepEqual(docs.ui.toolPanels, [{
    id: 'doc',
    label: 'Doc',
    icon: 'FileText',
    tools: ['docs_write', 'docs_video_script', 'doksi_ir', 'doksi_video_forgatokonyv'],
    entry: 'dist/index.js',
    css: 'dist/style.css',
  }])
})
