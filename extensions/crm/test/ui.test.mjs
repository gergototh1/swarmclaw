import assert from 'node:assert/strict'
import test from 'node:test'

import { bundle } from '../scripts/build.mjs'
import { STATUSZ_PILL } from '../ui/ugyfelek.tsx'

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
  //
  // A task-5 (Ügyek képernyő vizuális átalakítása) a gombra egy
  // `className="crm-btn crm-btn-sm"` propot tett, ami a props-objektumban
  // az `onClick` ELÉ kerül -- a korábbi `\{\s*onClick:` (semmi köztes prop)
  // ezért erre a jelöléscserére is elbukott volna, holott a bekötés maga
  // (gate, `lept(d.id, kovetkezo)`, "Tovább" felirat) változatlan maradt.
  // A `\{[\s\S]{0,80}?onClick:` innentől bármilyen köztes propot (pl.
  // className) átenged, de a lényeget -- a gate-et, a pontos hívást és a
  // feliratot -- továbbra is szó szerint megköveteli.
  assert.match(
    js,
    /kovetkezo\s*&&[\s\S]{0,80}?"button",\s*\{[\s\S]{0,80}?onClick:\s*\(\)\s*=>\s*lept\(d\.id,\s*kovetkezo\)[\s\S]{0,40}?children:\s*"Tovább"/,
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

/**
 * A figyelem-lista a lapon. A CRM-3 terv 4. feladata "a lista az ugynoknek ES
 * a lapnak" cimet viselte, de a lap sosem hivta meg az `attention` rpc-t: a
 * rangsorolt lista kizarolag a 08:10-es chat-uzenetben letezett, es az operator
 * semmilyen uton nem tudta megnezni, MIROL ir az ugynok. Ezek a tesztek nem a
 * feliratot nezik, hanem a bekotest -- ugyanabbol az okbol, amiert az Elfogad
 * gomb es a szakaszleptetes tesztjei sem elegednek meg egy `includes`-szal.
 */
test('a lap TENYLEGESEN meghivja az attention rpc-t, es a valasz mindket mezojet felhasznalja', async () => {
  const out = await bundle({ write: false })
  const js = out.outputFiles[0].text
  assert.match(
    js,
    /rpc\("attention",\s*\{\s*limit:\s*\d+\s*\}\)\.then\(\(f\) => \{[\s\S]{0,200}?setFigyelem\(valasz\.sorok\);[\s\S]{0,80}?setFigyelemOsszes\(valasz\.osszes\);/,
    'hianyzik a bundle-bol az `attention` rpc hivasa a `sorok` ES az `osszes` mezo felhasznalasaval',
  )
  assert.match(
    js,
    /rpc\("attention"[\s\S]{0,300}?\}\)\.catch\(\(e\) => setHiba\(e\.message\)\)/,
    'az attention hivas hibaja nem a kozos `hiba` savba megy -- egy nema ures lista '
    + 'megkulonboztethetetlen attol, hogy tenyleg nincs teendo',
  )
})

test('a figyelem-sor a tipusat, a cimet ES az indokat is mutatja, nem csak az egyiket', async () => {
  const out = await bundle({ write: false })
  const js = out.outputFiles[0].text
  // A Task 2 vizualis atalakitasa (crm-attrow/crm-attbody/crm-attline
  // markup) tavolabb tolta a harom mezot egymastol, mint a korabbi lapos
  // <li> -- az ablakok ezert szelesebbek, de a sorrend (tipus, majd cim,
  // majd indok) es a tenyleges mezo-hasznalat valtozatlan kovetelmeny.
  assert.match(
    js,
    /figyelem\.map\(\(f\) =>[\s\S]{0,800}?figyelemKindNev\(f\.kind\)[\s\S]{0,300}?f\.cim[\s\S]{0,300}?f\.indok/,
    'a figyelem-sorbol hianyzik a tipus, a cim vagy az indok -- a sor onmagaban kell hogy megmondja, MIERT van rajta',
  )
})

test('a figyelem-sor Megnyit gombja az ugyfel lapjara visz, a sor accountId-javal', async () => {
  const out = await bundle({ write: false })
  const js = out.outputFiles[0].text
  // A minta a prop-sorrendtol fuggetlenul illeszkedik: a bekot lenyege az,
  // hogy egy "button" objektumon BELUL van egy onClick: () => megnyit(f.accountId)
  // ES egy children: "Megnyit" -- nem az, hogy melyik prop all elobb (a Task 2
  // jelolese elott peldaul a "className" allt a legelso helyen).
  assert.match(
    js,
    /"button",\s*\{[^}]*?onClick:\s*\(\)\s*=>\s*megnyit\(f\.accountId\)[^}]*?children:\s*"Megnyit"/,
    'hianyzik a figyelem-sor `megnyit(f.accountId)`-t hivo Megnyit gombja',
  )
})

test('a lap megmondja, ha csak a lista teteje latszik -- az `osszes`-t a limitalt hosszhoz merve', async () => {
  const out = await bundle({ write: false })
  const js = out.outputFiles[0].text
  assert.match(
    js,
    /figyelemOsszes\s*>\s*figyelem\.length\s*&&/,
    'hianyzik a limit-jelzes: husz sor es a teljes lista igy megkulonboztethetetlen',
  )
})

/**
 * Az `elfogadEredmeny` ("Feladat letrehozva: ...") egy EGYSZERI muvelet
 * visszajelzese, nem a lap allapota. Ha az elvetes, a sopres vagy egy
 * navigacio nem torolne, az operator egy mar nem ide tartozo feladat-
 * azonositot olvasna a Figyelmet igenyel szakasz tetejen.
 */
test('az elfogadas visszajelzeset az elvet, a soper ES a navigacio is torli', async () => {
  const out = await bundle({ write: false })
  const js = out.outputFiles[0].text
  assert.match(
    js,
    /const megnyit = \(accountId\) => \{\s*setElfogadEredmeny\(""\);\s*onOpen\(accountId\);/,
    'a navigacio nem torli az elfogadas visszajelzeset',
  )
  assert.match(
    js,
    /const elvet = \(suggestionId\) => \{\s*setElfogadEredmeny\(""\);/,
    'az elvetes nem torli az elfogadas visszajelzeset',
  )
  assert.match(
    js,
    /const soper = \(\) => \{\s*setFut\(true\);\s*setElfogadEredmeny\(""\);/,
    'a sopres nem torli az elfogadas visszajelzeset',
  )
})

test('a besorolatlan sor talalgatas-pillje is a torlo `megnyit`-en megy at, nem a nyers onOpen-en', async () => {
  const out = await bundle({ write: false })
  const js = out.outputFiles[0].text
  // A Task 2 vizualis atalakitasa a kulon (korabban `disabled={!u.guess_account_id}`-
  // lel tiltott) Megnyit gombot es a "valoszinuleg ..." feliratot egyetlen
  // kattinthato pillebe vonta ossze -- a tiltas szerepet mostantol a
  // `{u.guess_account_id && (...)}` felteteles renderelese veszi at, a gomb
  // csak akkor letezik, ha van talalgatas. A lenyeg valtozatlan: a navigacio
  // itt is a torlo `megnyit`-en megy at, es tovabbra is a `guess_account_id`
  // fuggveny hivja meg.
  assert.match(
    js,
    /u\.guess_account_id\s*&&[\s\S]{0,200}?"button",[\s\S]{0,200}?onClick:\s*\(\)\s*=>\s*u\.guess_account_id\s*&&\s*megnyit\(u\.guess_account_id\)/,
    'a besorolatlan sor talalgatas-pillje navigacioja megkeruli az `elfogadEredmeny` torleset, vagy nincs a `guess_account_id`-hoz kotve',
  )
})

/**
 * I3: a `role="tab"` NEM egy diszites, hanem egy igeret. A harom
 * `aria-pressed`-es gomb, amit lecserelt, semmit nem igert; a `role="tab"`
 * viszont a kepernyoolvasonak ful-widgetet mond be, es egy ful-widget, ami
 * nyilra nem mozdul, aminek nincs panelje es aminek minden fule kulon
 * tab-megallo, pontosan azt az igeretet szegi meg. A minta MIND A NEGY
 * darabja kell: `aria-controls` -> a panel, `role="tabpanel"` + `id` +
 * `aria-labelledby` -> vissza a valasztott fulre, roving `tabindex` (0 a
 * valasztotton, -1 a tobbin), es Bal/Jobb nyil.
 */
test('a fulsav tablist, es a fulek aria-selected-et viselnek', async () => {
  const out = await bundle({ write: false })
  const js = out.outputFiles[0].text
  assert.match(js, /role:\s*"tablist"/, 'a fulsav role="tablist"')
  assert.match(js, /role:\s*"tab"/, 'a fulek role="tab"-ot visznek')
  assert.equal(js.includes('aria-pressed'), false, 'a fulek nem gomb-, hanem ful-szemantikat visznek')
  assert.match(js, /"aria-selected":\s*nezet === f\.id/, 'a kivalasztottsagot az aktualis nezet donti el')
  // A harom nezet-kulcs tovabbra is egyetlen helyrol, a NEZETEK tablabol jon.
  assert.match(js, /\{ id: "ma", cimke: "Ma" \}/)
  assert.match(js, /\{ id: "ugyfelek", cimke: "Ügyfelek" \}/)
  assert.match(js, /\{ id: "ugyek", cimke: "Ügyek" \}/)
})

test('minden ful `aria-controls`-szal a panelre mutat, a panel pedig vissza a valasztott fulre', async () => {
  const out = await bundle({ write: false })
  const js = out.outputFiles[0].text
  assert.match(js, /"aria-controls":\s*PANEL_ID/, 'a fuleknek meg kell nevezniuk, mit vezerelnek')
  assert.match(
    js,
    /"main",\s*\{[^}]*?role:\s*"tabpanel"[^}]*?id:\s*PANEL_ID[^}]*?"aria-labelledby":\s*fulId\(nezet\)/,
    'a panelnek role="tabpanel"-nek kell lennie, a fulek altal hivatkozott id-vel, es vissza kell mutatnia a valasztott fulre',
  )
  // EGY panel van (a `main` egyszerre egy nezetet rendereli), ezert a
  // panel-azonosito allando -- fulonkenti id itt logo hivatkozas lenne.
  assert.match(js, /var PANEL_ID = "crm-panel"/, 'a panel azonositoja allando')
  assert.match(js, /fulId = \(nezet\) => `crm-tab-\$\{nezet\}`/, 'a ful azonositoja a nezetbol szarmazik')
})

test('roving tabindex: a fulsav EGY tab-megallo, a valasztott fullel', async () => {
  const out = await bundle({ write: false })
  const js = out.outputFiles[0].text
  assert.match(
    js,
    /tabIndex:\s*nezet === f\.id \? 0 : -1/,
    'roving tabindex nelkul a harom ful harom kulon tab-megallo -- ez nem ful-widget viselkedes',
  )
})

test('Bal/Jobb nyil lepteti a fulet, korbeer, es viszi a fokuszt is', async () => {
  const out = await bundle({ write: false })
  const js = out.outputFiles[0].text
  assert.match(js, /onKeyDown:\s*\(e\) => nyilra\(e, i\)/, 'a fulek nincsenek bekotve a nyil-kezelore')
  assert.match(js, /e\.key === "ArrowRight" \? 1 : e\.key === "ArrowLeft" \? -1 : 0/, 'a Bal/Jobb nyil iranya')
  assert.match(js, /if \(lepes === 0\) return/, 'minden mas billentyu valtozatlanul tovabbmegy')
  assert.match(js, /e\.preventDefault\(\)/, 'a nyil nem gorgetheti kozben a lapot')
  assert.match(
    js,
    /\(index \+ lepes \+ NEZETEK\.length\) % NEZETEK\.length/,
    'a fulsav zart halmaz: a szelen korbe kell ernie',
  )
  assert.match(
    js,
    /fulsav\.current\?\.querySelectorAll\('\[role="tab"\]'\)\[cel\]\?\.focus\(\)/,
    'a nyil a FOKUSZT is viszi, nem csak a kivalasztast -- kulonben a kovetkezo nyil ugyanonnan indulna',
  )
})

test('az ugyfellista statusz-pillt visel, nem csupasz cimket', async () => {
  const out = await bundle({ write: false })
  const js = out.outputFiles[0].text
  assert.match(js, /crm-accts/, 'hianyzik az ugyfellista osztalya')
  assert.match(js, /crm-pill crm-pill-(ok|nema|plain)/, 'a statusz pillt kap')
})

/**
 * A bundle-alapu teszt fentebb csak azt bizonyitja, hogy VALAMELYIK
 * crm-pill-* osztaly szerepel a kimenetben -- egy felcserelt STATUSZ_PILL
 * bejegyzes (pl. ha 'client' is 'crm-pill-nema'-t kapna) at is menne rajta,
 * mert a stringek maguktol meg mind jelen vannak valahol a bundle-ben. Ez a
 * teszt kozvetlenul a STATUSZ_PILL tablat vizsgalja, statuszonkent, hogy egy
 * eltevesztett leképezes tenyleg bukjon.
 */
test('a STATUSZ_PILL tabla statuszonkent a helyes pill-osztalyt adja, ismeretlenre semlegeset', () => {
  assert.equal(STATUSZ_PILL.client, 'crm-pill-ok', 'az "Ügyfél" status elo bevetel, nem semleges pillt kell kapnia')
  assert.equal(STATUSZ_PILL.lead, 'crm-pill-nema', 'a "Lead" status lehetoseg-pillt kell kapnia')
  assert.equal(STATUSZ_PILL.inactive, 'crm-pill-plain', 'az "Inaktiv" status archivum-pillt kell kapnia')
  assert.equal(STATUSZ_PILL.lost, 'crm-pill-plain', 'az "Elvesztett" status archivum-pillt kell kapnia')
  assert.equal(STATUSZ_PILL.valami_ismeretlen, undefined, 'ismeretlen status a tablaban nincs jelen -- a hivo oldal ad neki semleges default-ot')
})


/**
 * I2: mind a negy kepernyot a sajat `<h2>`-je nevezi meg a dokumentumban.
 *
 * Verified: mind a negy `<h2 className="crm-h2">`-t `<div>`-re cserelve a
 * teljes csomag (277 teszt) zolden futott le -- semmi nem orizte oket, es a
 * lapon SEMMI MAS nem nevezi meg a kepernyoket: `role="tabpanel"`-en kivul
 * nincs cim, `aria-label` sincs a nezeteken. Egy `crm-h2` osztaly-string
 * nem eleg allitas: az egy `<div className="crm-h2">`-ben is ott van. A
 * minta ezert a TAG-et koveteli meg, kepernyonkent, a sajat cimevel.
 */
test('mind a negy kepernyo cime valodi <h2> marad a dokumentumban', async () => {
  const out = await bundle({ write: false })
  const js = out.outputFiles[0].text
  const cimek = { Ma: '"Ma"', 'Ügyfelek': '"Ügyfelek"', 'Ügyek': '"Ügyek"', 'ügyfél lap': 'lap.account.name' }
  for (const [kepernyo, gyerek] of Object.entries(cimek)) {
    assert.match(
      js,
      new RegExp(`\\)\\("h2", \\{ className: "crm-h2", children: ${gyerek.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\}\\)`),
      `a(z) "${kepernyo}" kepernyo cime nem <h2> -- a kepernyoolvaso cim-fajabol eltunik a kepernyo`,
    )
  }
})

/**
 * Spec 3.: szakaszonkent EGY hangsulyos akcio. Az "Ügyfelek" kepernyo
 * "Felvesz" gombja mar `crm-btn-primary` volt, az ugyfel lap harom rogzito
 * gombja ("Új ügy", "Új kapcsolat", "Rögzít") viszont sima maradt -- ugyanaz
 * a szerep, ket kulonbozo sullyal. Mindharom primary lett; a "Cím
 * hozzáadása" sorononkenti masodlagos akcio marad, ezert NEM az.
 */
test('minden urlap-szakasz rogzito gombja hangsulyos (primary), a masodlagosak nem', async () => {
  const out = await bundle({ write: false })
  const js = out.outputFiles[0].text
  for (const felirat of ['Felvesz', 'Új ügy', 'Új kapcsolat', 'Rögzít']) {
    const talalat = js.match(new RegExp(`className:\\s*"([^"]*)"[^{}]*children:\\s*"${felirat}"`))
    assert.ok(talalat, `nem talalhato a(z) "${felirat}" gomb JSX-e a bundle-ben`)
    assert.match(talalat[1], /\bcrm-btn-primary\b/, `a(z) "${felirat}" a szakasza egyetlen rogzito akcioja -- primary kell legyen`)
  }
  const cim = js.match(/className:\s*"([^"]*)"[^{}]*children:\s*"Cím hozzáadása"/)
  assert.ok(cim, 'nem talalhato a "Cím hozzáadása" gomb JSX-e')
  assert.doesNotMatch(cim[1], /\bcrm-btn-primary\b/, 'a soronkenti masodlagos akcio nem lehet a szakasz primary gombja')
})

/**
 * A talalgatas-pill (Besorolatlan sor) ket javitasa egyben.
 *
 * 1. A `crm-btn-quiet` halott volt rajta -- a `crm-pill-plain` nyeri a
 *    hatteret, a keretet es a szint (kesobb all a stiluslapban) --, EGY
 *    dolgot kiveve: a `.crm-btn-quiet:hover { background: transparent }`
 *    tovabbra is ervenyesult, tehat a chip a mutatora ELVESZTETTE a
 *    kitolteset. Mertem: nyugalomban `color(srgb .2 .2 .23)`, hoverben
 *    `rgba(0,0,0,0)`.
 * 2. Az akadalymentes nev korabban "valószínűleg X" volt -- ez nem mondja
 *    meg, hogy a gomb NAVIGAL. (A korabbi kulon, tiltott "Megnyit" gomb
 *    helyere lepett, es a "Megnyit" szo vele egyutt tunt el.) Az uj nev a
 *    LATHATO szoveggel kezdodik (WCAG 2.5.3 "Label in Name"), es kimondja,
 *    hogy megnyit egy ugyfelet.
 */
test('a talalgatas-pill nem visel crm-btn-quiet-et, es a neve megmondja, hogy megnyit egy ugyfelet', async () => {
  const out = await bundle({ write: false })
  const js = out.outputFiles[0].text
  const pill = js.match(/className:\s*"(crm-btn crm-pill[^"]*)"/)
  assert.ok(pill, 'nem talalhato a talalgatas-pill className-je')
  assert.doesNotMatch(
    pill[1], /\bcrm-btn-quiet\b/,
    'a crm-btn-quiet egyetlen ele szabalya a hover -- ott elveszi a chip kitolteset',
  )
  assert.match(
    js,
    /"aria-label":\s*`valószínűleg \$\{talalgatasNev \?\? "ismeretlen ügyfél"\} — ügyfél megnyitása`/,
    'az akadalymentes nevnek a lathato szoveggel kell kezdodnie, es meg kell mondania, hogy navigal',
  )
})
