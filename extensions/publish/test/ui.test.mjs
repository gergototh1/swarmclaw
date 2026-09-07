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
import { AG_ALLAPOTOK, KIADAS_ALLAPOTOK, PLATFORMOK } from '../src/db.mjs'
import { errText, isRecord, readFiokok, readKiadas, readNaptar, refusalText } from '../ui/api.ts'
import { FiokokBody, PLATFORMOK_SORREND } from '../ui/fiokok.tsx'
import { KiadasBody } from '../ui/kiadas.tsx'
import { AG_CIMKE, Bejegyzes, KIADAS_CIMKE, NaptarBody, PLATFORM_CIMKE, idopontSzoveg, napIndexZonaban } from '../ui/naptar.tsx'
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

/** One platform flag as it was actually rendered: the state class it carries, and the sentence inside it. */
function jelzo(html, platform) {
  const m = new RegExp(`<span class="([^"]*)" data-platform="${platform}">([^<]*)</span>`).exec(html)
  assert.ok(m !== null, `nincs kirajzolt jelző ehhez a platformhoz: ${platform}`)
  return { osztaly: m[1], szoveg: m[2] }
}

test('egy kiadás EGY bejegyzés a naptárban, négy platform-jelzővel', () => {
  const varhato = { youtube: 'kesz', facebook: 'var', instagram: 'hiba', tiktok: 'nincs_fiok' }
  const html = renderNaptar(naptarFixture({
    agak: Object.entries(varhato).map(([platform, allapot]) => ({ platform, allapot })),
  }))
  assert.equal(elofordulas(html, 'pub-bejegyzes'), 1, 'egy bejegyzés, nem négy')
  for (const p of Object.keys(varhato)) assert.ok(html.includes(p))

  // A PÁROSÍTÁS AZ ÁLLÍTÁS, nem a négy név puszta előfordulása. A brief saját
  // tesztje (fent) attól is átmegy, ha mind a négy jelző EGY ág kimenetelét
  // hordozza -- és akkor "a fiók nélküli, az elbukott és a még el nem jött"
  // egyetlen mondatba olvad, ami éppen a modul központi vizuális állítása
  // (constraints.md első szabálya: három tény, három állapot, sosem egymás
  // helyett).
  for (const [platform, allapot] of Object.entries(varhato)) {
    const j = jelzo(html, platform)
    assert.equal(j.szoveg, `${PLATFORM_CIMKE[platform]}: ${AG_CIMKE[allapot]}`, platform)
    assert.equal(j.osztaly, `pub-jelzo pub-jelzo-${allapot}`, platform)
  }
  assert.equal(new Set(Object.values(varhato).map((a) => AG_CIMKE[a])).size, 4, 'a négy szó tényleg négy különböző mondat')
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

test('a lap szókincse a db.mjs saját konstansaihoz van kötve, nem egy kézzel másolt listához', () => {
  // A `ui/` SEMMIT NEM IMPORTÁL a `src/`-ből: a szavak kézzel át vannak
  // másolva, mert a lap böngésző-bundle-je nem akarja behúzni a repository
  // hatszáz sorát nyolc szó kedvéért. A másolat viszont elcsúszik, és az
  // elcsúszás néma: egy kilencedik szó a `KIADAS_ALLAPOTOK`-ban egy
  // `db.test.mjs` pint buktatna, a lapot soha -- az a kiadás egyszerűen a
  // nyers szavát írná ki az operátornak. Ezért a pin ITT van, a TESZTBEN,
  // ami mindkét oldalt importálja.
  assert.deepEqual(Object.keys(KIADAS_CIMKE).sort(), Object.values(KIADAS_ALLAPOTOK).slice().sort())
  assert.deepEqual(Object.keys(AG_CIMKE).sort(), Object.values(AG_ALLAPOTOK).slice().sort())
  assert.deepEqual(Object.keys(PLATFORM_CIMKE).sort(), PLATFORMOK.slice().sort())
  assert.deepEqual(PLATFORMOK_SORREND.slice().sort(), PLATFORMOK.slice().sort())

  // És minden szónak SAJÁT mondata: egy közös helytartó, amire kettő
  // visszaesik, ugyanúgy összeolvasztana két tényt.
  for (const [tabla, nev] of [[KIADAS_CIMKE, 'KIADAS_CIMKE'], [AG_CIMKE, 'AG_CIMKE'], [PLATFORM_CIMKE, 'PLATFORM_CIMKE']]) {
    for (const [szo, mondat] of Object.entries(tabla)) {
      assert.ok(typeof mondat === 'string' && mondat !== '', `${nev}.${szo}`)
    }
    assert.equal(new Set(Object.values(tabla)).size, Object.keys(tabla).length, nev)
  }
})

test('a kiadás-lap és a naptár UGYANAZT az ág-szótárat használja, nem két kézzel írt másolatot', () => {
  // Két különálló AG_CIMKE tábla (ez volt itt) csendben szétcsúszik: a
  // részletes nézet még "elbukott"-at ír, miközben a naptárat már mást
  // tanítottak mondani UGYANARRÓL a sorról.
  const html = render(KiadasBody, kiadasBodyProps({
    reszlet: kiadasReszlet({ agak: [{ platform: 'youtube', allapot: 'hiba', url: null, hibaKod: 'kvota_elfogyott', kikuldveAt: null, szoveg: null }] }),
  }))
  assert.ok(html.includes(AG_CIMKE.hiba))
  const naptarHtml = renderNaptar(naptarFixture({ agak: [{ platform: 'youtube', allapot: 'hiba' }] }))
  assert.ok(naptarHtml.includes(AG_CIMKE.hiba))
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
  reszlet: kiadasReszlet(), hiba: null, uzenet: null, kuldes: false, ujIdopont: '',
  onJovahagy: noop, onUjIdopont: noop, onAtutemez: noop, onBack: noop, onFrissit: noop, ...overrides,
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
  // ÉS NEM MONDJA VISSZA A TÁROLT ÉRTÉKET. Az elutasított url egy `javascript:`
  // vagy `data:` payload lehet, amit egy platform-adapter vagy egy ügynök írt
  // oda; React text child, tehát nem hajtódik végre, de a modul kimondott
  // szabálya (constraints.md) az, hogy egy elutasítás soha nem mondja vissza a
  // hívó értékét vagy a tárolt szöveget -- és a minta, amire ez a nézet
  // hivatkozik, `extensions/video/ui/video.tsx`, szintén érték nélkül fejezi be
  // a mondatot.
  assert.equal(rossz.includes('javascript:alert(1)'), false, 'az elutasított url nem kerül vissza a lapra')
  assert.equal(rossz.includes('alert(1)'), false)
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
  // AZ ŐR MAGA IS ÁLLÍTÁS. A `ag.hibaKod !== null &&` nélkül az ép ágak is
  // kapnának egy ÜRES `.pub-ag-hiba` bekezdést -- egy hibajelző elem egy olyan
  // ágon, amivel semmi baj nincs, ami pont a modul központi
  // megkülönböztetését mossa el (az elbukott és a még el nem jött nem ugyanaz).
  // A kód puszta előfordulása ezt nem fogja meg; az elemek SZÁMA igen.
  // A teljes `class="..."` az állítás, nem a puszta osztálynév: az `<li>` maga
  // `pub-ag-sor pub-ag-hiba`-t visel egy elbukott ágon (`pub-ag-${allapot}`),
  // tehát a részletre való számolás a sort is beleszámolná.
  assert.equal(elofordulas(html, 'class="pub-ag-hiba"'), 1, 'csak a hibás ág kap hiba-bekezdést, a másik nem')
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

// --- the release detail: when it goes out, and the operator's own reschedule ---
//
// `idopont`, `felulirtIdopont` and `savId` were read and typed by `ui/api.ts`
// from the page's first version and rendered by NOTHING, so the one screen an
// operator opens to decide whether to approve never said when the release
// would actually be published. These tests are that sentence, and the
// separate one the override gets.

test('a részletes nézet megmondja, mikor megy ki a kiadás, és a sávból kapott időpontot nem nevezi operátori felülírásnak', () => {
  const nincs = render(KiadasBody, kiadasBodyProps())
  assert.ok(nincs.includes('Ennek a kiadásnak még nincs időpontja'))
  assert.equal(nincs.includes('2026-'), false, 'időpont nélkül nincs mit kiírni')

  const utemezve = render(KiadasBody, kiadasBodyProps({
    reszlet: kiadasReszlet({ allapot: 'utemezve', idopont: '2026-09-07T09:00:00.000Z', savId: 's1' }),
  }))
  assert.ok(utemezve.includes('2026-09-07 09:00 UTC'))
  // A NAPTÁR SAJÁT MONDATA, nem egy második megfogalmazás: a két képernyő
  // ugyanazt a pillanatot ígéri, tehát ugyanazt a pontosságot is kell
  // mondaniuk a negyed órás csúszásról (design spec 7).
  assert.ok(utemezve.includes(idopontSzoveg('2026-09-07T09:00:00.000Z')))
  assert.equal(utemezve.includes('kézzel állította át'), false, 'a sáv adta időpont nem operátori felülírás')

  const felulirt = render(KiadasBody, kiadasBodyProps({
    reszlet: kiadasReszlet({ allapot: 'utemezve', idopont: '2026-09-08T10:00:00.000Z', felulirtIdopont: '2026-09-08T10:00:00.000Z', savId: 's1' }),
  }))
  assert.ok(felulirt.includes('2026-09-08 10:00 UTC'))
  assert.ok(felulirt.includes('kézzel állította át'), 'a felülírás külön tény, nem a formázás')
})

test('az áthelyezés űrlapja csak utemezve állapotban jelenik meg -- ott, ahol a modul nem utasítaná el', () => {
  // `repo.idopontFeluliras` (src/db.mjs) minden más állapotot nevesítve
  // elutasít, mert egy sáv nélküli kiadáson nincs mit felülírni. Egy gomb,
  // amit a modul úgyis elutasít, rosszabb, mint a hiánya.
  for (const allapot of ['vazlat', 'lektoralt', 'jovahagyva', 'kesz', 'reszben', 'hiba', 'nincs_hova']) {
    const html = render(KiadasBody, kiadasBodyProps({ reszlet: kiadasReszlet({ allapot }) }))
    assert.equal(html.includes('Áthelyezés másik időpontra'), false, allapot)
  }
  const utemezve = render(KiadasBody, kiadasBodyProps({
    reszlet: kiadasReszlet({ allapot: 'utemezve', idopont: '2026-09-07T09:00:00.000Z', savId: 's1' }),
  }))
  assert.ok(utemezve.includes('Áthelyezés másik időpontra'))
  assert.ok(utemezve.includes('a saját géped órája szerint'), 'a címke megmondja, melyik órán olvassa a beírt értéket')
  // Üres mezővel a gomb nem él: egy üres `datetime-local` nem időpont.
  assert.ok(/<button[^>]*disabled[^>]*>Áthelyezés</.test(utemezve))
  const beirva = render(KiadasBody, kiadasBodyProps({
    reszlet: kiadasReszlet({ allapot: 'utemezve', idopont: '2026-09-07T09:00:00.000Z', savId: 's1' }),
    ujIdopont: '2026-09-08T10:00',
  }))
  assert.equal(/<button[^>]*disabled[^>]*>Áthelyezés</.test(beirva), false)
})

test('egy félig megírt ág-szöveg félignek látszik, nem "még nincs megírt szöveg"-nek', () => {
  // `olvasSzoveg` (src/szoveg.mjs) a `cim`-et és a `leiras`-t KÜLÖN olvassa,
  // tehát `{ cim: 'C', leiras: null }` valódi tárolt állapot. A korábbi olvasó
  // ezt is, meg egy olvashatatlan választ is `null`-lá lapított, és a lap
  // mindkettőre azt írta, hogy semmi nincs megírva -- elrejtve az operátor
  // saját, félig kész címét.
  const felig = render(KiadasBody, kiadasBodyProps({
    reszlet: kiadasReszlet({ agak: [
      { platform: 'youtube', allapot: 'var', url: null, hibaKod: null, kikuldveAt: null, szoveg: { cim: 'Egy megírt cím', leiras: null } },
    ] }),
  }))
  assert.ok(felig.includes('Egy megírt cím'))
  assert.ok(felig.includes('Ehhez a platformhoz nincs megírt leírás.'))
  assert.equal(felig.includes('Ehhez a platformhoz még nincs megírt szöveg.'), false, 'egy megírt cím nem "semmi sincs megírva"')

  const semmi = render(KiadasBody, kiadasBodyProps({
    reszlet: kiadasReszlet({ agak: [
      { platform: 'youtube', allapot: 'var', url: null, hibaKod: null, kikuldveAt: null, szoveg: null },
    ] }),
  }))
  assert.ok(semmi.includes('Ehhez a platformhoz még nincs megírt szöveg.'))
  assert.equal(semmi.includes('nincs megírt cím'), false, 'a két tény nem egymás fölött jelenik meg')
})

test('readKiadas: a hiányzó szoveg KULCS alakhiba, egy jelen lévő null pedig "nincs szövege" -- és egy fél szöveg átjön', () => {
  const alap = {
    kiadasId: 'k1', videoId: 'v1', allapot: 'vazlat', idopont: null, felulirtIdopont: null, savId: null,
    cim: 'C', narracioSzoveg: null, videoHiba: null, talalatok: [],
    agak: [{ platform: 'youtube', allapot: 'var', url: null, hibaKod: null, kikuldveAt: null, szoveg: null }],
  }
  assert.equal(readKiadas(alap).agak[0].szoveg, null)

  const felig = JSON.parse(JSON.stringify(alap))
  felig.agak[0].szoveg = { cim: 'C', leiras: null }
  assert.deepEqual(readKiadas(felig).agak[0].szoveg, { cim: 'C', leiras: null })

  // Amit a régi olvasó NÉMÁN `null`-ra váltott: hiányzó kulcs, és egy olyan
  // alak, amit ez a lap nem tud elolvasni. Mindkettő megnevezve utasul el.
  const hianyzo = JSON.parse(JSON.stringify(alap))
  delete hianyzo.agak[0].szoveg
  assert.throws(() => readKiadas(hianyzo), /szoveg/)
  const rosszAlak = JSON.parse(JSON.stringify(alap))
  rosszAlak.agak[0].szoveg = 'egy sztring'
  assert.throws(() => readKiadas(rosszAlak), /szoveg/)
  const rosszMezo = JSON.parse(JSON.stringify(alap))
  rosszMezo.agak[0].szoveg = { cim: 42, leiras: 'L' }
  assert.throws(() => readKiadas(rosszMezo), /cim/)
})

// --- the calendar's slot controls: the entrance to the slot table ----------

const naptarBodyProps = (overrides = {}) => ({
  adat: { idozona: 'Europe/Budapest', savok: [], kiadasok: [] },
  hiba: null, uzenet: null, kuldes: false, savUrlap: { nap: null, ora: '18', perc: '00' },
  onOpen: noop, onFrissit: noop, onSavUrlapNyit: noop, onSavOra: noop, onSavPerc: noop,
  onSavFelvesz: noop, onSavTorol: noop, onAlapSavok: noop,
  ...overrides,
})

test('nulla sávos naptáron ott az egykattintásos alapkészlet, és minden nap ad gombot a sáv felvételéhez', () => {
  // EZ VOLT A LYUK, AMIÉRT A MODUL EGÉSZE TÉTLEN MARADT. A hét nap
  // mindegyike kiírta, hogy "Nincs sáv ezen a napon", gomb nélkül, és éles
  // kódból SEMMI nem hívta a `repo.ujSav`-ot -- tehát minden jóváhagyás
  // `nincs_szabad_sav`-val végződött, örökre.
  const html = render(NaptarBody, naptarBodyProps())
  assert.equal(elofordulas(html, 'Nincs sáv ezen a napon.'), 7)
  assert.equal(elofordulas(html, 'Sáv hozzáadása'), 7, 'mind a hét napban van bejárat')
  assert.ok(html.includes('Alap sávkészlet felvétele (hétfő, szerda, péntek 18:00)'))
  assert.ok(html.includes('a jóváhagyott kiadások nem kapnak'), 'a lap megmondja, mi az ára annak, hogy nincs sáv')
  // A zóna a válasszal utazik, és a törlés ára ki van mondva.
  assert.ok(html.includes('Europe/Budapest'))
  assert.ok(html.includes('Egy sáv törlése csak az ezután következő ütemezéseket érinti'))
})

test('egy felvett sáv a saját napjában jelenik meg, saját törlő gombbal, és az alapkészlet ajánlata eltűnik', () => {
  const html = render(NaptarBody, naptarBodyProps({
    adat: { idozona: 'Europe/Budapest', savok: [{ id: 's1', nap: 3, ora: 18, perc: 0 }], kiadasok: [] },
  }))
  assert.ok(html.includes('data-sav-id="s1"'))
  assert.ok(html.includes('18:00'), 'a sáv fali órája két jegyre kiírva')
  assert.equal(elofordulas(html, 'Sáv törlése'), 1, 'sávonként egy törlő gomb, nem naponként')
  assert.equal(elofordulas(html, 'Nincs sáv ezen a napon.'), 6, 'a szerda már nem üres, a másik hat igen')
  assert.equal(html.includes('Alap sávkészlet felvétele'), false, 'az alapkészlet üres naptár ajánlata, nem állandó gomb')

  // A sáv a SAJÁT napjában van, nem egy közös listában valahol a hét fölött.
  const szerda = html.split('data-nap="3"')[1].split('data-nap="4"')[0]
  assert.ok(szerda.includes('data-sav-id="s1"'))
})

test('egyszerre EGY nap sáv-űrlapja van nyitva, és az, amelyiket az operátor megnyitotta', () => {
  const zart = render(NaptarBody, naptarBodyProps())
  assert.equal(elofordulas(zart, 'Sáv mentése'), 0)

  const nyitva = render(NaptarBody, naptarBodyProps({ savUrlap: { nap: 3, ora: '18', perc: '30' } }))
  assert.equal(elofordulas(nyitva, 'Sáv mentése'), 1, 'hét nyitott űrlap hét helye lenne egy félig beírt órának')
  assert.equal(elofordulas(nyitva, 'Sáv hozzáadása'), 6, 'a nyitott nap a gombja helyett az űrlapját mutatja')
  assert.ok(nyitva.includes('aria-label="Óra — Szerda"'), 'a mező megnevezi, melyik nap órájáról van szó')
  assert.ok(nyitva.includes('aria-label="Perc — Szerda"'))
  const szerda = nyitva.split('data-nap="3"')[1].split('data-nap="4"')[0]
  assert.ok(szerda.includes('Sáv mentése'))
})

test('NaptarNezet: a sáv-felvétel a megnyitott napot és a beírt fali órát küldi, egy üres óra pedig NEM éjfél', async () => {
  const { NaptarNezet } = await import('../ui/naptar.tsx')
  let felveszValasz = () => Promise.resolve({ sav: { id: 's1', nap: 3, ora: 18, perc: 30 } })
  let toltesek = 0
  const { rpc, hivasok } = stubRpc({
    naptar: () => { toltesek += 1; return Promise.resolve({ idozona: 'Europe/Budapest', savok: [], kiadasok: [] }) },
    savotFelvesz: (params) => felveszValasz(params),
  })
  const view = mount(NaptarNezet, { rpc, onOpen: noop })
  await settle()
  const body = () => childProps(view, NaptarBody)
  assert.equal(toltesek, 1)
  const utolsoFelvesz = () => hivasok.filter((h) => h.method === 'savotFelvesz').at(-1)

  body().onSavUrlapNyit(3)
  body().onSavPerc('30')
  body().onSavFelvesz()
  await settle()
  assert.deepEqual(utolsoFelvesz().params, { nap: 3, ora: 18, perc: 30 }, 'számok mennek ki, nem az input sztringjei')
  assert.equal(body().uzenet, 'Sáv felvéve.')
  assert.equal(body().savUrlap.nap, null, 'a siker becsukja az űrlapot')
  assert.equal(toltesek, 2, 'a siker újratölti a naptárat')

  // A KIÜRÍTETT ÓRA-MEZŐ. `Number('')` nulla, tehát egy naiv átalakítás
  // csendben éjféli sávot deklarálna -- egy valódi publikálási időpontot, úgy,
  // mintha az operátor választotta volna. NaN nem egész, tehát a modul
  // nevesítve utasítja el.
  body().onSavUrlapNyit(3)
  body().onSavOra('')
  felveszValasz = () => Promise.resolve({ hiba: 'argumentum_hibas', uzenet: 'ora: 0 és 23 közötti egész szám kell' })
  body().onSavFelvesz()
  await settle()
  assert.equal(Number.isNaN(utolsoFelvesz().params.ora), true, 'az üres mező nem lesz 0')
  assert.ok(body().uzenet.includes('argumentum_hibas'))
  assert.equal(body().savUrlap.nap, 3, 'egy elutasítás nyitva hagyja az űrlapot, hogy legyen mit javítani')
  assert.equal(toltesek, 2, 'egy elutasítás nem tölt újra')

  felveszValasz = () => Promise.reject(new Error('a host 502-t adott'))
  body().onSavFelvesz()
  await settle()
  assert.equal(body().uzenet, 'A sáv felvételének kérése el sem jutott a modulhoz: a host 502-t adott')
})

test('NaptarNezet: a sáv törlése és az alapkészlet ugyanazt a három kimenetet mondja külön', async () => {
  const { NaptarNezet } = await import('../ui/naptar.tsx')
  let torolValasz = () => Promise.resolve({ savId: 's1' })
  let alapValasz = () => Promise.resolve({ savok: [{ id: 'a1', nap: 1, ora: 18, perc: 0 }] })
  let toltesek = 0
  const { rpc, hivasok } = stubRpc({
    naptar: () => { toltesek += 1; return Promise.resolve({ idozona: 'Europe/Budapest', savok: [], kiadasok: [] }) },
    savotTorol: (params) => torolValasz(params),
    alapSavokatFelvesz: (params) => alapValasz(params),
  })
  const view = mount(NaptarNezet, { rpc, onOpen: noop })
  await settle()
  const body = () => childProps(view, NaptarBody)

  body().onSavTorol('s1')
  await settle()
  assert.deepEqual(hivasok.filter((h) => h.method === 'savotTorol').at(-1).params, { savId: 's1' })
  assert.equal(body().uzenet, 'Sáv törölve.')
  assert.equal(toltesek, 2)

  torolValasz = () => Promise.resolve({ hiba: 'sav_ismeretlen', uzenet: 'nincs sáv a megadott savId-vel' })
  body().onSavTorol('elavult')
  await settle()
  assert.ok(body().uzenet.includes('sav_ismeretlen'), 'egy elavult lapról kattintott sor nem néma')
  assert.equal(toltesek, 2)

  body().onAlapSavok()
  await settle()
  assert.deepEqual(hivasok.filter((h) => h.method === 'alapSavokatFelvesz').at(-1).params, {})
  assert.ok(body().uzenet.includes('hétfő, szerda és péntek 18:00'), 'a siker kimondja, mit vett fel')
  assert.equal(toltesek, 3)

  alapValasz = () => Promise.resolve({ hiba: 'van_mar_sav', uzenet: 'ezen a telepítésen már van legalább egy sáv' })
  body().onAlapSavok()
  await settle()
  assert.ok(body().uzenet.includes('van_mar_sav'))

  alapValasz = () => Promise.reject(new Error('a host 502-t adott'))
  body().onAlapSavok()
  await settle()
  assert.equal(body().uzenet, 'Az alap sávkészlet kérése el sem jutott a modulhoz: a host 502-t adott')
})

test('KiadasNezet: az áthelyezés a beírt helyi időt ISO pillanattá váltja, és egy olvashatatlan értéket el sem küld', async () => {
  const { KiadasNezet } = await import('../ui/kiadas.tsx')
  const reszlet = kiadasReszlet({ allapot: 'utemezve', idopont: '2026-09-07T09:00:00.000Z', savId: 's1' })
  let atutemezValasz = () => Promise.resolve({ felulirtIdopont: '2026-09-08T08:00:00.000Z', allapot: 'utemezve' })
  let toltesek = 0
  const { rpc, hivasok } = stubRpc({
    kiadas: () => { toltesek += 1; return Promise.resolve(reszlet) },
    atutemez: (params) => atutemezValasz(params),
  })
  const view = mount(KiadasNezet, { rpc, kiadasId: 'k1', onBack: noop })
  await settle()
  const body = () => childProps(view, KiadasBody)
  assert.equal(toltesek, 1)

  // Egy olvashatatlan érték ITT dől el, nem egy körút után: a modul úgyis
  // `idopont_ervenytelen`-nel felelne, csak lassabban.
  body().onUjIdopont('nem-egy-datum')
  body().onAtutemez()
  await settle()
  assert.equal(hivasok.filter((h) => h.method === 'atutemez').length, 0, 'ezt el sem küldi')
  assert.ok(body().uzenet.includes('nem olvasható vissza'))

  // A `datetime-local` értékben NINCS zóna: a gép saját óráján olvasódik. A
  // teszt ezért nem egy fix ISO sztringet vár (az a futtató TZ-jétől függne),
  // hanem azt, hogy a kiküldött pillanat UGYANAZ a pillanat, amit a beírt
  // helyi fali óra jelent -- és hogy zónás alakban megy ki.
  body().onUjIdopont('2026-09-08T10:00')
  body().onAtutemez()
  await settle()
  const kuldott = hivasok.filter((h) => h.method === 'atutemez').at(-1)
  assert.equal(kuldott.params.kiadasId, 'k1')
  assert.equal(new Date(kuldott.params.felulirtIdopont).getTime(), new Date('2026-09-08T10:00').getTime())
  assert.ok(kuldott.params.felulirtIdopont.endsWith('Z'), 'a modul ISO pillanatot kap, nem zóna nélküli szöveget')
  assert.ok(body().uzenet.includes('áthelyezve'))
  assert.equal(body().ujIdopont, '', 'a siker kiüríti a mezőt')
  assert.equal(toltesek, 2, 'a siker újratölti a részletet')

  atutemezValasz = () => Promise.resolve({ hiba: 'kiadas_allapota_nem_engedi', uzenet: 'csak ütemezett kiadás helyezhető át' })
  body().onUjIdopont('2026-09-08T10:00')
  body().onAtutemez()
  await settle()
  assert.ok(body().uzenet.includes('kiadas_allapota_nem_engedi'))
  assert.equal(body().ujIdopont, '2026-09-08T10:00', 'egy elutasítás megtartja a beírtakat')
  assert.equal(toltesek, 2, 'egy elutasítás nem tölt újra')

  atutemezValasz = () => Promise.reject(new Error('a host 502-t adott'))
  body().onAtutemez()
  await settle()
  assert.equal(body().uzenet, 'Az áthelyezés kérése el sem jutott a modulhoz: a host 502-t adott')
})

// --- the host table, read directly -----------------------------------------

test('hostReact megnevezi a hiányzó host-modult, és a host SAJÁT react-jét adja vissza', async () => {
  // AZ EDDIGI ŐR NEM EZT A FÜGGVÉNYT HAJTOTTA. A bundle-t egy üres
  // `modules` táblával futtatva a `scripts/build.mjs` shimje dob előbb,
  // ugyanazzal a mondattal ("host module missing: react") -- tehát az
  // állítás anélkül teljesült, hogy a `hostReact()` valaha lefutott volna,
  // és ennek a fájlnak a sora akár törölhető is lett volna észrevétlenül.
  // Ez a teszt magát a függvényt hívja.
  const { hostOf, hostReact } = await import('../ui/host.ts')
  const eredetiVan = 'window' in globalThis
  const eredeti = globalThis.window
  try {
    globalThis.window = {}
    assert.throws(() => hostOf(), /window\.swarmclaw is not installed/)
    globalThis.window = { swarmclaw: { modules: {} } }
    assert.throws(() => hostOf(), /window\.swarmclaw is not installed/, 'registerPage nélkül a tábla nem a hoszté')
    globalThis.window = { swarmclaw: { modules: {}, registerPage: () => {} } }
    assert.throws(() => hostReact(), /publish: host module missing: react/)
    globalThis.window = { swarmclaw: { modules: { react: React }, registerPage: () => {} } }
    assert.equal(hostReact(), React, 'a hoszt tábláján lévő objektum, nem másolat')
  } finally {
    if (eredetiVan) globalThis.window = eredeti
    else delete globalThis.window
  }
})

test('a jóváhagyva, de sáv nélkül maradt kiadás kap gombot -- különben a friss telepítés első kiadása elveszne', () => {
  const html = render(KiadasBody, kiadasBodyProps({ reszlet: kiadasReszlet({ allapot: 'jovahagyva' }) }))
  assert.equal(/<button[^>]*disabled[^>]*>\s*Ütemezés a következő szabad sávba/.test(html), false, 'él a gomb')
  assert.ok(html.includes('Ütemezés a következő szabad sávba'))
  assert.ok(html.includes('akkor hagytad jóvá, amikor még nem volt szabad sáv'), 'megmondja, miért nincs időpontja és mi a teendő')
  assert.equal(html.includes('Csak lektorált kiadás hagyható jóvá'), false, 'ez nem az az eset')

  // És a szó szerinti jóváhagyás továbbra is csak lektoráltra szól.
  const lektoralt = render(KiadasBody, kiadasBodyProps({ reszlet: kiadasReszlet({ allapot: 'lektoralt' }) }))
  assert.ok(lektoralt.includes('>Jóváhagyás'))
  assert.equal(lektoralt.includes('Ütemezés a következő szabad sávba'), false)
  const vazlat = render(KiadasBody, kiadasBodyProps({ reszlet: kiadasReszlet({ allapot: 'vazlat' }) }))
  assert.ok(/<button[^>]*disabled[^>]*>\s*Jóváhagyás/.test(vazlat))
  assert.equal(vazlat.includes('Ütemezés a következő szabad sávba'), false)
})
