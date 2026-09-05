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

import { readBoard, readHealth, readManagedStatus, readPreviewCancel, readPreviewStart, readPreviewStatus, readProposals, readTemplatePreview, readTemplates, readVideo } from '../ui/api.ts'
import { bundle } from '../scripts/build.mjs'
import { describeManaged, formatMs, megtartasSzoveg, propokSzoveg, sapkaBetelt, statusLabel } from '../ui/format.ts'
import { pixelbolMs, pontbolJelenet, szazalek, teljesHossz } from '../ui/idovonal-state.ts'
import { JavaslatokBody } from '../ui/javaslatok.tsx'
import { MANAGED_RESOURCES_URL, loadManagedStatus } from '../ui/managed-state.ts'
import { URES_SZURO, normal, szurtTipusok } from '../ui/sablon-szuro.ts'
import { SablonokBody, csakKepek } from '../ui/sablonok.tsx'
import { Sor } from '../ui/sor.tsx'
import { StatusBar, StatusBarBody } from '../ui/status-bar.tsx'
import { VideoBody } from '../ui/video.tsx'

/**
 * The page, driven without a browser.
 *
 * The arithmetic a click turns into stored numbers lives in a plain module
 * (idovonal-state.ts) and is driven directly. What a state looks like once
 * drawn is pinned by rendering the component for it to static markup and
 * reading the string: that is enough to see a stranger's title arrive as
 * text, a `javascript:` url arrive without an `href`, a refused response
 * arrive as its message, and a full cap replace a button with a sentence.
 *
 * The stateful halves load in an effect, which a server render never runs, so
 * the split-out `...Body` components are what the state tests render.
 */

const render = (type, props) => renderToStaticMarkup(jsx(type, props))
const noop = () => {}

/**
 * The OPEN bar. The shell owns the fold, the message and the in-flight flag;
 * what a state looks like once drawn is the body's, so these tests render the
 * body directly, the same split `VideoBody` and `SablonokBody` already use.
 * The closed bar's one line is pinned separately, on the shell.
 */
const renderStatus = ({ onRefresh, rpc, ...props }) => render(StatusBarBody, { dolgozik: false, leallit: noop, tisztit: noop, ...props })

function summary(overrides = {}) {
  return {
    renderId: 'r1', videoId: 'v1', status: 'kesz', outPath: 'out/swarmclaw/v1/r1.mp4', logPath: 'out/swarmclaw/v1/r1.log',
    fileSha256: 'abc', qa: null, hiba: null, elteltMs: 120_000, hostUjraindult: false,
    startedAt: '2026-09-01T10:00:00.000Z', finishedAt: '2026-09-01T10:02:00.000Z', ...overrides,
  }
}

function card(overrides = {}) {
  return {
    id: 'v1', cim: 'Egy cím', status: 'terv', forrasTipus: 'signal', forrasId: 's1', createdAt: '2026-09-01T10:00:00.000Z',
    tervVerzio: 1, tervId: 't1', utolsoVerdikt: null, render: null, qa: null, ...overrides,
  }
}

const SAPKAK = {
  nyitottJavaslat: { db: 4, sapka: 20 },
  tanulsag: { 'agent:gyarto': { db: 9, sapka: 12 }, 'agent:lektor': { db: 0, sapka: 12 } },
  backlog: { szabaly: { db: 2, sapka: 10 }, sablon: { db: 0, sapka: 10 } },
}

const COUNTS = { videos: 1, tervek: 1, renderek: 0, qaOk: 0, nyitottJavaslatok: 4, fordulok: 0 }

function board(overrides = {}) {
  return {
    oszlopok: { nyitott: [], terv: [card()], lezart: [] },
    statusok: ['nyitott', 'terv', 'lezart'],
    futoRender: null,
    sapkak: SAPKAK,
    counts: COUNTS,
    utolsoFordulok: [],
    utolsoFordulokLimit: 20,
    ...overrides,
  }
}

function health(overrides = {}) {
  return {
    ok: true, hibak: [], figyelmeztetesek: [], blokkolt: [], nemValaszolt: ['reconcile_hianyzik'],
    remotion: { beallitva: true, letezik: true, hianyzoFajlok: [] },
    eszkozok: { ffmpeg: true, ffprobe: true, npx: true },
    chrome: { konyvtar: true, megjegyzes: 'a node_modules/.remotion könyvtár léte a projektben' },
    platform: 'darwin', linuxRenderEngedely: false,
    szerzodesek: { tts: null, signals: null },
    futoRender: null, sorNelkul: 0, counts: COUNTS, forduloRogzites: 'sajat',
    sapkak: { nyitottJavaslat: 20, tanulsagCelonkent: 12, backlog: 10 },
    ...overrides,
  }
}

function videoDetail(overrides = {}) {
  return {
    id: 'v1', cim: 'Egy cím', status: 'terv', forrasTipus: 'signal', forrasId: 's1',
    forrasSzoveg: 'Fejléc\n\nÖsszefoglaló\n\nhttps://example.test/a',
    nyitottaAgentId: 'agent:gyarto', createdAt: '2026-09-01T10:00:00.000Z', lezarvaAt: null,
    tervek: [], renderek: [], visszajelzesek: [], megtartas: [], ...overrides,
  }
}

function proposal(overrides = {}) {
  return {
    id: 'j1', cel: 'agent:gyarto', fajta: 'tanulsag', cim: 'Egy javaslat', szoveg: 'A szövege.',
    bizonyitek: [], status: 'nyitott', dontesMegjegyzes: null, createdAt: '2026-09-01T10:00:00.000Z', decidedAt: null,
    ...overrides,
  }
}

