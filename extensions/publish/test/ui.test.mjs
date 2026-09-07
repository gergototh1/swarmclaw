import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'

import { renderToStaticMarkup } from 'react-dom/server'
import { jsx } from 'react/jsx-runtime'

import { bundle } from '../scripts/build.mjs'
import { errText, isRecord, readFiokok, readKiadas, readNaptar, refusalText } from '../ui/api.ts'
import { FiokokBody } from '../ui/fiokok.tsx'
import { KiadasBody } from '../ui/kiadas.tsx'
import { Bejegyzes, KIADAS_CIMKE, idopontSzoveg, napIndexZonaban } from '../ui/naptar.tsx'
import { safeHref } from '../ui/safe-href.ts'

/**
 * The page, driven without a browser -- the hook-driving harness copied from
 * `extensions/video/test/ui.test.mjs` (`mount`, `stubRpc`, `settle`), per the
 * brief's own instruction not to build a third one.
 */

const render = (type, props) => renderToStaticMarkup(jsx(type, props))

const REACT_DISPATCHER = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE

const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, n) => Object.is(x, b[n]))

function mount(Component, props) {
  const cells = []
  const pending = []
  let tree = null
  let cell = 0
  let depth = 0
  const slot = (init) => {
    const idx = cell++
    if (!(idx in cells)) cells[idx] = init()
    return cells[idx]
  }
  const dispatcher = {
    useState(initial) {
      const c = slot(() => ({ value: typeof initial === 'function' ? initial() : initial }))
      return [c.value, (next) => { c.value = typeof next === 'function' ? next(c.value) : next; draw() }]
    },
    useCallback(fn, deps) {
      const c = slot(() => ({ fn, deps }))
      if (!sameDeps(c.deps, deps)) { c.fn = fn; c.deps = deps }
      return c.fn
    },
    useMemo(fn, deps) {
      const c = slot(() => ({ value: fn(), deps }))
      if (!sameDeps(c.deps, deps)) { c.value = fn(); c.deps = deps }
      return c.value
    },
    useRef(initial) { return slot(() => ({ current: initial })) },
    useEffect(fn, deps) {
      const c = slot(() => ({ deps: null, cleanup: null }))
      if (!sameDeps(c.deps, deps)) { c.deps = deps; pending.push([c, fn]) }
    },
  }
  function draw() {
    depth += 1
    assert.ok(depth < 50, 'the component re-rendered itself 50 times without settling')
    try {
      const before = REACT_DISPATCHER.H
      REACT_DISPATCHER.H = dispatcher
      cell = 0
      try { tree = Component(props) } finally { REACT_DISPATCHER.H = before }
      while (pending.length > 0) {
        const [c, fn] = pending.shift()
        if (typeof c.cleanup === 'function') c.cleanup()
        const cleanup = fn()
        c.cleanup = typeof cleanup === 'function' ? cleanup : null
      }
    } finally { depth -= 1 }
  }
  draw()
  return { tree: () => tree }
}

function findElement(node, matches) {
  if (node === null || node === undefined || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findElement(child, matches)
      if (hit !== null) return hit
    }
    return null
  }
  if (matches(node)) return node
  return findElement(node.props === undefined ? null : node.props.children, matches)
}

const childProps = (mounted, Child) => {
  const el = findElement(mounted.tree(), (n) => n.type === Child)
  assert.ok(el !== null, 'the component did not render the child this test reads')
  return el.props
}

const settle = async () => { for (let n = 0; n < 4; n += 1) await new Promise((resolve) => { setImmediate(resolve) }) }
const noop = () => {}

/** One answer per rpc method, and the log of what the page actually asked for. A method the page calls unstubbed fails the test rather than resolving to undefined. */
function stubRpc(answers) {
  const hivasok = []
  const rpc = (method, params) => {
    hivasok.push({ method, params })
    assert.ok(answers[method] !== undefined, `the page called an rpc method this test did not stub: ${method}`)
    return answers[method](params)
  }
  return { rpc, hivasok }
}

