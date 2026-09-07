import assert from 'node:assert/strict'
import test from 'node:test'

import { AG_ALLAPOTOK, AG_KEZDO_ALLAPOT, KIADAS_ALLAPOTOK, KIADAS_KEZDO_ALLAPOT, isUniqueViolationOn } from '../src/db.mjs'
import { esedekes } from '../src/utemezes.mjs'
import { freshRepo } from './helpers.mjs'

/** A release taken from nothing to `jovahagyva`, ready for `kiadastUtemez`. */
function jovahagyva(repo, videoId) {
  const k = repo.ujKiadas({ videoId })
  repo.kiadasAllapototIr(k.id, KIADAS_ALLAPOTOK.LEKTORALT)
  return repo.kiadastJovahagy(k.id)
}

function refusal(fn) {
  try {
    fn()
  } catch (err) {
    return err
  }
  return null
}

/**
 * Schema tests for the publish module (Task 1: the module's skeleton).
 *
 * These pin the two decisions design spec 3 exists to make: an account is
 * keyed on (platform, kulso_id) and upserts rather than duplicates, and a
 * branch is keyed on (kiadas_id, platform) so a release can never carry two
 * rows for the same outlet. Both keys are asserted at the INDEX, not only in
 * application code (brief 1.5) -- a repository method that forgot the check
 * would still be caught by the database.
 */

test('a kiadás ágai platformonként egy sor, és a kiadás nem duplázódik', () => {
  const { repo } = freshRepo()
  const k = repo.ujKiadas({ videoId: 'v1' })
  assert.equal(k.allapot, 'vazlat')
  const yt = repo.ujAg({ kiadasId: k.id, platform: 'youtube' })
  const tt = repo.ujAg({ kiadasId: k.id, platform: 'tiktok' })
  // A frissen nyitott ág VÁR. Ez a modul legélesebb "három tény, három
  // állapot" pontja: egy ág, ami születésekor `kiment`-et állít, azt a tényt
  // állítja, amit senki nem figyelt meg -- és a naptár, az újrapróbálás meg a
  // részleges-kiadás számolás mind erre az egy szóra épül. A konstansra ÉS a
  // szóra is állítunk: a konstans átírása így nem viszi magával a tesztet.
  assert.equal(AG_KEZDO_ALLAPOT, 'var')
  assert.equal(yt.allapot, 'var', 'egy frissen nyitott ág vár, nem ment ki')
  assert.equal(tt.allapot, 'var', 'egy frissen nyitott ág vár, nem ment ki')
  assert.deepEqual(repo.agak(k.id).map((a) => a.allapot), ['var', 'var'])
  assert.equal(KIADAS_KEZDO_ALLAPOT, 'vazlat')
  assert.deepEqual(repo.agak(k.id).map((a) => a.platform), ['youtube', 'tiktok'])
  // A modul MEGNEVEZETT mondatához illesztünk, nem a `/platform/`-hoz: a nyers
  // meghajtó-szöveg (`UNIQUE constraint failed: ext_publish_agak.kiadas_id,
  // ext_publish_agak.platform`) is illeszkedne rá, tehát a teszt akkor is
  // átmenne, ha az operátor a séma szövegét kapná vissza -- egy nem megnevezett
  // elutasítás és visszamondott tárolt szöveg egyszerre.
  const utkozes = refusal(() => repo.ujAg({ kiadasId: k.id, platform: 'youtube' }))
  assert.ok(utkozes, 'egy kiadáson egy platform egyszer szerepel')
  assert.match(utkozes.message, /már van ág/)
  assert.equal(utkozes.message.includes('UNIQUE constraint failed'), false,
    'a meghajtó nyers séma-szövege nem kerülhet az operátor elé')
})

