import assert from 'node:assert/strict'
import test from 'node:test'

import { AGENTS } from '../src/agents.mjs'
import { AG_ALLAPOTOK, KIADAS_ALLAPOTOK, PLATFORMOK } from '../src/db.mjs'
import { LEKTOR_KODOK, PLATFORM_KORLATOK, SzovegError, VERDIKTEK, createSzovegTools, kiadastUjraprobal, kiadastUtemezSavba, korlatOf } from '../src/szoveg.mjs'
import { freshRepo } from './helpers.mjs'

/**
 * Task 4's three tools (`publishDraft`, `publishVerdict`, `publishDue`),
 * plus `publishOpen`/`publishQueue` (the file docblock in `src/szoveg.mjs`
 * explains why those two exist despite not being in the brief's named
 * interface list) and `kiadastUtemezSavba` (the scheduling half of the
 * approval step, exported for a later task).
 *
 * `setup()` follows `extensions/video/test/terv.test.mjs`'s own pattern: a
 * state with an in-memory repository and a `contracts` double, a `run`
 * helper that calls a tool's `execute` the way the host does.
 */
function setup({ video = null, videos = null, why = 'provider_missing', adapterek = {}, settings = {}, contracts, log } = {}) {
  const { repo } = freshRepo()
  // `video` (singular) stays for every test that only ever asks about one
  // video by id; `videos` is the R1 addition for a test whose fixture needs
  // more than one (publishDue now reads the video row of EVERY due release,
  // not only the one `publishOpen` opened).
  const videoById = new Map((videos ?? (video ? [video] : [])).map((v) => [v.id, v]))
  let beallitasok = settings
  const state = {
    repo,
    // MUTABLE, ÉS MINDEN HÍVÁSRA FRISS OBJEKTUM -- a host `ctx.settings`-e is
    // minden kérdésre újraolvassa a tárolt beállításokat és új objektumot ad.
    // Egy duplum, ami ugyanazt a befagyasztott objektumot adja vissza,
    // szigorúan könnyebb világ a valóságosnál, és el is takar egy egész
    // bughibaosztályt: egy hívó, ami EGYSZER olvasná ki a beállítást (a
    // konstrukciókor, ami az `index.mjs`-ben modulbetöltés), örökre a
    // folyamat indulásakori zónával válaszolna, és ezt egy örökké ugyanazt
    // adó duplum nem tudja megkülönböztetni a helyes olvasástól.
    // `test/rpc.test.mjs` setup()-ja ugyanezt mondja a maga oldaláról.
    settings: () => ({ ...beallitasok }),
    log: log ?? { info() {}, warn() {}, error() {} },
    contracts: contracts === undefined
      ? { get: (e, c) => (e === 'video' && c === 'videos' ? { get: async ({ id }) => videoById.get(id) ?? null } : null), why: () => why }
      : contracts,
    adapterek,
  }
  const tools = Object.fromEntries(createSzovegTools(state).map((t) => [t.name, t]))
  const run = (name, args, agentId = 'ag-1', sessionId = 's1') => tools[name].execute(args, { session: { id: sessionId, agentId }, message: '' })
  return { state, repo, run, tools, beallitasokatIr: (ujak) => { beallitasok = ujak } }
}

/** A qa_ok video the way `video.videos@1` projects one -- only the fields this module reads. */
function qaOkVideo(id, extra = {}) {
  return { id, cim: 'Egy videó', status: 'qa_ok', narracio_szoveg: 'Ez hangzik el a videóban.', ...extra }
}

// --- brief 4.1's own failing tests --------------------------------------

test('a platform hosszkorlátját túllépő szöveg megnevezve utasul el', async () => {
  const { repo, run } = setup()
  const k = repo.ujKiadas({ videoId: 'v1' })
  const r = await run('publishDraft', { kiadasId: k.id, szovegek: [
    { platform: 'youtube', cim: 'x'.repeat(101), leiras: 'y' },
  ] })
  assert.equal(r.error.code, 'szoveg_tul_hosszu')
  assert.equal(r.error.platform, 'youtube')
  assert.equal(r.error.message.includes('xxx'), false, 'a hívó szövege nem kerül az üzenetbe')
})

test('a lektori kódlista zárt, és a videó modul szavát használja, ahol a jelentés ugyanaz', () => {
  assert.ok(LEKTOR_KODOK.includes('allitas_forras_nelkul'), 'egy tényre egy név: az operátor ne tanuljon kettőt')
  assert.ok(LEKTOR_KODOK.includes('hashtag_kitalalt'))
  assert.equal(new Set(LEKTOR_KODOK).size, LEKTOR_KODOK.length)
})

// --- PLATFORM_KORLATOK -----------------------------------------------------

test('PLATFORM_KORLATOK: youtube van felmérve, a másik három null -- nem kitalált szám', () => {
  assert.deepEqual(PLATFORM_KORLATOK.youtube, { cim: 100, leiras: 5000 })
  assert.equal(PLATFORM_KORLATOK.facebook, null)
  assert.equal(PLATFORM_KORLATOK.instagram, null)
  assert.equal(PLATFORM_KORLATOK.tiktok, null)
})

// --- publishDraft ----------------------------------------------------------

test('publishDraft refuses a platform with no surveyed limit, by name, rather than letting it through unchecked', async () => {
  const { repo, run } = setup()
  const k = repo.ujKiadas({ videoId: 'v1' })
  const r = await run('publishDraft', { kiadasId: k.id, szovegek: [{ platform: 'tiktok', cim: 'c', leiras: 'l' }] })
  assert.equal(r.error.code, 'platform_felmeretlen')
  assert.equal(r.error.platform, 'tiktok')
})

test('publishDraft writes every given platform, and lets the cím/leírás pair through when it fits the limit', async () => {
  const { repo, run } = setup()
  const k = repo.ujKiadas({ videoId: 'v1' })
  const r = await run('publishDraft', { kiadasId: k.id, szovegek: [{ platform: 'youtube', cim: 'Rendben van', leiras: 'Egy leírás.' }] })
  assert.equal(r.error, undefined)
  assert.deepEqual(r.agak, [{ platform: 'youtube', allapot: 'var' }])
  const stored = repo.agak(k.id)[0]
  assert.deepEqual(JSON.parse(stored.szoveg), { cim: 'Rendben van', leiras: 'Egy leírás.' })
})

test('publishDraft refuses a release past the drafting phase, by name', async () => {
  const { repo, run } = setup()
  const k = repo.ujKiadas({ videoId: 'v1' })
  repo.kiadasAllapototIr(k.id, KIADAS_ALLAPOTOK.JOVAHAGYVA)
  const r = await run('publishDraft', { kiadasId: k.id, szovegek: [{ platform: 'youtube', cim: 'c', leiras: 'l' }] })
  assert.equal(r.error.code, 'kiadas_lezart_szovegre')
})

test('publishDraft refuses an unknown kiadasId, and a duplicated platform in one call', async () => {
  const { run, repo } = setup()
  assert.equal((await run('publishDraft', { kiadasId: 'nincs-ilyen', szovegek: [{ platform: 'youtube', cim: 'c', leiras: 'l' }] })).error.code, 'kiadas_ismeretlen')
  const k = repo.ujKiadas({ videoId: 'v1' })
  const r = await run('publishDraft', { kiadasId: k.id, szovegek: [
    { platform: 'youtube', cim: 'a', leiras: 'l' },
    { platform: 'youtube', cim: 'b', leiras: 'l' },
  ] })
  assert.equal(r.error.code, 'platform_ismetlodik')
})

// --- publishVerdict ----------------------------------------------------------

test('publishVerdict requires an agent, requires drafted text, and atmegy moves the release to lektoralt', async () => {
  const { repo, run } = setup()
  const k = repo.ujKiadas({ videoId: 'v1' })
  assert.equal((await run('publishVerdict', { kiadasId: k.id, verdikt: 'atmegy' }, null)).error.code, 'agent_hianyzik')
  assert.equal((await run('publishVerdict', { kiadasId: k.id, verdikt: 'atmegy' })).error.code, 'szoveg_hianyzik')
  await run('publishDraft', { kiadasId: k.id, szovegek: [{ platform: 'youtube', cim: 'c', leiras: 'l' }] })
  const r = await run('publishVerdict', { kiadasId: k.id, verdikt: 'atmegy' })
  assert.equal(r.error, undefined)
  assert.equal(r.allapot, KIADAS_ALLAPOTOK.LEKTORALT)
  assert.equal(repo.kiadas(k.id).allapot, KIADAS_ALLAPOTOK.LEKTORALT)
})

