import assert from 'node:assert/strict'
import test from 'node:test'

import { bundle } from '../scripts/build.mjs'

test('a bundle nem visz saját React-példányt', async () => {
  const out = await bundle({ write: false })
  const js = out.outputFiles[0].text
  assert.equal(js.includes('react-dom/client'), false)
  assert.match(js, /window\.swarmclaw/, 'a React a hoszt táblájából jön')
})

test('a bundle mind a három nézetet tartalmazza', async () => {
  const out = await bundle({ write: false })
  const js = out.outputFiles[0].text
  for (const jel of ['Ügyfelek', 'Ügyek', 'Elavult']) {
    assert.ok(js.includes(jel), `hiányzik a bundle-ből: ${jel}`)
  }
})

test('a bundle tartalmazza a kézi bevitel űrlapjait', async () => {
  const out = await bundle({ write: false })
  const js = out.outputFiles[0].text
  for (const jel of ['Új kapcsolat', 'Cím hozzáadása', 'Új ügy']) {
    assert.ok(js.includes(jel), `hiányzik a bundle-ből: ${jel}`)
  }
})

test('a bundle tartalmazza a besorolatlan hozzárendelő sorát', async () => {
  const out = await bundle({ write: false })
  const js = out.outputFiles[0].text
  for (const jel of ['Hozzárendel', 'Válassz kapcsolatot']) {
    assert.ok(js.includes(jel), `hiányzik a bundle-ből: ${jel}`)
  }
})

test('a bundle tartalmazza a találgatást feloldó "összes kapcsolat" jelölőnégyzetet', async () => {
  const out = await bundle({ write: false })
  const js = out.outputFiles[0].text
  assert.ok(js.includes('Összes kapcsolat'), 'hiányzik a bundle-ből: Összes kapcsolat')
})

test('a bundle tartalmazza a lapozast es a szoveg-megnyitast', async () => {
  const out = await bundle({ write: false })
  const js = out.outputFiles[0].text
  for (const jel of ['Korábbiak', 'Teljes szöveg']) {
    assert.ok(js.includes(jel), `hiányzik a bundle-ből: ${jel}`)
  }
})

test('a bundle tartalmazza a sopres gombjat', async () => {
  const out = await bundle({ write: false })
  const js = out.outputFiles[0].text
  assert.ok(js.includes('Levelek behúzása'), 'hiányzik a bundle-ből: Levelek behúzása')
})

test('a bundle tartalmazza a nem iktatott hozzarendeles jelzeset', async () => {
  const out = await bundle({ write: false })
  const js = out.outputFiles[0].text
  assert.ok(js.includes('még nincs ügyfele'), 'hiányzik a bundle-ből: a nem iktatott hozzárendelés üzenete')
})

test('a bundle megkulonbozteti a postafiok-hivas elhasalasanak ket okat', async () => {
  const out = await bundle({ write: false })
  const js = out.outputFiles[0].text
  for (const jel of [
    'nincs beállítva Google OAuth kliens',
    'GOOGLE_OAUTH_CLIENT_DESKTOP_ID',
    'Hiányzik vagy lejárt a Gmail-hitelesítő',
    'A hívás üzenete',
  ]) {
    assert.ok(js.includes(jel), `hiányzik a bundle-ből: ${jel}`)
  }
})

/**
 * A 7. feladat: az ügyfél lapon a host `/api/tasks`-ából jövő feladatlista,
 * és a Ma nézeten a javaslat elfogadásának gombja.
 */
test('a bundle tartalmazza az ugyfelhez tartozo feladatlistat', async () => {
  const out = await bundle({ write: false })
  const js = out.outputFiles[0].text
  for (const jel of ['Feladatok', 'Ehhez az ügyfélhez még nincs feladat']) {
    assert.ok(js.includes(jel), `hiányzik a bundle-ből: ${jel}`)
  }
})

test('a bundle tartalmazza a javaslat elfogadasanak gombjat', async () => {
  const out = await bundle({ write: false })
  const js = out.outputFiles[0].text
  for (const jel of ['Elfogad', 'acceptSuggestion', 'Feladat létrehozva']) {
    assert.ok(js.includes(jel), `hiányzik a bundle-ből: ${jel}`)
  }
})

test('a bundle a sopres-osszegzesben a kimeno levelet es a kihagyast is mutatja', async () => {
  const out = await bundle({ write: false })
  const js = out.outputFiles[0].text
  for (const jel of ['recordedOut', 'skippedOut', 'kimenő idővonalra']) {
    assert.ok(js.includes(jel), `hiányzik a bundle-ből: ${jel}`)
  }
})

