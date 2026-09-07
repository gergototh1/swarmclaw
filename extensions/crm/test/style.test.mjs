import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

/**
 * A stíluslap szerződése (spec 2. és 7.).
 *
 * A `scripts/build.mjs` a `ui/style.css`-t SIMA MÁSOLÁSSAL viszi
 * `dist/style.css`-be -- nincs feldolgozás --, ezért a forrást olvassuk,
 * buildelés nélkül. Ha a build egyszer feldolgozni kezdi, ezt a tesztet a
 * kimenetre kell átállítani, különben olyasmit igazol, ami nem kerül ki.
 */
const css = fs.readFileSync(new URL('../ui/style.css', import.meta.url), 'utf8')

/**
 * A CSS ugyanígy, csak a blokk-kommentek nélkül. A böngésző egy kommentet
 * sosem futtat le -- se szelektorként, se színként, se var() hívásként --,
 * ezért minden kontraktus-teszt ezen a szövegen dolgozik. Enélkül egy
 * vesszős magyar mondat a kommentben ugyanúgy szelektor-darabnak nézne ki,
 * mint egy valódi `.crm-foo, .crm-bar` lista -- a kommentek prózáját semmi
 * nem kényszerítheti vesszőtlenségre csak azért, mert a teszt nyersen olvas.
 */