function proposals(overrides = {}) {
  return {
    nyitott: [], backlog: [], tanulsagok: { 'agent:gyarto': { db: 9, sapka: 12, tetelek: [] } },
    elutasitott: [], kodolva: [], sapkak: SAPKAK, katalogusHiba: null, ...overrides,
  }
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// --- build ---

test('the built video bundle carries no React of its own and resolves the host modules', async () => {
  const result = await bundle({ write: false })
  const text = result.outputFiles.map((f) => f.text).join('\n')
  for (const name of ['react', 'react/jsx-runtime']) {
    assert.ok(text.includes(`host.modules[${JSON.stringify(name)}]`), `${name} resolves against window.swarmclaw.modules`)
  }
  assert.equal(text.includes('react-dom'), false)
  // Strings every React build carries and this bundle must not.
  assert.equal(text.includes('Invalid hook call'), false)
  assert.equal(text.includes('react.production'), false)
  assert.equal(text.includes('react.development'), false)
  assert.ok(text.includes("registerPage('video'") || text.includes('registerPage("video"'))
  // The page holds no window-level key or event listener at all: the aisignal
  // review found one stealing Enter from every focused control on the page.
  assert.equal(text.includes('window.addEventListener'), false)
  assert.equal(text.includes('addEventListener('), false)
  // Nothing on this page writes markup.
  assert.equal(text.includes('innerHTML'), false)
  assert.equal(text.includes('dangerouslySetInnerHTML'), false)
})

test('the built video bundle registers the declared page with the host React and the id the loader stamped', async () => {
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
  const document = { currentScript: new HTMLElement({ extension: 'video.mjs' }) }
  vm.runInNewContext(code, { window, document, HTMLElement, Error, Object, console }, { filename: 'dist/index.js' })
  assert.equal(registrations.length, 1)
  const [{ pageId, component, opts }] = registrations
  assert.equal(pageId, 'video')
  assert.equal(opts.extensionId, 'video.mjs')
  assert.equal(opts.react, React, 'the very object on window.swarmclaw.modules, not a copy')
  assert.equal(typeof component, 'function')
  // Before the first load lands the page says so rather than drawing an empty
  // queue -- but it draws the status bar and the tabs, which do not come from
  // the board and must not wait on it. A board that never arrives costs the
  // queue and nothing else.
  const html = renderToStaticMarkup(jsx(component, { extensionId: 'video.mjs', rpc: async () => ({}) }))
  assert.ok(html.includes('data-extension="video.mjs"'))
  assert.ok(html.includes('Betöltés'))
  assert.ok(html.includes('vid-status'), 'the status bar is drawn without the board')
  assert.ok(html.includes('lekérdezés folyamatban'), 'and the closed bar says which of its own loads is missing')
  assert.ok(html.includes('role="tablist"'), 'the tabs are drawn without the board')
})

test('the built video bundle names the missing host module instead of failing inside React', async () => {
  const result = await bundle({ write: false })
  const code = result.outputFiles.find((f) => f.path.endsWith('.js')).text
  const window = { swarmclaw: { modules: {}, registerPage: () => {} } }
  assert.throws(() => vm.runInNewContext(code, { window, document: { currentScript: null }, Error, Object }), /host module missing: react/)
})

test('the stylesheet only names vid- prefixed selectors, so it cannot restyle the shell', async () => {
  const { readFileSync } = await import('node:fs')
  const css = readFileSync(path.join(root, 'ui/style.css'), 'utf8')
  // Strip comments, then take the selector list before every rule body.
  const bodyless = css.replace(/\/\*[\s\S]*?\*\//g, '')
  for (const match of bodyless.matchAll(/([^{}]+)\{/g)) {
    for (const selector of match[1].split(',')) {
      const trimmed = selector.trim()
      if (trimmed === '') continue
      assert.ok(trimmed.startsWith('.vid-'), `every selector starts inside the page: ${trimmed}`)
    }
  }
})

// --- the timeline's arithmetic ---

test('pontbolJelenet uses half-open bounds so no millisecond belongs to two scenes', () => {
  const hatarok = [
    { jelenet: 0, kezdetMs: 0, vegMs: 1000 },
    { jelenet: 1, kezdetMs: 1000, vegMs: 2500 },
  ]
  assert.equal(pontbolJelenet(hatarok, 0), 0)
  assert.equal(pontbolJelenet(hatarok, 999), 0)
  // The boundary belongs to the scene that starts there, not the one that ends.
  assert.equal(pontbolJelenet(hatarok, 1000), 1)
  assert.equal(pontbolJelenet(hatarok, 2499), 1)
  // The last scene's own end is outside the video.
  assert.equal(pontbolJelenet(hatarok, 2500), null)
  assert.equal(pontbolJelenet(hatarok, -1), null)
  assert.equal(pontbolJelenet([], 0), null)
})

test('pixelbolMs clamps to the timeline and answers 0 for an unmeasurable element', () => {
  assert.equal(pixelbolMs(0, 200, 10_000), 0)
  assert.equal(pixelbolMs(100, 200, 10_000), 5000)
  assert.equal(pixelbolMs(200, 200, 10_000), 10_000)
  // Dragged off either end.
  assert.equal(pixelbolMs(-50, 200, 10_000), 0)
  assert.equal(pixelbolMs(500, 200, 10_000), 10_000)
  // An element that has not been laid out, and a timeline of no length.
  assert.equal(pixelbolMs(100, 0, 10_000), 0)
  assert.equal(pixelbolMs(100, -5, 10_000), 0)
  assert.equal(pixelbolMs(100, 200, 0), 0)
})

test('teljesHossz and szazalek lay the scenes out to scale', () => {
  const hatarok = [{ jelenet: 0, kezdetMs: 0, vegMs: 1000 }, { jelenet: 1, kezdetMs: 1000, vegMs: 4000 }]
  assert.equal(teljesHossz(hatarok), 4000)
  assert.equal(teljesHossz([]), 0)
  assert.deepEqual(szazalek(0, 1000, 4000), { left: 0, width: 25 })
  assert.deepEqual(szazalek(1000, 4000, 4000), { left: 25, width: 75 })
  assert.deepEqual(szazalek(0, 1000, 0), { left: 0, width: 0 })
})

// --- the gallery's filtering ---

/**
 * The real catalogue, not a hand-written stand-in.
 *
 * Its prose is written WITHOUT accents ("Temavaltasnal hasznald") while the
 * operator types WITH them, which is the whole reason `normal` exists; a
 * fixture invented here would have whatever accents this file happened to
 * type and would pin nothing.
 */
const KATALOGUS = JSON.parse(readFileSync(path.join(root, 'test/fixtures/katalogus.generated.json'), 'utf8'))

function forras(overrides = {}) {
  return {
    tipusok: KATALOGUS.tipusok,
    leirasok: KATALOGUS.leirasok,
    propok: KATALOGUS.propok,
    kuldheto: ['cimlap', 'atvezeto', 'szam'],
    hasznalat: { cimlap: 3, 'kartya-csere': 1 },
    vanKep: ['cimlap', 'lista'],
    ...overrides,
  }
}

const szuroval = (overrides = {}) => ({ ...URES_SZURO, ...overrides })

test('an empty filter keeps every type, in the catalogue own order', () => {
  assert.equal(KATALOGUS.tipusok.length, 24)
  assert.deepEqual(szurtTipusok(forras(), URES_SZURO), KATALOGUS.tipusok)
  // Whitespace is not a query: a cleared box must not empty the grid.
  assert.deepEqual(szurtTipusok(forras(), szuroval({ kereses: '   ' })), KATALOGUS.tipusok)
})

test('the search is accent-insensitive in both directions, because the catalogue writes none and the operator types them', () => {
  assert.equal(normal('Átvezető'), 'atvezeto')
  assert.equal(normal('atvezeto'), 'atvezeto')
  assert.deepEqual(szurtTipusok(forras(), szuroval({ kereses: 'átvezető' })), ['atvezeto'])
  assert.deepEqual(szurtTipusok(forras(), szuroval({ kereses: 'atvezeto' })), ['atvezeto'])
  // And into the prose, which is where the accents are actually missing.
  assert.deepEqual(szurtTipusok(forras(), szuroval({ kereses: 'Témaváltásnál' })), ['atvezeto'])
})

test('the search reaches prop names, not only the type name and its sentence', () => {
  assert.deepEqual(szurtTipusok(forras(), szuroval({ kereses: 'makett' })), ['lista'])
  assert.deepEqual(szurtTipusok(forras(), szuroval({ kereses: 'nincs-ilyen-szo' })), [])
})

test('each of the three toggles narrows on its own fact, and the four filters are ANDed', () => {
  const f = forras()
  assert.deepEqual(szurtTipusok(f, szuroval({ kuldhetoseg: 'kuldheto' })), ['cimlap', 'atvezeto', 'szam'])
  const nem = szurtTipusok(f, szuroval({ kuldhetoseg: 'nem' }))
  assert.equal(nem.length, 21)
  assert.ok(!nem.includes('cimlap'))

  // A type the statistic does not name is a type nothing used, which is 0.
  assert.deepEqual(szurtTipusok(f, szuroval({ hasznalat: 'hasznalt' })), ['cimlap', 'kartya-csere'])
  assert.ok(!szurtTipusok(f, szuroval({ hasznalat: 'nem' })).includes('cimlap'))

  assert.deepEqual(szurtTipusok(f, szuroval({ elonezet: 'van' })), ['cimlap', 'lista'])
  assert.ok(!szurtTipusok(f, szuroval({ elonezet: 'nincs' })).includes('lista'))

  // All four at once, and the order is still the catalogue's.
  assert.deepEqual(
    szurtTipusok(f, szuroval({ kereses: 'a', kuldhetoseg: 'kuldheto', hasznalat: 'hasznalt', elonezet: 'van' })),
    ['cimlap'],
  )
  // AND, not OR: one clause that matches nothing empties the result.
  assert.deepEqual(szurtTipusok(f, szuroval({ kuldhetoseg: 'kuldheto', hasznalat: 'hasznalt', elonezet: 'nincs' })), [])
})

test('a fact the page does not have cannot narrow, so an unrelated missing field never empties the grid', () => {
  const vak = forras({ kuldheto: null, hasznalat: null, vanKep: null })
  const mind = szuroval({ kuldhetoseg: 'kuldheto', hasznalat: 'hasznalt', elonezet: 'van' })
  assert.deepEqual(szurtTipusok(vak, mind), KATALOGUS.tipusok)
  // The search still works on what IS there, and a null prose field costs
  // the prose rather than the card.
  assert.deepEqual(szurtTipusok(forras({ leirasok: null, propok: null }), szuroval({ kereses: 'makett' })), [])
  assert.deepEqual(szurtTipusok(forras({ leirasok: null, propok: null }), szuroval({ kereses: 'lista' })), ['lista'])
})

// --- api readers: a malformed answer is refused, not drawn as an empty page ---

test('readBoard refuses a response without its columns instead of yielding an empty queue', () => {
  assert.throws(() => readBoard({ ...board(), oszlopok: undefined }), /hiányzik a oszlopok mező/)
  assert.throws(() => readBoard({ ...board(), statusok: undefined }), /statusok/)
  assert.throws(() => readBoard({ ...board(), sapkak: undefined }), /sapkak/)
  assert.throws(() => readBoard(null), /board/)
  assert.throws(() => readBoard('<!doctype html>'), /board/)
  const ok = readBoard(board())
  assert.deepEqual(ok.statusok, ['nyitott', 'terv', 'lezart'])
  assert.equal(ok.oszlopok.terv.length, 1)
})

test('readVideo refuses a response without its plan list, and keeps the source text byte for byte', () => {
  assert.throws(() => readVideo({ ...videoDetail(), tervek: undefined }), /hiányzik a tervek mező/)
  assert.throws(() => readVideo({ ...videoDetail(), renderek: undefined }), /renderek/)
  assert.throws(() => readVideo({ ...videoDetail(), forrasSzoveg: undefined }), /forrasSzoveg/)
  assert.throws(() => readVideo(null), /video/)
  const raw = 'Fejléc\n\n<script>alert(1)</script>\n\nhttps://example.test/a'
  assert.equal(readVideo(videoDetail({ forrasSzoveg: raw })).forrasSzoveg, raw)
})

test('readProposals, readTemplates and readHealth refuse by name, and a null sablonStat is an answer rather than a gap', () => {
  assert.throws(() => readProposals({ ...proposals(), nyitott: undefined }), /hiányzik a nyitott mező/)
  assert.throws(() => readProposals({ ...proposals(), tanulsagok: undefined }), /tanulsagok/)
  assert.throws(() => readTemplates({ hetiSor: [], sablonStat: 3 }), /sablonStat/)
  assert.throws(() => readTemplates({ sablonStat: null }), /hetiSor/)
  assert.equal(readTemplates({ hiba: 'remotion_dir_hianyzik', sablonStat: null, hetiSor: [] }).sablonStat, null)
  // The catalogue fields degrade one by one: a `propok` this page cannot
  // draw costs the gallery its prop lists, not the numbers beside them.
  const rossz = readTemplates({ hiba: null, sablonStat: {}, hetiSor: [], tipusok: ['cimlap'], propok: 'nem objektum', kozosPropok: 3, mintaHianyzik: [1] })
  assert.deepEqual(rossz.tipusok, ['cimlap'])
  assert.equal(rossz.propok, null)
  assert.equal(rossz.kozosPropok, null)
  assert.equal(rossz.mintaHianyzik, null, 'a list of something other than type names is not a list of type names')
  assert.deepEqual(rossz.sablonStat, {})
  assert.deepEqual(rossz.hetiSor, [])
  // The check goes as deep as the gallery walks: a `propok` entry that is
  // not a list of props, or a `leirasok` value that is not a sentence, would
  // otherwise throw inside the render and take the numbers down with it.
  const sekely = readTemplates({ hiba: null, sablonStat: {}, hetiSor: [], propok: { cimlap: 'x' }, leirasok: { cimlap: 42 }, kozosPropok: [{ nev: 'racs' }] })
  assert.equal(sekely.propok, null)
  assert.equal(sekely.leirasok, null)
  assert.equal(sekely.kozosPropok, null, 'a prop without a boolean kotelezo is not a prop')
  assert.deepEqual(sekely.sablonStat, {})
  // One unreadable entry costs the whole field: a prop table missing a type
  // without saying so would be a false statement about the kit.
  assert.equal(readTemplates({ hiba: null, sablonStat: {}, hetiSor: [], propok: { cimlap: [{ nev: 'sorok', kotelezo: true, mit: 'a' }], szam: [3] } }).propok, null)
  // `mit` is not required, because `katalogus.mjs` does not require it: the
  // page draws what the catalogue has rather than refusing what it lacks.
  const jo = readTemplates({ hiba: null, sablonStat: {}, hetiSor: [], propok: { cimlap: [{ nev: 'sorok', kotelezo: true }] }, leirasok: { cimlap: 'A nyitókép.' }, kozosPropok: [{ nev: 'racs', kotelezo: false, mit: 'rács' }] })
  assert.deepEqual(jo.propok, { cimlap: [{ nev: 'sorok', kotelezo: true }] })
  assert.deepEqual(jo.leirasok, { cimlap: 'A nyitókép.' })
  assert.deepEqual(jo.kozosPropok, [{ nev: 'racs', kotelezo: false, mit: 'rács' }])
  // A catalogue that could not be read leaves every one of them null, and
  // `hetiSor` still answers.
  const nelkul = readTemplates({ hiba: 'remotion_dir_hianyzik', sablonStat: null, hetiSor: [], tipusok: null, propok: null })
  assert.equal(nelkul.tipusok, null)
  assert.equal(nelkul.kuldhetoTipusok, null)
  // Every one of health's four lists is required: an absent `nemValaszolt`
  // drawn as an empty one would read as "everything was checked".
  for (const field of ['hibak', 'figyelmeztetesek', 'blokkolt', 'nemValaszolt', 'eszkozok']) {
    assert.throws(() => readHealth({ ...health(), [field]: undefined }), new RegExp(field))
  }
  assert.throws(() => readHealth({ ...health(), ok: undefined }), /ok/)
  // `sorNelkul: null` is "not counted" and stays null rather than becoming 0.
  assert.equal(readHealth(health({ sorNelkul: null })).sorNelkul, null)
})

// --- the queue draws a stranger's title as text ---

test('the Sor draws a card title as text, script tags and all, and never as markup', () => {
  const html = render(Sor, { board: board({ oszlopok: { nyitott: [], terv: [card({ cim: '<script>alert(1)</script>' })], lezart: [] } }), onOpen: noop })
  assert.equal(html.includes('<script>'), false)
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'))
  assert.ok(html.includes('data-video-id="v1"'))
  // Empty columns are named rather than dropped.
  assert.ok(html.includes('Üres:'))
  assert.ok(html.includes('Nyitott javaslatok: 4/20'))
})

test('the Sor keeps four card facts apart rather than folding them into one', () => {
  const html = render(Sor, { board: board(), onOpen: noop })
  assert.ok(html.includes('lektorálva: még nem'))
  assert.ok(html.includes('render: még nem indult'))
  assert.ok(html.includes('QA: nincs érvényes sor'))
  const bukott = render(Sor, {
    board: board({ oszlopok: { nyitott: [], terv: [card({ qa: { ok: false, bukasok: ['Q4', 'Q6'] }, render: summary({ status: 'hiba', hiba: { kod: 'render_idotullepes', szoveg: null } }) })], lezart: [] } }),
    onOpen: noop,
  })
  assert.ok(bukott.includes('QA: bukott (Q4, Q6)'))
  assert.ok(bukott.includes('render_idotullepes'))
})

test('statusLabel names a status it knows and flags one it does not', () => {
  assert.deepEqual(statusLabel('qa_hiba'), { label: 'QA-hiba', known: true })
  assert.deepEqual(statusLabel('valami_uj'), { label: 'valami_uj', known: false })
  assert.deepEqual(statusLabel(''), { label: '(üres státusz)', known: false })
  assert.deepEqual(statusLabel(undefined), { label: '(üres státusz)', known: false })
})

// --- the video view: a stranger's source, and the one link ---

const videoProps = (video) => ({
  video, pont: { atMs: '', jelenet: '' }, szoveg: '', kuldes: false, uzenet: null,
  onPick: noop, onSzoveg: noop, onAtMs: noop, onJelenet: noop, onKuld: noop, onLezar: noop, onBack: noop,
})

test('the Video view shows the source raw under the idegen szoveg label and links only an http(s) url', () => {
  const html = render(VideoBody, videoProps(videoDetail({ forrasSzoveg: 'Fejléc\n\n<b>félkövér</b> & társai\n\nhttps://example.test/a' })))
  assert.ok(html.includes('idegen szöveg'), 'the box is labelled as a stranger\'s text')
  assert.ok(html.includes('class="vid-forras"'))
  assert.equal(html.includes('<b>félkövér</b>'), false)
  assert.ok(html.includes('&lt;b&gt;félkövér&lt;/b&gt; &amp; társai'))
  assert.ok(html.includes('href="https://example.test/a"'))
  assert.ok(html.includes('rel="noopener noreferrer"'))
})

test('a javascript: url in the source never becomes an href', () => {
  const html = render(VideoBody, videoProps(videoDetail({ forrasSzoveg: 'Fejléc\n\nÖsszefoglaló\n\njavascript:alert(1)' })))
  assert.equal(html.includes('href="javascript'), false)
  assert.equal(html.includes('<a '), false)
  assert.ok(html.includes('nem http(s) url'))
  // The refused url is still shown, inside the source box, as text.
  assert.ok(html.includes('javascript:alert(1)'))
})

test('the Video view says which measurement is missing rather than printing a zero', () => {
  const terv = {
    id: 't1', verzio: 1, jelenetek: [{ tipus: 'cimlap', sorok: ['Egy'] }], narracio: [{ jelenet: 0, szoveg: 'Első mondat.' }],
    assetUjjlenyomatok: {}, tervHash: 'h1', katalogusHash: 'k1', szerzoAgentId: 'agent:gyarto', ellenorzes: {},
    createdAt: '2026-09-01T10:00:00.000Z', verdiktek: [], narraciok: [],
  }
  const html = render(VideoBody, videoProps(videoDetail({ tervek: [terv] })))
  assert.ok(html.includes('még nincs narráció-fájl, így nincs mért hossz'))
  assert.ok(html.includes('Ehhez a tervverzióhoz még nincs lektori ítélet.'))
  assert.ok(html.includes('Ehhez a videóhoz még nem indult render.'))
  assert.ok(html.includes('Nincs kész render, így nincs idővonal'))
})

test('a running render whose host restarted says so instead of printing an elapsed time it cannot know', () => {
  const run = { ...summary({ status: 'fut', finishedAt: null, hostUjraindult: true, elteltMs: 999_999 }), tervId: 't1', jelenetHatarok: [], propsPath: null, torolveAt: null }
  const html = render(VideoBody, videoProps(videoDetail({ renderek: [run] })))
  assert.ok(html.includes('futó render, eltelt idő ismeretlen a host újraindulása óta'))
  assert.equal(html.includes('999'), false)
  assert.ok(html.includes('nincs érvényes QA-sor'))
})

test('a reviewer finding points at its scene and arrives as text', () => {
  const terv = {
    id: 't1', verzio: 2, jelenetek: [{ tipus: 'cimlap' }, { tipus: 'szam' }], narracio: [],
    assetUjjlenyomatok: {}, tervHash: 'h2', katalogusHash: 'k1', szerzoAgentId: 'agent:gyarto', ellenorzes: {},
    createdAt: '2026-09-01T10:00:00.000Z',
    verdiktek: [{ id: 'vd1', verdikt: 'elbukik', tervHash: 'h2', lektorAgentId: 'agent:lektor', at: '2026-09-01T11:00:00.000Z', talalatok: [{ jelenet: 1, kod: 'horog_gyenge', szoveg: '<img src=x onerror=alert(1)>' }] }],
    narraciok: [],
  }
  const html = render(VideoBody, videoProps(videoDetail({ tervek: [terv] })))
  assert.ok(html.includes('data-jelenet="1"'))
  assert.ok(html.includes('horog_gyenge'))
  assert.equal(html.includes('<img src=x'), false)
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'))
})

test('propokSzoveg prints every prop but the type, as JSON text', () => {
  assert.equal(propokSzoveg({ tipus: 'szam', szam: 40 }), '{\n  "szam": 40\n}')
  assert.equal(propokSzoveg(null), 'null')
  assert.equal(propokSzoveg(['a']), '[\n  "a"\n]')
})

// --- the bar opens closed, and what the fold may not hide ---

test('the bar is closed on first draw and shows none of the detail', () => {
  const html = render(StatusBar, {
    board: board(), health: health(), healthError: null, managed: { kind: 'ready', schedules: 3 }, onRefresh: noop, rpc: async () => ({}),
  })
  assert.ok(html.includes('aria-expanded="false"'))
  assert.ok(html.includes('rendben'))
  // Not one line of the open bar is in the markup: the fold does not merely
  // hide with CSS, it does not render.
  assert.equal(html.includes('Remotion-könyvtár: rendben'), false)
  assert.equal(html.includes('Uninstall előtt'), false)
  assert.equal(html.includes('Fordulók rögzítése'), false)
})

test('a blocked capability is named on the closed bar, not only behind the fold', () => {
  const html = render(StatusBar, {
    board: board(),
    health: health({ ok: false, hibak: ['npx_hianyzik'], blokkolt: ['render'] }),
    healthError: null, managed: { kind: 'ready', schedules: 3 }, onRefresh: noop, rpc: async () => ({}),
  })
  assert.ok(html.includes('aria-expanded="false"'), 'still closed')
  assert.ok(html.includes('blokkolt: render'), 'and the operator can read what is blocked without opening it')
  assert.ok(html.includes('vid-bad'))
})

test('a blocking code that named no capability still reaches the closed bar', () => {
  const html = render(StatusBar, {
    board: board(),
    health: health({ ok: false, hibak: ['ffmpeg_hianyzik'], blokkolt: [] }),
    healthError: null, managed: { kind: 'ready', schedules: 3 }, onRefresh: noop, rpc: async () => ({}),
  })
  assert.ok(html.includes('ffmpeg_hianyzik'))
  assert.equal(html.includes('rendben'), false, 'a module with a blocking code is never summarised as fine')
})

test('a missing schedule is on the closed bar, because no run will happen until it is fixed', () => {
  const html = render(StatusBar, {
    board: board(), health: health(), healthError: null,
    managed: { kind: 'unscheduled', missing: ['Videó gyártó'], total: 3 }, onRefresh: noop, rpc: async () => ({}),
  })
  assert.ok(html.includes('nincs ütemezés — Reconcile kell'))
})

test('warnings are counted on the closed bar and spelled out only inside', () => {
  const props = {
    board: board(),
    health: health({ figyelmeztetesek: ['signals_szerzodes_hianyzik'], szerzodesek: { tts: null, signals: 'provider_disabled' } }),
    healthError: null, managed: { kind: 'ready', schedules: 3 }, onRefresh: noop, rpc: async () => ({}),
  }
  const zarva = render(StatusBar, props)
  assert.ok(zarva.includes('1 figyelmeztetés'))
  assert.equal(zarva.includes('aisignal.signals: provider_disabled'), false)
  // The same state, opened: the code itself, in the host's words.
  assert.ok(renderStatus(props).includes('aisignal.signals: provider_disabled'))
})

test('a health that could not be read says so on the closed bar', () => {
  const html = render(StatusBar, {
    board: board(), health: null, healthError: 'a szerver 500-zal válaszolt', managed: null, onRefresh: noop, rpc: async () => ({}),
  })
  assert.ok(html.includes('nem tudtam lekérdezni'))
  assert.ok(html.includes('vid-bad'))
})

// --- the status bar keeps the three kinds of fact apart ---

test('the status bar names the Reconcile remedy in its own sentence and class', () => {
  const html = renderStatus({
    board: board(),
    health: health(),
    healthError: null,
    managed: { kind: 'unscheduled', missing: ['Videó gyártó', 'Videó lektor'], total: 3 },
    onRefresh: noop,
    rpc: async () => ({}),
  })
  assert.ok(html.includes('vid-reconcile-warning'))
  assert.ok(html.includes('nincs ütemezés — Reconcile kell'))
  assert.ok(html.includes('Videó gyártó, Videó lektor'))
  // Never worded as an idle module.
  assert.equal(html.includes('ma még nem futott'), false)
})

test('the status bar tells three schedule states apart', () => {
  assert.deepEqual(describeManaged({ kind: 'ready', schedules: 3 }), { text: 'Ütemezés: 3 ütemezés él', trouble: false })
  assert.ok(describeManaged({ kind: 'unknown', reason: 'a host 500-tal válaszolt' }).text.includes('nem tudtam lekérdezni: a host 500-tal válaszolt'))
  assert.equal(describeManaged({ kind: 'unknown', reason: 'x' }).trouble, true)
  assert.equal(describeManaged(null).trouble, false)
  assert.ok(describeManaged(null).text.includes('folyamatban'))
})

test('the status bar repeats a contract refusal in the host words rather than paraphrasing it', () => {
  const html = renderStatus({
    board: board(),
    health: health({ szerzodesek: { tts: 'provider_missing', signals: 'provider_disabled' }, hibak: ['tts_szerzodes_hianyzik'], figyelmeztetesek: ['signals_szerzodes_hianyzik'], blokkolt: ['narracio'], ok: false }),
    healthError: null,
    managed: { kind: 'ready', schedules: 3 },
    onRefresh: noop,
    rpc: async () => ({}),
  })
  assert.ok(html.includes('tts.narration: provider_missing'))
  assert.ok(html.includes('aisignal.signals: provider_disabled'))
  // The blocking one and the limiting one are not drawn alike.
  assert.ok(html.includes('Most blokkolt: narracio'))
  assert.ok(html.includes('a videoOpen kézi forrással megy'))
})

test('the status bar reports a broken install condition by condition, not as one red dot', () => {
  const html = renderStatus({
    board: board(),
    health: health({
      ok: false,
      remotion: { beallitva: true, letezik: true, hianyzoFajlok: ['src/FosVideo.tsx'] },
      eszkozok: { ffmpeg: false, ffprobe: true, npx: true },
      chrome: { konyvtar: false, megjegyzes: 'a node_modules/.remotion könyvtár léte a projektben' },
      platform: 'linux', linuxRenderEngedely: false,
      sorNelkul: 4,
    }),
    healthError: null,
    managed: { kind: 'ready', schedules: 3 },
    onRefresh: noop,
    rpc: async () => ({}),
  })
  assert.ok(html.includes('Remotion-könyvtár: hiányzik: src/FosVideo.tsx'))
  assert.ok(html.includes('ffmpeg hiányzik'))
  assert.ok(html.includes('Chrome Headless Shell: a könyvtár hiányzik'))
  assert.ok(html.includes('Render: ezen a hoston nem indul (linux)'))
  assert.ok(html.includes('4 sor nélküli fájl a két névtérben (az operátoré)'))
  assert.ok(html.includes('reconcile_hianyzik'), 'the code health cannot answer is named, so its absence from hibak is not read as a pass')
})

test('a health that could not be read is drawn as unqueried rather than as calm', () => {
  const html = renderStatus({
    board: board(), health: null, healthError: 'a szerver 500-zal válaszolt', managed: null, onRefresh: noop, rpc: async () => ({}),
  })
  assert.ok(html.includes('Az állapotot nem tudtam lekérdezni: a szerver 500-zal válaszolt'))
  assert.equal(html.includes('Remotion-könyvtár: rendben'), false)
})

test('a running render shows its id and its minutes, and offers the stop button', () => {
  const html = renderStatus({
    board: board({ futoRender: summary({ status: 'fut', finishedAt: null, elteltMs: 7 * 60_000 }) }),
    health: health(), healthError: null, managed: { kind: 'ready', schedules: 3 }, onRefresh: noop, rpc: async () => ({}),
  })
  assert.ok(html.includes('Fut: r1, 7 perce'))
  assert.ok(html.includes('Leállít'))
})

test('the status bar says which turn recorder is on, and the three uninstall steps', () => {
  const mind = renderStatus({ board: board(), health: health({ forduloRogzites: 'mind' }), healthError: null, managed: null, onRefresh: noop, rpc: async () => ({}) })
  assert.ok(mind.includes('Fordulók rögzítése: minden csatolt ügynök, 60 napig'))
  const sajat = renderStatus({ board: board(), health: health(), healthError: null, managed: null, onRefresh: noop, rpc: async () => ({}) })
  assert.ok(sajat.includes('Fordulók rögzítése: csak a modul két ügynöke'))
  assert.ok(sajat.includes('Uninstall előtt'))
  assert.ok(sajat.includes('Tisztítás'))
  assert.ok(sajat.includes('ext_video_ táblákat'))
})

test('a board that could not be read costs the queue and nothing else on the bar', () => {
  // The board is one of three loads and gates neither of the others. What it
  // owns is the running render and the recorded turns, and those say they are
  // unknown; every health line, the schedule sentence and both buttons are
  // still drawn, because that is what an operator needs in order to act on a
  // module whose queue would not load.
  const html = renderStatus({
    board: null, health: health(), healthError: null, managed: { kind: 'unscheduled', missing: ['Videó gyártó'], total: 3 }, onRefresh: noop, rpc: async () => ({}),
  })
  assert.ok(html.includes('Remotion-könyvtár: rendben'), 'the health lines are drawn')
  assert.ok(html.includes('nincs ütemezés — Reconcile kell'), 'the Reconcile warning is drawn')
  assert.ok(html.includes('Uninstall előtt'))
  assert.ok(html.includes('A sort nem sikerült betölteni'), 'and what the missing board costs is named')
  assert.equal(html.includes('Nem fut render.'), false, 'a queue that never loaded is not a claim that nothing is running')
  assert.equal(html.includes('A modul még egyetlen fordulót sem rögzített.'), false, 'nor a claim that no turn was recorded')
})

test('the last turns are labelled as this module own record, not as the host run history', () => {
  const html = renderStatus({
    board: board({ utolsoFordulok: [{ agentId: 'agent:gyarto', forras: 'schedule', at: '2026-09-01T10:00:00.000Z' }] }),
    health: health(), healthError: null, managed: null, onRefresh: noop, rpc: async () => ({}),
  })
  assert.ok(html.includes('A modul fordulói szerint: agent:gyarto schedule'))
})

// --- proposals: caps replace buttons with sentences ---

test('a full lesson cap replaces Elfogad with the sentence naming the refusal code', () => {
  const html = render(JavaslatokBody, {
    data: proposals({
      nyitott: [proposal()],
      sapkak: { ...SAPKAK, tanulsag: { 'agent:gyarto': { db: 12, sapka: 12 } } },
      tanulsagok: { 'agent:gyarto': { db: 12, sapka: 12, tetelek: [] } },
    }),
    videoIdk: new Set(), onOpenVideo: noop, dont: noop, visszavon: noop, dolgozik: false, uzenet: null,
  })
  assert.equal(html.includes('vid-accept'), false)
  assert.ok(html.includes('tanulsag_sapka: 12/12'))
  assert.ok(html.includes('betelt, előbb dönteni kell'))
})

test('a full open cap says so at the top, and never disables the decision that would clear it', () => {
  const html = render(JavaslatokBody, {
    data: proposals({ nyitott: [proposal()], sapkak: { ...SAPKAK, nyitottJavaslat: { db: 20, sapka: 20 } } }),
    videoIdk: new Set(), onOpenVideo: noop, dont: noop, visszavon: noop, dolgozik: false, uzenet: null,
  })
  assert.ok(html.includes('20 nyitott javaslat, előbb dönteni kell'))
  assert.ok(html.includes('vid-accept'), 'deciding is what clears this cap, so it stays available')
  assert.ok(html.includes('Nyitott 20/20'))
})

test('Elutasit is disabled until there is a note, and says why', () => {
  const html = render(JavaslatokBody, {
    data: proposals({ nyitott: [proposal()] }),
    videoIdk: new Set(), onOpenVideo: noop, dont: noop, visszavon: noop, dolgozik: false, uzenet: null,
  })
  assert.ok(/class="vid-btn vid-reject"[^>]*disabled/.test(html) || /disabled[^>]*class="vid-btn vid-reject"/.test(html), 'the reject button is disabled with an empty note')
  assert.ok(html.includes('az elutasításhoz megjegyzés kell'))
})

test('an evidence id becomes a button only when the board knows it as a video', () => {
  const html = render(JavaslatokBody, {
    data: proposals({ nyitott: [proposal({ bizonyitek: ['v1', 'ismeretlen', '<script>x</script>'] })] }),
    videoIdk: new Set(['v1']), onOpenVideo: noop, dont: noop, visszavon: noop, dolgozik: false, uzenet: null,
  })
  assert.ok(html.includes('>v1</button>'))
  assert.ok(html.includes('>ismeretlen</span>'))
  assert.equal(html.includes('<script>x</script>'), false)
  assert.ok(html.includes('&lt;script&gt;x&lt;/script&gt;'))
})

test('the backlog says what each accepted proposal is waiting for', () => {
  const html = render(JavaslatokBody, {
    data: proposals({ backlog: [proposal({ id: 'j2', fajta: 'szabaly', cim: 'Q9' }), proposal({ id: 'j3', fajta: 'sablon', cim: 'uj-tipus' })] }),
    videoIdk: new Set(), onOpenVideo: noop, dont: noop, visszavon: noop, dolgozik: false, uzenet: null,
  })
  assert.ok(html.includes('kódolásra vár'))
  assert.ok(html.includes('a kitre vár'))
})

test('the active lessons show their per-target counter and a Visszavon beside each', () => {
  const html = render(JavaslatokBody, {
    data: proposals({ tanulsagok: { 'agent:gyarto': { db: 9, sapka: 12, tetelek: [{ id: 't1', javaslatId: 'j1', szoveg: 'Egy tanulság.', createdAt: '2026-09-01T10:00:00.000Z' }] } } }),
    videoIdk: new Set(), onOpenVideo: noop, dont: noop, visszavon: noop, dolgozik: false, uzenet: null,
  })
  assert.ok(html.includes('agent:gyarto (9/12)'))
  assert.ok(html.includes('vid-lesson'))
  assert.ok(html.includes('Visszavon'))
})

test('sapkaBetelt is inclusive, because the server refuses at the cap and not past it', () => {
  assert.equal(sapkaBetelt(11, 12), false)
  assert.equal(sapkaBetelt(12, 12), true)
  assert.equal(sapkaBetelt(13, 12), true)
  assert.equal(sapkaBetelt(undefined, 12), false)
})

// --- templates: two sentinels, and a catalogue that could not be read ---

/**
 * The gallery half owns state -- the filter, the open card, the pictures as
 * they arrive, the run -- and a server render runs no effect, so these pass
 * that state as props to the body, the same split `StatusBarBody` uses.
 */
const renderSablonok = (props) => render(SablonokBody, {
  health: null, allapot: null, allapotHiba: null, szuro: URES_SZURO, onSzuro: noop,
  kepek: {}, futasHibak: {}, nyitott: null, onNyit: noop,
  onGeneral: noop, onMegszakit: noop, dolgozik: false, uzenet: null, onUzenetZar: noop,
  ...props,
})

function templatesData(overrides = {}) {
  return {
    hiba: null, katalogusHash: 'k1', sablonStat: {}, hetiSor: [],
    tipusok: KATALOGUS.tipusok, leirasok: KATALOGUS.leirasok, propok: KATALOGUS.propok,
    kozosPropok: KATALOGUS.kozosPropok, kuldhetoTipusok: KATALOGUS.tipusok,
    nemKuldhetoTipusok: [], mintaHianyzik: [], tablaHianyok: [],
    ...overrides,
  }
}

function elonezetAllapot(overrides = {}) {
  return {
    hiba: null, katalogusHash: 'k1', katalogusTipusok: KATALOGUS.tipusok,
    meglevo: [], hianyzo: KATALOGUS.tipusok, mintaNelkul: [], fut: null, ...overrides,
  }
}

const kartyaDb = (html) => html.split('data-tipus="').length - 1

test('the template table prints the two sentinels as the words they are', () => {
  const html = renderSablonok({
    data: templatesData({
      sablonStat: { cimlap: { hasznalat: 3, lektoriTalalat: { horog_gyenge: 2 }, qaBukas: 'nincs_idokodos_szabaly', visszajelzes: 1, megtartas: 'meretlen' } },
    }),
  })
  assert.ok(html.includes('nincs_idokodos_szabaly'))
  assert.ok(html.includes('meretlen'))
  assert.ok(html.includes('horog_gyenge ×2'))
  // No zero stands in for either sentinel.
  assert.ok(html.includes('<td>3</td>'))
})

test('a catalogue that could not be read shows its code and no grid, and keeps the weekly row', () => {
  const html = renderSablonok({
    data: templatesData({
      hiba: 'remotion_dir_hianyzik', katalogusHash: null, sablonStat: null,
      hetiSor: [{ het: '2026-W36', renderek: 2, qaBukas: 1, lektoriTalalat: { horog_gyenge: 1 } }],
      tipusok: null, leirasok: null, propok: null, kozosPropok: null,
      kuldhetoTipusok: null, nemKuldhetoTipusok: null, mintaHianyzik: null, tablaHianyok: null,
    }),
  })
  assert.ok(html.includes('remotion_dir_hianyzik'))
  assert.ok(html.includes('Katalógus nélkül nincs típusonkénti táblázat'))
  assert.ok(html.includes('2026-W36'), 'the weekly row comes from stored rows and answers without the project')
  assert.equal(kartyaDb(html), 0)
  // The refusal code and the counter together are what keep this state
  // apart from a filter nobody matched.
  // `?`, not 0: nobody counted the kit's types, and `0/0` would say it has
  // none -- the same rule as `meretlen` and the `?` on a card's use count.
  assert.ok(html.includes('0/? típus látszik'))
  assert.ok(!html.includes('Egy típus sem felel meg'))
})

test('the grid draws all twenty-four types and the counter follows a filter that narrows', () => {
  const teljes = renderSablonok({ data: templatesData({ nemKuldhetoTipusok: ['osszegzes'] }) })
  assert.equal(kartyaDb(teljes), 24)
  assert.ok(teljes.includes('24/24 típus látszik'))
  // The one thing a card says about the kit table, and it says it once.
  assert.equal(teljes.split('<span class="vid-sablon-jel vid-warn">nem küldhető</span>').length - 1, 1)

  const szukitve = renderSablonok({ data: templatesData(), szuro: { ...URES_SZURO, kereses: 'átvezető' } })
  assert.equal(kartyaDb(szukitve), 1)
  assert.ok(szukitve.includes('1/24 típus látszik'))

  // An empty grid is never silent: the count says the catalogue has 24 and
  // the sentence says the filters are what hid them.
  const semmi = renderSablonok({ data: templatesData(), szuro: { ...URES_SZURO, kereses: 'nincs-ilyen' } })
  assert.equal(kartyaDb(semmi), 0)
  assert.ok(semmi.includes('0/24 típus látszik'))
  assert.ok(semmi.includes('Egy típus sem felel meg a szűrőknek'))
})

test('nincs_minta stands on the card as missing dictionary data, not as a failure', () => {
  const html = renderSablonok({
    data: templatesData(),
    allapot: elonezetAllapot({ mintaNelkul: ['gorbe'] }),
    kepek: { gorbe: { kind: 'nincs', ok: 'nincs_minta' } },
  })
  assert.ok(html.includes('nincs_minta'))
  const keret = html.slice(html.indexOf('nincs_minta') - 120, html.indexOf('nincs_minta'))
  assert.ok(keret.includes('vid-muted'), 'the frame is muted, not the failure colour')
  assert.ok(!keret.includes('vid-bad'))
  assert.ok(!html.includes('role="alert"'), 'a type without a sample is not an alert')
})

test('a picture arrives as the data url it is, and a card that has none says which of the reasons', () => {
  const html = renderSablonok({
    data: templatesData(),
    allapot: elonezetAllapot({ meglevo: ['cimlap'] }),
    kepek: {
      cimlap: { kind: 'kep', dataUrl: 'data:image/png;base64,AAAA' },
      lista: { kind: 'hiba', szoveg: 'remotion_dir_hianyzik' },
    },
  })
  assert.ok(html.includes('src="data:image/png;base64,AAAA"'))
  // No file: link and no second http route: the picture is the rpc answer.
  assert.ok(!html.includes('file:'))
  assert.ok(html.includes('remotion_dir_hianyzik'))
  assert.ok(html.includes('nincs kép'), 'the twenty-two cards nobody asked about say so rather than showing an empty box')
})

test('a failure of one type sits on its own card with the exit code, and the other cards are unaffected', () => {
  const html = renderSablonok({
    data: templatesData(),
    allapot: elonezetAllapot(),
    futasHibak: { szam: { kod: 'kilepesi_kod', kilepesiKod: 3 }, gorbe: { kod: 'idotullepes' } },
  })
  assert.ok(html.includes('kilepesi_kod (kilépési kód: 3)'))
  assert.ok(html.includes('idotullepes'))
  assert.equal(kartyaDb(html), 24)
})

test('the generate button names how many are missing and is dark when the catalogue or npx is', () => {
  const jo = renderSablonok({ data: templatesData(), allapot: elonezetAllapot(), health: health() })
  assert.ok(jo.includes('Előnézetek generálása (24 hiányzik)'))
  assert.ok(!/<button[^>]*disabled[^>]*>Előnézetek/.test(jo))

  const npxNelkul = renderSablonok({
    data: templatesData(), allapot: elonezetAllapot(),
    health: health({ eszkozok: { ffmpeg: true, ffprobe: true, npx: false }, hibak: ['npx_hianyzik'], blokkolt: ['render'] }),
  })
  assert.ok(/<button[^>]*disabled[^>]*>Előnézetek/.test(npxNelkul))
  assert.ok(npxNelkul.includes('npx_hianyzik'))

  const katalogusNelkul = renderSablonok({
    data: templatesData({ hiba: 'remotion_dir_hianyzik', sablonStat: null, tipusok: null }),
    allapot: elonezetAllapot({ hiba: 'remotion_dir_hianyzik', hianyzo: null }),
    health: health(),
  })
  assert.ok(/<button[^>]*disabled[^>]*>Előnézetek/.test(katalogusNelkul))
  assert.ok(katalogusNelkul.includes('A generálás katalógus nélkül nem indulhat.'))
})

test('the generate button follows the measured blocker rather than one hand-listed code', () => {
  // A fresh install: npx resolves, `node_modules/.remotion` does not exist.
  // `health.mjs` declares `chrome_hianyzik` a render blocker and the status
  // bar prints `Most blokkolt: render`; the button two rows below it must not
  // spawn twenty-four runs that each fail.
  const chromeNelkul = renderSablonok({
    data: templatesData(), allapot: elonezetAllapot(),
    health: health({ ok: false, chrome: { konyvtar: false, megjegyzes: 'x' }, hibak: ['chrome_hianyzik'], blokkolt: ['render'] }),
  })
  assert.ok(/<button[^>]*disabled[^>]*>Előnézetek/.test(chromeNelkul))
  assert.ok(chromeNelkul.includes('chrome_hianyzik'), 'and names the failing check rather than going dark in silence')

  const nemMac = renderSablonok({
    data: templatesData(), allapot: elonezetAllapot(),
    health: health({ ok: false, platform: 'linux', hibak: ['platform_nem_mac'], blokkolt: ['render'] }),
  })
  assert.ok(/<button[^>]*disabled[^>]*>Előnézetek/.test(nemMac))
  assert.ok(nemMac.includes('platform_nem_mac'))

  // A blocker that stops something else does NOT stop this button: the fact
  // read is `render`, not "health has an error".
  const csakNarracio = renderSablonok({
    data: templatesData(), allapot: elonezetAllapot(),
    health: health({ ok: false, hibak: ['tts_szerzodes_hianyzik'], blokkolt: ['narracio'] }),
  })
  assert.ok(!/<button[^>]*disabled[^>]*>Előnézetek/.test(csakNarracio))
})

test('a running generation replaces the button with where it got to and a way to stop it', () => {
  const html = renderSablonok({
    data: templatesData(),
    allapot: elonezetAllapot({
      hianyzo: KATALOGUS.tipusok.slice(6),
      fut: { katalogusHash: 'k1', osszes: 24, kesz: KATALOGUS.tipusok.slice(0, 6), hibak: {}, megszakitva: false, indultAt: '2026-09-05T10:00:00.000Z' },
    }),
    health: health(),
  })
  assert.ok(html.includes('6/24 — cta'), 'the numbers, and the type the run is on')
  assert.ok(html.includes('Megszakít'))
  assert.ok(!html.includes('Előnézetek generálása'))
})

test('the detail panel draws a prop line only when `mit` is a sentence, whatever the generated catalogue put there', () => {
  const html = renderSablonok({
    data: templatesData({
      propok: {
        ...KATALOGUS.propok,
        cimlap: [
          { nev: 'sorok', kotelezo: true },
          { nev: 'hatter', kotelezo: false, mit: 'A háttér.' },
          // `katalogus.generated.json` is written by the other repository and
          // neither `propLista` nor `isProp` type-checks `mit`, so a null and
          // a number are one JSON edit away from this panel. Neither is a
          // sentence, and a line that prints one is a false statement about
          // the kit -- the same fault as printing `undefined`, one value over.
          { nev: 'ures', kotelezo: true, mit: '' },
          { nev: 'nullas', kotelezo: true, mit: null },
          { nev: 'szamos', kotelezo: false, mit: 42 },
        ],
      },
      sablonStat: { cimlap: { hasznalat: 3, lektoriTalalat: {}, qaBukas: 'nincs_idokodos_szabaly', visszajelzes: 0, megtartas: 'meretlen' } },
    }),
    nyitott: 'cimlap',
  })
  // The rule is not "the word undefined never appears": it is that a line
  // carries the catalogue's sentence, or it stops after the name.
  assert.ok(html.includes('<li>sorok (kötelező)</li>'))
  assert.ok(html.includes('<li>ures (kötelező)</li>'))
  assert.ok(html.includes('<li>nullas (kötelező)</li>'))
  assert.ok(html.includes('<li>szamos (opcionális)</li>'))
  assert.ok(html.includes('hatter (opcionális) — A háttér.'))
  assert.ok(!html.includes('— undefined'))
  assert.ok(!html.includes('— null'))
  assert.ok(!html.includes('— 42'))
  assert.ok(html.includes('lathatoHossz'), 'the common props are on the panel too')
})

test('the progress line drops the name when the run and the status describe different kits', () => {
  const kozos = {
    data: templatesData(),
    health: health(),
  }
  const fut = { katalogusHash: 'k1', osszes: 24, kesz: KATALOGUS.tipusok.slice(0, 6), hibak: {}, megszakitva: false, indultAt: '2026-09-05T10:00:00.000Z' }

  // The catalogue changed under a run: `hianyzo` is recomputed from disk on
  // every poll and now describes another kit, so the name it would give is
  // wrong for the whole remaining run, not for one poll.
  const masKatalogus = renderSablonok({
    ...kozos,
    allapot: elonezetAllapot({ katalogusHash: 'k2', hianyzo: KATALOGUS.tipusok.slice(6), fut }),
  })
  assert.ok(masKatalogus.includes('6/24'), 'the numbers are the run own and stay')
  assert.ok(!masKatalogus.includes('6/24 — '), 'and no name is invented beside them')

  // A status that could not read the catalogue at all is the same case.
  const hashNelkul = renderSablonok({
    ...kozos,
    allapot: elonezetAllapot({ hiba: 'remotion_dir_hianyzik', katalogusHash: null, hianyzo: null, fut }),
  })
  assert.ok(hashNelkul.includes('6/24'))
  assert.ok(!hashNelkul.includes('6/24 — '))
})

test('a filter that cannot narrow says which fact it lacks, rather than being a grey box', () => {
  // Every list null: the kit table, the use counts and the preview state are
  // all unmeasured, and `sablon-szuro.ts` promises the view says so.
  const html = renderSablonok({
    data: templatesData({ kuldhetoTipusok: null, sablonStat: null }),
    allapot: null,
  })
  const selectek = html.match(/<select[^>]*>/g)
  assert.equal(selectek.length, 3)
  assert.ok(selectek.every((tag) => tag.includes('disabled=""')), 'all three are dark')
  assert.ok(html.includes('a kit-tábla nem olvasható, így erre nem lehet szűrni'))
  assert.ok(html.includes('katalógus nélkül nincs használati szám, így erre nem lehet szűrni'))
  assert.ok(html.includes('az előnézetek állapota még nem ismert, így erre nem lehet szűrni'))
  // The same words on the control itself, for a pointer rather than a reader.
  assert.equal(html.split('title="a kit-tábla nem olvasható').length - 1, 1)

  // And when the facts are there, no control is dark and no sentence is drawn.
  const meres = renderSablonok({ data: templatesData(), allapot: elonezetAllapot(), health: health() })
  assert.ok(meres.match(/<select[^>]*>/g).every((tag) => !tag.includes('disabled')))
  assert.ok(!meres.includes('nem lehet szűrni'))
})

test('the button muted by an in-flight start says so, like the other three reasons', () => {
  const html = renderSablonok({
    data: templatesData(), allapot: elonezetAllapot(), health: health(), dolgozik: true,
  })
  assert.ok(/<button[^>]*disabled[^>]*>Előnézetek/.test(html))
  assert.ok(html.includes('Az indítás elment, a válaszra várok.'), 'a dark control on this page always says why')
})

test('the notice can be put away, the same way the status bar own notice can', () => {
  const html = renderSablonok({
    data: templatesData(), allapot: elonezetAllapot(), health: health(),
    uzenet: 'Már fut egy generálás; ez a kérés nem állt sorba.',
  })
  assert.ok(html.includes('Már fut egy generálás'))
  const ertesites = html.slice(html.indexOf('vid-notice'), html.indexOf('vid-notice') + 400)
  assert.ok(ertesites.includes('Elrejt'), 'a line nothing retracts would stay up for the rest of the session')
})

test('readPreviewCancel honours the one field the contract has', () => {
  assert.equal(readPreviewCancel({ megszakitva: true }).megszakitva, true)
  // Nothing was running: the click stopped nothing, and `true` here would
  // report an act that did not happen.
  assert.equal(readPreviewCancel({ megszakitva: false }).megszakitva, false)
  // A shape this page cannot trust reads as "nothing was stopped".
  assert.equal(readPreviewCancel({}).megszakitva, false)
  assert.equal(readPreviewCancel({ megszakitva: 'igen' }).megszakitva, false)
})

test('csakKepek keeps the pictures a run produced and drops what it has to ask again for', () => {
  const elotte = {
    cimlap: { kind: 'kep', dataUrl: 'data:image/png;base64,AAAA' },
    lista: { kind: 'toltes' },
    szam: { kind: 'nincs', ok: 'nincs_kep' },
    gorbe: { kind: 'hiba', szoveg: 'remotion_dir_hianyzik' },
  }
  assert.deepEqual(Object.keys(csakKepek(elotte)), ['cimlap'])
  // A pure updater: it reads its argument and writes nothing.
  assert.deepEqual(Object.keys(elotte).sort(), ['cimlap', 'gorbe', 'lista', 'szam'])
  assert.notEqual(csakKepek(elotte), elotte)
})

/**
 * The crude guard, and it is crude on purpose.
 *
 * The observer, the two-second poll and the post-run pruning need a DOM and
 * there is none here; a `renderToStaticMarkup` test runs no effect, so a test
 * asserting "nothing was called" would pass over a regression as happily as
 * over the fix. What CAN be read without a browser is the source, and the one
 * regression worth catching that way is a `templatePreviewStart` that moved
 * into an effect: opening the page would then spend forty seconds of the
 * operator's machine on twenty-four headless browsers nobody asked for.
 */
test('opening the gallery cannot start a generation: templatePreviewStart is called once, and from no effect', () => {
  const src = readFileSync(path.join(root, 'ui/sablonok.tsx'), 'utf8')
  const sorok = src.split('\n')
  const hivasok = sorok.map((sor, i) => [sor, i]).filter(([sor]) => sor.includes("'templatePreviewStart'"))
  assert.equal(hivasok.length, 1, 'exactly one call site')

  // The hook it sits in is the nearest one opened above it, and it must be a
  // `useCallback` -- a handler the operator presses -- and never a `useEffect`,
  // which the page runs by itself on open.
  const [, sorszam] = hivasok[0]
  const hookok = sorok.slice(0, sorszam).filter((sor) => /use(Effect|Callback)\(/.test(sor))
  assert.ok(hookok.at(-1).includes('useCallback('), 'the call belongs to a handler, not to an effect')

  // And no state updater on this page writes a ref: React 19 StrictMode
  // double-invokes updaters, so a side effect in one runs twice.
  for (const [i, sor] of sorok.entries()) {
    if (!sor.includes('setKepek((')) continue
    const blokk = sorok.slice(i, i + 12).join('\n')
    assert.ok(!/Ref\.current\s*=/.test(blokk), `a state updater writes a ref at line ${i + 1}`)
  }
})

test('catalogue prose is a stranger text and arrives as text, tags and all', () => {
  const html = renderSablonok({
    data: templatesData({ leirasok: { ...KATALOGUS.leirasok, cimlap: '<script>alert(1)</script>' } }),
  })
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'))
  assert.ok(!html.includes('<script>'))
})

test('the three preview readers honour hiba and ok as the two different facts they are', () => {
  // Absent `ok` is success and is not tested for falsiness.
  const kep = readTemplatePreview({ dataUrl: 'data:image/png;base64,AAAA', hiba: null })
  assert.equal(kep.dataUrl, 'data:image/png;base64,AAAA')
  assert.equal(kep.ok, null)
  assert.equal(readTemplatePreview({ dataUrl: null, ok: 'nincs_minta', hiba: null }).ok, 'nincs_minta')
  assert.equal(readTemplatePreview({ dataUrl: null, hiba: 'remotion_dir_hianyzik' }).hiba, 'remotion_dir_hianyzik')
  // Only a png data url may reach an <img src>; anything else is refused by name.
  const hamis = readTemplatePreview({ dataUrl: 'javascript:alert(1)', hiba: null })
  assert.equal(hamis.dataUrl, null)
  assert.equal(hamis.ok, 'nem_kep')

  assert.equal(readPreviewStart({ indult: false, ok: 'mar_fut', hiba: null }).ok, 'mar_fut')
  assert.equal(readPreviewStart({ indult: true, hiba: null }).ok, null)
  assert.equal(readPreviewStart({ indult: false, hiba: 'remotion_dir_hianyzik' }).hiba, 'remotion_dir_hianyzik')

  // Beside a refusal code every catalogue-derived list is null, never [],
  // and the run still answers because it does not live in the project.
  const vak = readPreviewStatus({
    hiba: 'remotion_dir_hianyzik', katalogusHash: null, katalogusTipusok: null, meglevo: null, hianyzo: null, mintaNelkul: null,
    fut: { katalogusHash: 'k1', osszes: 2, kesz: ['cimlap'], hibak: { szam: { kod: 'idotullepes' } }, megszakitva: false, indultAt: 'x' },
  })
  assert.equal(vak.hianyzo, null)
  assert.equal(vak.meglevo, null)
  assert.deepEqual(vak.fut.kesz, ['cimlap'])
  assert.equal(vak.fut.hibak.szam.kod, 'idotullepes')
  assert.equal(readPreviewStatus({ hiba: null, fut: null, meglevo: [], hianyzo: ['szam'] }).fut, null)
})

test('megtartasSzoveg keeps the sign and passes the word through', () => {
  assert.equal(megtartasSzoveg(0.12), '+0.120')
  assert.equal(megtartasSzoveg(-0.05), '-0.050')
  assert.equal(megtartasSzoveg('meretlen'), 'meretlen')
})

test('formatMs says ? for a length nobody measured rather than 0', () => {
  assert.equal(formatMs(1500), '1.5 mp')
  assert.equal(formatMs(90_000), '1:30')
  assert.equal(formatMs(null), '?')
  assert.equal(formatMs(undefined), '?')
  assert.equal(formatMs(Number.NaN), '?')
})

// --- the schedule check: three states, and a failure that is its own state ---

test('loadManagedStatus reports a refusal as unknown rather than as unscheduled', async () => {
  const asked = []
  const ok = await loadManagedStatus(async (url) => {
    asked.push(url)
    return { ok: true, status: 200, json: async () => ({ extensions: [{ extensionId: 'video.mjs', schedules: [{ status: 'resolved' }, { status: 'resolved' }, { status: 'resolved' }] }] }) }
  }, 'video.mjs')
  assert.deepEqual(asked, [MANAGED_RESOURCES_URL])
  assert.deepEqual(ok, { kind: 'ready', schedules: 3 })

  const missing = await loadManagedStatus(async () => ({
    ok: true, status: 200,
    json: async () => ({ extensions: [{ extensionId: 'video.mjs', schedules: [{ status: 'resolved' }, { status: 'missing', displayName: 'Videó lektor' }] }] }),
  }), 'video.mjs')
  assert.deepEqual(missing, { kind: 'unscheduled', missing: ['Videó lektor'], total: 2 })

  const refused = await loadManagedStatus(async () => ({ ok: false, status: 403, json: async () => ({}) }), 'video.mjs')
  assert.deepEqual(refused, { kind: 'unknown', reason: 'a host 403-tal válaszolt' })

  const threw = await loadManagedStatus(async () => { throw new Error('offline') }, 'video.mjs')
  assert.deepEqual(threw, { kind: 'unknown', reason: 'offline' })
})

test('readManagedStatus refuses a summary that does not name this extension', () => {
  assert.throws(() => readManagedStatus({ extensions: [] }, 'video.mjs'), /nem tartalmazza ezt az extensiont/)
  assert.throws(() => readManagedStatus({ extensions: [{ extensionId: 'video.mjs', schedules: [] }] }, 'video.mjs'), /egyetlen ütemezést sem deklarál/)
})
