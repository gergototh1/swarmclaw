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
      assert.ok(t[1].startsWith('ext_docs_'), `rossz előtag: ${t[1]}`)
      assert.equal(t[1], t[1].toLowerCase())
    }
  }
})

test('the module declares the one contract it reaches for, with a reason the operator reads', () => {
  // A deklaráció maga a hozzáférés: nincs jóváhagyás, nincs visszavonás. Ha
  // ez a bejegyzés elveszik, a docs_video_script not_declared-ot kap,
  // és a hetedik tool minden hívónál elutasít.
  // A `reason` mezőt korábban önmagával hasonlítottuk össze: az a sor minden
  // szövegre igaz volt, az üresre is. Itt a MARADÉK egyezik pontosan, az
  // indoklást pedig külön mérjük, mert az operátor azt olvassa a Bővítmények
  // lapon, amikor eldönti, helyénvaló-e ez a hozzáférés.
  assert.equal(docs.consumes.length, 1, 'ez a modul pontosan egy szerződésért nyúl ki')
  const [{ reason, ...deklaracio }] = docs.consumes
  assert.deepEqual(deklaracio, { extension: 'video', contract: 'videos', version: 1 })
  assert.equal(typeof reason, 'string')
  assert.ok(reason.length > 30, 'az indoklás túl rövid ahhoz, hogy az operátornak mondjon valamit')
  // Megnevezi a toolt, ami miatt a hozzáférés kell, és azt, hogy mit hoz be:
  // egy „a Videó modulhoz kell” mondat ugyanolyan hosszú, és semmit nem mond.
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
  // Élesben ez bukott: a setup() a figyelőt még nem létező mappára indította,
  // az fs.watch ENOENT-tel elszállt, és a figyelés a telepítés után addig
  // állt, amíg az operátor kézzel újra nem indította.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-setup-')) + '/friss'
  try {
    docs.setup(fakeCtx({ root }))
    assert.equal(fs.existsSync(root), true, 'a setup() nem hozta létre a gyökeret')
    assert.equal(watcherControl.status().running, true, 'a figyelő nem indult el')
    assert.equal(watcherControl.status().error, null)
  } finally {
    watcherControl.stop()
    fs.rmSync(path.dirname(root), { recursive: true, force: true })
  }
})

test('setup() starts at most one watcher however often it runs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-egy-'))
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
  // Az operátor által kiürített mező '' -t tárol, nem undefined-ot, tehát a
  // host defaultValue-ja többé nem sül el: a fallback itt az egyetlen védelem.
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