/**
 * I5 (code review): a fenti bundle-tesztek csak a felirat-szövegek jelenlétét
 * ellenőrzik, nem a BEKÖTÉST -- a code review kimutatta, hogy a
 * `useEffect(feladatokatTolt, [accountId])` sor törlése (`ugyfel-lap.tsx`)
 * a feladatlista örökre "Feladatok betöltése…" állapotban ragad, és a
 * `disabled={!!elfogadFut[s.id]}` törlése (`ma.tsx`) az Elfogad gombról egy
 * explicit követelményt vesz le -- MINDKETTŐ mellett a teljes csomag zölden
 * fut le, mert egyik szöveges felirat sem tűnik el. Ez a két teszt magára a
 * bekötésre illeszkedik a build (nem minifikált, `esbuild jsx: 'automatic'`)
 * kimenetében, ezért egy törölt sorra hiányzó szövegként bukik el.
 *
 * A reviewer mindkét mutációt kipróbálta a javítás előtt: a `useEffect`
 * sor törlésével 17/17 teszt zölden futott (a jelen két teszt nélkül), a
 * `disabled` prop törlésével 12/12 zölden futott. A jelen két teszt mindkét
 * mutációra pirosra vált -- lásd a "Fix pass 2" szakaszt a task-7-report.md-ben
 * a konkrét előtte/utána kimenetért.
 */
test('a feladatlista betoltese TENYLEGESEN be van kotve az accountId valtozasara (useEffect)', async () => {
  const out = await bundle({ write: false })
  const js = out.outputFiles[0].text
  assert.match(
    js,
    /\.useEffect\)\(feladatokatTolt,\s*\[accountId\]\)/,
    'hiányzik a bundle-ből a `useEffect(feladatokatTolt, [accountId])` bekötés -- ' +
    'a feladatlista lekérdezése nélküle sosem indul el',
  )
})

test('az Elfogad gomb TENYLEGESEN le van tiltva, amig a sajat elfogadasa fut', async () => {
  const out = await bundle({ write: false })
  const js = out.outputFiles[0].text
  // A `disabled: !!elfogadFut[s.id]` szöveg ÖNMAGÁBAN nem elég -- az Elvet
  // gomb is ugyanezt a kifejezést hordozza, tehát egy sima `includes` nem
  // venné észre, ha pont az Elfogad gombról tűnne el. A minta ezért az
  // `onClick: () => elfogad(s.id)` UTÁN, ugyanazon a jsx-hívásban követeli
  // meg a `disabled`-et.
  assert.match(
    js,
    /onClick:\s*\(\)\s*=>\s*elfogad\(s\.id\),\s*disabled:\s*!!elfogadFut\[s\.id\]/,
    'hiányzik a bundle-ből az Elfogad gomb `disabled={!!elfogadFut[s.id]}` prop-ja',
  )
})

/**
 * 8. feladat: a pipeline szakaszléptetése. A `bundle`-alapú tesztek itt (a
 * fenti I5 mintát követve) nem a felirat jelenlétét, hanem a tényleges
 * bekötést ellenőrzik -- a `kovetkezoSzakasz` pure függvény helyességét a
 * `test/ugyek.test.mjs` teszteli közvetlenül, importtal.
 */
test('a bundle tartalmazza a szakaszleptetest', async () => {
  const out = await bundle({ write: false })
  assert.ok(out.outputFiles[0].text.includes('Tovább'), 'hiányzik a léptető')
})

test('a "Tovabb" gomb TENYLEGESEN a kovetkezo szakaszt kuldi az updateDeal-nek, es csak ha van kovetkezo', async () => {
  const out = await bundle({ write: false })
  const js = out.outputFiles[0].text
  // A gomb csak a `kovetkezo &&` gate mögött jelenik meg -- ez az, ami az
  // utolsó szakaszon (negotiation, ahol `kovetkezoSzakasz` null-t ad, lásd
  // ugyek.test.mjs) eltünteti. Az onClick pontosan a `kovetkezo` (a
  // következő szakasz) értékkel hívja a `lept`-et, nem egy rögzített
  // stringgel -- ha valaki egy konkrét szakaszra (pl. mindig 'won'-ra)
  // cserélné, ez a minta nem illeszkedne.
  assert.match(
    js,
    /kovetkezo\s*&&[\s\S]{0,80}?"button",\s*\{\s*onClick:\s*\(\)\s*=>\s*lept\(d\.id,\s*kovetkezo\),\s*children:\s*"Tovább"/,
    'hiányzik a bundle-ből a "Tovább" gomb gate-elt, `lept(d.id, kovetkezo)`-t hívó bekötése',
  )
})

test('a lept TENYLEGESEN az updateDeal rpc-t hivja, hiba eseten setHiba-t allit, siker eseten toltot', async () => {
  const out = await bundle({ write: false })
  const js = out.outputFiles[0].text
  assert.match(
    js,
    /const lept = \(dealId, kovetkezo\) => \{\s*rpc\("updateDeal", \{ dealId, stage: kovetkezo \}\)\.then\(tolt\)\.catch\(\(e\) => setHiba\(e\.message\)\)/,
    'hiányzik a bundle-ből a `lept` helyes bekötése: `updateDeal` hívás, siker esetén `tolt`, hiba esetén `setHiba`',
  )
})
