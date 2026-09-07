import assert from 'node:assert/strict'
import test from 'node:test'

import { AG_ALLAPOTOK, KIADAS_ALLAPOTOK, PLATFORMOK } from '../src/db.mjs'
import { createRpc } from '../src/rpc.mjs'
import { freshRepo } from './helpers.mjs'

/**
 * Task 6's own rpc surface: `naptar`, `kiadas`, `fiokok` (reads, throw on a
 * named refusal), `jovahagy`, `atutemez`, `fiokotOsszekot` (levers, resolve
 * with `{ hiba, uzenet, ...}` instead -- `src/rpc.mjs`'s file docblock says
 * why).
 *
 * `setup()` follows `test/szoveg.test.mjs`'s own pattern: an in-memory
 * repository (`test/helpers.mjs`) and a `contracts` double standing in for
 * the video module.
 */
function setup({ video = null, videos = null, why = 'provider_missing', settings = {}, oauth = null, contracts, log } = {}) {
  const { repo } = freshRepo()
  const videoById = new Map((videos ?? (video ? [video] : [])).map((v) => [v.id, v]))
  const state = {
    repo,
    settings: () => settings,
    log: log ?? { info() {}, warn() {}, error() {} },
    contracts: contracts === undefined
      ? { get: (e, c) => (e === 'video' && c === 'videos' ? { get: async ({ id }) => videoById.get(id) ?? null } : null), why: () => why }
      : contracts,
    oauth,
    adapterek: {},
  }
  return { state, repo, rpc: createRpc(state) }
}

function qaOkVideo(id, extra = {}) {
  return { id, cim: 'Egy videó', status: 'qa_ok', narracio_szoveg: 'Ez hangzik el a videóban.', ...extra }
}

/** A kiadás with a written youtube branch, moved straight to `lektoralt` -- `repo.kiadasAllapototIr` is a mechanical setter (src/db.mjs's own docblock), the same shortcut `test/db.test.mjs`/`test/szoveg.test.mjs` take to reach a state without re-running the whole approval chain. */
function lektoraltKiadas(repo, videoId = 'v1') {
  const k = repo.ujKiadas({ videoId })
  repo.szovegetIr({ kiadasId: k.id, platform: 'youtube', szoveg: JSON.stringify({ cim: 'C', leiras: 'L' }) })
  return repo.kiadasAllapototIr(k.id, KIADAS_ALLAPOTOK.LEKTORALT)
}

// --- naptar ------------------------------------------------------------

test('naptar: egy üres modulon üres listákkal felel, sosem hibázik', async () => {
  const { rpc } = setup()
  const r = await rpc.naptar()
  assert.deepEqual(r.savok, [])
  assert.deepEqual(r.kiadasok, [])
  assert.equal(r.idozona, 'Europe/Budapest')
})

test('naptar: az idozona a beállításból jön, a modul saját alapértéke csak fallback', async () => {
  const { rpc } = setup({ settings: { idozona: 'Pacific/Kiritimati' } })
  const r = await rpc.naptar()
  assert.equal(r.idozona, 'Pacific/Kiritimati')
})

test('naptar: a kiadás négy mezője a naptárnak, az ágak csak a négy jelzőt hordozzák -- soha a szöveget', async () => {
  const { repo, rpc } = setup()
  const k = repo.ujKiadas({ videoId: 'v1' })
  repo.szovegetIr({ kiadasId: k.id, platform: 'youtube', szoveg: JSON.stringify({ cim: 'Titkos cím', leiras: 'x' }) })
  repo.szovegetIr({ kiadasId: k.id, platform: 'facebook', szoveg: JSON.stringify({ cim: 'Y', leiras: 'y' }) })
  const r = await rpc.naptar()
  assert.equal(r.kiadasok.length, 1)
  const sor = r.kiadasok[0]
  assert.equal(sor.kiadasId, k.id)
  assert.equal(sor.videoId, 'v1')
  assert.equal(sor.allapot, 'vazlat')
  assert.equal(sor.idopont, null)
  assert.equal(sor.felulirtIdopont, null)
  assert.equal(sor.savId, null)
  assert.deepEqual(sor.agak.map((a) => a.platform).sort(), ['facebook', 'youtube'])
  for (const a of sor.agak) {
    assert.deepEqual(Object.keys(a).sort(), ['allapot', 'platform', 'url'])
    assert.equal(a.allapot, AG_ALLAPOTOK.VAR)
  }
})

