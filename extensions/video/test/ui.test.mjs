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

import { readBoard, readHealth, readManagedStatus, readPreviewCancel, readPreviewStart, readPreviewStatus, readProposals, readTemplatePreview, readTemplates, readVideo, readYoutubeOtletek, refusalText } from '../ui/api.ts'
import { bundle } from '../scripts/build.mjs'
import { describeManaged, formatMs, megtartasSzoveg, propokSzoveg, sapkaBetelt, statusLabel } from '../ui/format.ts'
import { pixelbolMs, pontbolJelenet, szazalek, teljesHossz } from '../ui/idovonal-state.ts'
import { JavaslatokBody } from '../ui/javaslatok.tsx'
import { VideoPage } from '../ui/main.tsx'
import { MANAGED_RESOURCES_URL, loadManagedStatus } from '../ui/managed-state.ts'
import { URES_SZURO, normal, szurtTipusok } from '../ui/sablon-szuro.ts'
import { SablonokBody, csakKepek, katalogusElavult } from '../ui/sablonok.tsx'
import { Sor, UjVideoBody, YoutubeOtletekBody, otletMondatok } from '../ui/sor.tsx'
import { StatusBar, StatusBarBody } from '../ui/status-bar.tsx'
import { GYARTO_NEV, LEKTOR_NEV, VideoBody, VideoView, megrendelesHiba } from '../ui/video.tsx'
import { AGENTS } from '../src/agents.mjs'
import { AGENTS_URL, CHATS_URL, rendelj } from '../ui/megrendeles.ts'

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

/**
 * The stateful halves, driven -- because markup alone cannot see a handler.
 *
 * WHY THIS EXISTS. `renderToStaticMarkup` pins what a state LOOKS like and
 * nothing else: it runs no effect and no click, so `VideoView.onNarral`,
 * `UjVideo.onKuld` and `onRenderel` were code no test had ever executed. What
 * they decide is the rule this whole view turns on -- a resolved answer
 * carrying `hiba` is a refusal, a resolved answer without one is the act, and
 * a REJECTED promise is a third fact -- and reading it wrong prints "elkészült"
 * over a module that refused. That has to be driven, not inspected.
 *
 * WHY NOT A DOM. This module's devDependencies are esbuild, playwright, react,
 * react-dom and tsx; there is no jsdom, and `react-dom/client` needs a real
 * one. Adding a DOM to run four handlers would be a heavier dependency than
 * the thing under test. So the component function is called directly with a
 * hand-written hook dispatcher: `useState` gets a cell and a setter that
 * re-renders, `useCallback`/`useMemo` memoise on their deps exactly as React's
 * do (without that, an effect keyed on a callback would re-fire forever), and
 * `useEffect` runs after the render with its predecessor's cleanup called
 * first. React is pinned to one version in this module's devDependencies, and
 * the dispatcher slot is where that version dispatches every hook.
 *
 * WHAT THIS IS NOT. There is no reconciler here: a child element is not
 * mounted by its parent, so a subtree's state and a `key` change are not
 * modelled. `mount` returns the ELEMENT TREE the component produced, and the
 * tests read a child's props out of it -- which is also how they reach a
 * handler to call. Where a test is about reconciliation, it says so and pins
 * the element identity React would reconcile on.
 */
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
    // A render that sets state that renders again is how these components
    // work; one that never stops is a bug, and this says so instead of hanging
    // the test run.
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

/** The first element in a rendered tree that matches, or null. Children only: props are otherwise opaque. */
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

/** The props a mounted component handed to one of its children -- read fresh, because every re-render makes new ones. */
const childProps = (mounted, Child) => {
  const el = findElement(mounted.tree(), (n) => n.type === Child)
  assert.ok(el !== null, 'the component did not render the child this test reads')
  return el.props
}

/** A `.then(...).finally(...)` chain, and the re-render it triggers, need more than one turn of the loop to settle. */
const settle = async () => { for (let n = 0; n < 4; n += 1) await new Promise((resolve) => { setImmediate(resolve) }) }
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

/** What `Sor` needs now that it also carries the manual open box. `rpc` is never called in a server render: nothing there submits the form. */
const sorProps = (overrides = {}) => ({ board: board(), onOpen: noop, rpc: noop, onNyitva: noop, ...overrides })

/** One plan version. `tervHash` is what a verdict and a narration row are both keyed on, so it is a field these tests move. */
function terv(overrides = {}) {
  return {
    id: 't1', verzio: 1, jelenetek: [{ tipus: 'cimlap', sorok: ['Egy'] }], narracio: [{ jelenet: 0, szoveg: 'Első mondat.' }],
    assetUjjlenyomatok: {}, tervHash: 'h1', katalogusHash: 'k1', szerzoAgentId: 'agent:gyarto', ellenorzes: {},
    createdAt: '2026-09-01T10:00:00.000Z', verdiktek: [], narraciok: [], ...overrides,
  }
}

function verdikt(overrides = {}) {
  return { id: 'vd1', verdikt: 'atmegy', tervHash: 'h1', lektorAgentId: 'agent:lektor', talalatok: [], at: '2026-09-01T11:00:00.000Z', ...overrides }
}

function narracioSor(overrides = {}) {
  return { jelenet: 0, fajl: 'narracio/v1/h1/0.mp3', hosszMs: 1200, hang: 'anna', modell: 'm', nyelv: 'hu', tervHash: 'h1', szovegHash: 'sz1', ...overrides }
}

