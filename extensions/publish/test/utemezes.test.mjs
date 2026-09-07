import assert from 'node:assert/strict'
import test from 'node:test'

import { ALAP_IDOZONA, KIADAS_ALLAPOTOK } from '../src/db.mjs'
import { esedekes, idopontNelkuliUtemezettek, idozonaOf, kovetkezoSzabadSav } from '../src/utemezes.mjs'
import { freshRepo } from './helpers.mjs'

/**
 * Task 3's own tests -- the slot arithmetic and the due filter, injected
 * `most` so both are testable without a clock -- plus the cases the review
 * round added: the zone a slot's wall clock is read in, the DST transitions
 * on both sides of the year, a duplicated slot not doubling a minute's
 * capacity, the tie-break, the day boundary, and every refusal.
 *
 * TWO PROPERTIES THAT LOOK THE SAME AND ARE NOT
 * ==============================================
 *   - The SLOTS are read in a CONFIGURED ZONE (`Europe/Budapest` by default).
 *     That is module data, and the assertions below are full of Budapest wall
 *     clocks converted to UTC instants by hand.
 *   - The TESTS are independent of the MACHINE's `TZ`. Every `most` is an
 *     explicit UTC instant, every expectation is an explicit UTC instant, and
 *     nothing here reads a local-time accessor -- so this file passes
 *     identically under `TZ=UTC`, `TZ=Europe/Budapest`, `TZ=America/New_York`
 *     and `TZ=Pacific/Kiritimati`. Both must hold; neither implies the other.
 *
 * Budapest's 2026 offsets, which every expectation below is derived from:
 * CET (UTC+1) until 2026-03-29T01:00Z, CEST (UTC+2) until 2026-10-25T01:00Z,
 * CET again after that.
 */

/** The zone every call below reads its slots in. There is no default on the arithmetic -- see `kovetkezoSzabadSav`'s own docblock -- so a fixture names it the same way a caller does. */
const BUDAPEST = ALAP_IDOZONA

/** The thrown error itself, so a refusal's own sentence can be asserted -- `assert.throws` returns nothing. Same helper as `test/db.test.mjs`. */
function refusal(fn) {
  try {
    fn()
  } catch (err) {
    return err
  }
  return null
}

test('a jóváhagyott kiadás a következő SZABAD sávba áll', () => {
  const savok = [{ id: 's1', nap: 1, ora: 9, perc: 0 }, { id: 's2', nap: 1, ora: 18, perc: 0 }]
  // Hétfő 07:00 budapesti idő: a 09:00-s sáv még előttünk van.
  const most = new Date('2026-09-07T05:00:00.000Z')
  assert.equal(kovetkezoSzabadSav(savok, [], most, BUDAPEST).savId, 's1')
  const foglalt = [{ savId: 's1', idopont: '2026-09-07T07:00:00.000Z' }]
  assert.equal(kovetkezoSzabadSav(savok, foglalt, most, BUDAPEST).savId, 's2')
})

test('kovetkezoSzabadSav: a sávok hetente ismétlődnek -- a mai lejárt előfordulás után a JÖVŐ HETIT adja, sosem múltbelit', () => {
  // A cím nem "nincs több szabad sáv": olyan eset nincs. A sávok örökké
  // ismétlődnek, tehát mindig van következő előfordulás; a `null` egyedül azt
  // jelenti, hogy egyetlen sáv sincs beállítva (lásd a lentebbi üres-tömb
  // tesztet). Egy cím, amit egy jövőbeli olvasó szerződésnek vesz, rosszabb,
  // mint semmi.
  const savok = [{ id: 's1', nap: 1, ora: 9, perc: 0 }]
  const most = new Date('2026-09-07T10:00:00.000Z') // hétfő 12:00 Budapest, a 09:00 elment
  const r = kovetkezoSzabadSav(savok, [], most, BUDAPEST)
  assert.ok(r !== null && Date.parse(r.idopont) > most.getTime(), 'soha nem ad múltbeli időpontot')
  assert.equal(r.idopont, '2026-09-14T07:00:00.000Z') // a KÖVETKEZŐ hétfő 09:00 budapesti idő
})