test('naptar: az idopont és a felulirt_idopont a saját mezőjükön külön érkeznek', async () => {
  const { repo, rpc } = setup()
  const sav = repo.ujSav({ nap: 1, ora: 9, perc: 0 })
  const jovahagyva = lektoraltKiadas(repo)
  const utemezett = repo.kiadastJovahagy(jovahagyva.id)
  repo.kiadastUtemez({ kiadasId: utemezett.id, savId: sav.id, idopont: '2026-09-07T09:00:00.000Z' })
  repo.idopontFeluliras({ kiadasId: utemezett.id, felulirtIdopont: '2026-09-08T10:00:00.000Z' })
  const r = await rpc.naptar()
  const sor = r.kiadasok[0]
  assert.equal(sor.idopont, '2026-09-08T10:00:00.000Z')
  assert.equal(sor.felulirtIdopont, '2026-09-08T10:00:00.000Z')
  assert.equal(sor.savId, sav.id)
})

// --- kiadas --------------------------------------------------------------

test('kiadas: hiányzó kiadasId megnevezve utasul el', async () => {
  const { rpc } = setup()
  await assert.rejects(() => rpc.kiadas({}), /kiadasId/)
})

test('kiadas: ismeretlen kiadasId megnevezve utasul el', async () => {
  const { rpc } = setup()
  await assert.rejects(() => rpc.kiadas({ kiadasId: 'nincs-ilyen' }), /nincs kiadás/)
})

test('kiadas: a videó címe és narrációja a szerződésen át érkezik, az ágak szövege visszaolvasva', async () => {
  const { repo, rpc } = setup({ video: qaOkVideo('v1') })
  const k = repo.ujKiadas({ videoId: 'v1' })
  repo.szovegetIr({ kiadasId: k.id, platform: 'youtube', szoveg: JSON.stringify({ cim: 'A cím', leiras: 'A leírás.' }) })
  const r = await rpc.kiadas({ kiadasId: k.id })
  assert.equal(r.cim, 'Egy videó')
  assert.equal(r.narracioSzoveg, 'Ez hangzik el a videóban.')
  assert.equal(r.videoHiba, null)
  const yt = r.agak.find((a) => a.platform === 'youtube')
  assert.deepEqual(yt.szoveg, { cim: 'A cím', leiras: 'A leírás.' })
  const other = r.agak.filter((a) => a.platform !== 'youtube')
  for (const a of other) assert.equal(a.szoveg, null)
  assert.deepEqual(r.talalatok, [])
})

test('kiadas: egy nem elérhető videó nevesített üzenetet ad, de a kiadás saját tényei -- ágak, szöveg -- attól még megjönnek', async () => {
  const { repo, rpc } = setup({ contracts: { get: () => null, why: () => 'provider_missing' } })
  const k = repo.ujKiadas({ videoId: 'v1' })
  repo.szovegetIr({ kiadasId: k.id, platform: 'youtube', szoveg: JSON.stringify({ cim: 'C', leiras: 'L' }) })
  const r = await rpc.kiadas({ kiadasId: k.id })
  assert.equal(r.cim, null)
  assert.equal(r.narracioSzoveg, null)
  assert.ok(typeof r.videoHiba === 'string' && r.videoHiba.length > 0)
  assert.equal(r.agak.find((a) => a.platform === 'youtube').szoveg.cim, 'C')
})

test('kiadas: egy verdikt találatai visszajönnek, ha a kiadás lektorálva lett és elbukott', async () => {
  const { repo, rpc } = setup()
  const k = repo.ujKiadas({ videoId: 'v1' })
  repo.talalatokatIr({ kiadasId: k.id, talalatok: JSON.stringify([{ platform: 'youtube', kod: 'hashtag_hianyzik', szoveg: 'nincs hashtag' }]) })
  const r = await rpc.kiadas({ kiadasId: k.id })
  assert.deepEqual(r.talalatok, [{ platform: 'youtube', kod: 'hashtag_hianyzik', szoveg: 'nincs hashtag' }])
})

// --- fiokok ----------------------------------------------------------------