const kommentNelkul = css.replace(/\/\*[\s\S]*?\*\//g, '')

/**
 * A szabályok választói, at-szabály-preludiumok nélkül.
 *
 * A prefix-halmazban a `{` is szerepel: egy `@media (...) { .crm-btn { ... } }`
 * blokkban a beágyazott szelektor előtt nem `}`/`;`/szöveg-eleje áll, hanem az
 * at-szabály saját nyitó `{`-je. A `{` felvétele ezt is látóvá teszi, az
 * at-szabály preludiuma (`@media (max-width: 860px)`) viszont továbbra sem
 * eshet bele a találatba: a capture-csoport `@`-t kizár, így egy `@`-lel
 * kezdődő prelidum sosem tud a capture elejévé válni.
 */
function valasztok() {
  return [...kommentNelkul.matchAll(/(?:^|[{};])\s*([^{};@]+?)\s*\{/g)]
    .map((m) => m[1].trim())
    .filter((s) => s.length > 0)
    .flatMap((s) => s.split(',').map((x) => x.trim()))
}

/**
 * Egy `var(...)` hívást a lezáró zárójeléig kivág -- beágyazott zárójelekkel
 * együtt --, és 'VAR' helyőrzővel helyettesíti.
 *
 * Ezt egy regex nem tudja helyesen: a `var(--a, var(--b, #fff))` alak vagy a
 * `var(--color-border, rgba(255,255,255,.07))` alak is zárójelet visz a
 * fallback-be, és egy lusta `[^;]*?\)` a belső hívás záró zárójelénél
 * megállna, kint hagyva a külsőt. Mély zárójel-számlálással kell párosítani
 * a nyitást a záróval, függetlenül attól, hány szint ágyazódik egymásba.
 */
function varHivasokNelkul(szoveg) {
  let eredmeny = ''
  let i = 0
  for (;;) {
    const start = szoveg.indexOf('var(', i)
    if (start === -1) {
      eredmeny += szoveg.slice(i)
      break
    }
    eredmeny += szoveg.slice(i, start)
    let melyseg = 1
    let j = start + 'var('.length
    while (j < szoveg.length && melyseg > 0) {
      if (szoveg[j] === '(') melyseg += 1
      else if (szoveg[j] === ')') melyseg -= 1
      j += 1
    }
    eredmeny += 'VAR'
    i = j
  }
  return eredmeny
}

test('a stiluslap nem tolt be betutipust', () => {
  // Kommentek nelkul: egy kikommentezett @font-face nem tolt be semmit, es
  // egy fonts.googleapis-t emlegeto magyarazo mondat sem betutoltes.
  assert.equal(
    /@font-face|@import|fonts\.googleapis|fonts\.gstatic/.test(kommentNelkul), false,
    'a hoszt mar betoltotte a betuket; a --font-* tokeneket kell olvasni',
  )
})

test('minden valaszto crm- prefixet visel', () => {
  const rosszak = valasztok().filter((s) => !s.includes('.crm-'))
  assert.deepEqual(rosszak, [], 'prefix nelkuli szabaly a hoszt shelljet is atstilusozna')
})

test('minden szin tokenbol jon, fallbackkel', () => {
  // A var(--token, fallback) hivasokat -- beagyazott zarojelekkel egyutt --
  // kivagjuk; ami hexa vagy rgb()/rgba()/hsl()/hsla() marad, az nyers.
  // Kommentek nelkul olvasunk: egy dokumentacios celu hexa szin egy
  // magyarazo mondatban nem valodi, ki nem szallitott stilus.
  const maradek = varHivasokNelkul(kommentNelkul)
  const nyersHexa = [...maradek.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0])
  const nyersFuggveny = [...maradek.matchAll(/\b(?:rgba?|hsla?)\(/gi)].map((m) => m[0])
  assert.deepEqual([...nyersHexa, ...nyersFuggveny], [], 'nyers szin csak var() fallback-pozicioban allhat')
})

test('minden var() hivas visz fallbacket', () => {
  // Kommentek nelkul: egy komment altal emlegetett token-nev nem valodi
  // var() hivas, nem is fut le, tehat nem eshet at ezen az ellenorzesen.
  const fallbackNelkul = [...kommentNelkul.matchAll(/var\(\s*(--[a-z0-9-]+)\s*\)/g)].map((m) => m[1])
  assert.deepEqual(fallbackNelkul, [], 'egy atnevezett token nelkul a lap olvashatatlan lenne')
})

test('varHivasokNelkul egy beagyazott var() fallbacket egyben nyel le', () => {
  // A stiluslapban ma nincs var(--a, var(--b, ...)) alak, de a strippelo
  // logikanak akkor is helyesen kellene kezelnie, kulonben egy jovobeli
  // beagyazott var() a belso zarojelnel szakadna meg, es a #fff nyersen
  // maradna -- lasd a fuggveny sajat kommentjet a zarojel-szamlalasrol.
  const szintetikus = '.crm-x { color: var(--a, var(--b, blue), #fff); }'
  const maradek = varHivasokNelkul(szintetikus)
  assert.equal(/#[0-9a-fA-F]{3,8}/.test(maradek), false, 'a beagyazott fallback belseje sem maradhat nyersen lathato')
  assert.equal(maradek.includes('VAR'), true, 'a teljes beagyazott var() hivast egy helyorzore kellett cserelni')
})

/**
 * `{ szelektorok, torzs }` blokkok listaja -- egymasba agyazott
 * at-szabalyok (pl. `@media`) eseten is a legbelso, tenyleges deklaracios
 * blokkot adja vissza, mert egy `[^{}]*` sosem nyelhet el egy beagyazott
 * `{`-t: a regex ott elakad, es a kovetkezo probalkozas mar a belso
 * szabalynal talal parost. Ezert a `@media (...) { .crm-btn { ... } }`
 * alakbol pontosan a `.crm-btn { ... }` blokk jon ki, az `@media` maga
 * nem -- nincs is ra szukseg, mert csak konkret szelektorokra keresunk.
 */
function szabalyBlokkok(szoveg) {
  return [...szoveg.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map((m) => ({ szelektorok: m[1].trim().split(',').map((s) => s.trim()), torzs: m[2] }))
    .filter((b) => !b.szelektorok.some((s) => s.startsWith('@')))
}

test('a .crm-acct kattinthato biztonsagi tulajdonsagai (font/cursor/transition) kozos szabalyban elnek a .crm-btn-vel, nem lemasolva', () => {
  // Regresszios teszt az F1 review-talalatra: a `ui/ugyfelek.tsx` sor-gombja
  // (`.crm-acct`) valodi <button>, ezert a `font: inherit`/`cursor: pointer`
  // biztonsagi parost es az atmenet-viselkedest (transition +
  // prefers-reduced-motion) meg kell osztania a `.crm-btn`-nel (es a
  // transition eseteben a `.crm-tab`-bal is) -- nem sajat, kezzel masolt
  // peldanyban kell elniuk. Ha a `.crm-acct` valaha kikerul ebbol a kozos
  // szabalybol es visszakapja a sajat masolatat, ez a teszt elbukik, meg
  // akkor is, ha a szamitott ertek veletlenul egyezik a `.crm-btn`-evel.
  const blokkok = szabalyBlokkok(kommentNelkul)

  const cursorSzabaly = blokkok.find((b) => b.szelektorok.includes('.crm-acct') && /cursor:\s*pointer/.test(b.torzs))
  assert.ok(cursorSzabaly, 'a .crm-acct-nak rendelkeznie kell cursor: pointer-rel')
  assert.ok(cursorSzabaly.szelektorok.includes('.crm-btn'),
    'a .crm-acct cursor: pointer szabalyat meg kell osztania a .crm-btn-vel, nem sajat masolatban kell elnie')

  const fontSzabaly = blokkok.find((b) => b.szelektorok.includes('.crm-acct') && /font:\s*inherit/.test(b.torzs))
  assert.ok(fontSzabaly, 'a .crm-acct-nak rendelkeznie kell font: inherit-tel')
  assert.ok(fontSzabaly.szelektorok.includes('.crm-btn'),
    'a .crm-acct font: inherit szabalyat meg kell osztania a .crm-btn-vel, nem sajat masolatban kell elnie')

  const transzicioSzabaly = blokkok.find((b) => b.szelektorok.includes('.crm-acct') && /^transition:\s*background/.test(b.torzs.trim()))
  assert.ok(transzicioSzabaly, 'a .crm-acct-nak resze kell legyen a transition szabalynak')
  assert.ok(
    transzicioSzabaly.szelektorok.includes('.crm-btn') && transzicioSzabaly.szelektorok.includes('.crm-tab'),
    'a .crm-acct transition szabalyat meg kell osztania a .crm-btn es a .crm-tab elemekkel',
  )

  const reducedSzabaly = blokkok.find((b) => b.szelektorok.includes('.crm-acct') && /transition:\s*none/.test(b.torzs))
  assert.ok(reducedSzabaly, 'a .crm-acct-nak resze kell legyen a prefers-reduced-motion override-nak')
  assert.ok(
    reducedSzabaly.szelektorok.includes('.crm-btn') && reducedSzabaly.szelektorok.includes('.crm-tab'),
    'a .crm-acct reduced-motion szabalyat meg kell osztania a .crm-btn es a .crm-tab elemekkel',
  )
})

test('a .crm-cols szabaly tenylegesen ket hasabos gridet deklaral', () => {
  // Regresszios teszt az F4 review-talalatra: a `.crm-cols` szelektor
  // MEGLETE onmagaban semmit nem bizonyit -- a `crm-cols` string a bundle-ben
  // (lasd `ugyfel-lap.test.mjs`) is akkor is talalna, ha a szabaly torzse ures
  // lenne, vagy ha csak egyetlen oszlopot adna. Ez a teszt a torzset magat
  // vizsgalja: `display: grid` es egy PONTOSAN ket ertekbol allo
  // `grid-template-columns` egyutt kell ahhoz, hogy ez a szabaly tenyleg azt
  // a ket hasabot valositsa meg, aminek a megorzese ennek a feladatnak a
  // celja -- e nelkul a `.crm-cols { display: grid; grid-template-columns:
  // 1.35fr 1fr }` sor torlese (a feladat altal megelozni kivant pontos
  // regresszio) az osszes tesztet zoldon hagyna.
  const blokkok = szabalyBlokkok(kommentNelkul)
  const szabaly = blokkok.find((b) => b.szelektorok.includes('.crm-cols'))
  assert.ok(szabaly, 'a .crm-cols szabalynak letezni kell')

  assert.match(szabaly.torzs, /display:\s*grid/, 'a .crm-cols-nak grid elrendezesnek kell lennie')

  const gridMatch = szabaly.torzs.match(/grid-template-columns:\s*([^;]+);/)
  assert.ok(gridMatch, 'a .crm-cols-nak grid-template-columns-t kell deklaralnia')
  const oszlopok = gridMatch[1].trim().split(/\s+/)
  assert.equal(oszlopok.length, 2, 'a grid-template-columns pontosan ket oszlopot kell megadjon')
})

test('a .crm-pipe negy szakasz-oszlopot ad, es 900px/520px alatt omlik ossze', () => {
  // Ugyanaz a mintazat, mint a fenti .crm-cols teszt (F4): a `.crm-pipe`
  // SZELEKTOR meglete onmagaban semmit nem bizonyit -- a `crm-pipe` string a
  // bundle-ben (ugyek.test.mjs) akkor is megtalalhato lenne, ha a szabaly
  // torzse ures lenne, vagy ha nem negy, hanem ket oszlopot adna. Ez a teszt
  // a torzset magat vizsgalja, es -- mivel a feladat brief-je szerint az
  // Ugyek szinpados oszlopok szama a lenyeg -- azt is, hogy a ket media
  // query tenyleg 2, majd 1 oszlopra tordeli a 4-et, nem csak letezik.
  const blokkok = szabalyBlokkok(kommentNelkul)

  const alap = blokkok.find((b) => b.szelektorok.includes('.crm-pipe') && /display:\s*grid/.test(b.torzs))
  assert.ok(alap, 'a .crm-pipe alap szabalynak grid elrendezesnek kell lennie')
  const alapGrid = alap.torzs.match(/grid-template-columns:\s*([^;]+);/)
  assert.ok(alapGrid, 'a .crm-pipe alap szabalyanak grid-template-columns-t kell deklaralnia')
  assert.match(alapGrid[1], /repeat\(\s*4\s*,/, 'a .crm-pipe alapertelmezetten negy oszlopot kell adjon')

  // A ket @media blokk torzset kulon keressuk: a `szabalyBlokkok` a
  // legbelso `.crm-pipe { ... }` deklaracios blokkot adja vissza minden
  // egyes @media-n belul kulon talalatkent, at-szabaly nelkul -- ezert
  // sorrendben (900px, majd 520px) a masodik es harmadik `.crm-pipe`
  // talalat ezeket adja.
  const pipeSzabalyok = blokkok.filter((b) => b.szelektorok.includes('.crm-pipe'))
  assert.equal(pipeSzabalyok.length, 3, 'a .crm-pipe-nek az alap szabaly mellett ket media-query valtozatot kell adnia')

  const kozepesGrid = pipeSzabalyok[1].torzs.match(/grid-template-columns:\s*([^;]+);/)
  assert.ok(kozepesGrid, 'a masodik .crm-pipe szabalynak grid-template-columns-t kell deklaralnia')
  assert.match(kozepesGrid[1], /repeat\(\s*2\s*,/, 'a keskenyebb nezetben ket oszlopra kell omolnia')

  const szukGrid = pipeSzabalyok[2].torzs.match(/grid-template-columns:\s*([^;]+);/)
  assert.ok(szukGrid, 'a harmadik .crm-pipe szabalynak grid-template-columns-t kell deklaralnia')
  assert.equal(szukGrid[1].trim(), '1fr', 'a legszukebb nezetben egyetlen oszlopra kell omolnia')
})

/**
 * Zarojel-melysegtudatos tordelo: a `grid-template-columns` ertekeben a
 * ket oszlopot elvalaszto szokoz megtalalasahoz a fuggveny-argumentumok
 * (`minmax(0, 380px)`) BELSO vesszo utani szokozeit NEM szabad
 * oszlophatarnak nezni -- egy naiv `split(/\s+/)` ezt elrontana.
 */
function oszlopokra(ertek) {
  const eredmeny = []
  let darab = ''
  let melyseg = 0
  for (const ch of ertek.trim()) {
    if (ch === '(') melyseg += 1
    if (ch === ')') melyseg -= 1
    if (/\s/.test(ch) && melyseg === 0) {
      if (darab) eredmeny.push(darab)
      darab = ''
    } else {
      darab += ch
    }
  }
  if (darab) eredmeny.push(darab)
  return eredmeny
}

test('a .crm-tri jobb (pickers) oszlopa korlatos, nem tudja 0-ra nyomni a bal (kuldo/targy) oszlopot', () => {
  // Regresszios teszt az F1 review-talalatra: `grid-template-columns: 1fr
  // auto` mellett egy hosszu <option> szoveg (valos eset: egy 115
  // karakteres magyar cegnev) a <select> max-content szelesseget 789px-re
  // hizlalta, az 'auto' oszlop erre nott, es a bal '1fr' oszlop (`min-
  // width: 0` miatt osszenyomhato) 0px-re esett ossze -- a kuldo cime es a
  // targy egy-egy karakter szelessegu oszlopba tordelodott. A jobb
  // oszlopnak explicit, FIX (nem szazalekos, nem "auto") felso korlatot
  // kell viselnie, kulonben ez a regresszio megismetlodhet.
  //
  // FONTOS, amit egy javitasi kiserlet soran a bongeszoben mertem: a
  // `minmax(0, min(46%, max-content))` -- ami csak akkor korlatozna, ha
  // tenylegesen szukseges lenne -- ERVENYTELEN CSS grid track-meretkent
  // (a %-ot es a max-content kulcsszot nem lehet `min()`-ben keverni):
  // Chrome-ban `getComputedStyle(...).gridTemplateColumns` ilyenkor
  // csendben "none"-ra esik, es a regi, hibas `auto` viselkedes marad
  // eletben. Ezert ez a teszt kifejezetten kizarja a `min(`-et tartalmazo
  // erteket is, nem csak a csupasz "auto"-t.
  //
  // Egy masik latszolagos javitas, a `minmax(0, 46%)` (tiszta szazalek)
  // szinten ERVENYES CSS, DE a grid track-meretezo "Maximize Tracks"
  // lepese ilyenkor a jobb oszlopot MINDIG pontosan 46%-ra hizlalja, meg
  // akkor is, ha a tartalma ennel sokkal kevesebb helyet igenyelne --
  // mertem: egy rovid (2 opcios) select-tel is 46%-ot foglalt a jobb
  // oszlop, feleslegesen szukitve a bal oszlopot minden NORMAL sorban is,
  // nem csak a patologikus esetben. Ezert ez a teszt a szazalekos erteket
  // is elutasitja -- fix (px/rem/em) korlat kell.
  const blokkok = szabalyBlokkok(kommentNelkul)
  const alap = blokkok.find((b) => b.szelektorok.includes('.crm-tri') && /display:\s*grid/.test(b.torzs))
  assert.ok(alap, '.crm-tri alap szabalynak grid elrendezesnek kell lennie')

  const gridMatch = alap.torzs.match(/grid-template-columns:\s*([^;]+);/)
  assert.ok(gridMatch, '.crm-tri-nek grid-template-columns-t kell deklaralnia')
  const oszlopok = oszlopokra(gridMatch[1])
  assert.equal(oszlopok.length, 2, '.crm-tri pontosan ket oszlopot ad')

  const jobb = oszlopok[1]
  assert.notEqual(jobb, 'auto', 'a jobb oszlop nem lehet korlatlan "auto" -- ez pontosan az F1 regresszios mintazata')
  assert.doesNotMatch(jobb, /^minmax\(0,\s*auto\)$/, 'a jobb oszlop "auto" maximuma ugyanugy korlatlan, akkor is, ha minmax()-ba csomagolva')
  assert.doesNotMatch(jobb, /min\(/, 'a `min()` egy szazalekot es egy max-content kulcsszot keverve ERVENYTELEN grid track-meretkent -- a bongeszo csendben eldobja az egesz deklaraciot, es a regi "auto" hibara esik vissza')
  assert.doesNotMatch(jobb, /%/, 'egy tiszta szazalekos felso korlat a "Maximize Tracks" lepes miatt MINDIG arra a szazalekra hizlalna az oszlopot, akkor is, ha rovid a tartalom -- fix (px/rem/em) korlat kell')
  assert.match(jobb, /\d+(px|rem|em)\)?$/, 'a jobb oszlopnak fix hosszusagu felso korlatot kell viselnie')

  // A <select> es a talalgatas-pill (mindketto tarolt szoveget mutat,
  // mindketto `.crm-btn`-tol orokolt `white-space: nowrap`) onmagaban is
  // szet tudna feszíteni egy mar korlatos oszlopot -- lasd style.css F1
  // kommentjet. Mindkettonek explicit `max-width`-et kell kapnia.
  const selectSzabaly = blokkok.find((b) => b.szelektorok.some((s) => s.includes('.crm-tri-pickers') && s.includes('select')))
  assert.ok(selectSzabaly, 'a .crm-tri-pickers select-nek sajat max-width szabalyt kell kapnia')
  assert.match(selectSzabaly.torzs, /max-width:\s*\d/, 'a select max-width-jenek fix hosszusagunak kell lennie (nem szazalek -- lasd a komment a korkoros fuggosegrol)')

  const guessSzabaly = blokkok.find((b) => b.szelektorok.some((s) => s.includes('.crm-tri-pickers') && s.includes('crm-pill')))
  assert.ok(guessSzabaly, 'a talalgatas-pillnek (.crm-tri-pickers button.crm-pill) sajat max-width szabalyt kell kapnia')
  assert.match(guessSzabaly.torzs, /max-width:\s*\d/, 'a talalgatas-pill max-width-jenek fix hosszusagunak kell lennie')
})