test('a fiók platformonként és külső id szerint egyedi', () => {
  const { repo } = freshRepo()
  repo.fiokotIr({ platform: 'youtube', kulsoId: 'UC1', nev: 'A csatornám' })
  repo.fiokotIr({ platform: 'youtube', kulsoId: 'UC1', nev: 'Átnevezve' })
  assert.equal(repo.fiokok().length, 1, 'ugyanaz a fiók frissül, nem duplázódik')
  assert.equal(repo.fiokok()[0].nev, 'Átnevezve')
})

test('a fiók-kulcs az adatbázison áll: a fiokotIr megkerülésével sem lehet duplikálni', () => {
  // A 37. sori teszt csak azt bizonyítja, hogy a `fiokotIr` nem duplikál --
  // azt egy tisztán alkalmazás-szintű ellenőrzés is teljesítené, és akkor egy
  // MÁSODIK írásút (egy migráció, egy import, egy párhuzamos folyamat) semmi
  // nem tartana vissza. Ez a teszt a `storage.raw`-on át, a repository-t
  // megkerülve szúr be, tehát csak az INDEX utasíthatja vissza.
  const { storage, repo } = freshRepo()
  repo.fiokotIr({ platform: 'youtube', kulsoId: 'UC1', nev: 'A csatornám' })
  const t = new Date().toISOString()
  assert.throws(
    () => storage.raw
      .prepare('INSERT INTO ext_publish_fiokok (id, platform, kulso_id, nev, csatlakoztatva_at, updated_at) VALUES (?,?,?,?,?,?)')
      .run('masik_iro', 'youtube', 'UC1', 'Egy másik írásút', t, t),
    /UNIQUE constraint failed: ext_publish_fiokok\.platform, ext_publish_fiokok\.kulso_id/,
    'az adatbázis engedte a duplikált (platform, kulso_id) párt',
  )
  assert.equal(repo.fiokok().length, 1)
})