test('publishVerdict elbukik requires at least one finding, and sends the release back to vazlat', async () => {
  const { repo, run } = setup()
  const k = repo.ujKiadas({ videoId: 'v1' })
  await run('publishDraft', { kiadasId: k.id, szovegek: [{ platform: 'youtube', cim: 'c', leiras: 'l' }] })
  assert.equal((await run('publishVerdict', { kiadasId: k.id, verdikt: 'elbukik' })).error.code, 'talalat_hianyzik')
  const r = await run('publishVerdict', { kiadasId: k.id, verdikt: 'elbukik', talalatok: [{ platform: 'youtube', kod: 'hashtag_kitalalt', szoveg: 'nincs köze a témához' }] })
  assert.equal(r.allapot, KIADAS_ALLAPOTOK.VAZLAT)
  assert.deepEqual(r.figyelmeztetesek, [])
})

test('publishVerdict warns on an unrecognised finding code rather than refusing the verdict', async () => {
  const { repo, run } = setup()
  const k = repo.ujKiadas({ videoId: 'v1' })
  await run('publishDraft', { kiadasId: k.id, szovegek: [{ platform: 'youtube', cim: 'c', leiras: 'l' }] })
  const r = await run('publishVerdict', { kiadasId: k.id, verdikt: 'elbukik', talalatok: [{ platform: 'youtube', kod: 'meg_nem_ismert_kod', szoveg: 'x' }] })
  assert.equal(r.error, undefined)
  assert.deepEqual(r.figyelmeztetesek, ['kod_ismeretlen:meg_nem_ismert_kod'])
})

test('publishVerdict only accepts a vazlat-state release with drafted text', async () => {
  const { repo, run } = setup()
  const k = repo.ujKiadas({ videoId: 'v1' })
  repo.kiadasAllapototIr(k.id, KIADAS_ALLAPOTOK.JOVAHAGYVA)
  const r = await run('publishVerdict', { kiadasId: k.id, verdikt: 'atmegy' })
  assert.equal(r.error.code, 'kiadas_nincs_vazlatban')
})

// --- publishOpen -------------------------------------------------------------

test('publishOpen opens a release from a qa_ok video, and returns the existing one on a repeat call', async () => {
  const video = qaOkVideo('vid-1')
  const { run, repo } = setup({ video })
  const a = await run('publishOpen', { videoId: 'vid-1' })
  assert.equal(a.uj, true)
  assert.equal(a.cim, 'Egy videó')
  assert.equal(a.narracioSzoveg, 'Ez hangzik el a videóban.')
  assert.deepEqual(a.agak, [], 'egy frissen nyitott kiadásnak még nincs ága')
  assert.deepEqual(a.talalatok, [], 'és nincs lektori találata sem')
  assert.equal(repo.kiadas(a.kiadasId).video_id, 'vid-1')
  const b = await run('publishOpen', { videoId: 'vid-1' })
  assert.equal(b.uj, false)
  assert.equal(b.kiadasId, a.kiadasId, 'ugyanaz a kiadás jön vissza, nem egy második')
  assert.equal(b.cim, 'Egy videó', 'az ismétlő ág is elolvassa a videót -- e nélkül a második nekifutás vakon ír')
  assert.equal(b.narracioSzoveg, 'Ez hangzik el a videóban.')
})

test('publishOpen refuses a video that has not passed QA, by name, and an unknown videoId', async () => {
  const { run } = setup({ video: qaOkVideo('vid-1', { status: 'render_hiba' }) })
  const r = await run('publishOpen', { videoId: 'vid-1' })
  assert.equal(r.error.code, 'video_nem_qa_ok')
  const { run: run2 } = setup({ video: null })
  assert.equal((await run2('publishOpen', { videoId: 'nincs-ilyen' })).error.code, 'video_ismeretlen')
})

// --- publishQueue --------------------------------------------------------

test('publishQueue lists only vazlat and lektoralt releases, with which platforms already have text', async () => {
  const { repo, run } = setup({ video: qaOkVideo('v1') })
  const k1 = repo.ujKiadas({ videoId: 'v1' })
  repo.szovegetIr({ kiadasId: k1.id, platform: 'youtube', szoveg: '{"cim":"x"}' })
  const k2 = repo.ujKiadas({ videoId: 'v2' })
  repo.kiadasAllapototIr(k2.id, KIADAS_ALLAPOTOK.JOVAHAGYVA)
  const r = await run('publishQueue', {})
  assert.deepEqual(r.kiadasok.map((k) => k.kiadasId), [k1.id], 'a jovahagyva kiadás nem a munkasor tagja')
  assert.deepEqual(r.kiadasok[0].agak, [{ platform: 'youtube', vanSzoveg: true, cim: 'x', leiras: null, szovegHiba: null }])
})

// --- BLOKKOLÓ 1: a lektor LÁTJA azt, amit megítél -------------------------

/**
 * A lektor ügynök SAJÁT deklarált eszközeivel, semmi mással.
 *
 * `src/agents.mjs` a `publish-lektor`-nak pontosan két modul-eszközt ad
 * (`publishQueue`, `publishVerdict`) -- a `memory` a hosté. Ez a helper
 * ebből a deklarációból építi a felületet, nem egy kézzel írt listából: ha
 * valaki elveszi a `publishQueue`-t a lektortól, ezek a tesztek nem
 * "átmennek másképp", hanem elhasalnak azon, hogy nincs mivel olvasni.
 */
function lektorEszkozei(run) {
  const lektor = AGENTS.find((a) => a.agentKey === 'publish-lektor')
  const sajat = lektor.tools.filter((t) => t !== 'memory')
  return { sajat, hiv: (nev, args) => {
    assert.ok(sajat.includes(nev), `a lektor nem hordozza ezt az eszközt: ${nev}`)
    return run(nev, args, 'lektor-1', 's-lektor')
  } }
}

test('BLOKKOLÓ 1: a lektor a saját eszközeivel ELOLVASSA a megírt szöveget, mielőtt ítél', async () => {
  // A ZÁRÓ ÁTNÉZÉS BIZONYÍTÉKA VOLT, HOGY NEM TUDTA. A `publishQueue`
  // vetítése `{ platform, vanSzoveg }` volt, a `publishVerdict` válasza az
  // állapot -- se a cím, se a leírás, se a narráció nem érkezett meg sehol,
  // tehát az `atmegy` verdikt olyan szövegen ment át, amit senki nem olvasott,
  // egy operátori kattintásra négy platformtól. Ez a teszt azt köti le, hogy
  // a lektor MINDHÁROM tényt megkapja a saját, ÍRÁSRA KÉPTELEN olvasásából.
  const { repo, run } = setup({ video: qaOkVideo('v1', { cim: 'A videó címe', narracio_szoveg: 'Ez hangzik el a videóban.' }) })
  const k = repo.ujKiadas({ videoId: 'v1' })
  repo.szovegetIr({ kiadasId: k.id, platform: 'youtube', szoveg: JSON.stringify({ cim: 'A megírt cím', leiras: 'A megírt leírás.' }) })

  const { sajat, hiv } = lektorEszkozei(run)
  assert.equal(sajat.includes('publishOpen'), false, 'a lektor nem kap írót: a publishOpen nyit, tehát ír')
  assert.equal(sajat.includes('publishDraft'), false, 'a lektor nem kap írót: a publishDraft felülír')

  const sor = (await hiv('publishQueue', {})).kiadasok.find((x) => x.kiadasId === k.id)
  assert.ok(sor, 'a megírt szövegű vazlat a lektor sorában van')
  const ag = sor.agak.find((a) => a.platform === 'youtube')
  assert.equal(ag.cim, 'A megírt cím', 'a lektor látja a megítélendő címet')
  assert.equal(ag.leiras, 'A megírt leírás.', 'a lektor látja a megítélendő leírást')
  assert.equal(sor.narracioSzoveg, 'Ez hangzik el a videóban.', 'az allitas_forras_nelkul enélkül eldönthetetlen')
  assert.equal(sor.cim, 'A videó címe')
  assert.equal(sor.videoHiba, null)

  // ...és csak ezután ítél.
  const verdikt = await hiv('publishVerdict', { kiadasId: k.id, verdikt: 'atmegy' })
  assert.equal(verdikt.error, undefined)
  assert.equal(verdikt.allapot, KIADAS_ALLAPOTOK.LEKTORALT)
})

test('BLOKKOLÓ 1: egy elérhetetlen videó nem üríti ki a lektor sorát -- megnevezi, miért nem ítélhet', async () => {
  // A narráció olvasása LEGJOBB IGYEKEZET: egy elérhetetlen videó a saját
  // kiadásán jelenik meg mondatként, nem az egész sor helyén hibaként. Egy
  // dobás itt a többi kiadást is elvinné, és a lektor napokig nem látná,
  // hogy egyáltalán van munkája.
  const { repo, run } = setup({ contracts: { get: () => null, why: () => 'not_installed' } })
  const k = repo.ujKiadas({ videoId: 'v1' })
  repo.szovegetIr({ kiadasId: k.id, platform: 'youtube', szoveg: JSON.stringify({ cim: 'C', leiras: 'L' }) })
  const { hiv } = lektorEszkozei(run)
  const r = await hiv('publishQueue', {})
  assert.equal(r.error, undefined, 'a sor megjön, nem hibázik el')
  const sor = r.kiadasok[0]
  assert.equal(sor.agak[0].cim, 'C', 'az író szövege ettől még olvasható')
  assert.equal(sor.narracioSzoveg, null)
  assert.ok(typeof sor.videoHiba === 'string' && sor.videoHiba !== '', 'a mondat megmondja, miért nincs forrás')
})