test('esedekes: a megadott idő UTÁNI első futás viszi ki', () => {
  const k = [{ id: 'k1', idopont: '2026-09-07T09:00:00.000Z', allapot: 'utemezve' }]
  assert.deepEqual(esedekes(k, new Date('2026-09-07T08:59:00.000Z')).map((x) => x.id), [])
  assert.deepEqual(esedekes(k, new Date('2026-09-07T09:07:00.000Z')).map((x) => x.id), ['k1'])
})

test('esedekes csak utemezve állapotút hoz — vázlatot soha', () => {
  const k = [{ id: 'k1', idopont: '2026-09-07T09:00:00.000Z', allapot: 'vazlat' }]
  assert.deepEqual(esedekes(k, new Date('2026-09-07T10:00:00.000Z')), [])
})

// --- a séma és a szűrő EGYÜTT: az esedekes valódi, TÁROLT soron fut ---

test('esedekes egy valódi adatbázisból visszaolvasott soron is talál -- az idopont oszlop létezik', () => {
  // EZ AZ A TESZT, AMI A NÉMA MEGHIBÁSODÁST KIFOGJA. Egy objektum-literál
  // hordozhat olyan mezőt, amilyen oszlop a sémában nincs; egy visszaolvasott
  // sor nem. Amíg az `esedekes` csak literálokon futott, egy hiányzó `idopont`
  // oszlop mellett is zöld volt a suite, miközben élesben minden futás üres
  // tömböt adott -- hiba, kivétel és naplósor nélkül.
  const { storage, repo } = freshRepo()
  const k = repo.ujKiadas({ videoId: 'v1' })
  storage.exec('UPDATE ext_publish_kiadasok SET allapot = ?, idopont = ? WHERE id = ?',
    [KIADAS_ALLAPOTOK.UTEMEZVE, '2026-09-07T07:00:00.000Z', k.id])

  const sorok = repo.kiadasok()
  assert.equal(sorok.length, 1)
  assert.equal(sorok[0].idopont, '2026-09-07T07:00:00.000Z')
  assert.deepEqual(esedekes(sorok, new Date('2026-09-07T06:59:00.000Z')).map((x) => x.id), [])
  assert.deepEqual(esedekes(sorok, new Date('2026-09-07T07:14:00.000Z')).map((x) => x.id), [k.id])
})

test('a kiszámolt idopont és az operátor felulirt_idopont-ja két külön oszlop, és nem folynak egybe', () => {
  // Spec 3: a naptár mindkettőt rajzolja és megkülönbözteti őket. Egy sor,
  // amit az operátor kézzel mozgatott, a felülírást is őrzi, nem csak a
  // belőle számolt pillanatot -- különben a naptár nem tudja megmutatni, hogy
  // ezt valaki kézzel tette oda.
  const { storage, repo } = freshRepo()
  const k = repo.ujKiadas({ videoId: 'v1' })
  storage.exec('UPDATE ext_publish_kiadasok SET allapot = ?, idopont = ?, felulirt_idopont = ? WHERE id = ?',
    [KIADAS_ALLAPOTOK.UTEMEZVE, '2026-09-07T07:00:00.000Z', '2026-09-07T09:00:00+02:00', k.id])
  const sor = repo.kiadas(k.id)
  assert.equal(sor.idopont, '2026-09-07T07:00:00.000Z')
  assert.equal(sor.felulirt_idopont, '2026-09-07T09:00:00+02:00')
  assert.notEqual(sor.idopont, sor.felulirt_idopont)
})

// --- a sáv BUDAPESTI fali órát mond (D5) ---

test('ugyanaz a sáv júliusban és decemberben ugyanazt a BUDAPESTI fali órát adja, két különböző UTC-pillanattal', () => {
  const savok = [{ id: 's1', nap: 1, ora: 9, perc: 0 }] // "hétfő 9:00", ahogy az operátor beírja
  const nyar = kovetkezoSzabadSav(savok, [], new Date('2026-07-01T00:00:00.000Z'), BUDAPEST)
  const tel = kovetkezoSzabadSav(savok, [], new Date('2026-12-01T00:00:00.000Z'), BUDAPEST)
  // Nyáron CEST (+2), télen CET (+1): két különböző UTC-pillanat...
  assert.equal(nyar.idopont, '2026-07-06T07:00:00.000Z')
  assert.equal(tel.idopont, '2026-12-07T08:00:00.000Z')
  assert.notEqual(nyar.idopont.slice(11), tel.idopont.slice(11))
  // ...ugyanarra a budapesti falióra-időre.
  for (const r of [nyar, tel]) {
    const falioras = new Intl.DateTimeFormat('en-GB', { timeZone: ALAP_IDOZONA, hourCycle: 'h23', weekday: 'long', hour: '2-digit', minute: '2-digit' })
    assert.equal(falioras.format(new Date(r.idopont)), 'Monday 09:00')
  }
})

