import assert from 'node:assert/strict'
import test from 'node:test'

import { KIADAS_ALLAPOT, kiadasAllapot } from '../src/allapot.mjs'
import { AG_ALLAPOTOK, KIADAS_ALLAPOTOK } from '../src/db.mjs'

/**
 * Task 2's own tests, from the brief verbatim (task-2-brief.md 2.1) -- the
 * one rule the page, the scheduler and the report all ask, so it gets pinned
 * here once rather than reimplemented three times -- plus the cases the first
 * review round added: the `ismeretlen` outcome, the refusal on a malformed
 * branch list, and the shape of the exported constant Tasks 3 and 6 import.
 */

const ag = (platform, allapot) => ({ platform, allapot })

function refusal(fn) {
  try {
    fn()
  } catch (err) {
    return err
  }
  return null
}

test('minden összekötött ág kiment: kesz', () => {
  assert.equal(kiadasAllapot([ag('youtube', 'kesz'), ag('tiktok', 'kesz')]), 'kesz')
})
test('egy kiment, egy elbukott: reszben — és NEM kesz', () => {
  assert.equal(kiadasAllapot([ag('youtube', 'kesz'), ag('tiktok', 'hiba')]), 'reszben')
})
test('egyik sem ment ki: hiba', () => {
  assert.equal(kiadasAllapot([ag('youtube', 'hiba'), ag('tiktok', 'hiba')]), 'hiba')
})
test('a fiók nélküli ág nem várakoztat és nem buktat', () => {
  assert.equal(kiadasAllapot([ag('youtube', 'kesz'), ag('tiktok', 'nincs_fiok')]), 'kesz')
})
test('EGYETLEN fiók sincs összekötve: nincs_hova, nem kesz', () => {
  // Ez a modul legrosszabb hazugsága lenne: nulla ágból nulla ment ki, tehát
  // a "minden ág kiment" ÜRESEN igaz, és a lap azt írná, publikálva van
  // valami, ami sehol nincs fent.
  assert.equal(kiadasAllapot([ag('youtube', 'nincs_fiok'), ag('tiktok', 'nincs_fiok')]), 'nincs_hova')
  assert.equal(kiadasAllapot([]), 'nincs_hova')
})
test('amíg bármelyik vár, a kiadás utemezve', () => {
  assert.equal(kiadasAllapot([ag('youtube', 'kesz'), ag('tiktok', 'var')]), 'utemezve')
})

// --- D2: az ismeretlen ág-állapot saját állapot, nem `hiba` ---

test('egy fel nem ismert ág-állapot ISMERETLEN, nem hiba és nem reszben', () => {
  // A modul első megkötése: három tény három állapot. Egy ág, aminek az
  // állapotát ez a verzió nem ismeri, egy MEG NEM FIGYELT tény -- ha
  // "nem kész"-ként a nevezőbe számolna, a kiadás egy elbukott ág tényét
  // mondaná ki egy olyanra, amiről semmit nem tudunk.
  assert.equal(kiadasAllapot([ag('youtube', 'ezt_a_verzio_nem_ismeri')]), 'ismeretlen')
  assert.equal(kiadasAllapot([ag('youtube', 'kesz'), ag('tiktok', 'ezt_a_verzio_nem_ismeri')]), 'ismeretlen')
  assert.equal(kiadasAllapot([ag('youtube', 'hiba'), ag('tiktok', 'ezt_a_verzio_nem_ismeri')]), 'ismeretlen')
})
test('az ismeretlen ág akkor is ismeretlen, ha egy másik ág még vár', () => {
  // A `var` ág `utemezve`-t adna, és az `esedekes()` (3. feladat) pont arra
  // szűr: egy nem értett kiadás nem csúszhat be a kiküldendők közé.
  assert.equal(kiadasAllapot([ag('youtube', 'var'), ag('tiktok', 'ezt_a_verzio_nem_ismeri')]), 'ismeretlen')
})
test('az ismeretlen ág akkor is ismeretlen, ha minden más ág fiók nélküli', () => {
  assert.equal(kiadasAllapot([ag('youtube', 'nincs_fiok'), ag('tiktok', 'ezt_a_verzio_nem_ismeri')]), 'ismeretlen')
})

// --- D3: a hibás alakú bemenet DOB ---