// --- publishDue ------------------------------------------------------------

/** A kiadás that is due right now, with the given branches. Uses the repo directly -- setting up the fixture is not what these tests are about. */
function esedekesKiadas(repo, videoId, platformok) {
  const k = repo.ujKiadas({ videoId })
  repo.kiadasAllapototIr(k.id, KIADAS_ALLAPOTOK.LEKTORALT)
  repo.kiadastJovahagy(k.id)
  repo.kiadastUtemez({ kiadasId: k.id, savId: 's1', idopont: '2020-01-01T00:00:00.000Z' })
  for (const platform of platformok) repo.ujAg({ kiadasId: k.id, platform })
  return repo.kiadas(k.id)
}

test('publishDue leaves a release with no connected accounts at nincs_hova, none of its branches counted as sent', async () => {
  const { repo, run } = setup()
  const k = esedekesKiadas(repo, 'v1', ['youtube', 'tiktok'])
  const r = await run('publishDue', {})
  assert.equal(r.kikuldve, 0)
  assert.deepEqual(r.hibak, [])
  assert.equal(repo.kiadas(k.id).allapot, KIADAS_ALLAPOTOK.NINCS_HOVA)
  assert.deepEqual(repo.agak(k.id).map((a) => a.allapot), ['nincs_fiok', 'nincs_fiok'])
})

test('publishDue sends through a registered adapter for a connected account, and counts the release once every branch is kesz', async () => {
  const { repo, run } = setup({ video: qaOkVideo('v1'), adapterek: { youtube: async () => ({ url: 'https://youtu.be/x' }) } })
  repo.fiokotIr({ platform: 'youtube', kulsoId: 'UC1', nev: 'Csatorna' })
  const k = esedekesKiadas(repo, 'v1', ['youtube'])
  const r = await run('publishDue', {})
  assert.equal(r.kikuldve, 1)
  assert.deepEqual(r.hibak, [])
  assert.equal(repo.kiadas(k.id).allapot, KIADAS_ALLAPOTOK.KESZ)
  const ag = repo.agak(k.id)[0]
  assert.equal(ag.allapot, 'kesz')
  assert.equal(ag.url, 'https://youtu.be/x')
  assert.equal(typeof ag.kikuldve_at, 'string')
})

test('publishDue reports a connected account with no registered adapter as a named hiba, not a silent skip', async () => {
  const { repo, run } = setup({ adapterek: {} })
  repo.fiokotIr({ platform: 'tiktok', kulsoId: 'x', nev: 'x' })
  const k = esedekesKiadas(repo, 'v1', ['tiktok'])
  const r = await run('publishDue', {})
  assert.equal(r.kikuldve, 0)
  assert.deepEqual(r.hibak, [{ kiadasId: k.id, platform: 'tiktok', hibaKod: 'adapter_nincs' }])
  assert.equal(repo.kiadas(k.id).allapot, KIADAS_ALLAPOTOK.HIBA)
})

test('publishDue reports a partial release as reszben, with one branch kesz and one hiba', async () => {
  const { repo, run } = setup({
    video: qaOkVideo('v1'),
    adapterek: {
      youtube: async () => ({ url: 'https://youtu.be/x' }),
      tiktok: async () => { const e = new Error('nem sikerült'); e.code = 'kulso_hiba'; throw e },
    },
  })
  repo.fiokotIr({ platform: 'youtube', kulsoId: 'UC1', nev: 'Csatorna' })
  repo.fiokotIr({ platform: 'tiktok', kulsoId: 'x', nev: 'x' })
  const k = esedekesKiadas(repo, 'v1', ['youtube', 'tiktok'])
  const r = await run('publishDue', {})
  assert.equal(r.kikuldve, 0, 'a reszben kiadás nem számít bele a rendben kimentek közé')
  assert.deepEqual(r.hibak, [{ kiadasId: k.id, platform: 'tiktok', hibaKod: 'kulso_hiba' }])
  assert.equal(repo.kiadas(k.id).allapot, KIADAS_ALLAPOTOK.RESZBEN)
})

// --- R1 (task 5): the freshness gate --------------------------------------
//
// Task 4's review proved this exact scenario: a release approved while its
// video was qa_ok, re-rendered to qa_hiba days later, still went out to
// every platform with `kikuldve: 1, hibak: []` -- because nothing between
// approval and dispatch ever asked the video module again. These tests
// exercise that gate directly, with an adapter that would prove it by
// throwing if it were ever reached.

test('publishDue refuses every var branch of a release whose video is no longer qa_ok, and never calls the adapter', async () => {
  let hivva = false
  const { repo, run } = setup({
    video: qaOkVideo('v1', { status: 'qa_hiba' }),
    adapterek: { youtube: async () => { hivva = true; return { url: 'https://youtu.be/x' } } },
  })
  repo.fiokotIr({ platform: 'youtube', kulsoId: 'UC1', nev: 'Csatorna' })
  const k = esedekesKiadas(repo, 'v1', ['youtube'])
  const r = await run('publishDue', {})
  assert.equal(hivva, false, 'a stale videó miatt az adapter meg sem hívódik')
  assert.equal(r.kikuldve, 0)
  assert.deepEqual(r.hibak, [{ kiadasId: k.id, platform: 'youtube', hibaKod: 'video_nem_qa_ok' }])
  assert.equal(repo.kiadas(k.id).allapot, KIADAS_ALLAPOTOK.HIBA)
  assert.equal(repo.agak(k.id)[0].allapot, AG_ALLAPOTOK.HIBA)
})

test('publishDue refuses a release whose video was closed (lezart) after approval, by the same named code as an operator-facing failed re-render', async () => {
  const { repo, run } = setup({
    video: qaOkVideo('v1', { status: 'lezart' }),
    adapterek: { youtube: async () => ({ url: 'https://youtu.be/x' }) },
  })
  repo.fiokotIr({ platform: 'youtube', kulsoId: 'UC1', nev: 'Csatorna' })
  const k = esedekesKiadas(repo, 'v1', ['youtube'])
  const r = await run('publishDue', {})
  assert.deepEqual(r.hibak, [{ kiadasId: k.id, platform: 'youtube', hibaKod: 'video_nem_qa_ok' }])
})

test('publishDue re-checks the video ONCE per release, not once per platform', async () => {
  let hivasok = 0
  const { repo, run } = setup({
    video: qaOkVideo('v1'),
    contracts: {
      get: (e, c) => (e === 'video' && c === 'videos' ? { get: async ({ id }) => { hivasok += 1; return id === 'v1' ? qaOkVideo('v1') : null } } : null),
      why: () => 'provider_missing',
    },
    adapterek: {
      youtube: async () => ({ url: 'https://youtu.be/x' }),
      tiktok: async () => ({ url: 'https://tiktok.example/x' }),
    },
  })
  repo.fiokotIr({ platform: 'youtube', kulsoId: 'UC1', nev: 'Csatorna' })
  repo.fiokotIr({ platform: 'tiktok', kulsoId: 'x', nev: 'x' })
  const k = esedekesKiadas(repo, 'v1', ['youtube', 'tiktok'])
  const r = await run('publishDue', {})
  assert.equal(r.kikuldve, 1)
  assert.equal(hivasok, 1, 'a videó szerződés egyszer kérdeződik le két platform ellenére')
  assert.equal(repo.kiadas(k.id).allapot, KIADAS_ALLAPOTOK.KESZ)
})

test('publishDue never asks the video contract for a release with no connected account or no registered adapter, at all', async () => {
  let hivasok = 0
  const { repo, run } = setup({
    contracts: {
      get: (e, c) => (e === 'video' && c === 'videos' ? { get: async () => { hivasok += 1; return null } } : null),
      why: () => 'provider_missing',
    },
    adapterek: {},
  })
  const k = esedekesKiadas(repo, 'v1', ['youtube', 'tiktok'])
  await run('publishDue', {})
  assert.equal(hivasok, 0, 'nincs csatlakoztatott fiók vagy adapter egyik platformhoz sem -- a videó lekérdezés felesleges lenne')
  assert.deepEqual(repo.agak(k.id).map((a) => a.allapot), ['nincs_fiok', 'nincs_fiok'])
})