/** The count a text occurs -- several sentences can be pinned side by side, and `includes` cannot tell which of two occurrences a test is about. */
const elofordulas = (html, mondat) => html.split(mondat).length - 1

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// --- build -----------------------------------------------------------------

test('the built publish bundle carries no React of its own and resolves the host modules', async () => {
  const result = await bundle({ write: false })
  const text = result.outputFiles.map((f) => f.text).join('\n')
  for (const name of ['react', 'react/jsx-runtime']) {
    assert.ok(text.includes(`host.modules[${JSON.stringify(name)}]`), `${name} resolves against window.swarmclaw.modules`)
  }
  assert.equal(text.includes('react-dom'), false)
  assert.equal(text.includes('Invalid hook call'), false)
  assert.equal(text.includes('react.production'), false)
  assert.equal(text.includes('react.development'), false)
  // Not on one line: esbuild's unminified output breaks `registerPage(` and
  // its first argument across lines, so the pin is the call and the id, not
  // the exact adjacency `extensions/video/test/ui.test.mjs`'s single-line
  // `registerPage('video'` copy can afford.
  assert.ok(text.includes('registerPage('))
  assert.ok(text.includes('"publish"') || text.includes("'publish'"))
  assert.equal(text.includes('window.addEventListener'), false)
  assert.equal(text.includes('addEventListener('), false)
  assert.equal(text.includes('innerHTML'), false)
  assert.equal(text.includes('dangerouslySetInnerHTML'), false)
  // Task 6's own db.mjs fix (`uid()` off `globalThis.crypto`): a browser
  // bundle that still needed `node:crypto` would have failed to build at
  // all, so a successful bundle above already proves the resolution issue is
  // gone -- this asserts the SPECIFIC thing that would have broken it is not
  // in the output, so a regression back to `crypto.randomBytes` fails here
  // even if some future esbuild version quietly tolerated the unresolved
  // import.
  assert.equal(text.includes('node:crypto'), false)
})

test('the built publish bundle registers the declared page with the host React and the id the loader stamped', async () => {
  const result = await bundle({ write: false })
  const code = result.outputFiles.find((f) => f.path.endsWith('.js')).text
  const registrations = []
  class HTMLElement { constructor(dataset) { this.dataset = dataset } }
  const window = {
    swarmclaw: {
      modules: { react: React, 'react/jsx-runtime': jsxRuntime },
      registerPage: (pageId, component, opts) => registrations.push({ pageId, component, opts }),
    },
  }
  const document = { currentScript: new HTMLElement({ extension: 'publish.mjs' }) }
  vm.runInNewContext(code, { window, document, HTMLElement, Error, Object, console, fetch: async () => { throw new Error('not stubbed') } }, { filename: 'dist/index.js' })
  assert.equal(registrations.length, 1)
  const [{ pageId, component, opts }] = registrations
  assert.equal(pageId, 'publish')
  assert.equal(opts.extensionId, 'publish.mjs')
  assert.equal(opts.react, React, 'the very object on window.swarmclaw.modules, not a copy')
  assert.equal(typeof component, 'function')
})

test('the built publish bundle names the missing host module instead of failing inside React', async () => {
  const result = await bundle({ write: false })
  const code = result.outputFiles.find((f) => f.path.endsWith('.js')).text
  const window = { swarmclaw: { modules: {}, registerPage: () => {} } }
  assert.throws(() => vm.runInNewContext(code, { window, document: { currentScript: null }, Error, Object }), /host module missing: react/)
})