/** A render row as the `video` response carries it, which is the summary plus the four detail fields. */
function renderSor(overrides = {}) {
  return { ...summary(overrides), tervId: 't1', jelenetHatarok: [], propsPath: null, torolveAt: null }
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
      // An at-rule's prelude -- `@media (min-width: 1080px)` -- is not a
      // selector and selects nothing. Skipping it costs the guard nothing:
      // the rules nested inside the block are followed by their own `{` and
      // are therefore checked by this same loop, so a selector cannot escape
      // `.vid-` by hiding in a media query.
      if (trimmed.startsWith('@')) continue
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
  const rossz = readTemplates({ hiba: null, sablonStat: {}, hetiSor: [], tipusok: ['cimlap'], propok: 'nem objektum', kozosPropok: 3, tablaHianyok: [1] })
  assert.deepEqual(rossz.tipusok, ['cimlap'])
  assert.equal(rossz.propok, null)
  assert.equal(rossz.kozosPropok, null)
  assert.equal(rossz.tablaHianyok, null, 'a list of something other than type names is not a list of type names')
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

test('refusalText tells a refusal from an answer, and names the one it found', () => {
  // `nyit`, `narral` and `renderel` resolve with their refusals rather than
  // throwing them, so a resolved promise is not proof that anything happened.
  assert.equal(refusalText({ hiba: 'napi_sapka', uzenet: 'ma már 1 videó nyílt; a napi sapka 1' }), 'napi_sapka: ma már 1 videó nyílt; a napi sapka 1')
  // The code first: it is what the operator can look up and quote.
  assert.ok(refusalText({ hiba: 'verdikt_hianyzik', uzenet: 'x' }).startsWith('verdikt_hianyzik'))
  // An answer with no `hiba` is the act having happened, not a refusal.
  assert.equal(refusalText({ videoId: 'v2', cim: 'Egy cím' }), null)
  assert.equal(refusalText({ renderId: 'r1', status: 'fut' }), null)
  // A code with no sentence is still a refusal, and says which code it is.
  assert.equal(refusalText({ hiba: 'ismeretlen_hiba' }), 'ismeretlen_hiba (a modul nem küldött hozzá mondatot)')
  // Not an object: a shape this page cannot read is not a success it may
  // report as one.
  assert.equal(refusalText('kesz'), 'valasz_ervenytelen: a modul nem objektummal válaszolt erre a hívásra')
  assert.equal(refusalText(null), 'valasz_ervenytelen: a modul nem objektummal válaszolt erre a hívásra')
})

// --- the queue draws a stranger's title as text ---

test('the Sor draws a card title as text, script tags and all, and never as markup', () => {
  const html = render(Sor, sorProps({ board: board({ oszlopok: { nyitott: [], terv: [card({ cim: '<script>alert(1)</script>' })], lezart: [] } }) }))
  assert.equal(html.includes('<script>'), false)
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'))
  assert.ok(html.includes('data-video-id="v1"'))
  // Empty columns are named rather than dropped.
  assert.ok(html.includes('Üres:'))
  assert.ok(html.includes('Nyitott javaslatok: 4/20'))
})

test('the Sor keeps four card facts apart rather than folding them into one', () => {
  const html = render(Sor, sorProps())
  assert.ok(html.includes('lektorálva: még nem'))
  assert.ok(html.includes('render: még nem indult'))
  assert.ok(html.includes('QA: nincs érvényes sor'))
  const bukott = render(Sor, sorProps({
    board: board({ oszlopok: { nyitott: [], terv: [card({ qa: { ok: false, bukasok: ['Q4', 'Q6'] }, render: summary({ status: 'hiba', hiba: { kod: 'render_idotullepes', szoveg: null } }) })], lezart: [] } }),
  }))
  assert.ok(bukott.includes('QA: bukott (Q4, Q6)'))
  assert.ok(bukott.includes('render_idotullepes'))
})

test('statusLabel names a status it knows and flags one it does not', () => {
  assert.deepEqual(statusLabel('qa_hiba'), { label: 'QA-hiba', known: true })
  assert.deepEqual(statusLabel('valami_uj'), { label: 'valami_uj', known: false })
  assert.deepEqual(statusLabel(''), { label: '(üres státusz)', known: false })
  assert.deepEqual(statusLabel(undefined), { label: '(üres státusz)', known: false })
})

// --- the queue offers the one manual step: opening a video ---

const ujVideoProps = (overrides = {}) => ({
  forrasSzoveg: '', cim: '', kuldes: false, uzenet: null, onForras: noop, onCim: noop, onKuld: noop, ...overrides,
})

test('the Uj video box refuses an empty source and says so beside the button', () => {
  const ures = render(UjVideoBody, ujVideoProps())
  assert.ok(/<button[^>]*disabled[^>]*>Új videó/.test(ures))
  assert.ok(ures.includes('Forrás szöveg nélkül nem nyílik videó.'))

  const van = render(UjVideoBody, ujVideoProps({ forrasSzoveg: 'Egy hír a hétről.' }))
  assert.equal(/<button[^>]*disabled[^>]*>Új videó/.test(van), false)
  assert.equal(van.includes('Forrás szöveg nélkül'), false)

  // Whitespace is not a source text either, and the sentence is the same one.
  const szokoz = render(UjVideoBody, ujVideoProps({ forrasSzoveg: '   \n  ' }))
  assert.ok(/<button[^>]*disabled[^>]*>Új videó/.test(szokoz))

  const uton = render(UjVideoBody, ujVideoProps({ forrasSzoveg: 'Egy hír.', kuldes: true }))
  assert.ok(/<button[^>]*disabled[^>]*>Új videó/.test(uton))
  assert.ok(uton.includes('A nyitás elment, a válaszra várok.'))
})

test('the Uj video box prints the module own answer as text, markup and all', () => {
  // The sentence carries a refusal code and the module's own message, and a
  // message can quote what the operator pasted.
  const html = render(UjVideoBody, ujVideoProps({ uzenet: 'A videó nem nyílt meg — forras: <b>rossz</b>' }))
  assert.equal(html.includes('<b>rossz</b>'), false)
  assert.ok(html.includes('&lt;b&gt;rossz&lt;/b&gt;'))
  assert.ok(html.includes('forras:'), 'the refusal arrives named, never as "sikertelen"')
})

test('the Sor offers the manual open, and the empty-queue sentence names it', () => {
  const html = render(Sor, sorProps({ board: board({ oszlopok: { nyitott: [], terv: [], lezart: [] } }) }))
  assert.ok(html.includes('Új videó'))
  assert.ok(html.includes('Egyetlen videó sincs a sorban'))
  assert.ok(html.includes('vagy amikor te nyitsz egyet'), 'a queue that says only agents open videos is now false')
})

// --- the video view: a stranger's source, and the one link ---

const videoProps = (video, overrides = {}) => ({
  video, pont: { atMs: '', jelenet: '' }, szoveg: '', kuldes: false, uzenet: null,
  narralas: false, renderInditas: false, tervRendeles: null, lektorRendeles: null,
  onPick: noop, onSzoveg: noop, onAtMs: noop, onJelenet: noop, onKuld: noop, onLezar: noop, onBack: noop,
  onNarral: noop, onRenderel: noop, onTervKeres: noop, onLektorKeres: noop, onFrissit: noop, ...overrides,
})

const narracioSotet = /<button[^>]*disabled[^>]*>Narráció kérése/
const renderSotet = /<button[^>]*disabled[^>]*>Render indítása/

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

// --- the two mechanical levers on the video view ---

test('Narracio kerese is live exactly when the plan has a passing verdict on its current hash', () => {
  const html = render(VideoBody, videoProps(videoDetail({ tervek: [terv({ verdiktek: [verdikt()] })] })))
  assert.ok(html.includes('Narráció kérése'))
  assert.equal(narracioSotet.test(html), false)
  assert.equal(html.includes('Terv nélkül nincs mit narrálni.'), false)
})

test('every dark Narracio kerese says which of the five states it is in', () => {
  const nincsTerv = render(VideoBody, videoProps(videoDetail()))
  assert.ok(narracioSotet.test(nincsTerv))
  assert.ok(nincsTerv.includes('Terv nélkül nincs mit narrálni.'))

  // Not reviewed, reviewed and failed, and passed on an older hash are three
  // different facts, and the sentence names which one this is.
  const nincsItelet = render(VideoBody, videoProps(videoDetail({ tervek: [terv()] })))
  assert.ok(narracioSotet.test(nincsItelet))
  assert.ok(nincsItelet.includes('Ehhez a tervverzióhoz még nincs lektori ítélet'))

  const elbukott = render(VideoBody, videoProps(videoDetail({
    tervek: [terv({ verdiktek: [verdikt({ verdikt: 'elbukik', talalatok: [{ jelenet: 0, kod: 'horog_gyenge', szoveg: 'gyenge' }] })] })],
  })))
  assert.ok(narracioSotet.test(elbukott))
  assert.ok(elbukott.includes('A lektor ítélete a jelenlegi terv-hashre: elbukik'))

  const elavult = render(VideoBody, videoProps(videoDetail({ tervek: [terv({ verdiktek: [verdikt({ tervHash: 'regi' })] })] })))
  assert.ok(narracioSotet.test(elavult))
  assert.ok(elavult.includes('Van átmegy ítélet erre a tervre, de nem a jelenlegi terv-hashre'))

  const futoRender = render(VideoBody, videoProps(videoDetail({
    tervek: [terv({ verdiktek: [verdikt()] })],
    renderek: [renderSor({ status: 'fut', finishedAt: null })],
  })))
  assert.ok(narracioSotet.test(futoRender))
  assert.ok(futoRender.includes('Ezen a videón most fut egy render (r1)'))

  const lezart = render(VideoBody, videoProps(videoDetail({ status: 'lezart', tervek: [terv({ verdiktek: [verdikt()] })] })))
  assert.ok(narracioSotet.test(lezart))
  assert.ok(lezart.includes('A videó le van zárva, a modul nem dolgozik rajta tovább.'))

  const uton = render(VideoBody, videoProps(videoDetail({ tervek: [terv({ verdiktek: [verdikt()] })] }), { narralas: true }))
  assert.ok(narracioSotet.test(uton))
  assert.ok(uton.includes('jelenetenként egy tts-hívás'), 'a lever that takes minutes says so while it runs')
})

test('Render inditasa asks for a narrated plan, and every dark state names itself', () => {
  const kesz = render(VideoBody, videoProps(videoDetail({ tervek: [terv({ verdiktek: [verdikt()], narraciok: [narracioSor()] })] })))
  assert.ok(kesz.includes('Render indítása'))
  assert.equal(renderSotet.test(kesz), false)

  const nincsTerv = render(VideoBody, videoProps(videoDetail()))
  assert.ok(renderSotet.test(nincsTerv))
  assert.ok(nincsTerv.includes('Terv nélkül nincs mit renderelni.'))

  const nincsNarracio = render(VideoBody, videoProps(videoDetail({ tervek: [terv({ verdiktek: [verdikt()] })] })))
  assert.ok(renderSotet.test(nincsNarracio))
  assert.ok(nincsNarracio.includes('Ehhez a tervhez még nincs narráció-fájl'))

  const futoRender = render(VideoBody, videoProps(videoDetail({
    tervek: [terv({ verdiktek: [verdikt()], narraciok: [narracioSor()] })],
    renderek: [renderSor({ status: 'fut', finishedAt: null })],
  })))
  assert.ok(renderSotet.test(futoRender))
  assert.ok(futoRender.includes('Ezen a videón már fut egy render (r1)'))

  const lezart = render(VideoBody, videoProps(videoDetail({ status: 'lezart', tervek: [terv({ verdiktek: [verdikt()], narraciok: [narracioSor()] })] })))
  assert.ok(renderSotet.test(lezart))
  assert.ok(lezart.includes('A videó le van zárva, a modul nem dolgozik rajta tovább.'))

  const uton = render(VideoBody, videoProps(videoDetail({ tervek: [terv({ verdiktek: [verdikt()], narraciok: [narracioSor()] })] }), { renderInditas: true }))
  assert.ok(renderSotet.test(uton))
  assert.ok(uton.includes('A render indítása elment, a válaszra várok.'))
})

/** How many times a sentence stands in the markup. Both levers can name the same state, and "at least once" would not see one of them missing it. */
const elofordulas = (html, mondat) => html.split(mondat).length - 1

test('a closed video names its closure, and never a lesser reason the operator cannot act on', () => {
  // THE ORDER IS THE MODULE'S. `narralTerv` refuses `video_lezart` before it
  // reads the verdict (src/narracio.mjs) and `renderOps.start` before it
  // weighs anything else about the plan (src/render.mjs). Closure used to be
  // the LAST test in both sentence functions, and on a closed video whose plan
  // was never reviewed the page then said "nincs lektori ítélet" -- sending
  // the operator to fetch a review that would have changed nothing. The Lezár
  // button is live in every status, so that video is reachable in one click.
  //
  // FOUR, not two: the two ordering levers follow the same rule and for the
  // same reason -- `videoDraft` and `videoVerdict` both refuse `video_lezart`
  // before they weigh anything else -- so a closed video may not be answered
  // with "Terv nélkül nincs mit lektorálni" either.
  const zarva = 'A videó le van zárva, a modul nem dolgozik rajta tovább.'
  const LEVEREK = 4

  const nincsItelet = render(VideoBody, videoProps(videoDetail({ status: 'lezart', tervek: [terv()] })))
  assert.ok(narracioSotet.test(nincsItelet))
  assert.ok(renderSotet.test(nincsItelet))
  assert.equal(elofordulas(nincsItelet, zarva), LEVEREK, 'every lever names the closure, not some of them')
  // The tail, not the whole sentence: the plan panel says "Ehhez a
  // tervverzióhoz még nincs lektori ítélet." on its own, as a fact about the
  // plan, and that one stays. What must be gone is the LEVER saying it as the
  // reason it is dark.
  assert.equal(nincsItelet.includes('nincs lektori ítélet; narrálni csak átmegy után lehet'), false)
  assert.equal(nincsItelet.includes('Ehhez a tervhez még nincs narráció-fájl'), false)

  // No plan either. A plan is not something the operator can usefully be sent
  // to have written on a video the module has stopped working on.
  const tervNelkul = render(VideoBody, videoProps(videoDetail({ status: 'lezart' })))
  assert.equal(elofordulas(tervNelkul, zarva), LEVEREK)
  assert.equal(tervNelkul.includes('Terv nélkül nincs mit narrálni.'), false)
  assert.equal(tervNelkul.includes('Terv nélkül nincs mit renderelni.'), false)
  assert.equal(tervNelkul.includes('Terv nélkül nincs mit lektorálni.'), false)

  // And a running render on a closed video: `video_lezart` comes before
  // `render_folyamatban` there too, so waiting for the render is not the
  // sentence -- the render finishing would not make either lever live.
  const futoRenderrel = render(VideoBody, videoProps(videoDetail({
    status: 'lezart',
    tervek: [terv({ verdiktek: [verdikt()], narraciok: [narracioSor()] })],
    renderek: [renderSor({ status: 'fut', finishedAt: null })],
  })))
  assert.equal(elofordulas(futoRenderrel, zarva), LEVEREK)
  assert.equal(futoRenderrel.includes('most fut egy render'), false)
  assert.equal(futoRenderrel.includes('már fut egy render'), false)
})

test('a plan that already has a narration still offers Narracio kerese', () => {
  // A DELIBERATE DEVIATION, PINNED HERE SO IT STAYS ONE. The brief scoped this
  // button to a plan with NO narration yet. The obvious test for that --
  // `terv.narraciok.length > 0` means dark -- is not in `narracioTiltasOka`,
  // because `narraciok` is keyed on `tervHash`: the rows belong to the plan as
  // it stands, so an emptiness test would darken the lever exactly after a
  // plan revision, which is the moment narration is most needed and the one
  // the rows say nothing about. And an unnecessary press costs nothing:
  // `narralTerv` answers `valtozatlan: true` without a single tts call when
  // every sentence already has its current file.
  const html = render(VideoBody, videoProps(videoDetail({ tervek: [terv({ verdiktek: [verdikt()], narraciok: [narracioSor()] })] })))
  assert.equal(narracioSotet.test(html), false, 'a narrated plan may be narrated again')
  assert.equal(html.includes('Ehhez a tervhez még nincs narráció-fájl'), false)
  assert.equal(renderSotet.test(html), false)
})

// --- the three levers pressed: what each of the three outcomes says ---

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

const betoltesek = (hivasok) => hivasok.filter((h) => h.method === 'video').length

test('the narration lever tells a refusal, an unchanged set and a synthesised one apart', async () => {
  let narral = () => Promise.resolve({ hiba: 'verdikt_hianyzik', uzenet: 'ehhez a tervhez nincs atmegy verdikt a jelenlegi hash-sel' })
  const { rpc, hivasok } = stubRpc({
    video: () => Promise.resolve(videoDetail({ tervek: [terv({ verdiktek: [verdikt()] })] })),
    narral: (params) => narral(params),
  })
  const view = mount(VideoView, { rpc, id: 'v1', onBack: noop })
  await settle()
  const body = () => childProps(view, VideoBody)
  assert.equal(body().video.id, 'v1', 'the effect ran and the detail loaded')

  // 1. RESOLVED WITH `hiba`: the module refused. `narral` does not throw its
  //    refusals, so a resolved promise is not proof that anything happened.
  body().onNarral('t1')
  await settle()
  assert.deepEqual(hivasok.at(-1), { method: 'narral', params: { tervId: 't1' } })
  assert.ok(body().uzenet.includes('verdikt_hianyzik'), 'the code the operator can look up comes first')
  assert.ok(body().uzenet.includes('nincs atmegy verdikt'))
  assert.equal(body().uzenet.includes('sikertelen'), false)
  assert.equal(body().uzenet.includes('elkészült'), false)
  assert.equal(betoltesek(hivasok), 1, 'a refusal is not an event, so nothing was re-read over it')

  // 2. RESOLVED WITH `valtozatlan`: the set was already current and no tts
  //    call was made. Printing "elkészült" over this would claim work the
  //    module explicitly says it did not do.
  narral = () => Promise.resolve({ valtozatlan: true, jelenetek: [], osszHosszMs: 0, teljesMs: 0, fedettseg: 1, hang: null })
  body().onNarral('t1')
  await settle()
  assert.ok(body().uzenet.includes('változatlan'))
  assert.equal(body().uzenet.includes('elkészült'), false)

  // 3. RESOLVED WITHOUT `hiba`: it happened, and the detail is re-read from
  //    the module's own rows rather than patched from the answer.
  const eddig = betoltesek(hivasok)
  narral = () => Promise.resolve({ valtozatlan: false, jelenetek: [{ jelenet: 0, fajl: 'a.mp3', hosszMs: 1200 }], osszHosszMs: 1200, teljesMs: 1200, fedettseg: 1, hang: 'anna' })
  body().onNarral('t1')
  await settle()
  assert.ok(body().uzenet.includes('elkészült'))
  assert.ok(betoltesek(hivasok) > eddig, 'what the operator reads next comes from a fresh detail load')
})

test('the render lever says started rather than finished, and names a refusal', async () => {
  let renderel = () => Promise.resolve({ hiba: 'render_folyamatban', uzenet: 'már fut egy render', renderId: 'r0' })
  const { rpc, hivasok } = stubRpc({
    video: () => Promise.resolve(videoDetail({ tervek: [terv({ verdiktek: [verdikt()], narraciok: [narracioSor()] })] })),
    renderel: (params) => renderel(params),
  })
  const view = mount(VideoView, { rpc, id: 'v1', onBack: noop })
  await settle()
  const body = () => childProps(view, VideoBody)

  body().onRenderel('t1')
  await settle()
  assert.deepEqual(hivasok.at(-1), { method: 'renderel', params: { tervId: 't1' } })
  assert.ok(body().uzenet.includes('render_folyamatban'))
  assert.equal(betoltesek(hivasok), 1)

  renderel = () => Promise.resolve({ renderId: 'r2', videoId: 'v1', tervId: 't1', status: 'fut' })
  body().onRenderel('t1')
  await settle()
  assert.ok(body().uzenet.includes('elindult'))
  assert.equal(body().uzenet.includes('elkészült'), false, 'a started render is not a finished one')
  assert.equal(betoltesek(hivasok), 2)
})

test('a lever whose request never reached the module says exactly that, and nothing else', async () => {
  // The third outcome, and the one neither of the other two may absorb: the
  // promise REJECTED, so there is no answer to read for a refusal and no act
  // to report. `refusalText` never sees this one.
  const { rpc, hivasok } = stubRpc({
    video: () => Promise.resolve(videoDetail({ tervek: [terv({ verdiktek: [verdikt()], narraciok: [narracioSor()] })] })),
    narral: () => Promise.reject(new Error('Failed to fetch')),
    renderel: () => Promise.reject(new Error('a host 502-tal válaszolt')),
  })
  const view = mount(VideoView, { rpc, id: 'v1', onBack: noop })
  await settle()
  const body = () => childProps(view, VideoBody)

  body().onNarral('t1')
  await settle()
  assert.equal(body().uzenet, 'A narráció kérése el sem jutott a modulhoz: Failed to fetch')

  body().onRenderel('t1')
  await settle()
  assert.equal(body().uzenet, 'A render indítása el sem jutott a modulhoz: a host 502-tal válaszolt')

  assert.equal(betoltesek(hivasok), 1, 'nothing happened, so there was nothing to re-read')
})

test('the Uj video box clears what was typed only when a video really opened, and then reloads the queue', async () => {
  let nyit = () => Promise.resolve({ hiba: 'napi_sapka', uzenet: 'ma már 1 videó nyílt; a napi sapka 1' })
  let ujratoltesek = 0
  const { rpc, hivasok } = stubRpc({ nyit: (params) => nyit(params) })
  const sor = mount(Sor, sorProps({ rpc, onNyitva: () => { ujratoltesek += 1 } }))
  // `UjVideo` holds the state and is not exported; it is reached as the
  // element `Sor` renders for it, which is also what proves the queue offers
  // it at all.
  const doboz = findElement(sor.tree(), (n) => typeof n.type === 'function')
  assert.equal(doboz.type.name, 'UjVideo')
  const box = mount(doboz.type, doboz.props)
  const body = () => childProps(box, UjVideoBody)

  body().onForras('Egy hír a hétről.')
  body().onCim('Egy cím')
  body().onKuld()
  await settle()
  // The text goes as it was pasted, and the blank title with it: `cimOf` has
  // the rule for an absent one, this box does not.
  assert.deepEqual(hivasok.at(-1), { method: 'nyit', params: { forras: 'kezi', forrasSzoveg: 'Egy hír a hétről.', cim: 'Egy cím' } })
  assert.ok(body().uzenet.includes('napi_sapka'))
  assert.equal(body().forrasSzoveg, 'Egy hír a hétről.', 'a refusal keeps the text: the operator has to be able to press again tomorrow')
  assert.equal(ujratoltesek, 0, 'nothing opened, so the queue has nothing new to show')

  nyit = () => Promise.reject(new Error('Failed to fetch'))
  body().onKuld()
  await settle()
  assert.equal(body().uzenet, 'A nyitás kérése el sem jutott a modulhoz: Failed to fetch')
  assert.equal(body().forrasSzoveg, 'Egy hír a hétről.')
  assert.equal(ujratoltesek, 0)

  nyit = () => Promise.resolve({ videoId: 'v9', cim: 'Egy cím', forrasSzoveg: 'Egy hír a hétről.', forrasFigyelmeztetes: null })
  body().onKuld()
  await settle()
  assert.ok(body().uzenet.includes('megnyílt'))
  assert.equal(body().forrasSzoveg, '', 'the box empties only on the act itself')
  assert.equal(body().cim, '')
  assert.equal(ujratoltesek, 1, 'the queue behind the box is reloaded, or the new video is nowhere to be seen')
})

test('a board reload does not remount the queue, so a half-typed source text survives it', async () => {
  // THE DEFECT THIS PINS. `<Sor>` used to be keyed on a counter that went up
  // on every successful board load, and the Uj video box now lives inside that
  // subtree: a Frissít pressed while a source text was half typed would have
  // thrown the text away, along with the sentence saying what the last open
  // did. This harness has no reconciler, so what is pinned is the element
  // identity React itself reconciles on -- a key that moves between loads is
  // exactly what remounts the subtree.
  const { rpc, hivasok } = stubRpc({
    board: () => Promise.resolve(board()),
    health: () => Promise.resolve(health()),
  })
  const page = mount(VideoPage, { extensionId: 'video', rpc })
  await settle()
  const elso = findElement(page.tree(), (n) => n.type === Sor)
  assert.ok(elso !== null, 'the queue is drawn')
  assert.equal(elso.key, null, 'the queue carries no key at all: nothing about a load may remount it')

  const bar = findElement(page.tree(), (n) => n.type === StatusBar)
  bar.props.onRefresh()
  await settle()
  assert.ok(hivasok.filter((h) => h.method === 'board').length >= 2, 'the reload really happened')
  const masodik = findElement(page.tree(), (n) => n.type === Sor)
  assert.equal(masodik.key, elso.key)
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
  // The preview cache is the module's own, has no row to bind a deletion to,
  // and is therefore the one thing an uninstall would otherwise leave behind
  // with nothing left to name it from. The guide names it.
  assert.ok(sajat.includes('out/swarmclaw/sablon-elonezet/'), 'the uninstall guide names the preview cache')
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
    nemKuldhetoTipusok: [], tablaHianyok: [],
    ...overrides,
  }
}

function elonezetAllapot(overrides = {}) {
  return {
    hiba: null, katalogusHash: 'k1',
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
      kuldhetoTipusok: null, nemKuldhetoTipusok: null, tablaHianyok: null,
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

test('the grid notices that the catalogue changed under it, and does not chase an unknown one', () => {
  // The gallery fetched `templates` once and polled `templatePreviewStatus`,
  // so a mid-session kit edit left the old type list in the grid beside a
  // button counting the new one. The status carries the hash it just read;
  // when the two disagree, the grid is stale and is fetched again.
  assert.equal(katalogusElavult('k1', 'k2'), true)
  assert.equal(katalogusElavult('k1', 'k1'), false)
  // Null is "this half does not know", on either side, and never a change:
  // a refetch fired on an unreadable project would be a request loop.
  assert.equal(katalogusElavult(null, 'k2'), false)
  assert.equal(katalogusElavult('k1', null), false)
  assert.equal(katalogusElavult(null, null), false)
})

test('the catalogue-table skew is drawn for the operator, not only handed to the agent', () => {
  // `tablaHianyok` is the same `katalogus_valtozott` the producer is warned
  // with on every plan. It reached this page from the first version of the
  // gallery and nothing drew it, which is how the kit table fell three types
  // behind the catalogue without the page ever saying so.
  const van = renderSablonok({ data: templatesData({ tablaHianyok: ['szam.szinatmenet', 'hologram'] }) })
  assert.ok(van.includes('katalogus_valtozott'))
  assert.ok(van.includes('szam.szinatmenet, hologram'), 'the names are the catalogue\'s own, so the operator knows what to add')
  // A table that is current says nothing, and a page that could not read the
  // catalogue does not claim the table is current either.
  assert.ok(!renderSablonok({ data: templatesData() }).includes('katalogus_valtozott'))
  assert.ok(!renderSablonok({ data: templatesData({ tablaHianyok: null }) }).includes('katalogus_valtozott'))
})

test('a type the catalogue gives no sample for is named, so a zero missing count beside empty cards is explained', () => {
  const html = renderSablonok({
    data: templatesData(),
    allapot: elonezetAllapot({ hianyzo: [], meglevo: KATALOGUS.tipusok.slice(2), mintaNelkul: ['gorbe', 'koriv'] }),
    health: health(),
  })
  assert.ok(html.includes('2 típushoz a katalógus nem ad mintát'))
  assert.ok(html.includes('gorbe, koriv'))
  // And the button says the generation would do nothing, which is the
  // sentence this line exists to make readable.
  assert.ok(html.includes('Minden mintával rendelkező típusnak van képe.'))
  // Nothing is said when every type has one.
  assert.ok(!renderSablonok({ data: templatesData(), allapot: elonezetAllapot(), health: health() }).includes('nem ad mintát'))
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

test('a preview state nobody could read darkens the button rather than offering a run that cannot be sized', () => {
  // `hianyzo: null` is the status saying it does not know, which is not the
  // same as zero. Without this branch the button stayed live beside a count
  // of `?`, and pressing it would start a run over a list the page could not
  // name -- with nothing red anywhere to say why.
  const html = renderSablonok({
    data: templatesData(), allapot: elonezetAllapot({ hianyzo: null }), health: health(),
  })
  assert.ok(/<button[^>]*disabled[^>]*>Előnézetek/.test(html))
  assert.ok(html.includes('Előnézetek generálása (? hiányzik)'), '`?` and not 0: nobody counted')
  assert.ok(html.includes('Az előnézetek állapota nem ismert, így a generálás nem indítható innen.'))
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

test('the search reaches the name, the sentence and the prop names, and stops there', () => {
  // `sablon-szuro.ts` documents at length that the prop `mit` sentences are
  // deliberately outside the haystack: they are the longest text on a card,
  // and a two-letter query that matched them would match most of the kit --
  // a filter that has stopped narrowing. Nothing pinned it, so adding them
  // broke no test.
  const forras = {
    tipusok: ['cimlap', 'szam'],
    leirasok: { cimlap: 'A nyitóképernyő.', szam: 'Egy szám a hír.' },
    propok: {
      cimlap: [{ nev: 'sorok', kotelezo: true, mit: 'A horog két-három rövid sora.' }],
      szam: [{ nev: 'szam', kotelezo: true, mit: 'A kiírandó érték.' }],
    },
    kuldheto: null, hasznalat: null, vanKep: null,
  }
  const keres = (kereses) => szurtTipusok(forras, { ...URES_SZURO, kereses })
  assert.deepEqual(keres('cimlap'), ['cimlap'], 'the type name')
  assert.deepEqual(keres('nyitóképernyő'), ['cimlap'], 'the catalogue sentence')
  assert.deepEqual(keres('sorok'), ['cimlap'], 'the prop names')
  assert.deepEqual(keres('horog'), [], 'and not a word that only the prop sentence has')
  assert.deepEqual(keres('kiírandó'), [])
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
    hiba: 'remotion_dir_hianyzik', katalogusHash: null, meglevo: null, hianyzo: null, mintaNelkul: null,
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

// --- ordering a turn: the three host calls, and the five ways they fail ---

/**
 * The host, as `rendelj` sees it: one queued answer per route, and the log of
 * what the page actually sent.
 *
 * A route the function calls unstubbed fails the test rather than resolving to
 * undefined, the way `stubRpc` above does -- these three calls spend money on
 * the other side, and a test that let a fourth one through silently would be
 * pinning nothing.
 */
function stubHost(valaszok) {
  const hivasok = []
  const fetchImpl = (input, init) => {
    const method = (init && init.method) || 'GET'
    hivasok.push({ url: input, method, init: init ?? {} })
    const kulcs = `${method} ${input.startsWith(`${CHATS_URL}/`) ? `${CHATS_URL}/:id/chat` : input}`
    assert.ok(valaszok[kulcs] !== undefined, `rendelj called a host route this test did not stub: ${kulcs}`)
    return valaszok[kulcs]()
  }
  return { fetchImpl, hivasok }
}

const hostOk = (torzs) => () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(torzs) })
const hostRossz = (status, torzs) => () => Promise.resolve({ ok: false, status, json: () => Promise.resolve(torzs) })
const hostDobas = (uzenet) => () => Promise.reject(new Error(uzenet))

/**
 * The turn's own answer: `text/event-stream`, whose body this page may not
 * read. `json` throws so that a page which read it fails here rather than in
 * production, where reading -- or worse, aborting -- would cut the turn.
 */
const hostStream = () => () => Promise.resolve({
  ok: true, status: 200,
  json: () => { throw new Error('the page read the event stream body of the chat turn') },
})

const ugynokok = (overrides = {}) => ({
  'a-1': { id: 'a-1', name: GYARTO_NEV, disabled: false },
  'a-2': { id: 'a-2', name: LEKTOR_NEV, disabled: false },
  ...overrides,
})

const TERV_UZENET = 'Írj tervet a v1 videóhoz a videoDraft toollal. Ne csinálj mást.'

test('the UI carries the agent names this extension actually declares', () => {
  // The bundle cannot import src/agents.mjs -- that file reaches node:fs
  // through kit-tabla.mjs -- so the two names are written out again in the UI.
  // This is the guard that makes the duplicate safe: rename a displayName over
  // there and the suite fails here rather than the page silently ordering a
  // turn from an agent the host does not have.
  const nevek = AGENTS.map((a) => a.displayName)
  assert.ok(nevek.includes(GYARTO_NEV), `AGENTS no longer declares ${GYARTO_NEV}`)
  assert.ok(nevek.includes(LEKTOR_NEV), `AGENTS no longer declares ${LEKTOR_NEV}`)
})

test('rendelj finds the agent by name, opens a session, sends one instruction, and never reads the stream', async () => {
  const { fetchImpl, hivasok } = stubHost({
    [`GET ${AGENTS_URL}`]: hostOk(ugynokok()),
    [`POST ${CHATS_URL}`]: hostOk({ id: 's-9', name: 'Videó terv: v1' }),
    [`POST ${CHATS_URL}/:id/chat`]: hostStream(),
  })
  const valasz = await rendelj({ agentNev: GYARTO_NEV, sessionNev: 'Videó terv: v1', uzenet: TERV_UZENET }, fetchImpl)

  // The id is the host's, minted on reconcile and different per install, which
  // is why the name is what the page looks up.
  assert.deepEqual(valasz, { kind: 'elment', agentId: 'a-1', sessionId: 's-9' })
  assert.equal(hivasok.length, 3, 'three calls, no polling loop behind them')

  assert.equal(hivasok[0].url, AGENTS_URL)
  assert.equal(hivasok[0].init.credentials, 'same-origin', 'the auth cookie travels on a same-origin fetch; this bundle holds no key')

  assert.equal(hivasok[1].url, CHATS_URL)
  assert.equal(hivasok[1].method, 'POST')
  assert.deepEqual(JSON.parse(hivasok[1].init.body), { agentId: 'a-1', name: 'Videó terv: v1' })

  assert.equal(hivasok[2].url, `${CHATS_URL}/s-9/chat`)
  assert.equal(hivasok[2].method, 'POST')
  assert.deepEqual(JSON.parse(hivasok[2].init.body), { message: TERV_UZENET })
  // Not reading the stream is half the rule; not cutting it is the other half.
  // An abort here would end the turn the operator has just paid for.
  assert.equal(hivasok[2].init.signal, undefined, 'the request carries no abort signal')
})

test('rendelj tells a missing agent, a disabled one and a list it could not read apart', async () => {
  // Three different facts, and the operator does something different about
  // each: press Reconcile, re-enable the agent, or look at why the host would
  // not answer. One shared sentence would send them to the wrong one.
  const nincs = stubHost({ [`GET ${AGENTS_URL}`]: hostOk({ 'a-3': { id: 'a-3', name: 'Valaki más' } }) })
  assert.deepEqual(await rendelj({ agentNev: GYARTO_NEV, sessionNev: 'x', uzenet: 'y' }, nincs.fetchImpl), { kind: 'nincs_ilyen_ugynok', agentNev: GYARTO_NEV })
  assert.equal(nincs.hivasok.length, 1, 'no session is opened for an agent that is not there')

  const letiltva = stubHost({ [`GET ${AGENTS_URL}`]: hostOk(ugynokok({ 'a-1': { id: 'a-1', name: GYARTO_NEV, disabled: true } })) })
  assert.deepEqual(await rendelj({ agentNev: GYARTO_NEV, sessionNev: 'x', uzenet: 'y' }, letiltva.fetchImpl), { kind: 'ugynok_letiltva', agentNev: GYARTO_NEV })
  assert.equal(letiltva.hivasok.length, 1, 'the host would answer 409 anyway; the page does not spend the call to find out')

  const rossz = stubHost({ [`GET ${AGENTS_URL}`]: hostRossz(403, { error: 'Forbidden' }) })
  const olvashatatlan = await rendelj({ agentNev: GYARTO_NEV, sessionNev: 'x', uzenet: 'y' }, rossz.fetchImpl)
  assert.equal(olvashatatlan.kind, 'ugynokok_olvashatatlanok')
  assert.ok(olvashatatlan.reason.includes('403'))
  assert.ok(olvashatatlan.reason.includes('Forbidden'), 'the host\'s own sentence is carried, not swallowed')

  const nemObjektum = stubHost({ [`GET ${AGENTS_URL}`]: hostOk([{ id: 'a-1', name: GYARTO_NEV }]) })
  const alak = await rendelj({ agentNev: GYARTO_NEV, sessionNev: 'x', uzenet: 'y' }, nemObjektum.fetchImpl)
  assert.equal(alak.kind, 'ugynokok_olvashatatlanok', 'a list where a map was promised is a shape this page cannot read, not an absent agent')
})

test('rendelj keeps a session that did not open apart from an instruction the host refused', async () => {
  const nyitas = stubHost({
    [`GET ${AGENTS_URL}`]: hostOk(ugynokok()),
    [`POST ${CHATS_URL}`]: hostRossz(409, { error: 'Agent "Videó Gyártó" is disabled' }),
  })
  const nemNyilt = await rendelj({ agentNev: GYARTO_NEV, sessionNev: 'x', uzenet: 'y' }, nyitas.fetchImpl)
  assert.equal(nemNyilt.kind, 'session_nem_nyilt')
  assert.ok(nemNyilt.reason.includes('409'))
  assert.ok(nemNyilt.reason.includes('is disabled'))
  assert.equal(nyitas.hivasok.length, 2, 'there is no session to send an instruction to')

  const idNelkul = stubHost({
    [`GET ${AGENTS_URL}`]: hostOk(ugynokok()),
    [`POST ${CHATS_URL}`]: hostOk({ name: 'Videó terv: v1' }),
  })
  const nincsId = await rendelj({ agentNev: GYARTO_NEV, sessionNev: 'x', uzenet: 'y' }, idNelkul.fetchImpl)
  assert.equal(nincsId.kind, 'session_nem_nyilt', 'an answer with no session id is not an opened session')

  const uzenet = stubHost({
    [`GET ${AGENTS_URL}`]: hostOk(ugynokok()),
    [`POST ${CHATS_URL}`]: hostOk({ id: 's-9' }),
    [`POST ${CHATS_URL}/:id/chat`]: hostRossz(400, { error: 'message or file is required' }),
  })
  const elutasitva = await rendelj({ agentNev: GYARTO_NEV, sessionNev: 'x', uzenet: '' }, uzenet.fetchImpl)
  assert.equal(elutasitva.kind, 'uzenet_elutasitva')
  assert.ok(elutasitva.reason.includes('message or file is required'))
})

test('rendelj never throws: each of the three calls failing has its own named answer', async () => {
  // The caller switches on `kind` and has no catch, deliberately. If any of the
  // three steps could reject, the button would stay dark for ever on a state
  // nothing named.
  const elso = stubHost({ [`GET ${AGENTS_URL}`]: hostDobas('Failed to fetch') })
  assert.deepEqual(await rendelj({ agentNev: GYARTO_NEV, sessionNev: 'x', uzenet: 'y' }, elso.fetchImpl), { kind: 'ugynokok_olvashatatlanok', reason: 'Failed to fetch' })

  const masodik = stubHost({
    [`GET ${AGENTS_URL}`]: hostOk(ugynokok()),
    [`POST ${CHATS_URL}`]: hostDobas('a host 502-tal válaszolt'),
  })
  assert.deepEqual(await rendelj({ agentNev: GYARTO_NEV, sessionNev: 'x', uzenet: 'y' }, masodik.fetchImpl), { kind: 'session_nem_nyilt', reason: 'a host 502-tal válaszolt' })

  const harmadik = stubHost({
    [`GET ${AGENTS_URL}`]: hostOk(ugynokok()),
    [`POST ${CHATS_URL}`]: hostOk({ id: 's-9' }),
    [`POST ${CHATS_URL}/:id/chat`]: hostDobas('offline'),
  })
  assert.deepEqual(await rendelj({ agentNev: GYARTO_NEV, sessionNev: 'x', uzenet: 'y' }, harmadik.fetchImpl), { kind: 'uzenet_elutasitva', reason: 'offline' })
})

test('every ordering failure gets its own sentence, and the missing agent names both the name and Reconcile', () => {
  assert.equal(megrendelesHiba({ kind: 'elment', agentId: 'a-1', sessionId: 's-9' }), null, 'an ordered turn is not a failure')

  const nincs = megrendelesHiba({ kind: 'nincs_ilyen_ugynok', agentNev: GYARTO_NEV })
  assert.ok(nincs.includes(GYARTO_NEV), 'the name it looked for')
  assert.ok(nincs.includes('Reconcile'), 'and what creates it')

  const letiltva = megrendelesHiba({ kind: 'ugynok_letiltva', agentNev: GYARTO_NEV })
  assert.ok(letiltva.includes(GYARTO_NEV))
  assert.ok(letiltva.includes('letilt'), 'a disabled agent is a different fact from an absent one')
  assert.notEqual(letiltva, nincs)

  const mondatok = [
    nincs,
    letiltva,
    megrendelesHiba({ kind: 'ugynokok_olvashatatlanok', reason: 'offline' }),
    megrendelesHiba({ kind: 'session_nem_nyilt', reason: 'a host 409-tal válaszolt' }),
    megrendelesHiba({ kind: 'uzenet_elutasitva', reason: 'a host 400-tal válaszolt' }),
  ]
  assert.equal(new Set(mondatok).size, 5, 'five facts, five sentences: none of them collapses into another')
  for (const mondat of mondatok) assert.equal(mondat.includes('sikertelen'), false)
})

test('the Terv keres button orders the producer, names the tool and the video id, and says the turn is running', async () => {
  const { fetchImpl, hivasok } = stubHost({
    [`GET ${AGENTS_URL}`]: hostOk(ugynokok()),
    [`POST ${CHATS_URL}`]: hostOk({ id: 's-9' }),
    [`POST ${CHATS_URL}/:id/chat`]: hostStream(),
  })
  const { rpc } = stubRpc({ video: () => Promise.resolve(videoDetail()) })
  const view = mount(VideoView, { rpc, id: 'v1', onBack: noop, hostFetch: fetchImpl })
  await settle()
  const body = () => childProps(view, VideoBody)
  assert.equal(body().tervRendeles, null)

  body().onTervKeres()
  await settle()
  assert.deepEqual(JSON.parse(hivasok[1].init.body).agentId, 'a-1')
  // The instruction names the tool and the id and forbids everything else: a
  // turn the operator paid for must not wander off into the rest of the queue.
  assert.deepEqual(JSON.parse(hivasok[2].init.body), { message: TERV_UZENET })
  assert.equal(body().tervRendeles, 'fut', 'the button stays dark: the turn is out and the page is not waiting on it')
  assert.ok(body().uzenet.includes(GYARTO_NEV))
  assert.ok(body().uzenet.includes('Frissítés'), 'the evidence is the plan appearing, so the operator is told where to look')
  assert.equal(body().uzenet.includes('sikertelen'), false)
})

test('the Lektoralas keres button orders the reviewer on the latest plan', async () => {
  const { fetchImpl, hivasok } = stubHost({
    [`GET ${AGENTS_URL}`]: hostOk(ugynokok()),
    [`POST ${CHATS_URL}`]: hostOk({ id: 's-4' }),
    [`POST ${CHATS_URL}/:id/chat`]: hostStream(),
  })
  const { rpc } = stubRpc({ video: () => Promise.resolve(videoDetail({ tervek: [terv({ id: 't7' })] })) })
  const view = mount(VideoView, { rpc, id: 'v1', onBack: noop, hostFetch: fetchImpl })
  await settle()
  const body = () => childProps(view, VideoBody)

  body().onLektorKeres('t7')
  await settle()
  // The reviewer, not the producer: `videoVerdict` refuses `onlektoralas`, so
  // ordering this from the plan's own author would be a turn spent on a refusal.
  assert.equal(JSON.parse(hivasok[1].init.body).agentId, 'a-2')
  assert.deepEqual(JSON.parse(hivasok[2].init.body), { message: 'Lektoráld a t7 tervet a videoVerdict toollal. Ne csinálj mást.' })
  assert.equal(body().lektorRendeles, 'fut')
  assert.ok(body().uzenet.includes(LEKTOR_NEV))
})

test('an ordering that did not go through says which fact stopped it, and lets the operator press again', async () => {
  const { fetchImpl } = stubHost({ [`GET ${AGENTS_URL}`]: hostOk({}) })
  const { rpc } = stubRpc({ video: () => Promise.resolve(videoDetail()) })
  const view = mount(VideoView, { rpc, id: 'v1', onBack: noop, hostFetch: fetchImpl })
  await settle()
  const body = () => childProps(view, VideoBody)

  body().onTervKeres()
  await settle()
  assert.ok(body().uzenet.includes(GYARTO_NEV))
  assert.ok(body().uzenet.includes('Reconcile'))
  assert.equal(body().tervRendeles, null, 'nothing is running, so the button goes live again')
})

test('Frissites re-reads the detail and takes back the running-turn state', async () => {
  const { fetchImpl } = stubHost({
    [`GET ${AGENTS_URL}`]: hostOk(ugynokok()),
    [`POST ${CHATS_URL}`]: hostOk({ id: 's-9' }),
    [`POST ${CHATS_URL}/:id/chat`]: hostStream(),
  })
  const { rpc, hivasok } = stubRpc({ video: () => Promise.resolve(videoDetail()) })
  const view = mount(VideoView, { rpc, id: 'v1', onBack: noop, hostFetch: fetchImpl })
  await settle()
  const body = () => childProps(view, VideoBody)

  body().onTervKeres()
  await settle()
  assert.equal(body().tervRendeles, 'fut')

  // There is no poller: the page cannot see the turn end, so the operator
  // looking again is what turns the order back into a fact.
  const eddig = betoltesek(hivasok)
  body().onFrissit()
  await settle()
  assert.ok(betoltesek(hivasok) > eddig, 'the detail is re-read from the module\'s own rows')
  assert.equal(body().tervRendeles, null)
})

const tervKeresSotet = /<button[^>]*disabled[^>]*>Terv kérése/
const lektorKeresSotet = /<button[^>]*disabled[^>]*>Lektorálás kérése/

test('a live ordering button still says what a press costs, and a dark one says why it is dark', () => {
  const el = render(VideoBody, videoProps(videoDetail({ tervek: [terv()] })))
  assert.equal(tervKeresSotet.test(el), false)
  assert.equal(lektorKeresSotet.test(el), false)
  // 2.2: the price is on screen while the button can still be pressed. A
  // warning that only appears once the control is dark warns nobody.
  assert.ok(el.includes('pénzbe kerül'))
  assert.ok(el.includes('percekig'))
  assert.equal((el.match(/vid-lepes-ar/g) ?? []).length, 2, 'both ordering levers carry it; the mechanical ones do not')

  const tervNelkul = render(VideoBody, videoProps(videoDetail()))
  assert.equal(tervKeresSotet.test(tervNelkul), false, 'a video with no plan is exactly when a plan is ordered')
  assert.ok(lektorKeresSotet.test(tervNelkul))
  assert.ok(tervNelkul.includes('Terv nélkül nincs mit lektorálni'))

  // Closure first, for the reason the two mechanical levers already test it
  // first: `videoDraft` and `videoVerdict` both refuse `video_lezart` before
  // they weigh anything else, so naming any other reason would send the
  // operator to do work that changes nothing.
  const lezart = render(VideoBody, videoProps(videoDetail({ status: 'lezart', tervek: [terv()] })))
  assert.ok(tervKeresSotet.test(lezart))
  assert.ok(lektorKeresSotet.test(lezart))
  assert.equal(lezart.includes('Terv nélkül nincs mit lektorálni'), false)
})

test('an ordered turn darkens its button and says so in the section header', () => {
  const kuldes = render(VideoBody, videoProps(videoDetail({ tervek: [terv()] }), { tervRendeles: 'kuldes' }))
  assert.ok(tervKeresSotet.test(kuldes))
  assert.ok(kuldes.includes('a válaszra várok'), 'the three host calls are out and nothing has been ordered yet')

  const fut = render(VideoBody, videoProps(videoDetail({ tervek: [terv()] }), { tervRendeles: 'fut' }))
  assert.ok(tervKeresSotet.test(fut))
  assert.ok(fut.includes('Frissítés'))
  // 2.3: the section header carries it too, so the state is visible without
  // reading down to the button.
  assert.ok(fut.includes('ügynök-forduló megrendelve: terv'))
  assert.equal(lektorKeresSotet.test(fut), false, 'the two orders are separate: one running does not darken the other')

  const mindketto = render(VideoBody, videoProps(videoDetail({ tervek: [terv()] }), { tervRendeles: 'fut', lektorRendeles: 'fut' }))
  assert.ok(mindketto.includes('ügynök-forduló megrendelve: terv, lektorálás'))
})

// --- the one button that reaches outside the module ---

const ytProps = (overrides = {}) => ({ dolgozik: false, mondatok: [], onKattint: noop, ...overrides })

const ytOtletek = (overrides = {}) => ({
  nyitott: [], marVolt: 0, jelolt: 0, maradek: 0, csatornaHibak: [], eldobott: 0, ...overrides,
})

test('readYoutubeOtletek refuses a response missing a list rather than drawing it as zero ideas', () => {
  assert.deepEqual(readYoutubeOtletek(ytOtletek({ jelolt: 3, marVolt: 1 })), ytOtletek({ jelolt: 3, marVolt: 1 }))
  for (const hianyos of [
    { ...ytOtletek(), nyitott: undefined },
    { ...ytOtletek(), csatornaHibak: undefined },
    { ...ytOtletek(), jelolt: undefined },
    { ...ytOtletek(), marVolt: 'sok' },
    'kesz',
  ]) assert.throws(() => readYoutubeOtletek(hianyos), /youtubeOtletek/)
})

test('the YouTube button is dark while it works, and says why beside itself', () => {
  const nyugalom = render(YoutubeOtletekBody, ytProps())
  assert.equal(/<button[^>]*disabled[^>]*>Ötletek a YouTube-ról/.test(nyugalom), false)
  assert.ok(nyugalom.includes('Ötletek a YouTube-ról'))
  // The line beside the button says what a press does, so the operator is not
  // guessing what the module is about to go and do.
  assert.ok(nyugalom.includes('beállított csatornák'))

  const kozben = render(YoutubeOtletekBody, ytProps({ dolgozik: true }))
  assert.ok(/<button[^>]*disabled[^>]*>Ötletek a YouTube-ról/.test(kozben))
  assert.ok(kozben.includes('csatornánként másodpercekig'), 'a press that takes seconds must say so, or it reads as a dead button')
})

test('the YouTube button prints a channel name as text, markup and all', () => {
  const html = render(YoutubeOtletekBody, ytProps({ mondatok: ['Nem válaszolt: <b>@a</b> (csatorna_idotullepes).'] }))
  assert.equal(html.includes('<b>@a</b>'), false)
  assert.ok(html.includes('&lt;b&gt;@a&lt;/b&gt;'))
})

test('every branch of the YouTube answer gets its own sentence, and none reads as another', () => {
  // Ideas opened, some already known, some left over.
  const teli = otletMondatok(ytOtletek({
    nyitott: [{ videoId: 'v1', cim: 'Egy' }, { videoId: 'v2', cim: 'Kettő' }],
    jelolt: 15, marVolt: 3, maradek: 10, eldobott: 4,
  })).join(' | ')
  assert.ok(teli.includes('2 új ötlet'))
  assert.ok(teli.includes('3'), 'the ones already on the board are counted separately')
  assert.ok(teli.includes('10'), 'and so is what a second press would still find')
  assert.ok(teli.includes('4'), 'the entries the module dropped are named, so a drifted feed is not a quiet one')

  // Zero because every candidate is already a video on this board.
  const marMind = otletMondatok(ytOtletek({ jelolt: 6, marVolt: 6 })).join(' | ')
  assert.ok(marMind.includes('mindegyikből'))
  assert.equal(marMind.includes('volt csatorna, ami nem válaszolt'), false)

  // Zero because nothing could be read. NOT the same sentence as the one above.
  const nemaCsatornak = otletMondatok(ytOtletek({
    csatornaHibak: [{ csatorna: '@a', ok: 'csatorna_feed_idotullepes' }, { csatorna: '@b', ok: 'csatorna_azonosito_ismeretlen' }],
  })).join(' | ')
  assert.ok(nemaCsatornak.includes('volt csatorna, amit nem sikerült beolvasni'))
  assert.equal(nemaCsatornak.includes('nem válaszolt.'), false, 'a 200 carrying an interstitial IS an answer; the headline may not deny it')
  assert.equal(nemaCsatornak.includes('mindegyikből'), false)
  // The page knows WHICH channels failed, so "1 of 3 did not answer" is not enough.
  assert.ok(nemaCsatornak.includes('@a'))
  assert.ok(nemaCsatornak.includes('@b'))
  // The code is still there to look up and quote -- and so is a sentence
  // saying what to do, because a code is not advice.
  assert.ok(nemaCsatornak.includes('csatorna_feed_idotullepes'))
  assert.ok(nemaCsatornak.includes('csatorna_azonosito_ismeretlen'))
  assert.ok(nemaCsatornak.includes('próbáld meg újra'))
  assert.ok(nemaCsatornak.includes('átnevezhették'), 'the operator is told what a missing channel id usually means')

  // Zero because the channels answered and had nothing inside the window.
  const uresHet = otletMondatok(ytOtletek({ jelolt: 0 })).join(' | ')
  assert.ok(uresHet.includes('válaszoltak, de nem jött belőlük új ötlet'))
  assert.equal(uresHet.includes('mindegyikből'), false)
  assert.equal(uresHet.includes('nem sikerült beolvasni'), false)

  // A channel that was read fine and simply has not uploaded lately is NOT a
  // failure and must not be printed as one: the operator would go and check a
  // url that is perfectly correct.
  const csendes = otletMondatok(ytOtletek({
    nyitott: [{ videoId: 'v1', cim: 'Egy' }], jelolt: 1,
    csatornaHibak: [{ csatorna: '@lassu', ok: 'csatorna_nincs_friss' }],
  })).join(' | ')
  assert.ok(csendes.includes('Nem volt friss feltöltése: @lassu'))
  assert.equal(csendes.includes('Nem válaszolt'), false)

  // Both kinds at once stay separate, each naming only its own channels.
  const vegyes = otletMondatok(ytOtletek({
    csatornaHibak: [{ csatorna: '@lassu', ok: 'csatorna_nincs_friss' }, { csatorna: '@torott', ok: 'csatorna_nem_valaszolt' }],
  }))
  const nemOlvashato = vegyes.find((m) => m.startsWith('Nem sikerült beolvasni:'))
  const nincsFriss = vegyes.find((m) => m.startsWith('Nem volt friss feltöltése:'))
  assert.ok(nemOlvashato.includes('@torott') && !nemOlvashato.includes('@lassu'))
  assert.ok(nincsFriss.includes('@lassu') && !nincsFriss.includes('@torott'))

  // A body that was not a feed is its own sentence, and it is NOT the one that
  // means "do nothing". This is the branch the review caught: an interstitial
  // or an error page served with HTTP 200 used to arrive as "nothing new".
  const olvashatatlan = otletMondatok(ytOtletek({
    csatornaHibak: [{ csatorna: '@a', ok: 'csatorna_feed_ertelmezhetetlen' }],
  })).join(' | ')
  assert.ok(olvashatatlan.startsWith('Nem jött egyetlen jelölt sem'))
  assert.ok(olvashatatlan.includes('amit nem sikerült beolvasni'), 'the headline must not say the channel did not answer: a 200 is an answer')
  assert.ok(olvashatatlan.includes('Nem sikerült beolvasni: @a'))
  assert.ok(olvashatatlan.includes('egyetlen bejegyzést sem tudott kiolvasni'), 'the sentence covers both a non-feed body and a feed whose entries drifted')
  assert.ok(olvashatatlan.includes('böngészőben'), 'and what to do about it')
  assert.equal(olvashatatlan.includes('Nem volt friss feltöltése'), false, 'the sentence that means "do nothing" must not cover an unreadable body')
  assert.equal(olvashatatlan.includes('Nincs nyilvános feltöltése'), false)

  // A channel with no public uploads at all is READ FINE and is not a
  // failure -- and it is not a freshness story either: telling this operator
  // "nincs friss feltöltése" implies there are older ones and that widening
  // the window is worth trying, which it never will be.
  const nincsFeltoltes = otletMondatok(ytOtletek({
    csatornaHibak: [{ csatorna: '@ures', ok: 'csatorna_nincs_feltoltes' }],
  })).join(' | ')
  assert.ok(nincsFeltoltes.includes('Nincs nyilvános feltöltése: @ures'))
  assert.equal(nincsFeltoltes.includes('Nem sikerült beolvasni'), false, 'the advice for an unreadable feed is false about a channel that is fine')
  assert.equal(nincsFeltoltes.includes('böngészőben'), false)
  assert.equal(nincsFeltoltes.includes('Nem volt friss feltöltése'), false, 'a freshness sentence implies older uploads that do not exist')
  assert.ok(nincsFeltoltes.startsWith('A csatornák válaszoltak'), 'it answered, so the headline says so')

  // A code this page has not learnt yet is still named, with a line saying the
  // page has no advice for it -- a channel missing from the report entirely
  // would be worse than one named without advice.
  const ismeretlen = otletMondatok(ytOtletek({ csatornaHibak: [{ csatorna: '@uj', ok: 'csatorna_valami_uj' }] })).join(' | ')
  assert.ok(ismeretlen.includes('@uj'))
  assert.ok(ismeretlen.includes('csatorna_valami_uj'))

  for (const mondatok of [teli, marMind, nemaCsatornak, uresHet, csendes, olvashatatlan, nincsFeltoltes]) assert.equal(mondatok.includes('sikertelen'), false)
})

test('the YouTube button tells a refusal, a rejected request and a real press apart, and reloads the board only on the last', async () => {
  let otletek = () => Promise.resolve({ hiba: 'youtube_nincs_csatorna', uzenet: 'nincs beállítva YouTube-csatorna: ... a youtubeCsatornak mezőbe ...' })
  let ujratoltesek = 0
  const { rpc, hivasok } = stubRpc({ youtubeOtletek: (params) => otletek(params) })
  const sor = mount(Sor, sorProps({ rpc, onNyitva: () => { ujratoltesek += 1 } }))
  const doboz = findElement(sor.tree(), (n) => typeof n.type === 'function' && n.type.name === 'YoutubeOtletek')
  assert.ok(doboz !== null, 'the queue offers the button at all')
  const box = mount(doboz.type, doboz.props)
  const body = () => childProps(box, YoutubeOtletekBody)

  // 1. RESOLVED WITH `hiba`: the module refused, and the sentence tells the
  //    operator where to go.
  body().onKattint()
  await settle()
  assert.deepEqual(hivasok.at(-1), { method: 'youtubeOtletek', params: {} })
  const nincs = body().mondatok.join(' | ')
  assert.ok(nincs.includes('youtube_nincs_csatorna'), 'the code the operator can look up comes first')
  assert.ok(nincs.includes('beállítás'), 'and the sentence says the fix is in the settings')
  assert.equal(nincs.includes('sikertelen'), false)
  assert.equal(ujratoltesek, 0, 'nothing opened, so the board has nothing new to show')

  // A missing binary is a different fact and gets a different sentence.
  otletek = () => Promise.resolve({ hiba: 'ytdlp_hianyzik', uzenet: 'a beállított útvonalon nincs futtatható yt-dlp: ...' })
  body().onKattint()
  await settle()
  const nincsBinaris = body().mondatok.join(' | ')
  assert.ok(nincsBinaris.includes('ytdlp_hianyzik'))
  assert.ok(nincsBinaris.includes('útvonalon'))
  assert.equal(ujratoltesek, 0)

  // 2. REJECTED: no answer to read for a refusal and no act to report.
  otletek = () => Promise.reject(new Error('Failed to fetch'))
  body().onKattint()
  await settle()
  assert.equal(body().mondatok.join(' | '), 'Az ötletek kérése el sem jutott a modulhoz: Failed to fetch')
  assert.equal(ujratoltesek, 0)

  // 3. RESOLVED WITHOUT `hiba`: cards opened, and the board behind the button
  //    is reloaded or the new videos are nowhere to be seen.
  otletek = () => Promise.resolve(ytOtletek({ nyitott: [{ videoId: 'v1', cim: 'Egy' }], jelolt: 1 }))
  body().onKattint()
  await settle()
  assert.ok(body().mondatok.join(' | ').includes('1 új ötlet'))
  assert.equal(ujratoltesek, 1)
  assert.equal(body().dolgozik, false, 'the button comes back to life whichever way the press ended')
})