test('publishDue skips (not throws) a release whose video contract cannot be resolved at dispatch time, reporting the host\'s own reason code', async () => {
  const { repo, run } = setup({
    video: qaOkVideo('v1'),
    contracts: { get: () => null, why: () => 'provider_disabled' },
    adapterek: { youtube: async () => ({ url: 'https://youtu.be/x' }) },
  })
  repo.fiokotIr({ platform: 'youtube', kulsoId: 'UC1', nev: 'Csatorna' })
  const k = esedekesKiadas(repo, 'v1', ['youtube'])
  const r = await run('publishDue', {})
  assert.equal(r.error, undefined, 'egy megnevezett szerződés-hiba nem szakítja meg a futást')
  assert.deepEqual(r.hibak, [{ kiadasId: k.id, platform: 'youtube', hibaKod: 'szerzodes_hianyzik' }])
})

test('the R1 gate hands the fresh video row to the adapter, not the one from approval time', async () => {
  let kapottVideo
  const { repo, run } = setup({
    video: qaOkVideo('v1', { out_path: '/renders/v1/uj.mp4' }),
    adapterek: { youtube: async ({ video }) => { kapottVideo = video; return { url: 'https://youtu.be/x' } } },
  })
  repo.fiokotIr({ platform: 'youtube', kulsoId: 'UC1', nev: 'Csatorna' })
  esedekesKiadas(repo, 'v1', ['youtube'])
  await run('publishDue', {})
  assert.equal(kapottVideo.out_path, '/renders/v1/uj.mp4')
})

test('publishDue never touches a release that is not yet due, and reports időpont nélküli ütemezett kiadás as its own, third fact', async () => {
  const { repo, run } = setup()
  const future = repo.ujKiadas({ videoId: 'v-future' })
  repo.kiadasAllapototIr(future.id, KIADAS_ALLAPOTOK.LEKTORALT)
  repo.kiadastJovahagy(future.id)
  repo.kiadastUtemez({ kiadasId: future.id, savId: 's1', idopont: '2999-01-01T00:00:00.000Z' })

  const noIdopont = repo.ujKiadas({ videoId: 'v-no-time' })
  repo.storage.exec('UPDATE ext_publish_kiadasok SET allapot = ? WHERE id = ?', [KIADAS_ALLAPOTOK.UTEMEZVE, noIdopont.id])

  const r = await run('publishDue', {})
  assert.equal(r.kikuldve, 0)
  assert.equal(repo.kiadas(future.id).allapot, KIADAS_ALLAPOTOK.UTEMEZVE, 'a jövőbeli kiadáshoz a publishDue nem nyúl')
  assert.deepEqual(r.idopontNelkuliUtemezettek, [{ kiadasId: noIdopont.id }])
})

// --- kiadastUtemezSavba (the scheduling half of approval) ------------------

test('kiadastUtemezSavba refuses named nincs_szabad_sav when no slot is declared, leaving the release at jovahagyva', () => {
  const { repo, state } = setup()
  const k = repo.ujKiadas({ videoId: 'v1' })
  repo.kiadasAllapototIr(k.id, KIADAS_ALLAPOTOK.LEKTORALT)
  repo.kiadastJovahagy(k.id)
  assert.throws(() => kiadastUtemezSavba(state, { kiadasId: k.id, most: new Date('2026-09-07T07:00:00.000Z') }), (err) => {
    assert.equal(err.code, 'nincs_szabad_sav')
    return true
  })
  assert.equal(repo.kiadas(k.id).allapot, KIADAS_ALLAPOTOK.JOVAHAGYVA)
})

test('kiadastUtemezSavba: two releases scheduled one after the other never share the same minute (invariant 2, end to end)', () => {
  const { repo, state } = setup()
  repo.ujSav({ nap: 1, ora: 9, perc: 0 })
  const k1 = repo.ujKiadas({ videoId: 'v1' })
  repo.kiadasAllapototIr(k1.id, KIADAS_ALLAPOTOK.LEKTORALT)
  repo.kiadastJovahagy(k1.id)
  const k2 = repo.ujKiadas({ videoId: 'v2' })
  repo.kiadasAllapototIr(k2.id, KIADAS_ALLAPOTOK.LEKTORALT)
  repo.kiadastJovahagy(k2.id)
  // 2026-09-07 06:00Z = Budapest 08:00 (CEST, UTC+2) -- before the 09:00 slot, so this week's occurrence is still free for the first release.
  const most = new Date('2026-09-07T06:00:00.000Z')
  const u1 = kiadastUtemezSavba(state, { kiadasId: k1.id, most })
  const u2 = kiadastUtemezSavba(state, { kiadasId: k2.id, most })
  assert.equal(u1.idopont, '2026-09-07T07:00:00.000Z', 'hétfő 09:00 Budapest = 07:00 UTC nyáridőben')
  assert.equal(u2.idopont, '2026-09-14T07:00:00.000Z', 'a második kiadás a KÖVETKEZŐ heti előfordulásra kerül, nem ugyanarra a percre')
  assert.notEqual(u1.idopont, u2.idopont, 'a második kiadás nem kaphatja meg ugyanazt a percet -- foglaltSavIdopontok már látja az elsőt')
  assert.equal(u2.allapot, KIADAS_ALLAPOTOK.UTEMEZVE)
})

test('VERDIKTEK is exactly atmegy and elbukik', () => {
  assert.deepEqual(VERDIKTEK, ['atmegy', 'elbukik'])
})

// --- the review loop: what the writer can actually SEE on a second pass ----
//
// The writer (`publish-iro`) and the reviewer (`publish-lektor`) are two
// managed agents in two different sessions (src/agents.mjs), and nothing in
// this module joins their conversations. Everything the writer needs for a
// second pass therefore has to come back out of storage, through
// `publishOpen`. These tests replay the whole loop and assert on what that
// call answers, because the failure they guard is silent: a writer that
// cannot see the findings, its own previous text or the narration has exactly
// one move left -- `publishDraft` with invented text -- and a reviewer may
// pass that blind rewrite straight to four platforms.

test('the review loop end to end: after an elbukik verdict, publishOpen hands the writer the findings, its own previous text, and the narration', async () => {
  const video = qaOkVideo('vid-1')
  const { run } = setup({ video })

  // open #1 -> the writer drafts
  const nyitas = await run('publishOpen', { videoId: 'vid-1' })
  assert.equal(nyitas.uj, true)
  await run('publishDraft', { kiadasId: nyitas.kiadasId, szovegek: [
    { platform: 'youtube', cim: 'Az első címem', leiras: 'Az első leírásom. #kitalalt' },
  ] })

  // verdict -> elbukik, back to vazlat, findings to the REVIEWER's turn only
  const itelet = await run('publishVerdict', { kiadasId: nyitas.kiadasId, verdikt: 'elbukik', talalatok: [
    { platform: 'youtube', kod: 'hashtag_kitalalt', szoveg: 'a #kitalalt nem a videó témájából jön' },
  ] }, 'ag-lektor', 's-lektor')
  assert.equal(itelet.allapot, KIADAS_ALLAPOTOK.VAZLAT)

  // queue -> the writer finds the work again, with the videoId it needs
  const sor = await run('publishQueue', {}, 'ag-iro', 's-iro-2')
  assert.deepEqual(sor.kiadasok.map((k) => [k.kiadasId, k.videoId, k.allapot]), [[nyitas.kiadasId, 'vid-1', KIADAS_ALLAPOTOK.VAZLAT]])

  // open #2, in a DIFFERENT session -- all three facts must be there
  const masodik = await run('publishOpen', { videoId: 'vid-1' }, 'ag-iro', 's-iro-2')
  assert.equal(masodik.error, undefined)
  assert.equal(masodik.uj, false)
  assert.equal(masodik.kiadasId, nyitas.kiadasId)
  assert.deepEqual(masodik.talalatok, [
    { platform: 'youtube', kod: 'hashtag_kitalalt', szoveg: 'a #kitalalt nem a videó témájából jön' },
  ], 'a lektori találatok túlélik a session-határt -- e nélkül az író tudja, hogy elbukott, de nem tudja, miért')
  assert.deepEqual(masodik.agak, [
    { platform: 'youtube', allapot: 'var', vanSzoveg: true, cim: 'Az első címem', leiras: 'Az első leírásom. #kitalalt' },
  ], 'a saját előző szövege visszaolvasható -- e nélkül a javítás csak újraírás lehet')
  assert.equal(masodik.narracioSzoveg, 'Ez hangzik el a videóban.', 'a narráció újra lekérhető -- e nélkül az író csak kitalálhat')
  assert.equal(masodik.cim, 'Egy videó')
})

