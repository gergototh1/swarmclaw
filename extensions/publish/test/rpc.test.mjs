import assert from 'node:assert/strict'
import test from 'node:test'

import { kiadasAllapot } from '../src/allapot.mjs'
import { AG_ALLAPOTOK, KIADAS_ALLAPOTOK, PLATFORMOK } from '../src/db.mjs'
import { ALAP_SAVOK, createRpc } from '../src/rpc.mjs'
import { ALAP_IDOZONA } from '../src/db.mjs'
import { hetKezdete } from '../src/utemezes.mjs'
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
  // MUTABLE, AND A FRESH OBJECT ON EVERY CALL -- the host's own `ctx.settings`
  // reads the stored settings each time it is asked and hands back a new
  // object, and a double that closed over one frozen object would be a
  // strictly easier world than production. It would also make an entire class
  // of bug untestable: a `createRpc` that read `state.settings()` ONCE (at
  // construction, which is module load in `index.mjs`) would go on answering
  // with the zone the process started with, and a double returning the same
  // object forever cannot tell that apart from a correct read. `beallitasokatIr`
  // below is what lets a test change the setting under a live rpc instance.
  let beallitasok = settings
  const state = {
    repo,
    settings: () => ({ ...beallitasok }),
    log: log ?? { info() {}, warn() {}, error() {} },
    contracts: contracts === undefined
      ? { get: (e, c) => (e === 'video' && c === 'videos' ? { get: async ({ id }) => videoById.get(id) ?? null } : null), why: () => why }
      : contracts,
    oauth,
    adapterek: {},
  }
  return { state, repo, rpc: createRpc(state), beallitasokatIr: (ujak) => { beallitasok = ujak } }
}

/**
 * A `naptar` argumentuma ahhoz a HÉTHEZ, amiben egy adott pillanat van.
 *
 * A naptár egy hetet rajzol, nem az összes valaha volt kiadást, tehát egy
 * teszt, ami egy fix időpontra ütemezett kiadást vár vissza, meg kell mondja,
 * MELYIK hetet kéri -- különben a teszt attól függene, mikor futtatják, és
 * jövő héten magától elromlana. Ugyanaz a számítás, amit a modul is végez
 * (`hetKezdete`, src/utemezes.mjs), a modul saját zónájában.
 */
function hetAmiben(iso, zona = ALAP_IDOZONA) {
  return { hetKezdet: hetKezdete(new Date(iso), zona, 0) }
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
  const r = await rpc.naptar(hetAmiben('2026-09-08T10:00:00.000Z'))
  const sor = r.kiadasok[0]
  assert.equal(sor.idopont, '2026-09-08T10:00:00.000Z')
  assert.equal(sor.felulirtIdopont, '2026-09-08T10:00:00.000Z')
  assert.equal(sor.savId, sav.id)
})

