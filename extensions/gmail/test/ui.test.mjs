import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'

import { renderToStaticMarkup } from 'react-dom/server'
import { jsx } from 'react/jsx-runtime'

import { RpcRefusal, errorCode, errorText, readBoard, readHealth, readKiadas, readKiserletek, readLiveDraft, readMcpConfig, unwrap } from '../ui/api.ts'
import { bundle } from '../scripts/build.mjs'
import { CimzettekNezet, KonyvTabla } from '../ui/cimzettek.tsx'
import { HEALTH_CODES } from '../src/health.mjs'
import { KiadasPanel, LezartSor, PiszkozatKartya } from '../ui/kimeno.tsx'
import { KiserletekTabla } from '../ui/kiserletek.tsx'
import { LAP_HEALTH_CODES, allapotLabel, bekothetoE, cimEntrybol, cimekFejlecbol, healthMondat, keretSzoveg, konyvKiiras, konyvonKivuliek, mcpJson } from '../ui/format.ts'
import { McpBlokk, UninstallBlokk } from '../ui/lablec.tsx'
import { StatusBar } from '../ui/status-bar.tsx'

/**
 * The page, driven without a browser.
 *
 * What can be pinned here is pinned here: the sentence every health code maps
 * to, the arithmetic of "which recipient is outside the book", the readers'
 * refusals, and what each state looks like once drawn. A state is drawn by
 * rendering its component to static markup and reading the string, which is
 * enough to see a stranger's subject arrive as text, a `bizonytalan` row
 * arrive with no release control, a full body arrive untruncated, and a
 * disabled connect button arrive with its sentence beside it.
 *
 * WHAT THIS FILE CANNOT SEE, and what the browser pass is for: the bundle
 * loaded through the shell, its hooks running against the host's React, the
 * CSP the shell sends, and a key press that React dispatches to a focused
 * control. The stateful halves load in an effect or on a click, neither of
 * which a server render runs, so the split-out pure components are what the
 * state tests render.
 */

const render = (type, props) => renderToStaticMarkup(jsx(type, props))
const noop = () => {}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Hostile on purpose: markup, an event attribute, and a scheme that must never become a link target. */
const HTML = '<script>alert(1)</script><img src=x onerror=alert(2)>'
const JS_URL = 'javascript:alert(3)'
/** 900 characters with no space in them. The layout rule is that this cannot widen the page or cover a button. */
const HOSSZU_SZO = 'árvíztűrő'.repeat(100)

function keret(overrides = {}) {
  return { mai: 0, keret: 20, olvashatatlan: false, ...overrides }
}

function szamok(overrides = {}) {
  return { cimzettek: 2, eloCimzettek: 1, piszkozat: 1, kiadva: 0, elvetve: 0, hiba: 0, bizonytalan: 0, kiserletek: 0, ...overrides }
}

function health(overrides = {}) {
  return {
    ok: true,
    hibak: [],
    figyelmeztetesek: [],
    nemValaszolt: [],
    blokkolt: [],
    postafiok: 'operator@example.test',
    keretek: { nap: '2026-09-05', piszkozat: keret(), kiadas: keret({ keret: 10 }) },
    szamok: szamok(),
    portFajl: { utvonal: '/tmp/home/run/port.json', letezik: true, elo: true },
    ...overrides,
  }
}

function konyvSor(overrides = {}) {
  return { handle: 'dorina', cim: 'dorina@example.test', megjegyzes: 'ügyfél', createdAt: '2026-09-01T10:00:00.000Z', visszavontAt: null, ...overrides }
}

function kimenoSor(overrides = {}) {
  return {
    id: 'a1b2c3d4e5f60718',
    allapot: 'piszkozat',
    ajto: 'rpc',
    cimzettHandlek: ['dorina'],
    cimzettCimek: ['dorina@example.test'],
    valaszUzenetId: '',
    targy: 'Egy tárgy',
    torzs: 'Egy törzs.',
    torzsHash: 'a'.repeat(64),
    gmailDraftId: 'r-1',
    gmailMessageId: '',
    szerkesztveAt: '',
    konyvonKivul: [],
    kiadvaAt: '',
    hibaKod: '',
    hibaSzoveg: '',
    createdAt: '2026-09-02T10:00:00.000Z',
    updatedAt: '2026-09-02T10:00:00.000Z',
    ...overrides,
  }
}

