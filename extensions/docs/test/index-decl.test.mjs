import assert from 'node:assert/strict'
import test from 'node:test'

import docs, { rootSetting, sharedFolder, state, vaultOf, versionsKept, watchEnabled, watcherControl } from '../index.mjs'

/** The smallest ctx the host could hand over. */
function fakeCtx(settings = {}) {
  return {
    extensionId: 'docs.mjs',
    tablePrefix: 'ext_docs_',
    storage: { exec() {}, all: () => [], get: () => undefined, transaction: (fn) => fn() },
    settings: () => settings,
    log: { info() {}, warn() {}, error() {} },
  }
}

test('the declaration names the module the way the host expects', () => {
  assert.equal(docs.name, 'Doksik')
  assert.equal(typeof docs.setup, 'function')
  assert.ok(Array.isArray(docs.migrations) && docs.migrations.length >= 1)
  assert.ok(docs.description.length > 0)
})

test('every migration table carries the ext_docs_ prefix, lower case', () => {
  for (const m of docs.migrations) {
    for (const t of m.sql.matchAll(/CREATE (?:VIRTUAL )?TABLE IF NOT EXISTS (\w+)/g)) {
      assert.ok(t[1].startsWith('ext_docs_'), `rossz előtag: ${t[1]}`)
      assert.equal(t[1], t[1].toLowerCase())
    }
  }
})

test('the page declaration satisfies the host validator rules', () => {
  const [page] = docs.ui.pages
  assert.equal(page.id, 'docs')
  assert.equal(page.label, 'Doksik')
  assert.match(page.path, /^\/x\/[a-z0-9][a-z0-9-]*$/)
  assert.match(page.entry, /^dist\/[A-Za-z0-9_./-]+\.js$/)
  assert.match(page.css, /^dist\/[A-Za-z0-9_./-]+\.css$/)
  assert.equal(page.icon, 'FileText')
  assert.equal(page.position, 'after:tasks')
})

test('every settings field has a key, a label and a known type', () => {
  const keys = docs.ui.settingsFields.map((f) => f.key)
  assert.deepEqual(keys, ['gyoker', 'figyelesBe', 'verzioMegtartas', 'kozosMappaNev'])
  for (const f of docs.ui.settingsFields) {
    assert.ok(f.label, `nincs címke: ${f.key}`)
    assert.ok(['text', 'number', 'boolean', 'select', 'secret'].includes(f.type))
  }
})

test('the root folder is declared as a managed local folder', () => {
  const [folder] = docs.managedResources.localFolders
  assert.equal(folder.access, 'readWrite')
  assert.ok(folder.displayName)
  assert.equal(docs.managedResources.setupChecks.length, 1)
})

test('setup() can run twice, and the second run follows the new root', () => {
  // A setup() minden data/extensions alatti írásra újrafut, tehát az
  // ismételhetőség nem kényelmi kérdés. A lényeg, hogy a második futás után
  // semmi ne az előző gyökérre mutasson.
  docs.setup(fakeCtx({ gyoker: '/tmp/docs-decl-a' }))
  assert.equal(vaultOf().root, '/tmp/docs-decl-a')

  docs.setup(fakeCtx({ gyoker: '/tmp/docs-decl-b' }))
  assert.equal(vaultOf().root, '/tmp/docs-decl-b')
  assert.equal(state._root, '/tmp/docs-decl-b')
})

test('setup() starts at most one watcher however often it runs', () => {
  docs.setup(fakeCtx({ gyoker: '/tmp/docs-decl-a' }))
  const first = watcherControl.status()
  docs.setup(fakeCtx({ gyoker: '/tmp/docs-decl-a' }))
  docs.setup(fakeCtx({ gyoker: '/tmp/docs-decl-a' }))
  assert.deepEqual(watcherControl.status(), first)
})

test('settings readers fall back rather than returning undefined', () => {
  docs.setup(fakeCtx({}))
  assert.equal(rootSetting(), '~/SwarmClaw/docs')
  assert.equal(sharedFolder(), 'kozos')
  assert.equal(versionsKept(), 50)
  assert.equal(watchEnabled(), true)
})

test('a cleared text setting falls back instead of becoming an empty path', () => {
  // Az operátor által kiürített mező '' -t tárol, nem undefined-ot, tehát a
  // host defaultValue-ja többé nem sül el: a fallback itt az egyetlen védelem.
  docs.setup(fakeCtx({ gyoker: '   ', kozosMappaNev: '', verzioMegtartas: 0 }))
  assert.equal(rootSetting(), '~/SwarmClaw/docs')
  assert.equal(sharedFolder(), 'kozos')
  assert.equal(versionsKept(), 50)
})

test('watching is on unless the operator turned it off', () => {
  docs.setup(fakeCtx({ figyelesBe: false }))
  assert.equal(watchEnabled(), false)
  docs.setup(fakeCtx({ figyelesBe: true }))
  assert.equal(watchEnabled(), true)
})