test('a "hétfő 00:30 budapesti idő" sáv egész évben ugyanaz a sor -- UTC-ben két különböző NAPRA esik', () => {
  // A lelet saját példája: erre a sávra egyetlen egész évben érvényes
  // nap/ora/perc hármas sincs, ha a hármas UTC-t jelent. Fali óraként egy sor
  // elég, és az UTC-pillanat vasárnapra csúszik -- mindkét évszakban.
  const savok = [{ id: 'ejfel', nap: 1, ora: 0, perc: 30 }]
  assert.equal(kovetkezoSzabadSav(savok, [], new Date('2026-07-01T00:00:00.000Z'), BUDAPEST).idopont, '2026-07-05T22:30:00.000Z')
  assert.equal(kovetkezoSzabadSav(savok, [], new Date('2026-12-01T00:00:00.000Z'), BUDAPEST).idopont, '2026-12-06T23:30:00.000Z')
})

test('a heti ismétlés HÉT FALIÓRA-NAP, nem 168 óra: a tavaszi óraátállításon át sem csúszik el', () => {
  // 2026-03-29T01:00Z-kor Budapest CET-ről CEST-re vált. A hétfő 09:00-s sáv
  // előtte 08:00Z, utána 07:00Z. Egy `+7 * 24 * 60 * 60 * 1000` ugrás
  // 2026-03-30T08:00Z-t adna, ami budapesti 10:00 -- egy órával azután, amit
  // az operátor beírt.
  const savok = [{ id: 's1', nap: 1, ora: 9, perc: 0 }]
  const most = new Date('2026-03-23T00:00:00.000Z')
  const elso = kovetkezoSzabadSav(savok, [], most, BUDAPEST)
  assert.equal(elso.idopont, '2026-03-23T08:00:00.000Z') // hétfő 09:00 CET
  const masodik = kovetkezoSzabadSav(savok, [{ savId: 's1', idopont: elso.idopont }], most, BUDAPEST)
  assert.equal(masodik.idopont, '2026-03-30T07:00:00.000Z') // hétfő 09:00 CEST, nem 08:00Z
})

test('a tavasszal KIMARADÓ falióra-perc egy hetet ugrik, nem csúszik át a szomszédos órára', () => {
  // 2026-03-29-én Budapesten 02:00 után rögtön 03:00 következik: "vasárnap
  // 02:30" azon a héten nem létezik. A 03:30-ra igazítás olyan időpontra
  // tenné ki a kiadást, amit az operátor sosem kért.
  const savok = [{ id: 'hajnali', nap: 0, ora: 2, perc: 30 }]
  const r = kovetkezoSzabadSav(savok, [], new Date('2026-03-23T00:00:00.000Z'), BUDAPEST)
  assert.equal(r.idopont, '2026-04-05T00:30:00.000Z') // a KÖVETKEZŐ vasárnap 02:30 CEST
})

test('az ősszel KÉTSZER lejátszódó falióra-perc a második előfordulásra esik -- döntés, nem véletlen', () => {
  // 2026-10-25T01:00Z-kor Budapesten 03:00-ról 02:00-ra ugrik vissza az óra,
  // tehát "vasárnap 02:30" kétszer van: 00:30Z (CEST) és 01:30Z (CET). A
  // modul az óraátállítás UTÁNI előfordulást adja. Nem mindegy, melyiket --
  // de az számít, hogy ki legyen mondva és pinnelve.
  const savok = [{ id: 'hajnali', nap: 0, ora: 2, perc: 30 }]
  const r = kovetkezoSzabadSav(savok, [], new Date('2026-10-19T00:00:00.000Z'), BUDAPEST)
  assert.equal(r.idopont, '2026-10-25T01:30:00.000Z')
})