test('an atmegy verdict clears the stored findings: a passed review leaves no stale objection for the next writer', async () => {
  const video = qaOkVideo('vid-1')
  const { run, repo } = setup({ video })
  const nyitas = await run('publishOpen', { videoId: 'vid-1' })
  await run('publishDraft', { kiadasId: nyitas.kiadasId, szovegek: [{ platform: 'youtube', cim: 'c', leiras: 'l' }] })
  await run('publishVerdict', { kiadasId: nyitas.kiadasId, verdikt: 'elbukik', talalatok: [{ platform: 'youtube', kod: 'hashtag_hianyzik', szoveg: 'nincs hashtag' }] })
  assert.equal(typeof repo.kiadas(nyitas.kiadasId).talalatok, 'string')
  await run('publishDraft', { kiadasId: nyitas.kiadasId, szovegek: [{ platform: 'youtube', cim: 'c2', leiras: 'l2 #tema' }] })
  assert.equal(typeof repo.kiadas(nyitas.kiadasId).talalatok, 'string', 'egy újraírás NEM törli a találatokat: az író javíthat platformonként, két session-ben')
  await run('publishVerdict', { kiadasId: nyitas.kiadasId, verdikt: 'atmegy' })
  assert.equal(repo.kiadas(nyitas.kiadasId).talalatok, null)
  const ujra = await run('publishOpen', { videoId: 'vid-1' })
  assert.deepEqual(ujra.talalatok, [])
})

test('a stored value this module cannot read back is a NAMED refusal, not a SyntaxError escaping the tool', async () => {
  // A JSON.parse that throws out of a tool reaches the host as an extension
  // failure (see `guard`'s docblock), so the parse lives at the boundary
  // where it can still become a sentence.
  const video = qaOkVideo('vid-1')
  const { run, repo } = setup({ video })
  const nyitas = await run('publishOpen', { videoId: 'vid-1' })
  repo.szovegetIr({ kiadasId: nyitas.kiadasId, platform: 'youtube', szoveg: 'nem json' })
  const r = await run('publishOpen', { videoId: 'vid-1' })
  assert.equal(r.error.code, 'tarolt_ertek_olvashatatlan')
  assert.equal(r.error.platform, 'youtube')
  assert.equal(r.error.mezo, 'szoveg')
  assert.equal(r.error.message.includes('nem json'), false, 'a tárolt szöveg nem kerül az üzenetbe')
  repo.szovegetIr({ kiadasId: nyitas.kiadasId, platform: 'youtube', szoveg: '{"cim":"c","leiras":"l"}' })
  repo.talalatokatIr({ kiadasId: nyitas.kiadasId, talalatok: '{"nem":"tomb"}' })
  const r2 = await run('publishOpen', { videoId: 'vid-1' })
  assert.equal(r2.error.code, 'tarolt_ertek_olvashatatlan')
  assert.equal(r2.error.mezo, 'talalatok')
})

// --- guard: what becomes { error }, and what stays a bug -------------------

test('publishOpen refuses a missing video contract by NAME instead of throwing -- three throws would auto-disable the whole extension', async () => {
  // src/lib/server/extensions.ts: markExtensionFailure ->
  // MAX_CONSECUTIVE_EXTENSION_FAILURES (3) -> autoDisableExternalExtension.
  // Three writer turns taken while the `video` extension happens to be off
  // would switch the publish extension off, and the operator would see "the
  // tools vanished" rather than "the video extension is disabled".
  const { run } = setup({ contracts: { get: () => null, why: () => 'provider_disabled' } })
  const r = await run('publishOpen', { videoId: 'vid-1' })
  assert.equal(r.error.code, 'szerzodes_hianyzik')
  assert.match(r.error.message, /Videó bővítmény ki van kapcsolva/)
  assert.equal(/sikertelen/i.test(r.error.message), false)
})

test('publishOpen refuses by name even before setup() has handed over contracts', async () => {
  const { run } = setup({ contracts: null })
  const r = await run('publishOpen', { videoId: 'vid-1' })
  assert.equal(r.error.code, 'szerzodes_hianyzik')
  assert.notEqual(r.error.message, 'szerzodes_hianyzik')
})

test('guard lets a real bug through as the bug it is: only a named refusal becomes { error }', async () => {
  // The mirror of the two tests above. A guard that swallowed everything
  // would turn a crash into an { error } an agent would retry forever.
  const state = {
    repo: { kiadasok() { throw new Error('a repository elszállt') } },
    settings: () => ({}),
    log: { info() {}, warn() {}, error() {} },
    contracts: null,
    adapterek: {},
  }
  const tools = Object.fromEntries(createSzovegTools(state).map((t) => [t.name, t]))
  await assert.rejects(() => tools.publishQueue.execute({}, { session: { id: 's1', agentId: 'ag-1' } }), /a repository elszállt/)
})

// --- the refusals are NAMED: a code AND a sentence that says what to do ----

/** A refusal is a code and a SENTENCE. The bare code is not a sentence, and "sikertelen" is not a reason (constraints.md). */
function nevezett(r, kod, mondat) {
  assert.equal(r.error.code, kod)
  assert.notEqual(r.error.message, kod, 'a kód nem mondat: az elutasítás kódból ÉS mondatból áll')
  assert.match(r.error.message, mondat)
  assert.equal(/sikertelen/i.test(r.error.message), false, 'a "sikertelen" szó nem fordul elő')
}

test('every publishDraft refusal carries a sentence that says what is wrong, not just its code', async () => {
  const { repo, run } = setup()
  const k = repo.ujKiadas({ videoId: 'v1' })
  nevezett(await run('publishDraft', { kiadasId: 'nincs-ilyen', szovegek: [{ platform: 'youtube', cim: 'c', leiras: 'l' }] }), 'kiadas_ismeretlen', /nincs kiadás a megadott kiadasId-vel/)
  nevezett(await run('publishDraft', { kiadasId: k.id, szovegek: [{ platform: 'tiktok', cim: 'c', leiras: 'l' }] }), 'platform_felmeretlen', /hosszkorlátja még nincs felmérve/)
  nevezett(await run('publishDraft', { kiadasId: k.id, szovegek: [{ platform: 'youtube', cim: 'x'.repeat(101), leiras: 'l' }] }), 'szoveg_tul_hosszu', /legfeljebb 100 karakter/)
  nevezett(await run('publishDraft', { kiadasId: k.id, szovegek: [{ platform: 'youtube', cim: 'c', leiras: 'x'.repeat(5001) }] }), 'szoveg_tul_hosszu', /legfeljebb 5000 karakter/)
  nevezett(await run('publishDraft', { kiadasId: k.id, szovegek: [
    { platform: 'youtube', cim: 'a', leiras: 'l' },
    { platform: 'youtube', cim: 'b', leiras: 'l' },
  ] }), 'platform_ismetlodik', /legfeljebb egyszer/)
  nevezett(await run('publishDraft', { kiadasId: k.id, szovegek: [{ platform: 'mastodon', cim: 'c', leiras: 'l' }] }), 'platform_ismeretlen', /youtube, facebook, instagram, tiktok/)
  nevezett(await run('publishDraft', { kiadasId: k.id, szovegek: 'nem lista' }), 'argumentum_hibas', /szovegek: lista kell/)
  repo.kiadasAllapototIr(k.id, KIADAS_ALLAPOTOK.JOVAHAGYVA)
  nevezett(await run('publishDraft', { kiadasId: k.id, szovegek: [{ platform: 'youtube', cim: 'c', leiras: 'l' }] }), 'kiadas_lezart_szovegre', /szövegírás fázisán/)
})