function liveDraft(overrides = {}) {
  return {
    kimenoId: 'a1b2c3d4e5f60718',
    gmailDraftId: 'r-1',
    cimek: 'dorina@example.test',
    targy: 'Egy tárgy',
    torzs: 'Egy törzs.',
    eloHash: 'b'.repeat(64),
    sorHash: 'a'.repeat(64),
    szerkesztve: true,
    ...overrides,
  }
}

// --- build ---

test('the built gmail bundle carries no React of its own and resolves the host modules', async () => {
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
  assert.ok(text.includes("registerPage('gmail'") || text.includes('registerPage("gmail"'))
})

test('the built gmail bundle installs no listener, writes no markup and creates no link target', async () => {
  const result = await bundle({ write: false })
  const text = result.outputFiles.map((f) => f.text).join('\n')
  // The aisignal review found a window-level key handler stealing Enter from
  // every focused control on that page, so a keyboard operator could activate
  // nothing and each attempt opened a stranger's url. This page holds no
  // listener at all: activation is the browser's own, on plain buttons and one
  // form.
  assert.equal(text.includes('window.addEventListener'), false)
  assert.equal(text.includes('addEventListener('), false)
  assert.equal(text.includes('onKeyDown'), false)
  // Nothing on this page writes markup or evaluates a string.
  assert.equal(text.includes('innerHTML'), false)
  assert.equal(text.includes('dangerouslySetInnerHTML'), false)
  assert.equal(text.includes('eval('), false)
  // Stronger than a scheme check: no element on this page has an href at all,
  // so no stored url can become a link target however it is spelled. The one
  // navigation the page makes is the host's own consent route, by assignment.
  assert.equal(text.includes('href'), false)
  assert.ok(text.includes('/api/oauth/google/start?purpose=gmail'))
})

test('the built gmail bundle computes no hash of its own: the confirmation is the one the server sent', async () => {
  const result = await bundle({ write: false })
  const text = result.outputFiles.map((f) => f.text).join('\n')
  // Two implementations of one fingerprint is how a page ends up confirming a
  // hash of something other than what it displayed, and the second one's drift
  // would show up as a silent gmail_lap_elavult on every release.
  assert.equal(text.includes('sha256'), false)
  assert.equal(text.includes('crypto.subtle'), false)
  assert.equal(text.includes('digest('), false)
  assert.ok(text.includes('megerosites'), 'the confirmation is still sent, just not computed here')
})

test('the built gmail bundle registers the declared page with the host React and the id the loader stamped', async () => {
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
  const document = { currentScript: new HTMLElement({ extension: 'gmail.mjs' }) }
  vm.runInNewContext(code, { window, document, HTMLElement, Error, Object, console }, { filename: 'dist/index.js' })
  assert.equal(registrations.length, 1)
  const [{ pageId, component, opts }] = registrations
  assert.equal(pageId, 'gmail')
  assert.equal(opts.extensionId, 'gmail.mjs')
  assert.equal(opts.react, React, 'the very object on window.swarmclaw.modules, not a copy')
  assert.equal(typeof component, 'function')
  // Before the first load lands the page says so rather than drawing an empty
  // queue -- but the status bar, the tabs and the foot do not come from the
  // board and must not wait on it.
  const html = renderToStaticMarkup(jsx(component, { extensionId: 'gmail.mjs', rpc: async () => ({}) }))
  assert.ok(html.includes('data-extension="gmail.mjs"'))
  assert.ok(html.includes('Betöltés'))
  assert.ok(html.includes('gm-status'), 'the status bar is drawn without the board')
  assert.ok(html.includes('Az állapot lekérdezése folyamatban'))
  assert.ok(html.includes('role="tablist"'))
  assert.ok(html.includes('Uninstall előtt'), 'the uninstall guide is readable before anything loads')
})

test('the built gmail bundle names the missing host module instead of failing inside React', async () => {
  const result = await bundle({ write: false })
  const code = result.outputFiles.find((f) => f.path.endsWith('.js')).text
  const window = { swarmclaw: { modules: {}, registerPage: () => {} } }
  assert.throws(() => vm.runInNewContext(code, { window, document: { currentScript: null }, Error, Object }), /host module missing: react/)
})