test('a zóna a modul ADATA: más zónában ugyanaz a sáv más pillanatot ad', () => {
  const savok = [{ id: 's1', nap: 1, ora: 9, perc: 0 }]
  const most = new Date('2026-09-07T05:00:00.000Z')
  assert.equal(kovetkezoSzabadSav(savok, [], most, BUDAPEST).idopont, '2026-09-07T07:00:00.000Z')
  assert.equal(kovetkezoSzabadSav(savok, [], most, 'UTC').idopont, '2026-09-07T09:00:00.000Z')
  assert.equal(kovetkezoSzabadSav(savok, [], most, 'Pacific/Kiritimati').idopont, '2026-09-13T19:00:00.000Z')
})

test('a zóna KÖTELEZŐ: elhagyva megnevezett elutasítás, nem csendben budapesti számolás', () => {
  // Nincs alapértéke a számtannak. Az `ALAP_IDOZONA` a modul KONSTANSA, nem az
  // operátor BEÁLLÍTÁSA, és a kettő nem ugyanaz a string abban a pillanatban,
  // amikor az operátor átírja a mezőt. Egy alapérték itt azt jelentené, hogy
  // egy hívó, aki elfelejtette átadni a beállítást, budapesti sávokat
  // számolna, miközben a beállítás-lap mást mond -- és semmi nem jelezné az
  // eltérést. Ugyanaz a néma tévedés, mint egy nem létező oszlopra szűrni.
  const savok = [{ id: 's1', nap: 1, ora: 9, perc: 0 }]
  const most = new Date('2026-09-07T05:00:00.000Z')
  const hianyzik = refusal(() => kovetkezoSzabadSav(savok, [], most))
  assert.ok(hianyzik instanceof TypeError, 'a zóna elhagyása nem lehet csendes')
  assert.match(hianyzik.message, /idozona/)
  // Az elutasítás megmondja, mi a teendő: olvasd ki a beállításból.
  assert.match(hianyzik.message, /idozonaOf/)
  for (const nemZona of [undefined, null, '', '   ', 42, {}]) {
    assert.throws(() => kovetkezoSzabadSav(savok, [], most, nemZona), TypeError)
  }
  // És a zóna hiánya akkor is elutasítás, ha egyetlen sáv sincs beállítva --
  // az üres-tömb ág nem kerülheti meg az ellenőrzést.
  assert.throws(() => kovetkezoSzabadSav([], [], most), TypeError)
})

test('kovetkezoSzabadSav: elutasítja az ismeretlen időzónát a saját mondatával, nem az Intl RangeError-jával', () => {
  // Az `Intl.DateTimeFormat` nyers `RangeError: Invalid time zone specified:
  // Nincs/Ilyen`-t dob: megnevezetlen elutasítás, ami ráadásul visszamondja a
  // hívó értékét. Egyik sem érhet el az operátorig.
  const savok = [{ id: 's1', nap: 1, ora: 9, perc: 0 }]
  const err = refusal(() => kovetkezoSzabadSav(savok, [], new Date('2026-09-07T05:00:00.000Z'), 'Nincs/Ilyen'))
  assert.ok(err instanceof TypeError, 'nem utasította el az ismeretlen zónát')
  assert.equal(err instanceof RangeError, false, 'az Intl saját RangeError-ja nem szivároghat ki')
  assert.match(err.message, /idozona/)
  assert.equal(err.message.includes('Nincs/Ilyen'), false, 'a hívó által küldött érvénytelen érték nem jelenhet meg az elutasításban')
  assert.equal(/Invalid time zone/.test(err.message), false, 'az Intl saját szövege nem jelenhet meg az elutasításban')
  // A hiányzó és az ismeretlen zóna KÉT KÜLÖN tény, két külön mondattal: az
  // egyik a hívót küldi a beállításhoz, a másik az operátort a mezőhöz.
  const hianyzik = refusal(() => kovetkezoSzabadSav(savok, [], new Date('2026-09-07T05:00:00.000Z')))
  assert.notEqual(err.message, hianyzik.message)
})