test('naptar: egy sávra tett, de NEM felülírt kiadáson a felulirtIdopont null -- a két oszlop nem ugyanaz', async () => {
  // A LÉTEZŐ ŐR VAK VOLT ERRE. A felette lévő teszt csak a felülírás UTÁNI
  // állapotot járja be, ahol `idopontFeluliras` szerkezetéből adódóan a két
  // oszlop már azonos, tehát egy `felulirtIdopont: k.idopont` mutáció
  // átcsúszik rajta. A megkülönböztetés pont itt dől el: ha ez a mező az
  // idopont-ból jönne, MINDEN ütemezett kiadás kiírná a naptáron az
  // "az operátor kézzel állította át az időpontot" mondatot -- pont az a
  // különbség fordulna a visszájára, amiért a séma a két oszlopot külön
  // tartja (design spec 3).
  const { repo, rpc } = setup()
  const sav = repo.ujSav({ nap: 1, ora: 9, perc: 0 })
  const k = lektoraltKiadas(repo)
  repo.kiadastJovahagy(k.id)
  repo.kiadastUtemez({ kiadasId: k.id, savId: sav.id, idopont: '2026-09-07T09:00:00.000Z' })
  const sor = (await rpc.naptar(hetAmiben('2026-09-07T09:00:00.000Z'))).kiadasok[0]
  assert.equal(sor.idopont, '2026-09-07T09:00:00.000Z')
  assert.equal(sor.felulirtIdopont, null, 'ezt a kiadást senki nem írta felül')
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

test('kiadas: az allapot a TÁROLT munkafolyamat-szó, sosem a kiadasAllapot számolt válasza', async () => {
  // EZ A MEZŐ HAJTJA A JÓVÁHAGYÁS-KAPUT (ui/kiadas.tsx). Egy csupa-`var` ágú
  // kiadásra a `kiadasAllapot` `utemezve`-t számol, akármelyik munkafolyamat-
  // szóban is áll valójában -- tehát ha ez a válasz a számolt értéket adná,
  // egy `lektoralt` kiadás "Ütemezve"-ként érkezne a lapra, és a Jóváhagyás
  // gomb ÖRÖKRE le lenne tiltva; egy `vazlat` pedig szintén ütemezettnek
  // látszana. A naptar()-on ugyanez már pinnelve van; itt a részletes olvasás
  // a tárgy.
  const { repo, rpc } = setup()
  const lektoralt = lektoraltKiadas(repo, 'v1')
  const vazlat = repo.ujKiadas({ videoId: 'v2' })
  repo.szovegetIr({ kiadasId: vazlat.id, platform: 'youtube', szoveg: JSON.stringify({ cim: 'C', leiras: 'L' }) })

  // A fixture tényleg megkülönbözteti a kettőt: a számolt válasz mindkettőre
  // ugyanaz, és egyikük tárolt szavával sem egyezik.
  assert.equal(kiadasAllapot(repo.agak(lektoralt.id)), 'utemezve')
  assert.equal(kiadasAllapot(repo.agak(vazlat.id)), 'utemezve')

  assert.equal((await rpc.kiadas({ kiadasId: lektoralt.id })).allapot, KIADAS_ALLAPOTOK.LEKTORALT)
  assert.equal((await rpc.kiadas({ kiadasId: vazlat.id })).allapot, KIADAS_ALLAPOTOK.VAZLAT)
})

test('kiadas: egy sávra tett, de NEM felülírt kiadáson a felulirtIdopont itt is null', async () => {
  const { repo, rpc } = setup()
  const sav = repo.ujSav({ nap: 1, ora: 9, perc: 0 })
  const k = lektoraltKiadas(repo)
  repo.kiadastJovahagy(k.id)
  repo.kiadastUtemez({ kiadasId: k.id, savId: sav.id, idopont: '2026-09-07T09:00:00.000Z' })
  const r = await rpc.kiadas({ kiadasId: k.id })
  assert.equal(r.idopont, '2026-09-07T09:00:00.000Z')
  assert.equal(r.felulirtIdopont, null)
  assert.equal(r.savId, sav.id)

  // És a felülírás UTÁN mindkettő megvan -- a null fent nem azért van, mert ez
  // a mező soha nem szólal meg.
  await rpc.atutemez({ kiadasId: k.id, felulirtIdopont: '2026-09-08T10:00:00.000Z' })
  const utana = await rpc.kiadas({ kiadasId: k.id })
  assert.equal(utana.felulirtIdopont, '2026-09-08T10:00:00.000Z')
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
  // A KORÁBBI VÁLTOZAT SEMMIT NEM ÁLLÍTOTT. A megengedett halmaza
  // ['jovahagyva','utemezve'] volt, ami pont az, amit a `kiadasAllapot` egy
  // csupa-`var` kiadásra ad -- tehát átment volna AKKOR IS, ha a számolt
  // választ írja vissza a jovahagy. Itt a két érték szét van választva: a
  // csupa-`var` ág `nincs_fiok`-ra állítva a számolt válasz `nincs_hova` lesz,
  // ami egyik munkafolyamat-szónak sem felel meg, és a tárolt szó pontosan
  // meg van nevezve, nem egy halmazba engedve.
  const { repo, rpc } = setup()
  repo.ujSav({ nap: 1, ora: 9, perc: 0 })
  const k = lektoraltKiadas(repo)
  const ag = repo.agak(k.id)[0]
  repo.agEredmenyetIr({ agId: ag.id, allapot: AG_ALLAPOTOK.NINCS_FIOK })
  assert.equal(kiadasAllapot(repo.agak(k.id)), KIADAS_ALLAPOTOK.NINCS_HOVA, 'a számolt válasz itt tényleg más, mint a munkafolyamat-szó')

  const r = await rpc.jovahagy({ kiadasId: k.id })
  assert.equal(r.allapot, KIADAS_ALLAPOTOK.UTEMEZVE)
  assert.equal(repo.kiadas(k.id).allapot, KIADAS_ALLAPOTOK.UTEMEZVE, 'a tárolt szó a munkafolyamaté; a nincs_hova-t csak a publishDue írhatja, valódi kiküldés után')
})

test('naptar: ugyanaz a createRpc példány követi a beállítás változását -- az idozona nincs a példány mellé mentve', async () => {
  // A `createRpc(state)` MODUL-BETÖLTÉSKOR fut le egyszer (index.mjs), a
  // metódusai viszont hónapokon át élnek. Egy gyorsítótárazott
  // `state.settings()` olvasás ezért nem lassulás, hanem elavult időzóna: az
  // operátor átírja a mezőt, a naptár és a sáv-aritmetika a process indulási
  // zónájában marad, és semmi nem jelenti a nézeteltérést. Egyetlen példány,
  // két olvasás, közte egy beállítás-változás -- ez az egyetlen alak, ami ezt
  // meg tudja fogni.
  const { rpc, beallitasokatIr } = setup({ settings: { idozona: 'Europe/Budapest' } })
  assert.equal((await rpc.naptar()).idozona, 'Europe/Budapest')
  beallitasokatIr({ idozona: 'Pacific/Kiritimati' })
  assert.equal((await rpc.naptar()).idozona, 'Pacific/Kiritimati')
  beallitasokatIr({})
  assert.equal((await rpc.naptar()).idozona, 'Europe/Budapest', 'a kiürített mező a modul saját alapértékére esik vissza, minden hívásnál újra')
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

// --- savotFelvesz / savotTorol / alapSavokatFelvesz -----------------------
//
// A BEJÁRAT A SÁV-TÁBLÁHOZ. Ezek a metódusok azért vannak, mert a `repo.ujSav`
// (src/db.mjs) ELSŐ öt feladaton át úgy létezett, hogy éles kódból SEMMI nem
// hívta: se rpc, se tool, se beállítás-mező. Így a `savok()` minden valódi
// telepítésen üres volt, a `kovetkezoSzabadSav` `null`-t adott, a
// `kiadastUtemezSavba` minden jóváhagyást `nincs_szabad_sav`-val utasított el,
// és a 15 perces ütemezés örökre tétlen futott. Az alábbi utolsó teszt az,
// ami ezt az egész láncot éles felületeken végigviszi.

test('savotFelvesz: felvesz egy sávot, és az azonnal ott van a naptáron', async () => {
  const { rpc } = setup()
  assert.deepEqual((await rpc.naptar()).savok, [], 'egy friss telepítésen nulla sáv van')
  const r = await rpc.savotFelvesz({ nap: 3, ora: 18, perc: 30 })
  assert.equal(r.hiba, undefined)
  assert.deepEqual(Object.keys(r.sav).sort(), ['id', 'nap', 'ora', 'perc'])
  assert.equal(r.sav.nap, 3)
  assert.equal(r.sav.ora, 18)
  assert.equal(r.sav.perc, 30)
  const savok = (await rpc.naptar()).savok
  assert.equal(savok.length, 1)
  assert.equal(savok[0].id, r.sav.id)
})

test('savotFelvesz: a tartományon kívüli és a nem egész érték nevesítve utasul el, és egyik sem íródik ki', async () => {
  const { repo, rpc } = setup()
  for (const rossz of [
    {},
    { nap: 7, ora: 9, perc: 0 },
    { nap: -1, ora: 9, perc: 0 },
    { nap: 1, ora: 24, perc: 0 },
    { nap: 1, ora: 9, perc: 60 },
    { nap: 1.5, ora: 9, perc: 0 },
    { nap: '1', ora: 9, perc: 0 },
    { nap: 1, ora: Number.NaN, perc: 0 },
  ]) {
    const r = await rpc.savotFelvesz(rossz)
    assert.equal(r.hiba, 'argumentum_hibas', JSON.stringify(rossz))
    assert.ok(/nap|ora|perc/.test(r.uzenet), 'az elutasítás megnevezi az argumentumot')
  }
  assert.deepEqual(repo.savok(), [], 'egyik elutasított hívás sem írt sort')
})

test('savotFelvesz: az elutasítás nem mondja vissza a beküldött értéket', async () => {
  const { rpc } = setup()
  const r = await rpc.savotFelvesz({ nap: 1, ora: 99, perc: 0 })
  assert.equal(r.hiba, 'argumentum_hibas')
  assert.equal(r.uzenet.includes('99'), false, 'a modul a saját tartományát mondja, nem a hívó számát')
})

test('savotTorol: töröl egy sávot, egy ismeretlen savId pedig nevesítve utasul el', async () => {
  const { repo, rpc } = setup()
  const sav = (await rpc.savotFelvesz({ nap: 1, ora: 9, perc: 0 })).sav
  const ures = await rpc.savotTorol({})
  assert.equal(ures.hiba, 'argumentum_hibas')
  const ismeretlen = await rpc.savotTorol({ savId: 'nincs-ilyen' })
  assert.equal(ismeretlen.hiba, 'sav_ismeretlen')
  assert.equal(repo.savok().length, 1, 'egy elutasított törlés nem töröl')

  const r = await rpc.savotTorol({ savId: sav.id })
  assert.equal(r.hiba, undefined)
  assert.equal(r.savId, sav.id)
  assert.deepEqual((await rpc.naptar()).savok, [])
})

test('savotTorol: egy már ütemezett kiadás időpontja túléli a sávja törlését', async () => {
  // A sáv törlése a JÖVŐBELI elhelyezéseket állítja meg. Ami már időpontot
  // kapott, az az `idopont` oszlopa szerint megy ki -- `esedekes` és
  // `foglaltSavIdopontok` is azt olvassa --, és egy kaszkádolt törlés
  // olyan kiadásokat ütemezne ki, amikről az operátor nem beszélt.
  const { repo, rpc } = setup()
  const sav = (await rpc.savotFelvesz({ nap: 1, ora: 9, perc: 0 })).sav
  const k = lektoraltKiadas(repo)
  const jovahagyas = await rpc.jovahagy({ kiadasId: k.id })
  assert.equal(jovahagyas.utemezve, true)
  const elotte = repo.kiadas(k.id)

  await rpc.savotTorol({ savId: sav.id })
  const utana = repo.kiadas(k.id)
  assert.equal(utana.allapot, KIADAS_ALLAPOTOK.UTEMEZVE)
  assert.equal(utana.idopont, elotte.idopont)
  assert.equal(utana.sav_id, sav.id, 'a jelzés megmarad; egy törölt sávra hivatkozó kiadás nem tűnik el')
})

test('alapSavokatFelvesz: üres naptárra felveszi az ALAP_SAVOK készletet, egy másodszori hívás nevesítve utasul el', async () => {
  const { repo, rpc } = setup()
  const r = await rpc.alapSavokatFelvesz()
  assert.equal(r.hiba, undefined)
  assert.deepEqual(
    r.savok.map((s) => ({ nap: s.nap, ora: s.ora, perc: s.perc })),
    ALAP_SAVOK.map((s) => ({ nap: s.nap, ora: s.ora, perc: s.perc })),
    'pontosan azt veszi fel, amit a lap gombja ígér',
  )
  assert.deepEqual(ALAP_SAVOK.map((s) => s.nap), [1, 3, 5], 'hétfő, szerda, péntek -- a lap gombjának szövege ezt mondja')
  assert.deepEqual([...new Set(ALAP_SAVOK.map((s) => `${s.ora}:${s.perc}`))], ['18:0'])
  assert.equal(repo.savok().length, 3)

  const megegyszer = await rpc.alapSavokatFelvesz()
  assert.equal(megegyszer.hiba, 'van_mar_sav')
  assert.equal(repo.savok().length, 3, 'a második gombnyomás nem duplázza meg a hetet')
})

test('alapSavokatFelvesz: egyetlen kézzel felvett sáv is elzárja az alapkészletet', async () => {
  const { repo, rpc } = setup()
  await rpc.savotFelvesz({ nap: 6, ora: 7, perc: 15 })
  const r = await rpc.alapSavokatFelvesz()
  assert.equal(r.hiba, 'van_mar_sav')
  assert.equal(repo.savok().length, 1, 'az operátor saját sávja mellé nem sétál be három találgatás')
})

test('a lap felületein egy friss telepítés eljut a jóváhagyástól az ütemezésig -- ez az, ami sáv-bejárat nélkül lehetetlen volt', async () => {
  const { repo, rpc } = setup()
  const k = lektoraltKiadas(repo)

  // 1. Sáv nélkül a jóváhagyás megtörténik, az ütemezés nevesítve elmarad.
  const savNelkul = await rpc.jovahagy({ kiadasId: k.id })
  assert.equal(savNelkul.jovahagyva, true)
  assert.equal(savNelkul.utemezve, false)
  assert.equal(savNelkul.utemezesHiba.kod, 'nincs_szabad_sav')
  assert.equal(savNelkul.allapot, KIADAS_ALLAPOTOK.JOVAHAGYVA)

  // 2. Az üres naptár gombja -- az egyetlen éles út, amin sáv keletkezhet.
  assert.equal((await rpc.alapSavokatFelvesz()).savok.length, 3)

  // 3. A modul saját következő lépése: a jóváhagyott kiadást a következő
  //    szabad sávba teszi. (A `jovahagy` másodszori hívása a MÁR JÓVÁHAGYOTT
  //    kiadásra azóta megengedett -- pont ez menti meg a friss telepítés első
  //    kiadását, lásd a lentebbi "NEM ragad be" tesztet --, itt viszont
  //    szándékosan egy MÁSIK, most lektorált kiadás megy végig, hogy a
  //    lépés a `lektoralt -> jovahagyva -> utemezve` teljes utat járja be,
  //    ne csak a második felét.)
  const masik = lektoraltKiadas(repo, 'v2')
  const savval = await rpc.jovahagy({ kiadasId: masik.id })
  assert.equal(savval.utemezve, true)
  assert.equal(savval.allapot, KIADAS_ALLAPOTOK.UTEMEZVE)
  const tarolt = repo.kiadas(masik.id)
  assert.ok(typeof tarolt.idopont === 'string' && tarolt.idopont !== '')
  assert.equal(tarolt.felulirt_idopont, null)

  // 4. És a naptár már ki tudja rajzolni: sávok is, időpont is. A naptár EGY
  //    hetet rajzol, ezért azt a hetet kérjük, amelyikbe a modul a kiadást
  //    tette -- a következő szabad sáv a jövő héten is lehet.
  const naptar = await rpc.naptar(hetAmiben(tarolt.idopont))
  assert.equal(naptar.savok.length, 3)
  assert.equal(naptar.kiadasok.find((x) => x.kiadasId === masik.id).idopont, tarolt.idopont)
})

test('jovahagy: egy sáv nélkül jóváhagyott kiadás NEM ragad be -- sáv felvétele után ugyanaz a gomb ütemezi', async () => {
  // A FRISS TELEPÍTÉS ELSŐ KIADÁSA PONTOSAN EZT AZ UTAT JÁRJA. A `jovahagy`
  // két független írása közül a második `nincs_szabad_sav`-val elbukhat, és
  // a köztes `jovahagyva` állapot ettől nem kivételes, hanem a szokásos:
  // az operátor előbb hagy jóvá, és csak utána veszi észre, hogy sávot is
  // kell csinálnia. Ha ez a metódus csak `lektoralt`-ot fogadna, az a kiadás
  // SEHONNAN nem lenne többé ütemezhető -- az `atutemez` csak `utemezve`-t
  // enged --, tehát minden telepítés első kiadása örökre elveszne.
  const { repo, rpc } = setup()
  const k = lektoraltKiadas(repo)

  const elso = await rpc.jovahagy({ kiadasId: k.id })
  assert.equal(elso.jovahagyva, true)
  assert.equal(elso.utemezve, false)
  assert.equal(elso.utemezesHiba.kod, 'nincs_szabad_sav')
  assert.equal(repo.kiadas(k.id).allapot, KIADAS_ALLAPOTOK.JOVAHAGYVA)

  assert.equal((await rpc.alapSavokatFelvesz()).savok.length, 3)

  const masodik = await rpc.jovahagy({ kiadasId: k.id })
  assert.equal(masodik.hiba, undefined, 'a már jóváhagyott kiadás nem utasul el')
  assert.equal(masodik.jovahagyva, true)
  assert.equal(masodik.utemezve, true)
  assert.equal(masodik.allapot, KIADAS_ALLAPOTOK.UTEMEZVE)
  assert.ok(typeof repo.kiadas(k.id).idopont === 'string')
})

test('jovahagy: se vázlatot, se már ütemezettet nem enged -- a nyitás csak a jovahagyva-ra szól', async () => {
  const { repo, rpc } = setup()
  repo.ujSav({ nap: 1, ora: 9, perc: 0 })

  const vazlat = repo.ujKiadas({ videoId: 'v9' })
  const r1 = await rpc.jovahagy({ kiadasId: vazlat.id })
  assert.equal(r1.hiba, 'kiadas_nincs_lektoralva')
  assert.equal(r1.allapot, KIADAS_ALLAPOTOK.VAZLAT)

  const k = lektoraltKiadas(repo)
  assert.equal((await rpc.jovahagy({ kiadasId: k.id })).utemezve, true)
  const r2 = await rpc.jovahagy({ kiadasId: k.id })
  assert.equal(r2.hiba, 'kiadas_nincs_lektoralva', 'egy ütemezett kiadást ez a gomb nem tesz át máshova; arra az atutemez van')
  assert.equal(r2.allapot, KIADAS_ALLAPOTOK.UTEMEZVE)
})

// --- a heti ablak: EGY hét, nem az összes valaha volt kiadás --------------

test('naptar: csak a kért hét kiadásait szállítja, és az időpont nélkülieket MINDEN héten', async () => {
  // A HÉTFŐ OSZLOP ÖRÖKRE GYŰJTÖTT. A lap hét oszlopba vödrözte az ÖSSZES
  // kiadást, ablak nélkül, az rpc pedig mindet szállította (plusz áganként
  // egy lekérdezést) -- egy "heti naptár", ami valójában élettartam-naptár
  // volt, korlát nélkül növekvő listával.
  //
  // Az időpont nélküliek a kivétel, és nem szivárgás: azok a vázlatok, a
  // lektoráltak és a sávra még nem tett jóváhagyottak. Egyik héthez sem
  // tartoznak (a lap saját "Időpont nélkül" oszlopában rajzolja őket), és egy
  // héthatár mögé rejtve pont az a kiadás tűnne el, amivel az operátornak
  // dolga van -- friss telepítésen mindig ott ül az első.
  const { repo, rpc } = setup()
  const sav = repo.ujSav({ nap: 1, ora: 9, perc: 0 })
  const ezenAHeten = lektoraltKiadas(repo, 'v-ez')
  repo.kiadastJovahagy(ezenAHeten.id)
  repo.kiadastUtemez({ kiadasId: ezenAHeten.id, savId: sav.id, idopont: '2026-09-07T09:00:00.000Z' })
  const masHeten = lektoraltKiadas(repo, 'v-mas')
  repo.kiadastJovahagy(masHeten.id)
  repo.kiadastUtemez({ kiadasId: masHeten.id, savId: sav.id, idopont: '2026-11-02T09:00:00.000Z' })
  const idopontNelkul = repo.ujKiadas({ videoId: 'v-vazlat' })

  const r = await rpc.naptar(hetAmiben('2026-09-07T09:00:00.000Z'))
  const idk = r.kiadasok.map((k) => k.kiadasId).sort()
  assert.deepEqual(idk, [ezenAHeten.id, idopontNelkul.id].sort(), 'a másik hét kiadása nincs benne')

  const masik = await rpc.naptar(hetAmiben('2026-11-02T09:00:00.000Z'))
  assert.deepEqual(masik.kiadasok.map((k) => k.kiadasId).sort(), [masHeten.id, idopontNelkul.id].sort())
})

test('naptar: a hét négy határpillanata a válasszal utazik, és a lapozás pont ezekkel lép -- a lap nem számol zónát', async () => {
  const { rpc } = setup()
  const r = await rpc.naptar(hetAmiben('2026-09-07T09:00:00.000Z'))
  assert.equal(r.hetVege, r.kovetkezoHetKezdet, 'a hét vége ÉS a következő hét kezdete ugyanaz a pillanat, nem két számítás')
  assert.equal(Date.parse(r.hetVege) - Date.parse(r.hetKezdet), 7 * 24 * 60 * 60 * 1000, 'ez a hét nem esik óraátállításra, tehát pont hét nap')
  // ...és a lapozás visszaadott pillanata tényleg az előző, illetve a
  // következő hetet nyitja: a lap semmit nem számol, csak visszaadja.
  const elozo = await rpc.naptar({ hetKezdet: r.elozoHetKezdet })
  assert.equal(elozo.kovetkezoHetKezdet, r.hetKezdet)
  const kovetkezo = await rpc.naptar({ hetKezdet: r.kovetkezoHetKezdet })
  assert.equal(kovetkezo.elozoHetKezdet, r.hetKezdet)
})

test('naptar: a hét a modul zónájának FALI ÓRÁJÁN kezdődik, nem UTC-ben', async () => {
  const { rpc } = setup({ settings: { idozona: 'Pacific/Kiritimati' } })
  const r = await rpc.naptar(hetAmiben('2026-09-07T09:00:00.000Z', 'Pacific/Kiritimati'))
  // Kiritimati UTC+14: a helyi vasárnap 00:00 az előző szombat 10:00 UTC-kor van.
  assert.equal(r.hetKezdet.endsWith('T10:00:00.000Z'), true, `a hét kezdete a zóna éjfele, nem UTC éjfél: ${r.hetKezdet}`)
})

// --- BLOKKOLÓ 2: a lap felületein a halott kiadás feltámad -----------------

test('BLOKKOLÓ 2: a friss telepítés első kiadása elbukik a gyerekeknek-mezőn, és az ujraprobal a lap EGYETLEN kijárata belőle', async () => {
  // A ZÁRÓ ÁTNÉZÉS REPRODUKCIÓJA. A `gyerekeknek` az a beállítás, aminek
  // SZÁNDÉKOSAN nincs alapértéke (COPPA-nyilatkozat), tehát a friss
  // telepítés első kiküldése ezen bukik el -- és utána MINDEN kijárat zárva
  // volt: `jovahagy` -> kiadas_nincs_lektoralva, `atutemez` ->
  // kiadas_nincs_utemezve, `publishDraft` -> kiadas_lezart_szovegre,
  // `publishVerdict` -> kiadas_nincs_vazlatban, `publishOpen` -> a HALOTT
  // kiadást adja vissza (idempotens a videoId-ra, tehát második kiadás sem
  // nyitható), `publishDue` -> üres. Az a videó soha többé nem volt
  // publikálható ezzel a modullal.
  const { repo, rpc } = setup()
  repo.ujSav({ nap: 1, ora: 18, perc: 0 })
  const k = repo.ujKiadas({ videoId: 'v1' })
  const ag = repo.ujAg({ kiadasId: k.id, platform: 'youtube' })
  repo.agEredmenyetIr({ agId: ag.id, allapot: AG_ALLAPOTOK.HIBA, hibaKod: 'gyerekeknek_nincs_beallitva' })
  repo.kiadasAllapototIr(k.id, kiadasAllapot(repo.agak(k.id)))
  assert.equal(repo.kiadas(k.id).allapot, KIADAS_ALLAPOTOK.HIBA)

  // A régi zsákutca, ugyanazon a felületen, ahol az operátor áll:
  assert.equal((await rpc.jovahagy({ kiadasId: k.id })).hiba, 'kiadas_nincs_lektoralva')
  assert.equal((await rpc.atutemez({ kiadasId: k.id, felulirtIdopont: '2026-09-09T10:00:00.000Z' })).hiba, 'kiadas_nincs_utemezve')

  // ...és a kar, ami kinyitja.
  const r = await rpc.ujraprobal({ kiadasId: k.id })
  assert.equal(r.hiba, undefined, 'az operátor beállította a mezőt, és a kiadás visszamehet a sorba')
  assert.deepEqual(r.platformok, ['youtube'])
  assert.equal(r.allapot, KIADAS_ALLAPOTOK.UTEMEZVE)
  const utana = repo.kiadas(k.id)
  assert.equal(utana.allapot, KIADAS_ALLAPOTOK.UTEMEZVE)
  assert.ok(typeof utana.idopont === 'string' && utana.idopont !== '')
  assert.equal(repo.agak(k.id)[0].allapot, AG_ALLAPOTOK.VAR)
  assert.equal(repo.agak(k.id)[0].hiba_kod, null)

  // ...és a részletlap már az új tényeket mutatja.
  const reszlet = await rpc.kiadas({ kiadasId: k.id })
  assert.equal(reszlet.allapot, KIADAS_ALLAPOTOK.UTEMEZVE)
  assert.equal(reszlet.agak[0].hibaKod, null)
})

test('BLOKKOLÓ 2: az ujraprobal egy ágra szól, ha megnevezik -- és egy már kesz ágra MEGNEVEZVE utasít el', async () => {
  const { repo, rpc } = setup()
  repo.ujSav({ nap: 1, ora: 18, perc: 0 })
  const k = repo.ujKiadas({ videoId: 'v1' })
  const yt = repo.ujAg({ kiadasId: k.id, platform: 'youtube' })
  const fb = repo.ujAg({ kiadasId: k.id, platform: 'facebook' })
  repo.agEredmenyetIr({ agId: yt.id, allapot: AG_ALLAPOTOK.KESZ, url: 'https://youtu.be/abc' })
  repo.agEredmenyetIr({ agId: fb.id, allapot: AG_ALLAPOTOK.HIBA, hibaKod: 'adapter_nincs' })
  repo.kiadasAllapototIr(k.id, kiadasAllapot(repo.agak(k.id)))
  assert.equal(repo.kiadas(k.id).allapot, KIADAS_ALLAPOTOK.RESZBEN)

  const elutasitva = await rpc.ujraprobal({ kiadasId: k.id, platform: 'youtube' })
  assert.equal(elutasitva.hiba, 'ag_mar_kesz')
  assert.notEqual(elutasitva.uzenet, elutasitva.hiba, 'kód ÉS mondat')
  assert.equal(repo.agak(k.id).find((a) => a.platform === 'youtube').url, 'https://youtu.be/abc')
  assert.equal(repo.kiadas(k.id).allapot, KIADAS_ALLAPOTOK.RESZBEN, 'egy elutasított kar nem ütemezett újra semmit')

  const r = await rpc.ujraprobal({ kiadasId: k.id, platform: 'facebook' })
  assert.equal(r.hiba, undefined)
  assert.deepEqual(r.platformok, ['facebook'], 'önmagában, a többihez nyúlás nélkül')
  const byPlatform = Object.fromEntries(repo.agak(k.id).map((a) => [a.platform, a]))
  assert.equal(byPlatform.youtube.allapot, AG_ALLAPOTOK.KESZ)
  assert.equal(byPlatform.facebook.allapot, AG_ALLAPOTOK.VAR)
})

test('ujraprobal: minden elutasítása MONDATTAL érkezik, nem dobással -- ez egy gomb, nem egy olvasás', async () => {
  const { repo, rpc } = setup()
  const nevezett = (r, kod) => {
    assert.equal(r.hiba, kod)
    assert.notEqual(r.uzenet, kod, 'a kód nem mondat')
    assert.equal(/sikertelen/i.test(r.uzenet), false)
  }
  nevezett(await rpc.ujraprobal({}), 'argumentum_hibas')
  nevezett(await rpc.ujraprobal({ kiadasId: 'nincs-ilyen' }), 'kiadas_ismeretlen')
  const k = repo.ujKiadas({ videoId: 'v1' })
  nevezett(await rpc.ujraprobal({ kiadasId: k.id }), 'kiadas_nem_ujraprobalhato')
  nevezett(await rpc.ujraprobal({ kiadasId: k.id, platform: 'mastodon' }), 'argumentum_hibas')
  const hibas = repo.ujKiadas({ videoId: 'v2' })
  const ag = repo.ujAg({ kiadasId: hibas.id, platform: 'youtube' })
  repo.agEredmenyetIr({ agId: ag.id, allapot: AG_ALLAPOTOK.HIBA, hibaKod: 'kvota_elfogyott' })
  repo.kiadasAllapototIr(hibas.id, KIADAS_ALLAPOTOK.HIBA)
  nevezett(await rpc.ujraprobal({ kiadasId: hibas.id }), 'nincs_szabad_sav')
})