test('the stylesheet only names gm- prefixed selectors, so it cannot restyle the shell', () => {
  const css = fs.readFileSync(path.join(root, 'ui/style.css'), 'utf8')
  const bodyless = css.replace(/\/\*[\s\S]*?\*\//g, '')
  for (const match of bodyless.matchAll(/([^{}]+)\{/g)) {
    for (const selector of match[1].split(',')) {
      const trimmed = selector.trim()
      if (trimmed === '') continue
      assert.ok(trimmed.startsWith('.gm-'), `every selector starts inside the page: ${trimmed}`)
    }
  }
})

// --- the health vocabulary: one sentence per code, and the two lists held equal ---

test('every health code the server can send has a sentence on this page, and every sentence has a code', () => {
  assert.deepEqual([...LAP_HEALTH_CODES].sort(), [...HEALTH_CODES].sort())
})

test('each of the six codes gets its own sentence rather than a shared one', () => {
  const mondatok = HEALTH_CODES.map((kod) => healthMondat({ kod }).mondat)
  assert.equal(new Set(mondatok).size, HEALTH_CODES.length, 'no two codes share a sentence')
  for (const lap of HEALTH_CODES.map((kod) => healthMondat({ kod }))) {
    assert.equal(lap.ismert, true)
    assert.notEqual(lap.teendo, '')
  }
})

test('the missing-client sentence names the deploy mode and that mode own env pair', () => {
  const desktop = healthMondat({ kod: 'google_oauth_client_missing', mode: 'desktop' })
  assert.ok(desktop.mondat.includes('Mód: desktop'))
  assert.ok(desktop.mondat.includes('A bekötés gomb ezért ki van kapcsolva'))
  assert.ok(desktop.teendo.includes('GOOGLE_OAUTH_CLIENT_DESKTOP_ID'))
  assert.ok(desktop.teendo.includes('GOOGLE_OAUTH_CLIENT_DESKTOP_SECRET'))
  assert.equal(desktop.teendo.includes('GOOGLE_OAUTH_CLIENT_WEB_ID'), false, 'the pair that will not be read is not named')

  const vps = healthMondat({ kod: 'google_oauth_client_missing', mode: 'vps' })
  assert.ok(vps.mondat.includes('Mód: vps'))
  assert.ok(vps.teendo.includes('GOOGLE_OAUTH_CLIENT_WEB_ID'))
  assert.ok(vps.teendo.includes('GOOGLE_OAUTH_CLIENT_WEB_SECRET'))
  assert.equal(vps.teendo.includes('GOOGLE_OAUTH_CLIENT_DESKTOP_ID'), false)
})

test('a mode this page does not recognise names both pairs and says the mode was not reported', () => {
  const ismeretlen = healthMondat({ kod: 'google_oauth_client_missing', mode: 'kubernetes' })
  assert.ok(ismeretlen.mondat.includes('nem mondta meg, melyik módban fut'))
  assert.ok(ismeretlen.teendo.includes('GOOGLE_OAUTH_CLIENT_DESKTOP_ID'))
  assert.ok(ismeretlen.teendo.includes('GOOGLE_OAUTH_CLIENT_WEB_ID'))
})

test('the empty-book sentence says which of the two drafting paths is stopped, and not more', () => {
  const lap = healthMondat({ kod: 'gmail_cimzettkonyv_ures' })
  assert.ok(lap.mondat.includes('könyvbeli handle-re címzett piszkozat nem készíthető'))
  assert.ok(lap.mondat.includes('Válasz-piszkozat készíthető'))
})

test('a code with no sentence here is shown as the code, never dropped and never given another code words', () => {
  const lap = healthMondat({ kod: 'gmail_valami_uj' })
  assert.equal(lap.ismert, false)
  assert.equal(lap.mondat, 'gmail_valami_uj')
  assert.ok(lap.teendo.includes('nincs mondat'))
})

test('bekothetoE disables the button only for a client that is known to be missing', () => {
  assert.equal(bekothetoE([]), true)
  assert.equal(bekothetoE([{ kod: 'gmail_hitelesites_hianyzik' }]), true)
  assert.equal(bekothetoE([{ kod: 'google_oauth_client_missing', mode: 'vps' }]), false)
})

// --- the status bar as drawn ---

test('with no OAuth client the connect button is disabled with the sentence, not hidden', () => {
  const html = render(StatusBar, {
    health: health({
      ok: false,
      hibak: [{ kod: 'google_oauth_client_missing', mode: 'vps' }],
      blokkolt: ['kiadas', 'olvasas', 'piszkozat_konyvbol', 'piszkozat_valasz'],
      postafiok: null,
    }),
    healthError: null,
    onRefresh: noop,
  })
  assert.ok(html.includes('Postafiók bekötése'), 'the control is still on the page')
  assert.ok(/<button[^>]*disabled[^>]*>Postafiók bekötése<\/button>/.test(html), 'and it is disabled')
  assert.ok(html.includes('nincs OAuth-kliens'))
  assert.ok(html.includes('GOOGLE_OAUTH_CLIENT_WEB_ID'))
  assert.ok(html.includes('Most blokkolt képességek: kiadas, olvasas'))
  assert.ok(html.includes('nincs olyan cím, amit a profil-olvasás visszaadott volna'))
})

test('a health that has not arrived leaves the button live and says the 409 will carry the remedy', () => {
  const html = render(StatusBar, { health: null, healthError: null, onRefresh: noop })
  assert.equal(/<button[^>]*disabled[^>]*>Postafiók bekötése<\/button>/.test(html), false)
  assert.ok(html.includes('409-cel válaszol'))
  assert.ok(html.includes('Az állapot lekérdezése folyamatban'))
})

test('a health that could not be read says so instead of drawing a calm bar', () => {
  const html = render(StatusBar, { health: null, healthError: 'a host 500-zal válaszolt', onRefresh: noop })
  assert.ok(html.includes('Az állapotot nem tudtam lekérdezni: a host 500-zal válaszolt'))
  assert.equal(html.includes('Nincs blokkolt képesség'), false)
})

test('a warning is drawn as a warning and never folded into the failures', () => {
  const html = render(StatusBar, {
    health: health({ figyelmeztetesek: [{ kod: 'gmail_port_fajl_hianyzik' }], blokkolt: ['mcp'] }),
    healthError: null,
    onRefresh: noop,
  })
  assert.ok(html.includes('gm-warn'))
  assert.ok(html.includes('Az MCP-szerver nem találná meg ezt a hostot'))
  assert.ok(html.includes('Most blokkolt képességek: mcp'))
  // A connected mailbox is still reported: a warning stops one capability.
  assert.ok(html.includes('Bekötött postafiók: operator@example.test'))
})

test('a question nobody answered is its own line, and the bar says the absence is not a pass', () => {
  const html = render(StatusBar, {
    health: health({ nemValaszolt: [{ mit: 'postafiok', kod: 'gmail_timeout' }, { mit: 'hitelesites', kod: null }] }),
    healthError: null,
    onRefresh: noop,
  })
  assert.ok(html.includes('postafiok (gmail_timeout)'))
  assert.ok(html.includes('hitelesites (kód nélkül)'))
  assert.ok(html.includes('nem következik, hogy rendben vannak'))
})

test('an unreadable budget prints ? and the reason, never the default', () => {
  assert.equal(keretSzoveg('piszkozat', 3, 20, false), 'piszkozat 3/20')
  const olvashatatlan = keretSzoveg('kiadás', 0, null, true)
  assert.ok(olvashatatlan.startsWith('kiadás 0/?'))
  assert.ok(olvashatatlan.includes('nem olvasható'))
  assert.equal(olvashatatlan.includes('10'), false)
})

// --- the outbound view ---

test('a draft card shows the whole body, the handle with its address, and both controls', () => {
  const html = render(PiszkozatKartya, {
    sor: kimenoSor({ targy: HTML, torzs: `${HOSSZU_SZO}\n${JS_URL}` }),
    konyv: [konyvSor()],
    dolgozik: false,
    elokeszitve: false,
    onElokeszit: noop,
    onElvet: noop,
  })
  assert.ok(html.includes('dorina — dorina@example.test'))
  assert.ok(html.includes('Kiadás előkészítése'))
  assert.ok(html.includes('Elvetés'))
  // The subject is a stranger's markup and arrives escaped, as text.
  assert.equal(html.includes('<script>alert(1)</script>'), false)
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'))
  // The body is whole: what is going to be sent is what has to be readable.
  assert.ok(html.includes(HOSSZU_SZO), 'the long word is not truncated')
  assert.ok(html.includes('javascript:alert(3)'), 'the url is shown')
  assert.equal(html.includes('href'), false, 'and never as a link target')
})

test('a recipient the live book does not know is marked on the draft card', () => {
  const html = render(PiszkozatKartya, {
    sor: kimenoSor({ cimzettHandlek: ['dorina', 'peter'], cimzettCimek: ['dorina@example.test', 'peter@example.test'] }),
    konyv: [konyvSor(), konyvSor({ handle: 'peter', cim: 'peter@example.test', visszavontAt: '2026-09-03T10:00:00.000Z' })],
    dolgozik: false,
    elokeszitve: false,
    onElokeszit: noop,
    onElvet: noop,
  })
  // A retired entry counts as outside the book, exactly as the release counts it.
  assert.ok(html.includes('peter — peter@example.test — nincs az élő könyvben'))
  assert.equal(html.includes('dorina — dorina@example.test — nincs az élő könyvben'), false)
})

test('the release panel shows the live body, the live hash and the edited-in-Gmail sentence', () => {
  const html = render(KiadasPanel, {
    live: liveDraft({ torzs: `Ezt küldöm.\n${HTML}`, cimek: '"Kis, Péter" <peter@example.test>, dorina@example.test' }),
    konyv: [konyvSor()],
    olvastam: false,
    onOlvastam: noop,
    onKiad: noop,
    onMegsem: noop,
    dolgozik: false,
  })
  assert.ok(html.includes('Ez fog kimenni'))
  assert.ok(html.includes('most lett kiolvasva a Gmailből'))
  assert.ok(html.includes('a Gmailben megváltozott'))
  assert.ok(html.includes(`megerősítés: ${'b'.repeat(64)}`))
  assert.ok(html.includes('Ezt küldöm.'))
  assert.equal(html.includes('<script>alert(1)</script>'), false)
  // The display name holds a comma and is one recipient, not two.
  assert.ok(html.includes('&quot;Kis, Péter&quot; &lt;peter@example.test&gt;'))
  assert.ok(html.includes('Címzettek (2)'))
  assert.ok(html.includes('nincs az élő könyvben'), 'the address the book does not know is named')
})

test('the release button is disabled until the operator ticks the box, and says so', () => {
  const zarva = render(KiadasPanel, {
    live: liveDraft(), konyv: [konyvSor()], olvastam: false, onOlvastam: noop, onKiad: noop, onMegsem: noop, dolgozik: false,
  })
  assert.ok(/<button[^>]*disabled[^>]*>Kiadás<\/button>/.test(zarva))
  assert.ok(zarva.includes('amíg a jelölőnégyzet üres'))

  const nyitva = render(KiadasPanel, {
    live: liveDraft(), konyv: [konyvSor()], olvastam: true, onOlvastam: noop, onKiad: noop, onMegsem: noop, dolgozik: false,
  })
  assert.equal(/<button[^>]*disabled[^>]*>Kiadás<\/button>/.test(nyitva), false)
  assert.equal(nyitva.includes('amíg a jelölőnégyzet üres'), false)
})

test('an unedited draft says the live copy matches the row rather than staying silent', () => {
  const html = render(KiadasPanel, {
    live: liveDraft({ szerkesztve: false }), konyv: [konyvSor()], olvastam: false, onOlvastam: noop, onKiad: noop, onMegsem: noop, dolgozik: false,
  })
  assert.ok(html.includes('megegyezik a tárolt sorral'))
  assert.equal(html.includes('a Gmailben megváltozott'), false)
})

test('a bizonytalan row is its own thing, carries the look-in-Sent sentence, and offers no release', () => {
  const html = render(LezartSor, {
    sor: kimenoSor({ allapot: 'bizonytalan', hibaKod: 'gmail_timeout', hibaSzoveg: 'a kérés határideje lejárt' }),
  })
  assert.ok(html.includes('gm-sor-bizonytalan'))
  assert.ok(html.includes('Bizonytalan'))
  assert.ok(html.includes('Nem tudjuk, kiment-e a levél'))
  assert.ok(html.includes('Elküldött mappáját'))
  assert.ok(html.includes('gmail_timeout'))
  assert.equal(html.includes('Kiadás'), false, 'no second send is ever offered')
  assert.equal(html.includes('<button'), false, 'a terminal row has no control at all')
})

test('a bizonytalan row with no cause says the process stopped before it could write one', () => {
  const html = render(LezartSor, { sor: kimenoSor({ allapot: 'bizonytalan' }) })
  assert.ok(html.includes('mielőtt bármit vissza tudott volna írni'))
})

test('a released row names the sent message and the recipients the book did not know', () => {
  const html = render(LezartSor, {
    sor: kimenoSor({ allapot: 'kiadva', gmailMessageId: 'm-77', kiadvaAt: '2026-09-04T09:00:00.000Z', konyvonKivul: ['idegen@example.test'] }),
  })
  assert.ok(html.includes('m-77'))
  assert.ok(html.includes('1 címzett nem volt az élő könyvben: idegen@example.test'))
  assert.equal(html.includes('<button'), false)
})

test('a state this page has no word for is shown raw and flagged, not folded into a known one', () => {
  assert.deepEqual(allapotLabel('piszkozat'), { label: 'Piszkozat', known: true })
  assert.deepEqual(allapotLabel('felfuggesztve'), { label: 'felfuggesztve', known: false })
  assert.deepEqual(allapotLabel(''), { label: '(üres állapot)', known: false })
  const html = render(LezartSor, { sor: kimenoSor({ allapot: 'felfuggesztve' }) })
  assert.ok(html.includes('ezt az állapotot ez a lap nem ismeri'))
})

// --- the book arithmetic, which decides which chip is highlighted ---

test('konyvonKivuliek counts a retired entry as outside the book and folds case only for the comparison', () => {
  const konyv = [
    konyvSor({ handle: 'dorina', cim: 'Dorina@Example.test' }),
    konyvSor({ handle: 'peter', cim: 'peter@example.test', visszavontAt: '2026-09-03T10:00:00.000Z' }),
  ]
  assert.deepEqual(konyvonKivuliek(['dorina@example.test'], konyv), [])
  assert.deepEqual(konyvonKivuliek(['peter@example.test'], konyv), ['peter@example.test'])
  assert.deepEqual(konyvonKivuliek(['UJ@example.test'], konyv), ['UJ@example.test'], 'the returned value keeps its own case')
})

test('the display split respects quotes and angle brackets, so one recipient stays one', () => {
  assert.deepEqual(cimekFejlecbol('a@example.test, b@example.test'), ['a@example.test', 'b@example.test'])
  assert.deepEqual(cimekFejlecbol('"Kis, Péter" <peter@example.test>, dorina@example.test'), ['"Kis, Péter" <peter@example.test>', 'dorina@example.test'])
  assert.deepEqual(cimekFejlecbol(''), [])
  assert.equal(cimEntrybol('"Kis, Péter" <peter@example.test>'), 'peter@example.test')
  assert.equal(cimEntrybol('dorina@example.test'), 'dorina@example.test')
})

// --- the recipient book, and the sentence that makes it the gate ---

test('the recipients view says it is the only place an address enters this module', () => {
  const html = render(CimzettekNezet, { konyv: [konyvSor()], rpc: async () => ({}), onChanged: noop })
  assert.ok(html.includes('Ez az egyetlen hely, ahol e-mail-cím keletkezik ehhez a modulhoz'))
  assert.ok(html.includes('Se a szerződés, se az MCP-szerver nem tud címet felvenni'))
  assert.ok(html.includes('Felvesz'))
  assert.ok(html.includes('Visszavon'))
})

test('an empty book says which drafting path that stops, and offers the form anyway', () => {
  const html = render(CimzettekNezet, { konyv: [], rpc: async () => ({}), onChanged: noop })
  assert.ok(html.includes('A címzettkönyv üres'))
  assert.ok(html.includes('válasz-piszkozat igen'))
  assert.ok(html.includes('Új címzett'))
})

test('a retired entry stays visible with the moment of its withdrawal and no Visszavon button', () => {
  const html = render(KonyvTabla, {
    konyv: [konyvSor({ handle: 'peter', cim: 'peter@example.test', visszavontAt: '2026-09-03T10:00:00.000Z' })],
    dolgozik: false,
    onVisszavon: noop,
  })
  assert.ok(html.includes('gm-visszavont'))
  assert.ok(html.includes('visszavonva'))
  assert.equal(html.includes('>Visszavon<'), false)
})

// --- the attempts view: somebody else's text, labelled as such ---

test('the attempts view labels the requested text as a stranger text above the box and renders it as text', () => {
  const html = render(KiserletekTabla, {
    data: {
      limit: 50,
      items: [{ id: 'k1', ajto: 'szerzodes', kod: 'gmail_cimzett_cim_literal', mit: `{"cimzettHandlek":["${HTML}"]}`, at: '2026-09-04T08:00:00.000Z' }],
    },
  })
  assert.ok(html.includes('Idegen szöveg: ezt a kérő írta, nem ez a modul'))
  assert.ok(html.includes('gmail_cimzett_cim_literal'))
  assert.ok(html.includes('szerződés-ajtó'))
  assert.equal(html.includes('<script>alert(1)</script>'), false)
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'))
  // The label sits outside the box, so it cannot be covered by what is inside it.
  assert.ok(html.indexOf('Idegen szöveg') < html.indexOf('&lt;script&gt;'))
})

test('an empty attempts list is the good news and says so, and is never what a failure looks like', () => {
  const html = render(KiserletekTabla, { data: { limit: 50, items: [] } })
  assert.ok(html.includes('Nincs visszautasított kimenő kérés'))
})

// --- the foot ---

test('the MCP block prints the entry, warns about the absolute path and prints no key value', () => {
  const config = {
    id: 'gmail',
    name: 'SwarmClaw Gmail (gmail)',
    transport: 'stdio',
    command: '/Applications/SwarmClaw.app/Contents/MacOS/SwarmClaw',
    args: ['/tmp/ws/mcp/server.mjs'],
    env: { ELECTRON_RUN_AS_NODE: '1', SWARMCLAW_PORT_FILE: '/tmp/home/run/port.json', SWARMCLAW_ACCESS_KEY: 'az ACCESS_KEY értéke a host .env.local fájljából; ide kézzel' },
  }
  const html = render(McpBlokk, { config })
  assert.ok(html.includes('SWARMCLAW_PORT_FILE'))
  assert.ok(html.includes('ELECTRON_RUN_AS_NODE'))
  assert.ok(html.includes('másold be újra ezt a blokkot'))
  assert.ok(html.includes('kulcsértéket sem nem olvas, sem nem ír ki'))
  assert.ok(mcpJson(config).includes('"transport": "stdio"'))
})

test('the uninstall guide names every step the host does not do, and prints the book to copy', () => {
  const html = render(UninstallBlokk, { konyv: [konyvSor(), konyvSor({ handle: 'peter', cim: 'peter@example.test', visszavontAt: '2026-09-03T10:00:00.000Z' })], nyitottPiszkozat: 3 })
  assert.ok(html.includes('Most 3 nyitott piszkozat van'))
  assert.ok(html.includes('google-oauth:gmail'))
  assert.ok(html.includes('google-oauth:aisignal'))
  assert.ok(html.includes('A törlés nem visszavonás'))
  assert.ok(html.includes('MCP-bejegyzést'))
  assert.ok(html.includes('a címzettkönyv elvész'))
  assert.ok(html.includes('dorina\tdorina@example.test'))
  assert.ok(html.includes('visszavonva: 2026-09-03T10:00:00.000Z'))
})

test('an unknown draft count and an unreadable book are said, not printed as zero and empty', () => {
  const html = render(UninstallBlokk, { konyv: null, nyitottPiszkozat: null })
  assert.ok(html.includes('azt most nem tudni'))
  assert.ok(html.includes('nem sikerült betölteni, tehát nem tudni, mi van benne'))
  assert.equal(konyvKiiras([]), '(a címzettkönyv üres)')
})

// --- the readers: a refusal is a refusal, never an empty list ---

test('unwrap turns the rpc error envelope into a throw that still carries the code', () => {
  assert.throws(
    () => unwrap('board', { error: { code: 'gmail_kiadas_keret_kimerult', message: 'a mai kiadasi keret betelt: 10/10', keret: 10 } }),
    (err) => {
      assert.ok(err instanceof RpcRefusal)
      assert.equal(err.code, 'gmail_kiadas_keret_kimerult')
      assert.equal(err.extra.keret, 10)
      assert.equal(errorCode(err), 'gmail_kiadas_keret_kimerult')
      assert.equal(errorText(err), 'gmail_kiadas_keret_kimerult: a mai kiadasi keret betelt: 10/10')
      return true
    },
  )
})

test('a refused board is refused rather than drawn as an install with no drafts and no recipients', () => {
  // The code is carried on the error, not spelled into its message: a caller
  // branching on `gmail_kiadas_bizonytalan` reads the field, not the prose.
  const kod = (expected) => (err) => err instanceof RpcRefusal && err.code === expected
  assert.throws(() => readBoard({ error: { code: 'gmail_szerzodes_hiba', message: 'nem válaszolt' } }), kod('gmail_szerzodes_hiba'))
  assert.throws(() => readKiserletek({ error: { code: 'gmail_argumentum_alak', message: 'limit' } }), kod('gmail_argumentum_alak'))
  assert.throws(() => readMcpConfig({ error: { code: 'gmail_argumentum_alak', message: 'x' } }), kod('gmail_argumentum_alak'))
})

test('the board reader names the first field it lacks and never defaults the book to empty', () => {
  const teljes = { health: health(), kimeno: { total: 1, count: 1, items: [] }, kimenoLimit: 100, konyv: [] }
  assert.equal(readBoard(teljes).konyv.length, 0)
  const konyvNelkul = { ...teljes }
  delete konyvNelkul.konyv
  assert.throws(() => readBoard(konyvNelkul), /hiányzik a konyv mező/)
  const kimenoNelkul = { ...teljes }
  delete kimenoNelkul.kimeno
  assert.throws(() => readBoard(kimenoNelkul), /hiányzik a kimeno mező/)
})

test('the health reader requires all four lists, because an empty one reads as a pass', () => {
  for (const field of ['hibak', 'figyelmeztetesek', 'nemValaszolt', 'blokkolt']) {
    const csonka = health()
    delete csonka[field]
    assert.throws(() => readHealth(csonka), new RegExp(`hiányzik a ${field} mező`))
  }
  const olvasott = readHealth(health({ keretek: { nap: '2026-09-05', piszkozat: { mai: 4, keret: null, olvashatatlan: true }, kiadas: keret({ keret: 10 }) } }))
  assert.equal(olvasott.keretek.piszkozat.keret, null)
  assert.equal(olvasott.keretek.piszkozat.olvashatatlan, true)
})

test('a liveDraft without the hash or the body is refused, so no release is offered for bytes nobody saw', () => {
  assert.equal(readLiveDraft(liveDraft()).eloHash, 'b'.repeat(64))
  const hashNelkul = liveDraft()
  delete hashNelkul.eloHash
  assert.throws(() => readLiveDraft(hashNelkul), /hiányzik a eloHash mező/)
  const torzsNelkul = liveDraft()
  delete torzsNelkul.torzs
  assert.throws(() => readLiveDraft(torzsNelkul), /hiányzik a torzs mező/)
})

test('a release answer without the sent message id is not reported as a send', () => {
  const jo = readKiadas({ kimenoId: 'a1', gmailMessageId: 'm-1', kiadvaAt: '2026-09-04T09:00:00.000Z', szerkesztve: false, konyvonKivul: [], torzsHash: 'b'.repeat(64) })
  assert.equal(jo.gmailMessageId, 'm-1')
  assert.throws(() => readKiadas({ kimenoId: 'a1' }), /hiányzik a gmailMessageId mező/)
})

test('errorText keeps a plain failure as its own message and stringifies anything else', () => {
  assert.equal(errorText(new Error('offline')), 'offline')
  assert.equal(errorText('nyers'), 'nyers')
  assert.equal(errorCode(new Error('offline')), null)
})

test('the outcome message lives outside the subtrees the board reload remounts', () => {
  // Found in a browser, not here: the queue and the book are keyed on the
  // board's load counter, so the refresh that follows a successful write
  // remounts them. With the message state inside one of those views, a letter
  // went out and the page said nothing at all -- the reload wiped the sentence
  // reporting the one write in this system that cannot be undone. The gate is
  // structural: only main.tsx may draw the notice, and the two keyed views may
  // only report into it.
  const ui = (name) => fs.readFileSync(path.join(root, 'ui', name), 'utf8')
  for (const name of ['kimeno.tsx', 'cimzettek.tsx']) {
    const src = ui(name)
    assert.equal(src.includes('gm-notice'), false, `${name} must not draw the notice itself`)
    assert.ok(src.includes('onUzenet'), `${name} reports its outcome to the page`)
  }
  const main = ui('main.tsx')
  assert.ok(main.includes('gm-notice'), 'main.tsx draws the notice')
  assert.ok(main.includes('setUzenet'), 'and owns its state')
  // And it is drawn before the tabs, so it is not inside a view either.
  assert.ok(main.indexOf('gm-notice') < main.indexOf('gm-tabs'))
})