test('idozonaOf: a kiürített és a soha be nem állított mező is a modul alapértékét adja', () => {
  assert.equal(idozonaOf(undefined), ALAP_IDOZONA)
  assert.equal(idozonaOf(null), ALAP_IDOZONA)
  assert.equal(idozonaOf({}), ALAP_IDOZONA)
  assert.equal(idozonaOf({ idozona: '' }), ALAP_IDOZONA, 'a kiürített mező üres stringet tárol, nem undefinedet')
  assert.equal(idozonaOf({ idozona: '   ' }), ALAP_IDOZONA)
  assert.equal(idozonaOf({ idozona: 42 }), ALAP_IDOZONA)
  assert.equal(idozonaOf({ idozona: ' America/New_York ' }), 'America/New_York')
})

// --- két sáv ugyanarra a percre nem duplázza a kapacitást (D6) ---

test('két sáv ugyanarra a percre NEM duplázza a kapacitást: a foglalás a pillanatra szól, nem a (sáv, pillanat) párra', () => {
  // A `db.mjs` kulcs-regisztere szerint a duplikált sáv redundáns, nem
  // érvénytelen -- de csak akkor igaz, ha INERT is. (savId, pillanat) kulcs
  // mellett a második sáv csendben ugyanarra a percre adna egy MÁSODIK
  // kiadást: két kiadás megy ki egyszerre négy platformra, attól, hogy az
  // operátor kétszer írta be ugyanazt az időt.
  const savok = [{ id: 's1', nap: 1, ora: 9, perc: 0 }, { id: 's2', nap: 1, ora: 9, perc: 0 }]
  const most = new Date('2026-09-07T05:00:00.000Z')
  const elso = kovetkezoSzabadSav(savok, [], most, BUDAPEST)
  assert.equal(elso.idopont, '2026-09-07T07:00:00.000Z')

  const masodik = kovetkezoSzabadSav(savok, [{ savId: elso.savId, idopont: elso.idopont }], most, BUDAPEST)
  assert.equal(masodik.idopont, '2026-09-14T07:00:00.000Z', 'a másik sáv nem oszthatja ki újra ugyanazt a percet')
})

test('kovetkezoSzabadSav: holtversenynél a savok tömbben ELŐBB álló sáv nyer', () => {
  // A `savok()` (src/db.mjs) `nap, ora, perc` szerint rendez, tehát a
  // holtverseny a duplikált sávok esete. `<` helyett `<=` a nyertes
  // összehasonlításában a KÉSŐBBI tömbelemet adná -- ugyanaz a pillanat, más
  // savId, és a naptár más sávba rajzolná a bejegyzést.
  const savok = [{ id: 'elso', nap: 1, ora: 9, perc: 0 }, { id: 'masodik', nap: 1, ora: 9, perc: 0 }]
  const r = kovetkezoSzabadSav(savok, [], new Date('2026-09-07T05:00:00.000Z'), BUDAPEST)
  assert.equal(r.savId, 'elso')
})

// --- a sáv-számtan többi pinnelt tulajdonsága ---

test('kovetkezoSzabadSav: az ora és a perc nem cserélhető fel némán -- a pontos időpont dönt, nem csak a sorrend', () => {
  // Az `ora`/`perc` felcserélése az implementációban "nagyjából" működne, ha
  // a fixture csak azt állítaná, melyik sáv nyert; ezért a TELJES kiszámolt
  // pillanat az állítás.
  const savok = [{ id: 's1', nap: 2, ora: 9, perc: 47 }, { id: 's2', nap: 2, ora: 9, perc: 12 }]
  const most = new Date('2026-09-08T00:00:00.000Z') // kedd 02:00 Budapest (nap = 2)
  const r = kovetkezoSzabadSav(savok, [], most, BUDAPEST)
  assert.equal(r.savId, 's2')
  assert.equal(r.idopont, '2026-09-08T07:12:00.000Z') // kedd 09:12 CEST
})

test('kovetkezoSzabadSav: a nap száma a ZÓNA fali napja szerint dönt, nem a tömbindex', () => {
  const savok = [{ id: 'pentek', nap: 5, ora: 8, perc: 0 }, { id: 'szerda', nap: 3, ora: 8, perc: 0 }]
  const most = new Date('2026-09-07T00:00:00.000Z') // hétfő 02:00 Budapest
  const r = kovetkezoSzabadSav(savok, [], most, BUDAPEST)
  assert.equal(r.savId, 'szerda')
  assert.equal(r.idopont, '2026-09-09T06:00:00.000Z') // a két nappal későbbi szerda 08:00 CEST, nem a péntek
})

