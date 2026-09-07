import assert from 'node:assert/strict'
import test from 'node:test'

import { KIADAS_ALLAPOTOK } from '../src/db.mjs'
import { LEKTOR_KODOK, PLATFORM_KORLATOK, SzovegError, VERDIKTEK, createSzovegTools, kiadastUtemezSavba } from '../src/szoveg.mjs'
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
function setup({ video = null, why = 'provider_missing', adapterek = {}, settings = {}, contracts, log } = {}) {
  const { repo } = freshRepo()
  const state = {
    repo,
    settings: () => settings,
    log: log ?? { info() {}, warn() {}, error() {} },
    contracts: contracts === undefined
      ? { get: (e, c) => (e === 'video' && c === 'videos' ? { get: async ({ id }) => (video && video.id === id ? video : null) } : null), why: () => why }
      : contracts,
    adapterek,
  }
  const tools = Object.fromEntries(createSzovegTools(state).map((t) => [t.name, t]))
  const run = (name, args, agentId = 'ag-1', sessionId = 's1') => tools[name].execute(args, { session: { id: sessionId, agentId }, message: '' })
  return { state, repo, run }
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
  const { repo, run } = setup()
  const k1 = repo.ujKiadas({ videoId: 'v1' })
  repo.szovegetIr({ kiadasId: k1.id, platform: 'youtube', szoveg: '{"cim":"x"}' })
  const k2 = repo.ujKiadas({ videoId: 'v2' })
  repo.kiadasAllapototIr(k2.id, KIADAS_ALLAPOTOK.JOVAHAGYVA)
  const r = await run('publishQueue', {})
  assert.deepEqual(r.kiadasok.map((k) => k.kiadasId), [k1.id], 'a jovahagyva kiadás nem a munkasor tagja')
  assert.deepEqual(r.kiadasok[0].agak, [{ platform: 'youtube', vanSzoveg: true }])
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
  const { repo, run } = setup({ adapterek: { youtube: async () => ({ url: 'https://youtu.be/x' }) } })
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
  const { repo, run } = setup({ adapterek: { youtube: async () => { throw new Error('a hálózat elszállt') } } })
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