test('the stylesheet only names pub- prefixed selectors, so it cannot restyle the shell', () => {
  const css = readFileSync(path.join(root, 'ui/style.css'), 'utf8')
  const bodyless = css.replace(/\/\*[\s\S]*?\*\//g, '')
  for (const match of bodyless.matchAll(/([^{}]+)\{/g)) {
    for (const selector of match[1].split(',')) {
      const trimmed = selector.trim()
      if (trimmed === '') continue
      if (trimmed.startsWith('@')) continue
      assert.ok(trimmed.startsWith('.pub-'), `every selector starts inside the page: ${trimmed}`)
    }
  }
})

// --- api readers: a malformed answer is refused, not drawn as an empty page ---

test('readNaptar refuses a response without its lists instead of drawing an empty week', () => {
  assert.throws(() => readNaptar(null), /naptar/)
  assert.throws(() => readNaptar({ savok: [] }), /kiadasok/)
  assert.throws(() => readNaptar({ kiadasok: [] }), /savok/)
  assert.throws(() => readNaptar({ kiadasok: [], savok: [] }), /idozona/)
  const ok = readNaptar({ idozona: 'Europe/Budapest', savok: [], kiadasok: [] })
  assert.deepEqual(ok, { idozona: 'Europe/Budapest', savok: [], kiadasok: [] })
})

test('readNaptar refuses a branch row missing url as a shape, not as an absent value -- but a present null url is read through', () => {
  const base = { idozona: 'Europe/Budapest', savok: [], kiadasok: [{ kiadasId: 'k1', videoId: 'v1', allapot: 'vazlat', idopont: null, felulirtIdopont: null, savId: null, agak: [{ platform: 'youtube', allapot: 'var', url: null }] }] }
  const ok = readNaptar(base)
  assert.equal(ok.kiadasok[0].agak[0].url, null)
  const rossz = JSON.parse(JSON.stringify(base))
  delete rossz.kiadasok[0].agak[0].url
  assert.throws(() => readNaptar(rossz), /url/)
})

test('readKiadas keeps a stranger-written szoveg through byte for byte, and refuses a shape it cannot read', () => {
  assert.throws(() => readKiadas(null), /kiadas/)
  assert.throws(() => readKiadas({ kiadasId: 'k1' }), /videoId/)
  const raw = {
    kiadasId: 'k1', videoId: 'v1', allapot: 'lektoralt', idopont: null, felulirtIdopont: null, savId: null,
    cim: '<script>alert(1)</script>', narracioSzoveg: 'Ez hangzik el.', videoHiba: null,
    agak: [{ platform: 'youtube', allapot: 'var', url: null, hibaKod: null, kikuldveAt: null, szoveg: { cim: '<b>x</b>', leiras: 'y' } }],
    talalatok: [],
  }
  const ok = readKiadas(raw)
  assert.equal(ok.cim, '<script>alert(1)</script>')
  assert.deepEqual(ok.agak[0].szoveg, { cim: '<b>x</b>', leiras: 'y' })
  assert.throws(() => readKiadas({ ...raw, agak: undefined }), /agak/)
  assert.throws(() => readKiadas({ ...raw, talalatok: undefined }), /talalatok/)
})

test('readFiokok requires googleKliensVan as a boolean, and refuses a fiok row missing a field', () => {
  assert.throws(() => readFiokok({ fiokok: [], platformok: [] }), /googleKliensVan/)
  const ok = readFiokok({ fiokok: [], platformok: ['youtube'], googleKliensVan: true })
  assert.deepEqual(ok, { fiokok: [], platformok: ['youtube'], googleKliensVan: true })
  assert.throws(() => readFiokok({ fiokok: [{ id: 'f1', platform: 'youtube', kulsoId: 'UC1', nev: 'N' }], platformok: [], googleKliensVan: false }), /csatlakoztatvaAt/)
})

test('refusalText tells a lever refusal from an answer, and errText names a request that never reached the module', () => {
  assert.equal(refusalText({ hiba: 'kiadas_ismeretlen', uzenet: 'nincs kiadás a megadott kiadasId-vel' }), 'kiadas_ismeretlen: nincs kiadás a megadott kiadasId-vel')
  assert.equal(refusalText({ hiba: 'ismeretlen_hiba' }), 'ismeretlen_hiba (a modul nem küldött hozzá mondatot)')
  assert.equal(refusalText({ jovahagyva: true, utemezve: true }), null, 'a siker nem hiba')
  assert.equal(refusalText('kesz'), 'valasz_ervenytelen: a modul nem objektummal válaszolt erre a hívásra')
  assert.equal(refusalText(null), 'valasz_ervenytelen: a modul nem objektummal válaszolt erre a hívásra')
  assert.equal(errText(new Error('Failed to fetch')), 'Failed to fetch')
  assert.equal(errText('plain string'), 'plain string')
})

test('isRecord tells an object apart from an array and from null', () => {
  assert.equal(isRecord({}), true)
  assert.equal(isRecord([]), false)
  assert.equal(isRecord(null), false)
  assert.equal(isRecord('x'), false)
})

// --- safe-href ---------------------------------------------------------

test('safeHref only accepts http(s), and refuses javascript:/data:/file: and non-strings', () => {
  assert.equal(safeHref('https://example.test/a'), 'https://example.test/a')
  assert.equal(safeHref('http://example.test/a'), 'http://example.test/a')
  assert.equal(safeHref('  https://example.test/a  '), 'https://example.test/a')
  assert.equal(safeHref('javascript:alert(1)'), null)
  assert.equal(safeHref('data:text/html,x'), null)
  assert.equal(safeHref('file:///etc/passwd'), null)
  assert.equal(safeHref('//example.test/a'), null)
  assert.equal(safeHref(null), null)
  assert.equal(safeHref(undefined), null)
})

// --- the calendar: brief 6.2's own four failing tests, verbatim -----------

function naptarFixture(overrides = {}) {
  return {
    kiadasId: 'k1',
    videoId: 'v1',
    allapot: 'utemezve',
    idopont: null,
    felulirtIdopont: null,
    savId: null,
    agak: ['youtube', 'facebook', 'instagram', 'tiktok'].map((platform) => ({ platform, allapot: 'var', url: null })),
    ...overrides,
  }
}

const renderNaptar = (kiadas) => render(Bejegyzes, { kiadas })

test('egy kiadás EGY bejegyzés a naptárban, négy platform-jelzővel', () => {
  const html = renderNaptar(naptarFixture({ agak: [
    { platform: 'youtube', allapot: 'kesz' }, { platform: 'facebook', allapot: 'var' },
    { platform: 'instagram', allapot: 'hiba' }, { platform: 'tiktok', allapot: 'nincs_fiok' },
  ] }))
  assert.equal(elofordulas(html, 'pub-bejegyzes'), 1, 'egy bejegyzés, nem négy')
  for (const p of ['youtube', 'facebook', 'instagram', 'tiktok']) assert.ok(html.includes(p))
})

test('a vázlat láthatóan más, mint a jóváhagyott', () => {
  const v = renderNaptar(naptarFixture({ allapot: 'vazlat' }))
  const j = renderNaptar(naptarFixture({ allapot: 'jovahagyva' }))
  assert.notEqual(v, j)
  assert.ok(v.includes('jóváhagyásra vár'))
})

test('a naptár megmondja, mikor megy ki ténylegesen, nem csak a kért időt', () => {
  const html = renderNaptar(naptarFixture({ idopont: '2026-09-07T09:00:00.000Z' }))
  assert.ok(/negyed ór|következő futás/.test(html),
    'a csúszás ki van mondva; egy percre pontosat ígérő naptár rosszabb, mint amelyik megmondja a pontosságát')
})

test('a nincs_hova nem kesz: a lap kimondja, hogy sehol nincs fent', () => {
  const html = renderNaptar(naptarFixture({ allapot: 'nincs_hova' }))
  assert.ok(html.includes('Egyetlen platform sincs összekötve'))
  assert.equal(html.includes('Kiment'), false)
})

// --- the calendar entry: a few more shapes the four given tests do not cover ---

test('minden KIADAS_ALLAPOT szó ismert, és mindegyiknek saját mondata van', () => {
  for (const allapot of ['vazlat', 'lektoralt', 'jovahagyva', 'utemezve', 'kesz', 'reszben', 'hiba', 'nincs_hova']) {
    assert.ok(typeof KIADAS_CIMKE[allapot] === 'string' && KIADAS_CIMKE[allapot] !== '', allapot)
  }
  // Every sentence is its own, not a shared placeholder eight words fell back to.
  assert.equal(new Set(Object.values(KIADAS_CIMKE)).size, 8)
})

test('egy felülírt időpontú kiadás megmondja, hogy az operátor nyúlt hozzá', () => {
  const felul = renderNaptar(naptarFixture({ idopont: '2026-09-07T09:00:00.000Z', felulirtIdopont: '2026-09-08T10:00:00.000Z' }))
  const sima = renderNaptar(naptarFixture({ idopont: '2026-09-07T09:00:00.000Z' }))
  assert.ok(felul.includes('kézzel állította át'))
  assert.equal(sima.includes('kézzel állította át'), false)
})

test('egy platform sem hordoz idegen mondatot, csak a saját allapot-jelzőjét -- data-platform minden ágon jelen van', () => {
  const html = renderNaptar(naptarFixture())
  for (const p of ['youtube', 'facebook', 'instagram', 'tiktok']) {
    assert.ok(html.includes(`data-platform="${p}"`))
  }
})

test('idopontSzoveg null egy időpont nélküli kiadásra, és TZ-független szöveget ad egy valódira', () => {
  assert.equal(idopontSzoveg(null), null)
  const szoveg = idopontSzoveg('2026-09-07T09:00:00.000Z')
  assert.ok(szoveg.includes('2026-09-07 09:00'))
})

test('napIndexZonaban a modul zónájában számol, nem UTC-ben, és null-t ad egy ismeretlen zónára', () => {
  // 2026-09-07 is a Monday; 23:30 UTC on the Sunday before is already Monday
  // in a zone ahead of UTC (Kiribati, UTC+14) -- this is the exact case a
  // UTC-only weekday computation would place under the wrong day.
  assert.equal(napIndexZonaban('2026-09-06T23:30:00.000Z', 'Pacific/Kiritimati'), 1)
  assert.equal(napIndexZonaban('2026-09-06T23:30:00.000Z', 'UTC'), 0)
  assert.equal(napIndexZonaban('nem-datum', 'UTC'), null)
  assert.equal(napIndexZonaban('2026-09-07T09:00:00.000Z', 'nem/zona'), null)
})

// --- the release detail: four texts, per-branch state and url, jóváhagyás ---

function kiadasReszlet(overrides = {}) {
  return {
    kiadasId: 'k1', videoId: 'v1', allapot: 'lektoralt', idopont: null, felulirtIdopont: null, savId: null,
    cim: 'Egy videó címe', narracioSzoveg: 'Ez hangzik el a videóban.', videoHiba: null,
    agak: ['youtube', 'facebook', 'instagram', 'tiktok'].map((platform) => ({
      platform, allapot: 'var', url: null, hibaKod: null, kikuldveAt: null, szoveg: null,
    })),
    talalatok: [],
    ...overrides,
  }
}

const kiadasBodyProps = (overrides = {}) => ({
  reszlet: kiadasReszlet(), hiba: null, uzenet: null, kuldes: false, onJovahagy: noop, onBack: noop, onFrissit: noop, ...overrides,
})

test('a kiadás-lap a négy platform szövegét React szövegként rajzolja, script-tagekkel együtt, sosem markupként', () => {
  const html = render(KiadasBody, kiadasBodyProps({
    reszlet: kiadasReszlet({ agak: [
      { platform: 'youtube', allapot: 'var', url: null, hibaKod: null, kikuldveAt: null, szoveg: { cim: '<script>alert(1)</script>', leiras: 'Egy leírás.' } },
    ] }),
  }))
  assert.equal(html.includes('<script>alert'), false)
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'))
})

test('a jóváhagyás gomb csak lektoralt állapotban él, és megmondja, miért nem, ha nem az', () => {
  const lektoralt = render(KiadasBody, kiadasBodyProps({ reszlet: kiadasReszlet({ allapot: 'lektoralt' }) }))
  assert.equal(/<button[^>]*disabled[^>]*>Jóváhagyás/.test(lektoralt), false)

  const vazlat = render(KiadasBody, kiadasBodyProps({ reszlet: kiadasReszlet({ allapot: 'vazlat' }) }))
  assert.ok(/<button[^>]*disabled[^>]*>Jóváhagyás/.test(vazlat))
  assert.ok(vazlat.includes('jelenlegi állapot: vazlat'))
})

test('egy http(s) url megnyitható linkként jelenik meg, egy nem-http(s) url szövegként marad', () => {
  const jo = render(KiadasBody, kiadasBodyProps({
    reszlet: kiadasReszlet({ agak: [{ platform: 'youtube', allapot: 'kesz', url: 'https://youtu.be/x', hibaKod: null, kikuldveAt: '2026-09-07T09:00:00.000Z', szoveg: null }] }),
  }))
  assert.ok(jo.includes('href="https://youtu.be/x"'))
  assert.ok(jo.includes('rel="noopener noreferrer"'))

  const rossz = render(KiadasBody, kiadasBodyProps({
    reszlet: kiadasReszlet({ agak: [{ platform: 'youtube', allapot: 'kesz', url: 'javascript:alert(1)', hibaKod: null, kikuldveAt: null, szoveg: null }] }),
  }))
  assert.equal(rossz.includes('href="javascript'), false)
  assert.ok(rossz.includes('nem http(s)'))
})

test('a hibás ág saját hibaKod-ját mutatja, a másik három ág nem', () => {
  const html = render(KiadasBody, kiadasBodyProps({
    reszlet: kiadasReszlet({ agak: [
      { platform: 'youtube', allapot: 'hiba', url: null, hibaKod: 'kvota_elfogyott', kikuldveAt: null, szoveg: null },
      { platform: 'facebook', allapot: 'var', url: null, hibaKod: null, kikuldveAt: null, szoveg: null },
    ] }),
  }))
  assert.ok(html.includes('kvota_elfogyott'))
  assert.equal(elofordulas(html, 'kvota_elfogyott'), 1)
})

test('a lektori találatok csak akkor jelennek meg, ha vannak, és platformonként a saját kódjukat mondják', () => {
  const nincs = render(KiadasBody, kiadasBodyProps())
  assert.equal(nincs.includes('Lektori találatok'), false)
  const van = render(KiadasBody, kiadasBodyProps({
    reszlet: kiadasReszlet({ talalatok: [{ platform: 'youtube', kod: 'hashtag_hianyzik', szoveg: 'nincs hashtag' }] }),
  }))
  assert.ok(van.includes('Lektori találatok'))
  assert.ok(van.includes('hashtag_hianyzik'))
})

test('a video-szerződés hibája nem nyeli el a kiadás saját tényeit', () => {
  const html = render(KiadasBody, kiadasBodyProps({ reszlet: kiadasReszlet({ cim: null, narracioSzoveg: null, videoHiba: 'a videó szerződés nem érhető el' }) }))
  assert.ok(html.includes('a videó szerződés nem érhető el'))
  assert.ok(html.includes('Nincs elérhető narráció-szöveg.'))
  // The branch list still drew, over the video failure.
  assert.ok(html.includes('data-platform="youtube"'))
})

test('a betöltés és a hiba állapota nem téveszthető össze -- mindkettő saját, más mondatot ad', () => {
  const betoltes = render(KiadasBody, kiadasBodyProps({ reszlet: null }))
  assert.ok(betoltes.includes('Betöltés folyamatban.'))
  const hiba = render(KiadasBody, kiadasBodyProps({ reszlet: null, hiba: 'publish: nincs kiadás a megadott kiadasId-vel' }))
  assert.ok(hiba.includes('nincs kiadás'))
  assert.equal(hiba.includes('Betöltés folyamatban.'), false)
})

// --- the accounts screen: connection, and what is named as missing --------

const fiokokBodyProps = (overrides = {}) => ({
  adat: { fiokok: [], platformok: ['youtube', 'facebook', 'instagram', 'tiktok'], googleKliensVan: true },
  hiba: null, uzenet: null, kuldes: false, platform: 'youtube', kulsoId: '', nev: '',
  onPlatform: noop, onKulsoId: noop, onNev: noop, onOsszekot: noop, onFrissit: noop,
  ...overrides,
})

test('egy platform fiók nélkül nevesítve mondja, hogy hiányzik, egy összekötött a saját nevét és azonosítóját mutatja', () => {
  const html = render(FiokokBody, fiokokBodyProps({
    adat: { fiokok: [{ id: 'f1', platform: 'youtube', kulsoId: 'UC1', nev: 'Csatorna neve' }], platformok: ['youtube', 'facebook', 'instagram', 'tiktok'], googleKliensVan: true },
  }))
  assert.ok(html.includes('Csatorna neve'))
  assert.ok(html.includes('UC1'))
  assert.ok(html.includes('Nincs összekötve fiók ehhez a platformhoz.'))
  assert.equal(elofordulas(html, 'Nincs összekötve fiók ehhez a platformhoz.'), 3, 'facebook, instagram, tiktok -- youtube már összekötve')
})

test('a Google-bekötés gomb ki van kapcsolva OAuth-kliens nélkül, és megmondja miért', () => {
  const van = render(FiokokBody, fiokokBodyProps({ adat: { fiokok: [], platformok: ['youtube'], googleKliensVan: true } }))
  assert.equal(/<button[^>]*disabled[^>]*>Google-fiók bekötése/.test(van), false)

  const nincs = render(FiokokBody, fiokokBodyProps({ adat: { fiokok: [], platformok: ['youtube'], googleKliensVan: false } }))
  assert.ok(/<button[^>]*disabled[^>]*>Google-fiók bekötése/.test(nincs))
  assert.ok(nincs.includes('nincs OAuth-kliens'))
})

test('az összekötés-gomb kikapcsol, amíg nincs kitöltve mindkét mező, és amíg a kérés folyamatban van', () => {
  const ures = render(FiokokBody, fiokokBodyProps({ kulsoId: '', nev: '' }))
  assert.ok(/<button[^>]*disabled[^>]*>Összekötés/.test(ures))
  const felig = render(FiokokBody, fiokokBodyProps({ kulsoId: 'UC1', nev: '' }))
  assert.ok(/<button[^>]*disabled[^>]*>Összekötés/.test(felig))
  const van = render(FiokokBody, fiokokBodyProps({ kulsoId: 'UC1', nev: 'Csatorna' }))
  assert.equal(/<button[^>]*disabled[^>]*>Összekötés/.test(van), false)
  const kuldve = render(FiokokBody, fiokokBodyProps({ kulsoId: 'UC1', nev: 'Csatorna', kuldes: true }))
  assert.ok(/<button[^>]*disabled[^>]*>Összekötés/.test(kuldve))
})

// --- the stateful views, driven: what each lever's three outcomes says ---

test('NaptarNezet betölti a heti listát, és egy rossz válaszra megnevezett hibát mutat, nem üres naptárat', async () => {
  const { NaptarNezet } = await import('../ui/naptar.tsx')
  let naptarValasz = () => Promise.reject(new Error('Failed to fetch'))
  const { rpc } = stubRpc({ naptar: () => naptarValasz() })
  const view = mount(NaptarNezet, { rpc, onOpen: noop })
  await settle()
  const { NaptarBody } = await import('../ui/naptar.tsx')
  const body1 = () => childProps(view, NaptarBody)
  assert.equal(body1().hiba, 'Failed to fetch')
  assert.equal(body1().adat, null)

  naptarValasz = () => Promise.resolve({ idozona: 'Europe/Budapest', savok: [], kiadasok: [{ kiadasId: 'k1', videoId: 'v1', allapot: 'utemezve', idopont: null, felulirtIdopont: null, savId: null, agak: [] }] })
  body1().onFrissit()
  await settle()
  const body2 = () => childProps(view, NaptarBody)
  assert.equal(body2().hiba, null)
  assert.equal(body2().adat.kiadasok.length, 1)
})

test('KiadasNezet: a jóváhagyás gomb a három kimenetet -- ütemezve, nincs sáv, hálózati hiba -- külön mondja', async () => {
  const { KiadasNezet } = await import('../ui/kiadas.tsx')
  const reszlet = kiadasReszlet({ allapot: 'lektoralt' })
  let jovahagyValasz = () => Promise.resolve({ jovahagyva: true, utemezve: true, utemezesHiba: null, allapot: 'utemezve' })
  const { rpc, hivasok } = stubRpc({
    kiadas: () => Promise.resolve(reszlet),
    jovahagy: (params) => jovahagyValasz(params),
  })
  const view = mount(KiadasNezet, { rpc, kiadasId: 'k1', onBack: noop })
  await settle()
  const body = () => childProps(view, KiadasBody)
  assert.equal(body().reszlet.kiadasId, 'k1')
  // A successful approval reloads the detail (`kiadas`) right after, so the
  // last call overall is not the lever itself -- the last call NAMED
  // `jovahagy` is what this test pins.
  const lastJovahagy = () => hivasok.filter((h) => h.method === 'jovahagy').at(-1)

  body().onJovahagy()
  await settle()
  assert.deepEqual(lastJovahagy(), { method: 'jovahagy', params: { kiadasId: 'k1' } })
  assert.ok(body().uzenet.includes('ütemezve'))

  jovahagyValasz = () => Promise.resolve({ jovahagyva: true, utemezve: false, utemezesHiba: { kod: 'nincs_szabad_sav', uzenet: 'nincs sáv' }, allapot: 'jovahagyva' })
  body().onJovahagy()
  await settle()
  assert.ok(body().uzenet.includes('nincs_szabad_sav'))
  assert.ok(body().uzenet.includes('nem ütemezve'))

  jovahagyValasz = () => Promise.reject(new Error('a host 502-t adott'))
  body().onJovahagy()
  await settle()
  assert.equal(body().uzenet, 'A jóváhagyás kérése el sem jutott a modulhoz: a host 502-t adott')
})

test('FiokokNezet: az összekötés sikere kiüríti a mezőket és újratölti, egy elutasítás megtartja a beírtakat', async () => {
  const { FiokokNezet } = await import('../ui/fiokok.tsx')
  let osszekotValasz = () => Promise.resolve({ hiba: 'argumentum_hibas', uzenet: 'kulsoId kötelező' })
  let toltesek = 0
  const { rpc } = stubRpc({
    fiokok: () => { toltesek += 1; return Promise.resolve({ fiokok: [], platformok: ['youtube'], googleKliensVan: true }) },
    fiokotOsszekot: (params) => osszekotValasz(params),
  })
  const view = mount(FiokokNezet, { rpc })
  await settle()
  const { FiokokBody } = await import('../ui/fiokok.tsx')
  const body = () => childProps(view, FiokokBody)
  assert.equal(toltesek, 1)

  body().onKulsoId('UC1')
  body().onNev('Csatorna')
  body().onOsszekot()
  await settle()
  assert.ok(body().uzenet.includes('kulsoId'))
  assert.equal(body().kulsoId, 'UC1', 'egy elutasítás megtartja a beírtakat')
  assert.equal(toltesek, 1, 'egy elutasítás nem tölt újra')

  osszekotValasz = () => Promise.resolve({ fiok: { id: 'f1', platform: 'youtube', kulsoId: 'UC1', nev: 'Csatorna', csatlakoztatvaAt: '2026-09-07T00:00:00.000Z' } })
  body().onOsszekot()
  await settle()
  assert.ok(body().uzenet.includes('összekötve'))
  assert.equal(body().kulsoId, '', 'a siker kiüríti a mezőket')
  assert.equal(body().nev, '')
  assert.equal(toltesek, 2, 'a siker újratölti a listát')
})