test('az ág-kulcs is az adatbázison áll: a ujAg megkerülésével sem lehet duplikálni', () => {
  const { storage, repo } = freshRepo()
  const k = repo.ujKiadas({ videoId: 'v1' })
  repo.ujAg({ kiadasId: k.id, platform: 'youtube' })
  const t = new Date().toISOString()
  assert.throws(
    () => storage.raw
      .prepare('INSERT INTO ext_publish_agak (id, kiadas_id, platform, szoveg, allapot, hiba_kod, url, kikuldve_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run('masik_iro', k.id, 'youtube', null, 'var', null, null, null, t, t),
    /UNIQUE constraint failed: ext_publish_agak\.kiadas_id, ext_publish_agak\.platform/,
    'az adatbázis engedte a duplikált (kiadas_id, platform) párt',
  )
  assert.equal(repo.agak(k.id).length, 1)
})

test('két különböző fiók platformonként és külső id szerint két sor', () => {
  const { repo } = freshRepo()
  repo.fiokotIr({ platform: 'youtube', kulsoId: 'UC1', nev: 'Egyik' })
  repo.fiokotIr({ platform: 'youtube', kulsoId: 'UC2', nev: 'Másik' })
  repo.fiokotIr({ platform: 'tiktok', kulsoId: 'UC1', nev: 'Ugyanaz a külső id, más platform' })
  assert.equal(repo.fiokok().length, 3)
})

test('ujAg refuses an unknown platform by name, without echoing the caller\'s value', () => {
  const { repo } = freshRepo()
  const k = repo.ujKiadas({ videoId: 'v1' })
  const err = refusal(() => repo.ujAg({ kiadasId: k.id, platform: 'myspace' }))
  assert.ok(err, 'nem utasította el')
  assert.match(err.message, /platform/)
  assert.equal(err.message.includes('myspace'), false, 'a hívó által küldött érvénytelen érték nem jelenhet meg az elutasításban')
})

test('fiokotIr refuses an unknown platform by name, without echoing the caller\'s value', () => {
  const { repo } = freshRepo()
  const err = refusal(() => repo.fiokotIr({ platform: 'myspace', kulsoId: 'X', nev: 'Bármi' }))
  assert.ok(err, 'nem utasította el')
  assert.match(err.message, /platform/)
  assert.equal(err.message.includes('myspace'), false, 'a hívó által küldött érvénytelen érték nem jelenhet meg az elutasításban')
})

test('ujKiadas stores the videoId and starts with no assigned sáv', () => {
  const { repo } = freshRepo()
  const k = repo.ujKiadas({ videoId: 'v42' })
  assert.equal(k.video_id, 'v42')
  assert.equal(k.sav_id, null)
  // Három külön mező, három külön tény: melyik sávba tettük, mikorra
  // SZÁMOLTUK ki a kiküldést, és mit írt felül kézzel az operátor. Egy
  // vázlatnak egyik sincs.
  assert.equal(k.idopont, null)
  assert.equal(k.felulirt_idopont, null)
  assert.equal(typeof k.letrehozva_at, 'string')
})

test('az ext_publish_kiadasok oszlopai -- az idopont NEM hiányozhat a sémából', () => {
  // Ez a pin a néma meghibásodás második őre. Az `esedekes` (src/utemezes.mjs)
  // erre az oszlopra szűr; ha kimarad a migrációból, minden ütemezett sor
  // `undefined` idopont-tal jön vissza, minden futás üres tömböt ad, és a
  // 15 perces ütemezés örökké nulla kiadást tesz ki -- hiba, kivétel és
  // naplósor nélkül. Egy oszlop-lista, amit egy diff megmutat, olcsóbb, mint
  // az a csend.
  const { storage } = freshRepo()
  const oszlopok = storage.raw.prepare('SELECT name FROM pragma_table_info(?) ORDER BY cid').all('ext_publish_kiadasok').map((r) => r.name)
  assert.deepEqual(oszlopok, ['id', 'video_id', 'allapot', 'sav_id', 'idopont', 'felulirt_idopont', 'letrehozva_at', 'updated_at'])
})

test('agak returns only the branches of the release asked for, in creation order', () => {
  const { repo } = freshRepo()
  const k1 = repo.ujKiadas({ videoId: 'v1' })
  const k2 = repo.ujKiadas({ videoId: 'v2' })
  repo.ujAg({ kiadasId: k1.id, platform: 'youtube' })
  repo.ujAg({ kiadasId: k2.id, platform: 'facebook' })
  repo.ujAg({ kiadasId: k1.id, platform: 'instagram' })
  assert.deepEqual(repo.agak(k1.id).map((a) => a.platform), ['youtube', 'instagram'])
  assert.deepEqual(repo.agak(k2.id).map((a) => a.platform), ['facebook'])
})

test('isUniqueViolationOn narrows to exactly the named columns: an id collision is a different fact than a (kiadas_id, platform) collision', () => {
  // No stubbed uid(): reuse the id a legitimate ujAg() call already minted,
  // and insert it again through the same storage.raw bypass the index tests
  // above use, under a DIFFERENT platform so the (kiadas_id, platform) index
  // does not fire -- only the primary key on `id` does. That produces the
  // real driver text `UNIQUE constraint failed: ext_publish_agak.id`, and
  // isUniqueViolationOn must answer false for it against the (kiadas_id,
  // platform) column set: an id collision states no fact about that pair.
  const { storage, repo } = freshRepo()
  const k = repo.ujKiadas({ videoId: 'v1' })
  const yt = repo.ujAg({ kiadasId: k.id, platform: 'youtube' })
  const t = new Date().toISOString()
  const err = refusal(() => storage.raw
    .prepare('INSERT INTO ext_publish_agak (id, kiadas_id, platform, szoveg, allapot, hiba_kod, url, kikuldve_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(yt.id, k.id, 'tiktok', null, 'var', null, null, null, t, t))
  assert.ok(err, 'a megismételt id-t az adatbázisnak vissza kellett volna utasítania')
  assert.match(err.message, /UNIQUE constraint failed: ext_publish_agak\.id/)
  assert.equal(
    isUniqueViolationOn(err, 'ext_publish_agak', ['kiadas_id', 'platform']),
    false,
    'egy id-ütközés nem ugyanaz a tény, mint egy (kiadas_id, platform) ütközés',
  )
})

test('isUniqueViolationOn a NEVEZETT oszlopokra igazat mond, és csak Error-ra felel', () => {
  // A pozitív ág: a valódi (kiadas_id, platform) ütközés szövegét fel kell
  // ismernie. Ez az, ami az `ujAg` megnevezett mondatát elsüti -- az
  // oszlop-listát összefűző elválasztó elrontása (`', '` -> `','`) itt bukik.
  const { storage, repo } = freshRepo()
  const k = repo.ujKiadas({ videoId: 'v1' })
  repo.ujAg({ kiadasId: k.id, platform: 'youtube' })
  const t = new Date().toISOString()
  const par = refusal(() => storage.raw
    .prepare('INSERT INTO ext_publish_agak (id, kiadas_id, platform, szoveg, allapot, hiba_kod, url, kikuldve_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run('masik_iro', k.id, 'youtube', null, 'var', null, null, null, t, t))
  assert.ok(par)
  assert.equal(isUniqueViolationOn(par, 'ext_publish_agak', ['kiadas_id', 'platform']), true)

  // És csak Error-ra: egy nem-Error, ami történetesen ugyanazt a `message`
  // mezőt hordja (egy soros API-válasz, egy JSON-ból visszaállított objektum),
  // nem bizonyíték egy adatbázis-ütközésről. Az `instanceof` őr nélkül ez
  // igazat adna -- vagy a `null`-on kivételt dobna a saját hívójában.
  assert.equal(isUniqueViolationOn({ message: par.message }, 'ext_publish_agak', ['kiadas_id', 'platform']), false)
  assert.equal(isUniqueViolationOn(par.message, 'ext_publish_agak', ['kiadas_id', 'platform']), false)
  assert.equal(isUniqueViolationOn(null, 'ext_publish_agak', ['kiadas_id', 'platform']), false)
  assert.equal(isUniqueViolationOn(undefined, 'ext_publish_agak', ['kiadas_id', 'platform']), false)
})

test('a két oszlop szókincse az oszlopok mellett áll, egy helyen', () => {
  // A négy ág-szó a spec 8 négy naptár-jelzője (kiment / vár / elbukott /
  // nincs fiók), a nyolc kiadás-szó a spec 3 oszlop-domainje. Mindkettőt a
  // `src/allapot.mjs` és a 6. feladat lapja is olvassa; ha egy szó itt
  // elmozdul, ott is elmozdul, nem csúszik szét.
  assert.deepEqual(AG_ALLAPOTOK, { VAR: 'var', KESZ: 'kesz', HIBA: 'hiba', NINCS_FIOK: 'nincs_fiok' })
  assert.ok(Object.isFrozen(AG_ALLAPOTOK))
  assert.equal(AG_KEZDO_ALLAPOT, AG_ALLAPOTOK.VAR)

  assert.deepEqual(Object.values(KIADAS_ALLAPOTOK),
    ['vazlat', 'lektoralt', 'jovahagyva', 'utemezve', 'kesz', 'reszben', 'hiba', 'nincs_hova'])
  assert.ok(Object.isFrozen(KIADAS_ALLAPOTOK))
  assert.equal(KIADAS_KEZDO_ALLAPOT, KIADAS_ALLAPOTOK.VAZLAT)
})

test('a séma mind a négy táblát létrehozza', () => {
  const { storage } = freshRepo()
  const names = storage.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'ext_publish_%' ORDER BY name").all().map((r) => r.name)
  assert.deepEqual(names, ['ext_publish_agak', 'ext_publish_fiokok', 'ext_publish_kiadasok', 'ext_publish_savok'])
})

// --- savok (Task 3) ---

test('ujSav tárolja a nap/ora/perc hármast, és savok() a hét sorrendjében adja vissza', () => {
  const { repo } = freshRepo()
  const s1 = repo.ujSav({ nap: 5, ora: 18, perc: 0 })
  const s2 = repo.ujSav({ nap: 1, ora: 9, perc: 0 })
  const s3 = repo.ujSav({ nap: 1, ora: 8, perc: 30 })
  assert.equal(s1.nap, 5)
  assert.equal(s1.ora, 18)
  assert.equal(s1.perc, 0)
  assert.equal(typeof s1.id, 'string')
  assert.equal(typeof s1.created_at, 'string')
  // Hét sorrendje, nem a létrehozás sorrendje: s3 (hétfő 08:30) < s2 (hétfő
  // 09:00) < s1 (péntek 18:00), holott s1 jött létre elsőként.
  assert.deepEqual(repo.savok().map((s) => s.id), [s3.id, s2.id, s1.id])
})

test('sav egyetlen sávot ad vissza id szerint, ismeretlen id-re null-t', () => {
  const { repo } = freshRepo()
  const s = repo.ujSav({ nap: 3, ora: 12, perc: 15 })
  assert.deepEqual(repo.sav(s.id), s)
  assert.equal(repo.sav('nincs-ilyen'), null)
})

test('ujSav elutasítja az érvénytelen nap/ora/perc értéket, a hívó értékét vissza nem mondva', () => {
  const { repo } = freshRepo()
  const napErr = refusal(() => repo.ujSav({ nap: 7, ora: 9, perc: 0 }))
  assert.ok(napErr, 'nem utasította el a 7-es napot')
  assert.match(napErr.message, /nap/)
  assert.equal(napErr.message.includes('7'), false, 'a hívó által küldött érvénytelen érték nem jelenhet meg az elutasításban')

  const oraErr = refusal(() => repo.ujSav({ nap: 1, ora: 24, perc: 0 }))
  assert.ok(oraErr, 'nem utasította el a 24-es órát')
  assert.match(oraErr.message, /ora/)
  assert.equal(oraErr.message.includes('24'), false, 'a hívó által küldött érvénytelen érték nem jelenhet meg az elutasításban')

  const percErr = refusal(() => repo.ujSav({ nap: 1, ora: 9, perc: 60 }))
  assert.ok(percErr, 'nem utasította el a 60-as percet')
  assert.match(percErr.message, /perc/)
  assert.equal(percErr.message.includes('60'), false, 'a hívó által küldött érvénytelen érték nem jelenhet meg az elutasításban')

  assert.deepEqual(repo.savok(), [], 'egyik elutasított hívás sem írt sort')
})

test('két sáv állhat ugyanabban a heti percben -- nincs egyediségi megszorítás rajtuk', () => {
  const { repo } = freshRepo()
  repo.ujSav({ nap: 1, ora: 9, perc: 0 })
  repo.ujSav({ nap: 1, ora: 9, perc: 0 })
  assert.equal(repo.savok().length, 2)
})

/**
 * Task 4's write path: draft text, workflow transitions, scheduling and
 * dispatch results (src/db.mjs's own "the write path" section). The two
 * tests marked INVARIANT below are the ones task-4-brief.md names by hand:
 * "write a test that enforces this."
 */

test('szovegetIr opens a branch on first write and upserts on the second, and always sends the release back to vazlat', () => {
  const { repo } = freshRepo()
  const k = repo.ujKiadas({ videoId: 'v1' })
  repo.kiadasAllapototIr(k.id, KIADAS_ALLAPOTOK.LEKTORALT)
  const a = repo.szovegetIr({ kiadasId: k.id, platform: 'youtube', szoveg: '{"cim":"első"}' })
  assert.equal(a.szoveg, '{"cim":"első"}')
  assert.equal(a.allapot, AG_KEZDO_ALLAPOT, 'a friss ág vár, még ha a kiadás lektoralt volt is')
  assert.equal(repo.kiadas(k.id).allapot, KIADAS_ALLAPOTOK.VAZLAT, 'egy új szöveg visszaküldi a kiadást vazlat-ba')
  assert.equal(repo.agak(k.id).length, 1)
  const b = repo.szovegetIr({ kiadasId: k.id, platform: 'youtube', szoveg: '{"cim":"második"}' })
  assert.equal(b.id, a.id, 'ugyanaz az ág frissül, nem duplázódik')
  assert.equal(b.szoveg, '{"cim":"második"}')
  assert.equal(repo.agak(k.id).length, 1)
})

test('kiadasAllapototIr refuses an allapot outside the closed vocabulary, by name, without echoing the value', () => {
  const { repo } = freshRepo()
  const k = repo.ujKiadas({ videoId: 'v1' })
  assert.throws(() => repo.kiadasAllapototIr(k.id, 'kesz-e'), (err) => {
    assert.match(err.message, /allapot/)
    assert.equal(err.message.includes('kesz-e'), false)
    return true
  })
})

test('kiadastJovahagy moves lektoralt to jovahagyva, and refuses by name from any other state', () => {
  const { repo } = freshRepo()
  const k = repo.ujKiadas({ videoId: 'v1' })
  assert.throws(() => repo.kiadastJovahagy(k.id), /csak lektoralt/)
  repo.kiadasAllapototIr(k.id, KIADAS_ALLAPOTOK.LEKTORALT)
  const uj = repo.kiadastJovahagy(k.id)
  assert.equal(uj.allapot, KIADAS_ALLAPOTOK.JOVAHAGYVA)
  assert.throws(() => repo.kiadastJovahagy(k.id), /csak lektoralt/, 'egy már jóváhagyott kiadás nem hagyható jóvá újra')
})

test('kiadastUtemez only accepts a jovahagyva release, and writes sav_id, idopont and allapot together', () => {
  const { repo } = freshRepo()
  const k = repo.ujKiadas({ videoId: 'v1' })
  assert.throws(() => repo.kiadastUtemez({ kiadasId: k.id, savId: 's1', idopont: '2026-09-07T09:00:00.000Z' }), /csak jovahagyva/)
  const j = jovahagyva(repo, 'v2')
  const u = repo.kiadastUtemez({ kiadasId: j.id, savId: 's1', idopont: '2026-09-07T09:00:00.000Z' })
  assert.equal(u.sav_id, 's1')
  assert.equal(u.idopont, '2026-09-07T09:00:00.000Z')
  assert.equal(u.allapot, KIADAS_ALLAPOTOK.UTEMEZVE)
})

test('agEredmenyetIr stamps kikuldve_at only on kesz, and only accepts the three dispatch outcomes', () => {
  const { repo } = freshRepo()
  const k = repo.ujKiadas({ videoId: 'v1' })
  const ag = repo.ujAg({ kiadasId: k.id, platform: 'youtube' })
  assert.throws(() => repo.agEredmenyetIr({ agId: ag.id, allapot: AG_ALLAPOTOK.VAR }), /allapot/, '"var" nem dispatch-eredmény -- azt a branch a nyitáskor kapja')
  const nincsFiok = repo.agEredmenyetIr({ agId: ag.id, allapot: AG_ALLAPOTOK.NINCS_FIOK })
  assert.equal(nincsFiok.kikuldve_at, null)
  const ag2 = repo.ujAg({ kiadasId: k.id, platform: 'tiktok' })
  const hiba = repo.agEredmenyetIr({ agId: ag2.id, allapot: AG_ALLAPOTOK.HIBA, hibaKod: 'x' })
  assert.equal(hiba.kikuldve_at, null)
  assert.equal(hiba.hiba_kod, 'x')
  const ag3 = repo.ujAg({ kiadasId: k.id, platform: 'facebook' })
  const kesz = repo.agEredmenyetIr({ agId: ag3.id, allapot: AG_ALLAPOTOK.KESZ, url: 'https://example.test/p' })
  assert.equal(typeof kesz.kikuldve_at, 'string')
  assert.equal(kesz.url, 'https://example.test/p')
})

// --- the two invariants task-4-brief.md names ---------------------------

test('INVARIANT 1: idopontFeluliras collapses the override onto idopont in the same write -- one column decides from then on', () => {
  const { repo } = freshRepo()
  const j = jovahagyva(repo, 'v1')
  repo.kiadastUtemez({ kiadasId: j.id, savId: 's1', idopont: '2026-09-07T09:00:00.000Z' })
  assert.throws(() => repo.idopontFeluliras({ kiadasId: j.id, felulirtIdopont: 'nem-datum' }), /idopont/)
  const felulirva = repo.idopontFeluliras({ kiadasId: j.id, felulirtIdopont: '2026-09-08T18:00:00.000Z' })
  assert.equal(felulirva.felulirt_idopont, '2026-09-08T18:00:00.000Z')
  assert.equal(felulirva.idopont, '2026-09-08T18:00:00.000Z', 'a felülírás után az idopont oszlop is az ÚJ időt mondja -- esedekes() ezt olvassa, nem a felulirt_idopont-ot')
  // A rendszer szemszögéből: a régi sáv-pillanatnál a kiadás már NEM esedékes, a felülírtnál IGEN -- ha a bug visszatérne (idopont a régi maradna), ez a két assert fordítva sülne el.
  assert.deepEqual(esedekes([felulirva], new Date('2026-09-07T09:05:00.000Z')), [], 'a régi (felülírt) sáv-pillanatnál a kiadás már nem esedékes')
  assert.deepEqual(esedekes([felulirva], new Date('2026-09-08T18:05:00.000Z')).map((k) => k.id), [j.id], 'az új, felülírt pillanatnál esedékes')
})

test('idopontFeluliras only accepts an already-utemezve release', () => {
  const { repo } = freshRepo()
  const j = jovahagyva(repo, 'v1')
  assert.throws(() => repo.idopontFeluliras({ kiadasId: j.id, felulirtIdopont: '2026-09-08T18:00:00.000Z' }), /csak utemezve/)
})

test('INVARIANT 2: foglaltSavIdopontok reads only the idopont column -- sav_id alone does not reserve a minute', () => {
  const { repo, storage } = freshRepo()
  const k = repo.ujKiadas({ videoId: 'v1' })
  // Egy sor sav_id-vel, de idopont NÉLKÜL (törött vagy részleges írás) -- ha
  // foglaltSavIdopontok a sav_id-t nézné, ez foglalná a sávot; az idopont
  // oszlop alapján NEM foglal semmit.
  storage.exec('UPDATE ext_publish_kiadasok SET sav_id = ? WHERE id = ?', ['s1', k.id])
  assert.deepEqual(repo.foglaltSavIdopontok(), [])
})

test('foglaltSavIdopontok reads every release that has both sav_id and idopont, in the exact shape kovetkezoSzabadSav takes as foglaltak', () => {
  const { repo } = freshRepo()
  const j1 = jovahagyva(repo, 'v1')
  repo.kiadastUtemez({ kiadasId: j1.id, savId: 's1', idopont: '2026-09-07T09:00:00.000Z' })
  const j2 = jovahagyva(repo, 'v2')
  repo.kiadastUtemez({ kiadasId: j2.id, savId: 's2', idopont: '2026-09-07T18:00:00.000Z' })
  assert.deepEqual(repo.foglaltSavIdopontok(), [
    { savId: 's1', idopont: '2026-09-07T09:00:00.000Z' },
    { savId: 's2', idopont: '2026-09-07T18:00:00.000Z' },
  ])
})
