import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'

import docs, { rootSetting, sharedFolder, state, vaultOf, versionsKept, watchEnabled, watcherControl } from '../index.mjs'

/**
 * setup() now starts a real watcher, and an open fs.watch handle keeps the
 * Node process alive after the last test has passed. Every suite that calls
 * setup() has to hand it back.
 */
after(() => { watcherControl.stop() })

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

test('the module declares the one contract it reaches for, with a reason the operator reads', () => {
  // A deklaráció maga a hozzáférés: nincs jóváhagyás, nincs visszavonás. Ha
  // ez a bejegyzés elveszik, a doksi_video_forgatokonyv not_declared-ot kap,
  // és a hetedik tool minden hívónál elutasít.
  assert.deepEqual(docs.consumes, [
    {
      extension: 'video',
      contract: 'videos',
      version: 1,
      reason: docs.consumes[0].reason,
    },
  ])
  assert.ok(docs.consumes[0].reason.length > 30, 'az indoklás túl rövid ahhoz, hogy az operátornak mondjon valamit')
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
  //
  // A vault a gyökeret realpath-tal oldja fel -- macOS-en a /tmp maga is
  // symlink --, ezért a kanonikus alakhoz hasonlítunk, nem a beírthoz.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-ket-'))
  const a = path.join(base, 'a')
  const b = path.join(base, 'b')
  try {
    docs.setup(fakeCtx({ gyoker: a }))
    assert.equal(vaultOf().root, fs.realpathSync(a))

    docs.setup(fakeCtx({ gyoker: b }))
    assert.equal(vaultOf().root, fs.realpathSync(b))
    assert.equal(state._root, b)
  } finally {
    watcherControl.stop()
    fs.rmSync(base, { recursive: true, force: true })
  }
})

test('setup() creates the root so the first watch does not fail on ENOENT', () => {
  // Élesben ez bukott: a setup() a figyelőt még nem létező mappára indította,
  // az fs.watch ENOENT-tel elszállt, és a figyelés a telepítés után addig
  // állt, amíg az operátor kézzel újra nem indította.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-setup-')) + '/friss'
  try {
    docs.setup(fakeCtx({ gyoker: root }))
    assert.equal(fs.existsSync(root), true, 'a setup() nem hozta létre a gyökeret')
    assert.equal(watcherControl.status().fut, true, 'a figyelő nem indult el')
    assert.equal(watcherControl.status().hiba, null)
  } finally {
    watcherControl.stop()
    fs.rmSync(path.dirname(root), { recursive: true, force: true })
  }
})

test('setup() starts at most one watcher however often it runs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-egy-'))
  try {
    docs.setup(fakeCtx({ gyoker: root }))
    const first = watcherControl.status()
    docs.setup(fakeCtx({ gyoker: root }))
    docs.setup(fakeCtx({ gyoker: root }))
    assert.deepEqual(watcherControl.status(), first)
  } finally {
    watcherControl.stop()
    fs.rmSync(root, { recursive: true, force: true })
  }
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