test('a nem tömb bemenet TypeError, nem "nincs_hova"', () => {
  // A `nincs_hova` nem semleges tartalék, hanem egy konkrét állítás
  // ("egyetlen platform sincs összekötve"), amit a lap szó szerint kiír.
  // Egy hívói hiba nem válhat magabiztos hamis mondattá.
  for (const rossz of [undefined, null, 'kesz', 42, { platform: 'youtube', allapot: 'kesz' }]) {
    const err = refusal(() => kiadasAllapot(rossz))
    assert.ok(err instanceof TypeError, 'a hibás alakú bemenet nem dobott TypeError-t')
    // A modul SAJÁT megnevezett mondatát várjuk, nem a futtatókörnyezetét. Az
    // `Array.isArray` őr nélkül ugyanis mindkét ág dobna, csak nem ezt: egy
    // `undefined` a `for...of` "is not iterable" szövegét kapná, egy string
    // pedig karakterenként az ÁG-ra írt mondatot -- két nem megnevezett
    // elutasítás egyetlen hívói hibára.
    assert.match(err.message, /az agak csak ág-sorok tömbje lehet/)
  }
})
test('egy ág, ami nem { platform, allapot } alakú: TypeError', () => {
  for (const rossz of [null, undefined, 'kesz', 42, {}, { platform: 'youtube' }, { platform: 'youtube', allapot: 42 }]) {
    const err = refusal(() => kiadasAllapot([rossz]))
    assert.ok(err instanceof TypeError, 'a hibás alakú ág nem dobott TypeError-t')
    assert.match(err.message, /minden eleme ág-sor kell legyen/)
  }
})
test('az elutasítás megnevezi az argumentumot, és nem mondja vissza a hívó értékét', () => {
  const nemTomb = refusal(() => kiadasAllapot('titkos_ertek'))
  assert.ok(nemTomb, 'nem utasította el')
  assert.match(nemTomb.message, /agak/)
  assert.equal(nemTomb.message.includes('titkos_ertek'), false, 'a hívó által küldött érték nem jelenhet meg az elutasításban')

  const rosszAg = refusal(() => kiadasAllapot([{ platform: 'titkos_platform', allapot: 42 }]))
  assert.ok(rosszAg, 'nem utasította el')
  assert.match(rosszAg.message, /agak/)
  assert.equal(rosszAg.message.includes('titkos_platform'), false, 'a hívó által küldött érték nem jelenhet meg az elutasításban')
})
test('a jól formált ág-listára soha nem dob: mind a négy ismert ág-szó átmegy', () => {
  for (const szo of Object.values(AG_ALLAPOTOK)) {
    assert.equal(typeof kiadasAllapot([ag('youtube', szo)]), 'string')
  }
})

// --- D1 / Minor 5: a KIADAS_ALLAPOT az, amit a 3. és 6. feladat importál ---

test('a KIADAS_ALLAPOT pontosan a kimenetel-szavakat hordja, és nem hordja a munkafolyamat-szavakat', () => {
  assert.deepEqual(KIADAS_ALLAPOT, {
    UTEMEZVE: 'utemezve',
    KESZ: 'kesz',
    RESZBEN: 'reszben',
    HIBA: 'hiba',
    NINCS_HOVA: 'nincs_hova',
    ISMERETLEN: 'ismeretlen',
  })
  assert.ok(Object.isFrozen(KIADAS_ALLAPOT), 'a konstans fagyasztva kell legyen')
  for (const munkafolyamat of ['vazlat', 'lektoralt', 'jovahagyva']) {
    assert.equal(
      Object.values(KIADAS_ALLAPOT).includes(munkafolyamat), false,
      'a munkafolyamat-állapotokat az ext_publish_kiadasok.allapot mondja meg, nem ez a függvény',
    )
  }
})
test('a KIADAS_ALLAPOT minden szava elő is áll, és a függvény nem ad ezeken kívül semmit', () => {
  // Egy unió, ami olyan szót hirdet, amit a függvény nem tud előállítani,
  // hazug típus: a 3. és 6. feladat írna rá egy `case`-t, ami sosem sül el.
  const eloall = new Set([
    kiadasAllapot([ag('youtube', 'var')]),
    kiadasAllapot([ag('youtube', 'kesz')]),
    kiadasAllapot([ag('youtube', 'kesz'), ag('tiktok', 'hiba')]),
    kiadasAllapot([ag('youtube', 'hiba')]),
    kiadasAllapot([]),
    kiadasAllapot([ag('youtube', 'ezt_a_verzio_nem_ismeri')]),
  ])
  assert.deepEqual([...eloall].sort(), Object.values(KIADAS_ALLAPOT).slice().sort())
})
test('a tárolható kimenetel-szavak az oszlop domainjéből valók, az ismeretlen viszont sosem tárolt', () => {
  // Minor 6: a szókincs egy helyen áll (db.mjs, az oszlop mellett), és ez a
  // teszt köti hozzá a számolt kimenetelt. Az `ismeretlen` szándékosan NEM
  // része a domainnek: ez a függvény válasza egy meg nem értett sorra, nem
  // egy állapot, amit bárki visszaírhatna a kiadásra.
  const tarolt = new Set(Object.values(KIADAS_ALLAPOTOK))
  for (const szo of Object.values(KIADAS_ALLAPOT)) {
    if (szo === KIADAS_ALLAPOT.ISMERETLEN) {
      assert.equal(tarolt.has(szo), false, 'az ismeretlen nem tárolható kiadás-állapot')
      continue
    }
    assert.ok(tarolt.has(szo), `a ${szo} nincs benne az ext_publish_kiadasok.allapot domainjében`)
  }
})