test('every publishVerdict, publishOpen and kiadastUtemezSavba refusal carries its own sentence too', async () => {
  const { repo, run, state } = setup({ video: qaOkVideo('vid-1', { status: 'render_hiba' }) })
  const k = repo.ujKiadas({ videoId: 'v1' })
  nevezett(await run('publishVerdict', { kiadasId: k.id, verdikt: 'atmegy' }, null), 'agent_hianyzik', /ügynök kell/)
  nevezett(await run('publishVerdict', { kiadasId: 'nincs-ilyen', verdikt: 'atmegy' }), 'kiadas_ismeretlen', /nincs kiadás a megadott kiadasId-vel/)
  nevezett(await run('publishVerdict', { kiadasId: k.id, verdikt: 'atmegy' }), 'szoveg_hianyzik', /még nincs megírt szöveg/)
  await run('publishDraft', { kiadasId: k.id, szovegek: [{ platform: 'youtube', cim: 'c', leiras: 'l' }] })
  nevezett(await run('publishVerdict', { kiadasId: k.id, verdikt: 'talan' }), 'verdikt_ismeretlen', /atmegy, elbukik/)
  nevezett(await run('publishVerdict', { kiadasId: k.id, verdikt: 'elbukik' }), 'talalat_hianyzik', /legalább egy találat/)
  nevezett(await run('publishVerdict', { kiadasId: k.id, verdikt: 'elbukik', talalatok: [{ platform: 'youtube', kod: 'NAGYBETŰS', szoveg: 'x' }] }), 'argumentum_hibas', /kisbetűs_kód/)
  repo.kiadasAllapototIr(k.id, KIADAS_ALLAPOTOK.JOVAHAGYVA)
  nevezett(await run('publishVerdict', { kiadasId: k.id, verdikt: 'atmegy' }), 'kiadas_nincs_vazlatban', /csak vazlat állapotú kiadás lektorálható/)

  nevezett(await run('publishOpen', { videoId: 'vid-1' }), 'video_nem_qa_ok', /csak a QA-t átment \(qa_ok\) videóból/)
  nevezett(await run('publishOpen', { videoId: 'nincs-ilyen' }), 'video_ismeretlen', /nincs videó a megadott videoId-vel/)
  nevezett(await run('publishOpen', {}), 'argumentum_hibas', /videoId kötelező/)

  // T4/R3: A KÉT KIMARADT MONDAT. Az `olvasSzoveg` és az `olvasTalalatok`
  // ugyanazt a kódot adja (`tarolt_ertek_olvashatatlan`) két KÜLÖNBÖZŐ
  // oszlopra, két külön mondattal arról, mi a teendő -- írasd újra a
  // szöveget, illetve kérj új lektori ítéletet. Egyik sem járta be ezt a
  // söprést, pedig pont ezek azok az elutasítások, amiket egy ügynök a saját
  // adatbázisunk sérült sorára kap, és a kód önmagában egyikre sem mondja
  // meg, mit csináljon.
  const { repo: repo2, run: run2 } = setup({ video: qaOkVideo('vid-jo') })
  const k2 = repo2.ujKiadas({ videoId: 'vid-jo' })
  repo2.szovegetIr({ kiadasId: k2.id, platform: 'youtube', szoveg: 'nem json' })
  nevezett(await run2('publishOpen', { videoId: 'vid-jo' }), 'tarolt_ertek_olvashatatlan', /írasd újra a szöveget a publishDraft-tal/)

  const { repo: repo3, run: run3 } = setup({ video: qaOkVideo('vid-jo2') })
  const k3 = repo3.ujKiadas({ videoId: 'vid-jo2' })
  repo3.talalatokatIr({ kiadasId: k3.id, talalatok: 'nem json' })
  nevezett(await run3('publishOpen', { videoId: 'vid-jo2' }), 'tarolt_ertek_olvashatatlan', /kérj új lektori ítéletet/)

  const j = repo.ujKiadas({ videoId: 'v2' })
  repo.kiadasAllapototIr(j.id, KIADAS_ALLAPOTOK.LEKTORALT)
  repo.kiadastJovahagy(j.id)
  assert.throws(() => kiadastUtemezSavba(state, { kiadasId: j.id, most: new Date('2026-09-07T07:00:00.000Z') }), (err) => {
    assert.ok(err instanceof SzovegError, 'a modul exportálja azt az osztályt, amit dob -- egy későbbi hívó .code szerint kapja el')
    assert.equal(err.code, 'nincs_szabad_sav')
    assert.notEqual(err.message, err.code)
    assert.match(err.message, /nincs egyetlen publikálási sáv sem beállítva/)
    return true
  })
})

// --- publishDue: one broken release must not cancel the tick ---------------

test('publishDue names an adapter failure that carries no code of its own, rather than reporting a nameless one', async () => {
  // A REAL adapter (task 5's) can throw a plain Error. Without the fallback
  // the branch would store hiba_kod = null and the report would say
  // hibaKod: null -- an unnamed failure in the one path where the name
  // matters most.
  const { repo, run } = setup({ video: qaOkVideo('v1'), adapterek: { youtube: async () => { throw new Error('a hálózat elszállt') } } })
  repo.fiokotIr({ platform: 'youtube', kulsoId: 'UC1', nev: 'Csatorna' })
  const k = esedekesKiadas(repo, 'v1', ['youtube'])
  const r = await run('publishDue', {})
  assert.deepEqual(r.hibak, [{ kiadasId: k.id, platform: 'youtube', hibaKod: 'kikuldes_hiba' }])
  assert.equal(repo.agak(k.id)[0].hiba_kod, 'kikuldes_hiba')
})

test('publishDue never re-sends a branch that is no longer waiting -- only a var branch is dispatched', async () => {
  // The only thing standing between a future "retry the failed release" path
  // and a second post of an already-published branch.
  let hivasok = 0
  const { repo, run } = setup({ adapterek: { youtube: async () => { hivasok += 1; return { url: 'https://youtu.be/masodik' } } } })
  repo.fiokotIr({ platform: 'youtube', kulsoId: 'UC1', nev: 'Csatorna' })
  const k = esedekesKiadas(repo, 'v1', ['youtube'])
  const ag = repo.agak(k.id)[0]
  repo.agEredmenyetIr({ agId: ag.id, allapot: 'kesz', url: 'https://youtu.be/elso' })
  const r = await run('publishDue', {})
  assert.equal(hivasok, 0, 'egy már kiment ág nem megy ki másodszor')
  assert.deepEqual(r.hibak, [])
  assert.equal(repo.agak(k.id)[0].url, 'https://youtu.be/elso', 'és az első kiküldés url-je marad')
})

test('publishDue skips a release it cannot read the state of, reports it, and still sends every other due release', async () => {
  // A single ext_publish_agak row with an unrecognised allapot makes
  // kiadasAllapot answer `ismeretlen`. Thrown from inside the loop, that
  // cancelled every remaining due release in the tick -- every 15 minutes,
  // forever, and the operator would see a failing schedule rather than the
  // one release that is broken.
  const figyelmeztetesek = []
  const { repo, run } = setup({
    videos: [qaOkVideo('v-jo')],
    adapterek: { youtube: async () => ({ url: 'https://youtu.be/x' }) },
    log: { info() {}, warn: (m) => figyelmeztetesek.push(m), error() {} },
  })
  repo.fiokotIr({ platform: 'youtube', kulsoId: 'UC1', nev: 'Csatorna' })
  const jo = esedekesKiadas(repo, 'v-jo', ['youtube'])
  const torott = esedekesKiadas(repo, 'v-torott', ['youtube'])
  // `kiadasok()` is newest-first, so the broken release is processed FIRST:
  // if it aborted the run, the good one below would never be dispatched.
  repo.storage.exec('UPDATE ext_publish_agak SET allapot = ? WHERE id = ?', ['valami_amit_ez_a_verzio_nem_ismer', repo.agak(torott.id)[0].id])

  const r = await run('publishDue', {})
  assert.equal(r.error, undefined, 'a törött kiadás nem szakítja meg a futást')
  assert.equal(r.kikuldve, 1, 'a másik esedékes kiadás kiment')
  assert.equal(repo.kiadas(jo.id).allapot, KIADAS_ALLAPOTOK.KESZ)
  assert.deepEqual(r.hibak, [{ kiadasId: torott.id, platform: null, hibaKod: 'kiadas_allapot_ismeretlen' }], 'a kimaradt kiadás jelentve van, platform nélkül: az EGÉSZ kiadás maradt ki')
  assert.equal(repo.kiadas(torott.id).allapot, KIADAS_ALLAPOTOK.UTEMEZVE, 'és nem írunk rá olyan szót, amit nem tudunk elolvasni')
  assert.equal(figyelmeztetesek.length, 1, 'és egy naplósor is marad utána')
})

// --- a két zárt lista egyezése -------------------------------------------

test('PLATFORM_KORLATOK kulcsai PONTOSAN a PLATFORMOK -- egy kimaradt platform nyers TypeError volt a guard mellett', () => {
  // BIZONYÍTOTT: a `publishDraft` `korlat === null` őre `undefined`-ra nem
  // fogott, a következő sor pedig `korlat.cim`-et olvasott -- "THREW past
  // guard -> TypeError: Cannot read properties of undefined (reading 'cim')".
  // Az ilyen dobás nem megnevezett elutasítás, tehát kijut a `guard`-ból, a
  // host pedig a harmadik ilyen ügynök-fordulónál AUTO-LETILTJA a
  // bővítményt -- az operátornak "eltűntek a publikálás toolok"-nak látszik.
  // A PUB-2 egyenesen ebbe sétálna bele: egy ötödik platform a zárt listán,
  // korlát nélkül. A `PLATFORM_KORLATOK` volt az egyetlen, ami kimaradt a
  // zárt-lista pinekből.
  assert.deepEqual(Object.keys(PLATFORM_KORLATOK).sort(), [...PLATFORMOK].sort())
})