test('fiokok: a platformok listája a modul zárt PLATFORMOK-ja, googleKliensVan false ha nincs oauth', async () => {
  const { rpc } = setup({ oauth: null })
  const r = await rpc.fiokok()
  assert.deepEqual(r.platformok, PLATFORMOK)
  assert.equal(r.googleKliensVan, false)
  assert.deepEqual(r.fiokok, [])
})

test('fiokok: googleKliensVan az oauth saját válaszát mondja, nem találgat', async () => {
  const { rpc } = setup({ oauth: { googleClientConfigured: () => true } })
  const r = await rpc.fiokok()
  assert.equal(r.googleKliensVan, true)
})

test('fiokok: az összekötött fiókok camelCase mezőkkel jönnek vissza', async () => {
  const { repo, rpc } = setup()
  repo.fiokotIr({ platform: 'youtube', kulsoId: 'UC1', nev: 'Csatorna' })
  const r = await rpc.fiokok()
  assert.equal(r.fiokok.length, 1)
  assert.deepEqual(Object.keys(r.fiokok[0]).sort(), ['csatlakoztatvaAt', 'id', 'kulsoId', 'nev', 'platform'])
  assert.equal(r.fiokok[0].kulsoId, 'UC1')
})

// --- jovahagy --------------------------------------------------------------

test('jovahagy: hiányzó kiadasId nevesített elutasítást ad vissza, nem dob', async () => {
  const { rpc } = setup()
  const r = await rpc.jovahagy({})
  assert.equal(r.hiba, 'argumentum_hibas')
  assert.ok(r.uzenet.includes('kiadasId'))
})

test('jovahagy: ismeretlen kiadás nevesítve utasul el', async () => {
  const { rpc } = setup()
  const r = await rpc.jovahagy({ kiadasId: 'nincs-ilyen' })
  assert.equal(r.hiba, 'kiadas_ismeretlen')
})

test('jovahagy: csak lektoralt kiadás hagyható jóvá, a jelenlegi állapot névvel', async () => {
  const { repo, rpc } = setup()
  const k = repo.ujKiadas({ videoId: 'v1' })
  const r = await rpc.jovahagy({ kiadasId: k.id })
  assert.equal(r.hiba, 'kiadas_nincs_lektoralva')
  assert.equal(r.allapot, 'vazlat')
  assert.equal(repo.kiadas(k.id).allapot, 'vazlat', 'a jóváhagyás nem történt meg')
})

test('jovahagy: sáv nélkül a jóváhagyás megtörténik, de az ütemezés nevesítve marad el -- a kiadás jovahagyva marad', async () => {
  const { repo, rpc } = setup()
  const k = lektoraltKiadas(repo)
  const r = await rpc.jovahagy({ kiadasId: k.id })
  assert.equal(r.jovahagyva, true)
  assert.equal(r.utemezve, false)
  assert.equal(r.utemezesHiba.kod, 'nincs_szabad_sav')
  assert.equal(r.allapot, 'jovahagyva')
  assert.equal(repo.kiadas(k.id).allapot, 'jovahagyva', 'a jóváhagyás írása valóban megtörtént, csak az ütemezés nem')
})

test('jovahagy: sávval a jóváhagyás ÉS az ütemezés egy hívásban lezajlik', async () => {
  const { repo, rpc } = setup()
  repo.ujSav({ nap: 1, ora: 9, perc: 0 })
  const k = lektoraltKiadas(repo)
  const r = await rpc.jovahagy({ kiadasId: k.id })
  assert.equal(r.jovahagyva, true)
  assert.equal(r.utemezve, true)
  assert.equal(r.utemezesHiba, null)
  assert.equal(r.allapot, 'utemezve')
  const stored = repo.kiadas(k.id)
  assert.equal(stored.allapot, 'utemezve')
  assert.ok(typeof stored.idopont === 'string' && stored.idopont !== '')
  assert.equal(stored.sav_id !== null, true)
})

test('jovahagy: a computed kiadasAllapot választ soha nem írja vissza a kiadásra -- csak a munkafolyamat-szó kerül a kiadas.allapot oszlopba', async () => {
  const { repo, rpc } = setup()
  repo.ujSav({ nap: 1, ora: 9, perc: 0 })
  const k = lektoraltKiadas(repo)
  await rpc.jovahagy({ kiadasId: k.id })
  const stored = repo.kiadas(k.id)
  assert.ok(['jovahagyva', 'utemezve'].includes(stored.allapot), 'soha kesz/reszben/hiba/nincs_hova -- azokat csak publishDue írhatja, valódi kiküldés után')
})