test('kovetkezoSzabadSav: a most-tal pontosan egybeeső előfordulás NEM szabad -- egy héttel odébb ugrik', () => {
  const savok = [{ id: 's1', nap: 1, ora: 9, perc: 0 }]
  const most = new Date('2026-09-07T07:00:00.000Z') // pontosan a sáv saját pillanata
  const r = kovetkezoSzabadSav(savok, [], most, BUDAPEST)
  assert.equal(r.idopont, '2026-09-14T07:00:00.000Z')
})

test('kovetkezoSzabadSav: üres savok esetén null', () => {
  assert.equal(kovetkezoSzabadSav([], [], new Date('2026-09-07T09:00:00.000Z'), BUDAPEST), null)
})

test('kovetkezoSzabadSav: elutasítja az érvénytelen sávot a nap HATÁRÁN is, a hívó értékét vissza nem mondva', () => {
  const most = new Date('2026-09-07T05:00:00.000Z')
  // A 7 a nap első ÉRVÉNYTELEN értéke. Az `ujSav` (src/db.mjs) pinneli, de a
  // `kovetkezoSzabadSav` publikus belépő, ami bárhonnan kaphat sort -- a
  // saját határát a saját tesztje kell hogy őrizze.
  const hetes = refusal(() => kovetkezoSzabadSav([{ id: 's1', nap: 7, ora: 9, perc: 0 }], [], most, BUDAPEST))
  assert.ok(hetes instanceof TypeError, 'a 7-es nap az első ÉRVÉNYTELEN érték, és elutasítást kell kapnia')
  assert.equal(hetes.message.includes('nap: 7'), false)
  assert.throws(() => kovetkezoSzabadSav([{ id: 's1', nap: -1, ora: 9, perc: 0 }], [], most, BUDAPEST), TypeError)
  assert.throws(() => kovetkezoSzabadSav([{ id: 's1', nap: 9, ora: 9, perc: 0 }], [], most, BUDAPEST), TypeError)
  assert.throws(() => kovetkezoSzabadSav([{ id: 's1', nap: 1, ora: 24, perc: 0 }], [], most, BUDAPEST), TypeError)
  assert.throws(() => kovetkezoSzabadSav([{ id: 's1', nap: 1, ora: 9, perc: 60 }], [], most, BUDAPEST), TypeError)
  assert.throws(() => kovetkezoSzabadSav([{ nap: 1, ora: 9, perc: 0 }], [], most, BUDAPEST), TypeError)
})

test('kovetkezoSzabadSav: elutasítja az érvénytelen most-ot', () => {
  assert.throws(() => kovetkezoSzabadSav([], [], new Date('nem-datum'), BUDAPEST), TypeError)
  assert.throws(() => kovetkezoSzabadSav([], [], 'nem is Date', BUDAPEST), TypeError)
})

test('kovetkezoSzabadSav: a foglaltak minden elemét ELLENŐRZI, nem csak a savok-at', () => {
  const savok = [{ id: 's1', nap: 1, ora: 9, perc: 0 }]
  const most = new Date('2026-09-07T05:00:00.000Z')
  // Enélkül: nyers `RangeError: Invalid time value` a V8-tól, egy operátornak
  // szánt felületen.
  const rossz = refusal(() => kovetkezoSzabadSav(savok, [{ savId: 's1', idopont: 'nem-datum' }], most, BUDAPEST))
  assert.ok(rossz instanceof TypeError, 'nem utasította el a hibás foglalást')
  assert.match(rossz.message, /foglaltak/)
  assert.equal(rossz.message.includes('nem-datum'), false, 'a hívó által küldött érvénytelen érték nem jelenhet meg az elutasításban')
  assert.throws(() => kovetkezoSzabadSav(savok, [{ savId: 's1' }], most, BUDAPEST), TypeError)
  assert.throws(() => kovetkezoSzabadSav(savok, [{ idopont: '2026-09-07T07:00:00.000Z' }], most, BUDAPEST), TypeError)
  assert.throws(() => kovetkezoSzabadSav(savok, [null], most, BUDAPEST), TypeError)
  assert.throws(() => kovetkezoSzabadSav(savok, ['2026-09-07T07:00:00.000Z'], most, BUDAPEST), TypeError)
})