test('korlatOf: a hiányzó kulcs és a null korlát UGYANAZ a válasz -- null, sosem undefined', () => {
  // EZ AZ ÁLLÍTÁS KORÁBBAN HALOTT VOLT. A viselkedési fele a `facebook`-ot
  // hajtotta, aminek a korlátja `null`, tehát a `?? null` visszavonása
  // 319/319 zölden átment -- a teszt azt hitte, az `undefined` ágat méri,
  // közben a `null` ágat mérte. A két lista egyezés-pinje miatt éles úton
  // nem is nevezhető meg olyan platform, aminek nincs kulcsa, ezért a
  // lookup egy hívható név mögé került: itt az `undefined` ág egy hívásnyira
  // van, és `assert.equal` (strict) szerint az `undefined` NEM `null`.
  assert.equal(PLATFORM_KORLATOK.facebook, null, 'a null ág: szándékosan fel nem mért')
  assert.equal(PLATFORM_KORLATOK.mastodon, undefined, 'az undefined ág: nincs is ilyen kulcs')
  assert.equal(korlatOf('facebook'), null)
  assert.equal(korlatOf('mastodon'), null, 'a hiányzó kulcs is null, nem undefined -- különben a guard mellett nyers TypeError jön')
  assert.deepEqual(korlatOf('youtube'), { cim: 100, leiras: 5000 }, 'a felmért korlát változatlanul átjön')
})

test('a hiányzó korlát és a null korlát UGYANAZ a megnevezett elutasítás a publishDraft-on', async () => {
  const { repo, run } = setup()
  const k = repo.ujKiadas({ videoId: 'v1' })
  const r = await run('publishDraft', { kiadasId: k.id, szovegek: [{ platform: 'facebook', cim: 'c', leiras: 'l' }] })
  assert.equal(r.error.code, 'platform_felmeretlen')
  assert.equal(r.error.platform, 'facebook')
})

// --- BLOKKOLÓ 2: a kar, ami visszahozza az elbukott kiadást ----------------

/** Egy kiadás, aminek minden ága a megadott állapotba került, és a kiadás maga a megadott végállapotba -- a `publishDue` utáni világ, fixtúrából. */
function kikuldottKiadas(repo, { videoId = 'v1', agak, kiadasAllapot }) {
  const k = repo.ujKiadas({ videoId })
  for (const [platform, allapot, extra] of agak) {
    const ag = repo.ujAg({ kiadasId: k.id, platform })
    repo.agEredmenyetIr({ agId: ag.id, allapot, ...(extra ?? {}) })
  }
  repo.kiadasAllapototIr(k.id, kiadasAllapot)
  return repo.kiadas(k.id)
}

test('BLOKKOLÓ 2: egy hiba állapotú kiadás elbukott ága visszakerül var-ba, a kiadás pedig utemezve-be friss időponttal', async () => {
  const { repo, state } = setup()
  repo.ujSav({ nap: 1, ora: 18, perc: 0 })
  const k = kikuldottKiadas(repo, {
    agak: [['youtube', AG_ALLAPOTOK.HIBA, { hibaKod: 'gyerekeknek_nincs_beallitva' }]],
    kiadasAllapot: KIADAS_ALLAPOTOK.HIBA,
  })
  const r = kiadastUjraprobal(state, { kiadasId: k.id, most: new Date('2026-09-07T07:00:00.000Z') })
  assert.deepEqual(r.platformok, ['youtube'])
  assert.equal(repo.kiadas(k.id).allapot, KIADAS_ALLAPOTOK.UTEMEZVE)
  assert.ok(typeof repo.kiadas(k.id).idopont === 'string' && repo.kiadas(k.id).idopont !== '')
  const ag = repo.agak(k.id)[0]
  assert.equal(ag.allapot, AG_ALLAPOTOK.VAR, 'az ág újra vár, tehát a következő futás megpróbálja')
  assert.equal(ag.hiba_kod, null, 'a régi hibakód nem marad ott egy meg nem történt kiküldés mellé')
})

test('BLOKKOLÓ 2 / a spec másik fele: egy MÁR KESZ ág újrapróbálása MEGNEVEZVE utasul el', () => {
  // „Amit egyszer kitettünk, azt nem tesszük ki újra: az ág az url-jét őrzi,
  // és egy már kesz ág újrapróbálása megnevezve elutasul." (spec 5.)
  // Egy kar, ami csendben újraposztolna egy már kiment ágat, ROSSZABB volna
  // annál a zsákutcánál, amit lecserél: a hiba egy második nyilvános poszt
  // lenne, amit a modul nem tud visszavenni.
  const { repo, state } = setup()
  repo.ujSav({ nap: 1, ora: 18, perc: 0 })
  const k = kikuldottKiadas(repo, {
    agak: [['youtube', AG_ALLAPOTOK.KESZ, { url: 'https://youtu.be/abc' }], ['facebook', AG_ALLAPOTOK.HIBA, { hibaKod: 'adapter_nincs' }]],
    kiadasAllapot: KIADAS_ALLAPOTOK.RESZBEN,
  })
  assert.throws(
    () => kiadastUjraprobal(state, { kiadasId: k.id, platform: 'youtube', most: new Date('2026-09-07T07:00:00.000Z') }),
    (err) => {
      assert.ok(err instanceof SzovegError)
      assert.equal(err.code, 'ag_mar_kesz')
      assert.notEqual(err.message, err.code, 'kód ÉS mondat')
      assert.equal(/sikertelen/i.test(err.message), false)
      return true
    },
  )
  const youtube = repo.agak(k.id).find((a) => a.platform === 'youtube')
  assert.equal(youtube.allapot, AG_ALLAPOTOK.KESZ, 'az elutasított hívás nem nyúlt hozzá')
  assert.equal(youtube.url, 'https://youtu.be/abc', 'az ág őrzi az url-jét')
  assert.equal(repo.kiadas(k.id).allapot, KIADAS_ALLAPOTOK.RESZBEN, 'és a kiadás sem került vissza sorba')
})

test('BLOKKOLÓ 2: a tömeges újraküldés a KESZ ágat nem viszi vissza, csak az elbukottakat', () => {
  const { repo, state } = setup()
  repo.ujSav({ nap: 1, ora: 18, perc: 0 })
  const k = kikuldottKiadas(repo, {
    agak: [['youtube', AG_ALLAPOTOK.KESZ, { url: 'https://youtu.be/abc' }], ['facebook', AG_ALLAPOTOK.HIBA, { hibaKod: 'adapter_nincs' }], ['tiktok', AG_ALLAPOTOK.NINCS_FIOK]],
    kiadasAllapot: KIADAS_ALLAPOTOK.RESZBEN,
  })
  const r = kiadastUjraprobal(state, { kiadasId: k.id, most: new Date('2026-09-07T07:00:00.000Z') })
  assert.deepEqual(r.platformok, ['facebook'], 'csak az elbukott ág megy vissza sorba')
  const byPlatform = Object.fromEntries(repo.agak(k.id).map((a) => [a.platform, a]))
  assert.equal(byPlatform.youtube.allapot, AG_ALLAPOTOK.KESZ, 'ami kiment, az kiment marad')
  assert.equal(byPlatform.youtube.url, 'https://youtu.be/abc')
  assert.equal(byPlatform.facebook.allapot, AG_ALLAPOTOK.VAR)
  // HÁROM TÉNY, HÁROM ÁLLAPOT: egy fiók nélküli platform nem bukott el, csak
  // sosem került sorra -- az újraküldés nem tesz úgy, mintha elbukott volna,
  // és a kiadás nem is vár rá (spec 5).
  assert.equal(byPlatform.tiktok.allapot, AG_ALLAPOTOK.NINCS_FIOK, 'a nincs_fiok ág nem lesz hibából újraindítva')
})

test('BLOKKOLÓ 2: se vázlatot, se ütemezettet, se készet nem enged vissza a sorba -- mind megnevezve', () => {
  const { repo, state } = setup()
  repo.ujSav({ nap: 1, ora: 18, perc: 0 })
  const most = new Date('2026-09-07T07:00:00.000Z')

  const vazlat = repo.ujKiadas({ videoId: 'v-vazlat' })
  repo.ujAg({ kiadasId: vazlat.id, platform: 'youtube' })
  assert.throws(() => kiadastUjraprobal(state, { kiadasId: vazlat.id, most }), (err) => {
    assert.equal(err.code, 'kiadas_nem_ujraprobalhato')
    assert.ok(err.message.includes(KIADAS_ALLAPOTOK.VAZLAT), 'a mondat megnevezi a jelenlegi állapotot')
    return true
  })

  const utemezett = kikuldottKiadas(repo, { videoId: 'v-ut', agak: [['youtube', AG_ALLAPOTOK.HIBA]], kiadasAllapot: KIADAS_ALLAPOTOK.UTEMEZVE })
  assert.throws(() => kiadastUjraprobal(state, { kiadasId: utemezett.id, most }), (err) => {
    assert.equal(err.code, 'kiadas_nem_ujraprobalhato')
    return true
  })
  assert.equal(repo.agak(utemezett.id)[0].allapot, AG_ALLAPOTOK.HIBA, 'egy elutasított hívás egyetlen ágat sem írt át')

  const kesz = kikuldottKiadas(repo, { videoId: 'v-kesz', agak: [['youtube', AG_ALLAPOTOK.KESZ, { url: 'https://youtu.be/x' }]], kiadasAllapot: KIADAS_ALLAPOTOK.KESZ })
  assert.throws(() => kiadastUjraprobal(state, { kiadasId: kesz.id, most }), (err) => {
    assert.equal(err.code, 'kiadas_nem_ujraprobalhato')
    return true
  })

  assert.throws(() => kiadastUjraprobal(state, { kiadasId: 'nincs-ilyen', most }), (err) => {
    assert.equal(err.code, 'kiadas_ismeretlen')
    return true
  })
})