test('a lever egy váratlan hibát ismeretlen_hiba alatt ad vissza, nem dobja tovább nevesítetlenül', async () => {
  const { repo, rpc } = setup()
  const k = lektoraltKiadas(repo)
  const eredeti = repo.kiadastJovahagy
  repo.kiadastJovahagy = () => { throw new Error('nem várt hiba a repóból') }
  try {
    const r = await rpc.jovahagy({ kiadasId: k.id })
    assert.equal(r.hiba, 'ismeretlen_hiba')
    assert.equal(r.uzenet, 'nem várt hiba a repóból')
  } finally {
    repo.kiadastJovahagy = eredeti
  }
})

// --- atutemez ----------------------------------------------------------

test('atutemez: hiányzó vagy érvénytelen időpont nevesítve utasul el', async () => {
  const { repo, rpc } = setup()
  const k = lektoraltKiadas(repo)
  const missing = await rpc.atutemez({ kiadasId: k.id })
  assert.equal(missing.hiba, 'argumentum_hibas')
  const bad = await rpc.atutemez({ kiadasId: k.id, felulirtIdopont: 'nem-datum' })
  assert.equal(bad.hiba, 'idopont_ervenytelen')
})

test('atutemez: csak utemezve állapotú kiadás időpontja írható felül', async () => {
  const { repo, rpc } = setup()
  const k = lektoraltKiadas(repo)
  const r = await rpc.atutemez({ kiadasId: k.id, felulirtIdopont: '2026-09-10T09:00:00.000Z' })
  assert.equal(r.hiba, 'kiadas_nincs_utemezve')
  assert.equal(r.allapot, 'lektoralt')
})

test('atutemez: a felülírás mindkét oszlopot egyszerre írja, ahogy a repo maga is teszi', async () => {
  const { repo, rpc } = setup()
  const sav = repo.ujSav({ nap: 1, ora: 9, perc: 0 })
  const k = lektoraltKiadas(repo)
  const jovahagyva = repo.kiadastJovahagy(k.id)
  repo.kiadastUtemez({ kiadasId: jovahagyva.id, savId: sav.id, idopont: '2026-09-07T09:00:00.000Z' })
  const r = await rpc.atutemez({ kiadasId: k.id, felulirtIdopont: '2026-09-09T11:30:00.000Z' })
  assert.equal(r.idopont, '2026-09-09T11:30:00.000Z')
  assert.equal(r.felulirtIdopont, '2026-09-09T11:30:00.000Z')
  const stored = repo.kiadas(k.id)
  assert.equal(stored.idopont, '2026-09-09T11:30:00.000Z')
  assert.equal(stored.felulirt_idopont, '2026-09-09T11:30:00.000Z')
})

// --- fiokotOsszekot ----------------------------------------------------

test('fiokotOsszekot: hiányzó mezők nevesítve utasulnak el, egyik sem íródik ki', async () => {
  const { repo, rpc } = setup()
  const r1 = await rpc.fiokotOsszekot({})
  assert.equal(r1.hiba, 'argumentum_hibas')
  const r2 = await rpc.fiokotOsszekot({ platform: 'nemletezo', kulsoId: 'x', nev: 'y' })
  assert.equal(r2.hiba, 'argumentum_hibas')
  assert.deepEqual(repo.fiokok(), [])
})

test('fiokotOsszekot: ír egy fiókot, és ugyanaz a platform+kulsoId frissít, nem duplikál', async () => {
  const { repo, rpc } = setup()
  const r1 = await rpc.fiokotOsszekot({ platform: 'youtube', kulsoId: 'UC1', nev: 'Régi név' })
  assert.equal(r1.hiba, undefined)
  assert.equal(r1.fiok.nev, 'Régi név')
  const r2 = await rpc.fiokotOsszekot({ platform: 'youtube', kulsoId: 'UC1', nev: 'Új név' })
  assert.equal(r2.fiok.id, r1.fiok.id)
  assert.equal(repo.fiokok().length, 1)
  assert.equal(repo.fiokok()[0].nev, 'Új név')
})