test('kovetkezoSzabadSav: a savId nélküli foglalás nem látszik szabadnak', () => {
  // A legrosszabb alak: a hiányzó `savId` régen csendben olyan kulcsot
  // épített, ami sosem illeszkedett -- a foglalt sáv szabadnak látszott, és
  // ugyanarra a percre egy második kiadás került. Most megnevezett elutasítás.
  const savok = [{ id: 's1', nap: 1, ora: 9, perc: 0 }]
  const most = new Date('2026-09-07T05:00:00.000Z')
  assert.throws(() => kovetkezoSzabadSav(savok, [{ savId: '', idopont: '2026-09-07T07:00:00.000Z' }], most, BUDAPEST), TypeError)
})

// --- esedekes: több kiadás egyszerre, és a HARMADIK tény ---

test('esedekes: több kiadás közül csak az esedékes utemezve-ket adja, a sorrendet megtartva', () => {
  const most = new Date('2026-09-07T10:00:00.000Z')
  const k = [
    { id: 'jovoben', idopont: '2026-09-07T11:00:00.000Z', allapot: KIADAS_ALLAPOTOK.UTEMEZVE },
    { id: 'esedekes-1', idopont: '2026-09-07T09:00:00.000Z', allapot: KIADAS_ALLAPOTOK.UTEMEZVE },
    { id: 'jovahagyva-de-nem-utemezve', idopont: '2026-09-07T09:00:00.000Z', allapot: KIADAS_ALLAPOTOK.JOVAHAGYVA },
    { id: 'esedekes-2', idopont: '2026-09-07T10:00:00.000Z', allapot: KIADAS_ALLAPOTOK.UTEMEZVE },
  ]
  assert.deepEqual(esedekes(k, most).map((x) => x.id), ['esedekes-1', 'esedekes-2'])
})

test('az időpont nélküli utemezve sor HARMADIK tény: nem esedékes, de meg is van nevezve', () => {
  // Nem "még nem esedékes" és nem is kivétel: saját, megnevezett kimenet. A
  // két függvény együtt PARTICIONÁLJA az ütemezett sorokat -- semmi nem esik
  // közéjük.
  const most = new Date('2026-09-07T10:00:00.000Z')
  const k = [
    { id: 'esedekes', idopont: '2026-09-07T09:00:00.000Z', allapot: KIADAS_ALLAPOTOK.UTEMEZVE },
    { id: 'jovoben', idopont: '2026-09-07T11:00:00.000Z', allapot: KIADAS_ALLAPOTOK.UTEMEZVE },
    { id: 'nincs-idopontja', allapot: KIADAS_ALLAPOTOK.UTEMEZVE },
    { id: 'romlott-idopontja', idopont: 'nem-datum', allapot: KIADAS_ALLAPOTOK.UTEMEZVE },
    { id: 'null-idopontja', idopont: null, allapot: KIADAS_ALLAPOTOK.UTEMEZVE },
    { id: 'vazlat', allapot: KIADAS_ALLAPOTOK.VAZLAT },
  ]
  assert.deepEqual(esedekes(k, most).map((x) => x.id), ['esedekes'])
  assert.deepEqual(idopontNelkuliUtemezettek(k).map((x) => x.id),
    ['nincs-idopontja', 'romlott-idopontja', 'null-idopontja'])
  // A vázlat egyik listában sincs: az `allapot` már kizárta, mielőtt az
  // `idopont`-ra egyáltalán sor került volna.
  const utemezettek = k.filter((x) => x.allapot === KIADAS_ALLAPOTOK.UTEMEZVE)
  assert.equal(esedekes(k, most).length + idopontNelkuliUtemezettek(k).length + 1, utemezettek.length,
    'esedékes + időpont nélküli + a jövőbeli = az összes ütemezett sor')
})

test('idopontNelkuliUtemezettek: elutasítja az érvénytelen bemenetet', () => {
  assert.throws(() => idopontNelkuliUtemezettek([{ id: 'k1' }]), TypeError)
  assert.throws(() => idopontNelkuliUtemezettek('nem tömb'), TypeError)
})

test('esedekes: elutasítja az érvénytelen bemenetet', () => {
  assert.throws(() => esedekes([{ id: 'k1' }], new Date()), TypeError)
  assert.throws(() => esedekes([], 'nem Date'), TypeError)
})