test('BLOKKOLÓ 2: sáv nélkül az újraküldés megnevezve marad el, és a kiadás nem kerül félig visszaírt állapotba', () => {
  const { repo, state } = setup()
  const k = kikuldottKiadas(repo, { agak: [['youtube', AG_ALLAPOTOK.HIBA, { hibaKod: 'kvota_elfogyott' }]], kiadasAllapot: KIADAS_ALLAPOTOK.HIBA })
  assert.throws(() => kiadastUjraprobal(state, { kiadasId: k.id, most: new Date('2026-09-07T07:00:00.000Z') }), (err) => {
    assert.equal(err.code, 'nincs_szabad_sav')
    return true
  })
  assert.equal(repo.agak(k.id)[0].allapot, AG_ALLAPOTOK.HIBA, 'az ág nem került var-ba egy kiadás alá, ami hiba maradt')
  assert.equal(repo.kiadas(k.id).allapot, KIADAS_ALLAPOTOK.HIBA)
})

test('BLOKKOLÓ 2: egy nem hibás, megnevezett ág elutasul, és a kiadáson nincs elbukott ág üzenete is megnevezett', () => {
  const { repo, state } = setup()
  repo.ujSav({ nap: 1, ora: 18, perc: 0 })
  const most = new Date('2026-09-07T07:00:00.000Z')
  const k = kikuldottKiadas(repo, {
    agak: [['youtube', AG_ALLAPOTOK.HIBA], ['facebook', AG_ALLAPOTOK.NINCS_FIOK]],
    kiadasAllapot: KIADAS_ALLAPOTOK.HIBA,
  })
  assert.throws(() => kiadastUjraprobal(state, { kiadasId: k.id, platform: 'facebook', most }), (err) => {
    assert.equal(err.code, 'ag_nem_hibas')
    return true
  })
  assert.throws(() => kiadastUjraprobal(state, { kiadasId: k.id, platform: 'instagram', most }), (err) => {
    assert.equal(err.code, 'ag_ismeretlen')
    return true
  })
  const ures = kikuldottKiadas(repo, { videoId: 'v-ures', agak: [['youtube', AG_ALLAPOTOK.NINCS_FIOK]], kiadasAllapot: KIADAS_ALLAPOTOK.HIBA })
  assert.throws(() => kiadastUjraprobal(state, { kiadasId: ures.id, most }), (err) => {
    assert.equal(err.code, 'nincs_ujraprobalhato_ag')
    return true
  })
})

// --- item 7: „épp kiküldés alatt" harmadik tény ---------------------------

test('publishDue: egy másik futás által épp kiküldött ágat nem küld ki másodszor, és nem is hallgatja el', async () => {
  // EGY TÉNY EGY ÁLLAPOTBAN. A „most épp kiküldés alatt" tényt az ág `var`
  // állapota mondta ki -- ugyanaz a szó, mint a „még nem került sorra"-ra --,
  // tehát egy kézi `publishDue` hívás egy ütemezett futással egyidejűleg
  // ugyanazt a videót MÁSODSZOR is feltöltötte. A host `inFlightScheduleKeys`-e
  // csak ütemezés-vs-ütemezés ellen véd, és a kettő közül az egyik itt nem
  // ütemezett.
  let feloldas
  let hivasok = 0
  const lassuAdapter = () => { hivasok += 1; return new Promise((resolve) => { feloldas = () => resolve({ url: 'https://youtu.be/abc' }) }) }
  const { repo, run } = setup({ adapterek: { youtube: lassuAdapter }, video: qaOkVideo('v1') })
  repo.fiokotIr({ platform: 'youtube', kulsoId: 'UC1', nev: 'Csatorna' })
  const k = esedekesKiadas(repo, 'v1', ['youtube'])

  // Az első futás beleragad az adapterbe; a második ugyanarra az ágra érkezik.
  const elso = run('publishDue', {})
  await new Promise((resolve) => { setImmediate(resolve) })
  const masodik = await run('publishDue', {})
  assert.equal(hivasok, 1, 'a második futás NEM hívta meg újra az adaptert ugyanarra az ágra')
  assert.deepEqual(masodik.folyamatban, [{ kiadasId: k.id, platform: 'youtube' }], 'a kihagyás megnevezve jelenik meg, nem csendben')
  assert.equal(masodik.kikuldve, 0)
  assert.deepEqual(masodik.hibak, [], 'egy másik futás munkája nem hiba')

  feloldas()
  const elsoEredmeny = await elso
  assert.equal(elsoEredmeny.kikuldve, 1)
  assert.deepEqual(elsoEredmeny.folyamatban, [])
  assert.equal(repo.agak(k.id)[0].allapot, AG_ALLAPOTOK.KESZ)
})

test('BLOKKOLÓ 1 / robbanási sugár: egy olvashatatlan ág EGY ágba kerül, nem viszi el a lektor egész sorát', async () => {
  // REGRESSZIÓ A b4cae31-HEZ KÉPEST, amit ez a kör maga nyitott. Amíg a
  // vetítés `vanSzoveg: a.szoveg !== null` volt, nem tudott elutasítani;
  // a szöveg beemelésével az `olvasSzoveg` `tarolt_ertek_olvashatatlan`-t
  // dobhat a `.map`-ből, ami kiszökik a map-ből, kiszökik a `guard`-ból, és
  // az EGÉSZ hívást egyetlen `{ error }`-ra váltja -- a lektor minden más
  // kiadásával együtt. Bizonyítva volt: `releases returned: 0`, pedig a
  // második kiadás ép.
  //
  // A tíz sorral fentebbi videó-olvasás már legjobb igyekezet; ez a két
  // olvasás csak abban különbözik, HOGYAN bukik el (PublishError kontra
  // SzovegError), a szabály ugyanaz: egy törött ág egy ágba kerüljön.
  const { repo, run } = setup({ videos: [qaOkVideo('v-tort'), qaOkVideo('v-ep', { narracio_szoveg: 'Az ép kiadás narrációja.' })] })
  const tort = repo.ujKiadas({ videoId: 'v-tort' })
  repo.szovegetIr({ kiadasId: tort.id, platform: 'youtube', szoveg: 'nem json' })
  repo.szovegetIr({ kiadasId: tort.id, platform: 'facebook', szoveg: JSON.stringify({ cim: 'Ép cím', leiras: 'Ép leírás.' }) })
  const ep = repo.ujKiadas({ videoId: 'v-ep' })
  repo.szovegetIr({ kiadasId: ep.id, platform: 'youtube', szoveg: JSON.stringify({ cim: 'C', leiras: 'L' }) })

  const { hiv } = lektorEszkozei(run)
  const r = await hiv('publishQueue', {})
  assert.equal(r.error, undefined, 'a sor megjön, nem egyetlen hibává omlik össze')
  assert.equal(r.kiadasok.length, 2, 'MINDKÉT kiadás visszajön, az ép is')

  const epSor = r.kiadasok.find((x) => x.kiadasId === ep.id)
  assert.equal(epSor.agak[0].cim, 'C', 'az ép kiadás szövege érintetlen')
  assert.equal(epSor.agak[0].szovegHiba, null)
  assert.equal(epSor.narracioSzoveg, 'Az ép kiadás narrációja.')

  const tortSor = r.kiadasok.find((x) => x.kiadasId === tort.id)
  const tortAg = tortSor.agak.find((a) => a.platform === 'youtube')
  assert.equal(tortAg.vanSzoveg, false)
  assert.equal(tortAg.cim, null)
  assert.ok(typeof tortAg.szovegHiba === 'string' && tortAg.szovegHiba !== '', 'a törött ág a saját mondatát hozza')
  assert.ok(tortAg.szovegHiba.includes('publishDraft'), 'és a mondat megmondja, mi a teendő')
  assert.equal(tortAg.szovegHiba.includes('nem json'), false, 'a tárolt szöveget nem mondja vissza')

  // ...és a TÖRÖTT kiadás másik ága ugyanabban a válaszban olvasható marad:
  // egy ág költsége egy ág, nem a kiadásé és nem a soré.
  const epTestver = tortSor.agak.find((a) => a.platform === 'facebook')
  assert.equal(epTestver.cim, 'Ép cím')
  assert.equal(epTestver.szovegHiba, null)
})
