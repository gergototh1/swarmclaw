import assert from 'node:assert/strict'
import test from 'node:test'

import { KIADAS_ALLAPOTOK } from '../src/db.mjs'
import { LEKTOR_KODOK, PLATFORM_KORLATOK, VERDIKTEK, createSzovegTools, kiadastUtemezSavba } from '../src/szoveg.mjs'
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
function setup({ video = null, why = 'provider_missing', adapterek = {}, settings = {} } = {}) {
  const { repo } = freshRepo()
  const state = {
    repo,
    settings: () => settings,
    log: { info() {}, warn() {}, error() {} },
    contracts: { get: (e, c) => (e === 'video' && c === 'videos' ? { get: async ({ id }) => (video && video.id === id ? video : null) } : null), why: () => why },
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
  assert.equal(repo.kiadas(a.kiadasId).video_id, 'vid-1')
  const b = await run('publishOpen', { videoId: 'vid-1' })
  assert.equal(b.uj, false)
  assert.equal(b.kiadasId, a.kiadasId, 'ugyanaz a kiadás jön vissza, nem egy második')
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
