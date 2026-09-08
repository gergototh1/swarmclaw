import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import { bundle } from '../scripts/build.mjs'

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

/**
 * A tiltas a stiluslapra ES a JS bundle-re is all: egy betut nem csak
 * `@font-face`-szel lehet betolteni. Egy `new FontFace(...)`, egy
 * `document.fonts.add(...)`, egy dinamikusan beszurt `<link rel="stylesheet"
 * href="https://fonts.googleapis.com/...">` vagy egy `@import` egy JS-bol
 * injektalt stilusban ugyanugy halozati betut hoz -- es ezek egyike sem
 * latszik a CSS-fajlban, tehat a fenti teszt egyiket sem venne eszre.
 */
test('a JS bundle sem tolt be betutipust', async () => {
  const out = await bundle({ write: false })
  const js = out.outputFiles[0].text
  for (const minta of [/fonts\.googleapis/, /fonts\.gstatic/, /@font-face/, /new FontFace/, /document\.fonts/]) {
    assert.equal(minta.test(js), false, `a bundle betut tolt be: ${minta}`)
  }
})

/**
 * A `--status-*` token-csalad tiltasat eddig CSAK egy komment orizte a
 * style.css tetejen -- egy kommentet semmi nem kenyszerit ki. A tiltas oka
 * ott olvashato: a hoszt statusz-jelentesei (fut / hiba / tetlen) nem esnek
 * egybe a CRM trigger-tipusaival, es egy nema ugy `--status-idle`-kent olyan
 * egyenertekuseget allitana, ami nem igaz. Ez a teszt a szabalyt magat
 * ellenorzi, nem a rola szolo mondatot.
 */
test('a lap egyetlen hoszt `--status-*` tokent sem hasznal', () => {
  const talalatok = [...kommentNelkul.matchAll(/var\(\s*(--status-[a-z0-9-]+)/g)].map((m) => m[1])
  assert.deepEqual([...new Set(talalatok)], [], 'a --status-* csalad jelentesei nem esnek egybe a CRM trigger-tipusaival')
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
  const oszlopok = oszlopokra(gridMatch[1])
  assert.equal(oszlopok.length, 2, 'a grid-template-columns pontosan ket oszlopot kell megadjon')

  // C1: mindket hasab minimuma 0 -- kulonben egy hosszu tarolt szo (ugycim,
  // targy, email-torzs) az egyik hasab min-contentjen keresztul szetfeszitene
  // a masikat, es a lap oldalra gordulne. Ez ugyanaz az invarians, amit a
  // `.crm-tri` es a `.crm-acct` tesztje kovetel meg lentebb.
  for (const oszlop of oszlopok) {
    assert.match(oszlop, /^minmax\(\s*0\s*,/, `a .crm-cols savjai korlatosak kell legyenek, ez nem az: ${oszlop}`)
  }
})

/**
 * I6: az `ugyfel-lap.test.mjs` korabban a `crm-cols` STRING jelenletet
 * kereste a bundle-ben -- de az a string a JSX `className`-jeben el, tehat a
 * media query TELJES torlese is zolden hagyta a csomagot. A 860px alatti
 * egyhasabos osszeomlas (es a benne rogzitett terulet-sorrend: Osszefoglalo,
 * majd a checks kartyak, majd az Idovonal) magaban a stiluslapban el, tehat
 * itt a helye.
 */
test('a .crm-cols 860px alatt EGY hasabra omlik, es megtartja a terulet-sorrendet', () => {
  const blokkok = szabalyBlokkok(kommentNelkul)
  const colsSzabalyok = blokkok.filter((b) => b.szelektorok.includes('.crm-cols'))
  assert.equal(colsSzabalyok.length, 2, 'a .crm-cols-nak az alap mellett pontosan egy media-query valtozata van')

  const szuk = colsSzabalyok[1]
  const szukGrid = szuk.torzs.match(/grid-template-columns:\s*([^;]+);/)
  assert.ok(szukGrid, 'a szuk .crm-cols szabalynak grid-template-columns-t kell deklaralnia')
  assert.equal(oszlopokra(szukGrid[1]).length, 1, '860px alatt egyetlen hasab marad')

  const teruletek = szuk.torzs.match(/grid-template-areas:\s*([^;]+);/)
  assert.ok(teruletek, 'a szuk .crm-cols szabalynak at kell rendeznie a teruleteket')
  assert.deepEqual(
    [...teruletek[1].matchAll(/"([^"]+)"/g)].map((m) => m[1].trim()),
    ['summary', 'checks', 'timeline'],
    'a hosszu idovonal nem kerulhet az ellenorizendo kartyak fole',
  )

  // A media query maga 860px -- a `szabalyBlokkok` az at-szabalyt nem adja
  // vissza, ezert a preludiumot kulon keressuk a nyers (komment nelkuli)
  // szovegben, a `.crm-cols` blokk elott.
  assert.match(kommentNelkul, /@media\s*\(max-width:\s*860px\)\s*\{[^@]*?\.crm-cols\s*\{/,
    'az egyhasabos osszeomlast egy 860px-es media query-nek kell hoznia')
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

  // I1: a fenti allitasok a javitas ALAKJAT irjak le, nem azt a
  // tulajdonsagat, amitol mukodik. Mertem: a `minmax(0, 380px)`-et
  // `minmax(0, 2000px)`-re cserelve MINDEN fenti allitas atmegy (fix
  // hosszusag, nem auto, nem min(), nem %) -- 900px-es nezetben viszont a
  // regi hiba pontosan visszater: a bal savot 0px-re nyomja, a
  // `.crm-tri-who` 1017px magas, egy-karakteres sorokra tordelt oszlop lesz.
  // Egy felso korlat, ami nagyobb minden realis nezetnel, nem korlat.
  // A ceg a `.crm-tri-pickers` sajat max-width-jeibol jon: a select 220px +
  // a pill 260px + a koztuk levo 7px gap = 487px az az elmeleti maximum,
  // amit ez az oszlop egyaltalan hasznalni tud egy sorban.
  const jobbPx = Number(jobb.match(/(\d+(?:\.\d+)?)px\)?$/)?.[1])
  assert.ok(Number.isFinite(jobbPx), `a felso korlatot px-ben kell megadni, hogy merheto legyen: ${jobb}`)
  assert.ok(
    jobbPx <= 500,
    `a jobb oszlop felso korlatja (${jobbPx}px) nagyobb, mint amit a benne allo `
    + 'select (220px) es pill (260px) egyaltalan igenyelhet -- egy ilyen "korlat" '
    + 'a keskeny nezetekben ugyanugy 0px-re nyomja a bal (kuldo/targy) oszlopot, '
    + 'mint a regi `auto`',
  )

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


/* ---------------------------------------------------------------------- *
 * C1: tarolt szoveg sosem eheztetheti ki a sajat savjat, es sosem tolhat
 * semmit a kepernyorol.
 * ---------------------------------------------------------------------- */

/**
 * A tordeles OSZTALY-szintu szabaly: a `.crm-app` gyokeren all, es
 * oroklodik. A korabbi, dobozonkenti felsorolas ketszer maradt hianyos
 * (eloszor a `.crm-tri-who`, aztan az Ugyfelek domain-listaja), es a
 * hianyzo doboz mindketszer ugyanazt az osszeomlast hozta vissza. Ez a
 * teszt a gyokerszabalyt koveteli meg -- torlese eseten hiaba marad ott
 * barmelyik dobozonkenti masolat.
 */
test('az `overflow-wrap: anywhere` a .crm-app gyokeren all, tehat MINDEN leszarmazott orokli', () => {
  const blokkok = szabalyBlokkok(kommentNelkul)
  const app = blokkok.find((b) => b.szelektorok.includes('.crm-app'))
  assert.ok(app, 'a .crm-app szabalynak leteznie kell')
  assert.match(
    app.torzs, /overflow-wrap:\s*anywhere/,
    'a tordelesnek a gyokeren kell allnia -- dobozonkent felsorolva ketszer maradt ki egy doboz',
  )
})

/**
 * Minden grid, ami tarolt szoveget allit egy tartalombol meretezett
 * szomszed melle. A szoveg savja `minmax(0, ...)` (a min-contentje sosem
 * kenyszerithet ra semmit a szomszedra), a szomszed pedig vagy fix felso
 * korlatot visel, vagy `auto` -- de akkor csakis statikus magyar felirattal
 * (gombsav), nem tarolt szoveggel.
 */
test('minden tarolt szoveget tarto grid-sav korlatos (minmax(0, ...))', () => {
  const blokkok = szabalyBlokkok(kommentNelkul)
  // Szelektor -> a savok, amiknek `minmax(0, ...)`-nak KELL lenniuk (index szerint).
  const elvart = {
    '.crm-attrow': [1],          // 3px | szoveg | gombsav
    '.crm-tlitem': [1],          // sin | torzs
    '.crm-tri': [0, 1],          // kuldo/targy | pickers
    '.crm-acct': [0],            // nev | domain-lista (sajat max-width) | pill
    '.crm-cols': [0, 1],         // osszefoglalo/idovonal | checks
  }
  for (const [szelektor, indexek] of Object.entries(elvart)) {
    const szabaly = blokkok.find((b) => b.szelektorok.includes(szelektor) && /grid-template-columns:/.test(b.torzs))
    assert.ok(szabaly, `${szelektor}: nincs grid-template-columns deklaracio`)
    const oszlopok = oszlopokra(szabaly.torzs.match(/grid-template-columns:\s*([^;]+);/)[1])
    for (const i of indexek) {
      assert.match(
        oszlopok[i] ?? '', /^minmax\(\s*0\s*,/,
        `${szelektor} ${i}. savja nem korlatos: ${oszlopok[i]} -- egy hosszu tarolt szo `
        + 'a szomszedjan keresztul 0px-re nyomhatja, vagy oldalra gordulhet tole a lap',
      )
    }
  }
})

/**
 * A domain-lista FIX felso korlatot visel -- kulonben a `.crm-acct` eredeti
 * hibaja ter vissza: a lista a sajat (korlatlan) max-contentjere nott, es a
 * nevsav 0px-re esett. Mertem 1400px-en egy 215 karakteres domainnel:
 * nevsav 0px, `document.scrollWidth` 1877 egy 1400-as nezetben.
 *
 * A korlat MAGAN AZ ELEMEN all, nem a savon -- ugyanaz a minta, mint a
 * `.crm-tri-pickers select`-nel. A domain-lista ugyanis FELTETELES: domain
 * nelkuli ugyfelnel csak ket grid-elem van, es egy `minmax(0, 260px)` SAV
 * ilyenkor a statusz-pillt fogadna be es 260px szelesre nyujtana (mertem:
 * 8 sorbol 2 sor pillje lett 260px szeles) -- vagyis a sav-korlat az I5
 * hibajat hozta volna vissza a sajat, szukebb valtozataban.
 */
test('a .crm-acct domain-listaja fix felso korlatot visel, nem no a tartalommal', () => {
  const blokkok = szabalyBlokkok(kommentNelkul)
  const szabaly = blokkok.find((b) => b.szelektorok.includes('.crm-acct') && /grid-template-columns:/.test(b.torzs))
  const oszlopok = oszlopokra(szabaly.torzs.match(/grid-template-columns:\s*([^;]+);/)[1])
  assert.equal(oszlopok.length, 3, 'a .crm-acct harom savot ad: nev, domain-lista, statusz-pill')

  const dom = blokkok.find((b) => b.szelektorok.includes('.crm-acct-dom'))
  assert.ok(dom, 'a domain-listanak sajat, korlatozhato osztalyt kell viselnie (.crm-acct-dom)')
  const px = Number(dom.torzs.match(/max-width:\s*(\d+(?:\.\d+)?)px/)?.[1])
  assert.ok(Number.isFinite(px), `a domain-lista max-width-jenek fix (px) hosszusagunak kell lennie: ${dom.torzs.trim()}`)
  assert.ok(px <= 400, `a domain-lista felso korlatja (${px}px) tul nagy ahhoz, hogy korlat legyen`)
})

/**
 * I5: 640px alatt a `.crm-acct` KET savra esett, mikozben HAROM grid-eleme
 * van -- a statusz-pill igy a masodik sor `1fr` savjaba csuszott, es a grid
 * alapertelmezett `stretch` igazitasa miatt teljes szelessegu savva nyult.
 * Mertem 520px-en: 311px / 350px / 296px szeles "pillek". A domain nelkuli
 * sorok helyesek maradtak, ezert volt konnyu nem eszrevenni.
 */
test('a .crm-acct 640px alatt EGY savra esik, es az elemei nem nyulnak teljes szelessegure', () => {
  const blokkok = szabalyBlokkok(kommentNelkul)
  const acctSzabalyok = blokkok.filter((b) => b.szelektorok.includes('.crm-acct') && /grid-template-columns:/.test(b.torzs))
  assert.equal(acctSzabalyok.length, 2, 'a .crm-acct-nak az alap mellett pontosan egy media-query valtozata van')

  const szuk = acctSzabalyok[1]
  const oszlopok = oszlopokra(szuk.torzs.match(/grid-template-columns:\s*([^;]+);/)[1])
  assert.equal(
    oszlopok.length, 1,
    'ket sav harom elemhez: a harmadik elem (a statusz-pill) egy `1fr` savba csuszik, es teljes szelessegu savva nyulik',
  )
  assert.match(
    szuk.torzs, /justify-items:\s*start/,
    'egy oszlopban a grid alapertelmezett `stretch`-e a pillt savva nyujtana -- `justify-items: start` kell',
  )
  assert.match(kommentNelkul, /@media\s*\(max-width:\s*640px\)\s*\{[^@]*?\.crm-acct\s*\{/,
    'az egysavos osszeomlast egy 640px-es media query-nek kell hoznia')
})

/* ---------------------------------------------------------------------- *
 * C2: a jelentest hordozo szoveg mindket temaban olvashato.
 * ---------------------------------------------------------------------- */

/**
 * A `--color-text-3` a hoszt VILAGOS temajaban `#6b7280`, ami a lap
 * kartyain 4.13:1-et, a lap hatteren 3.97:1-et ad -- mindketto a WCAG AA
 * 4.5:1 kuszobe alatt, es a lap minden szovege 11-13.5px, tehat a nagy
 * szovegre vonatkozo konnyites nem all. A `--color-text-2` ugyanott 6.42:1
 * / 6.16:1. A `-3` ezert innentol CSAK diszkent (hatter, keret) allhat, ahol
 * nincs olvasando betu -- ezt a teszt szelektor-fuggetlenul kenyszeriti ki:
 * eleg egyetlen `color:` deklaracioban megjelennie, es bukik.
 */
test('a --color-text-3 sehol nem szovegszin (vilagos temaban 4.5:1 ala esne)', () => {
  const szovegkent = [...kommentNelkul.matchAll(/(^|[;{])\s*color:\s*([^;}]*)/g)]
    .map((m) => m[2])
    .filter((ertek) => /--color-text-3/.test(ertek))
  assert.deepEqual(
    szovegkent, [],
    'a --color-text-3 vilagos temaban 4.5:1 alatti szoveget ad -- diszkent (hatter/keret) hasznalhato, betukent nem',
  )
})

/**
 * A negy jelentes-pill, a `.crm-elavult` es a `.crm-hiba` szovegszine a sajat
 * tokenjet a `--color-text` FELE keveri, nem a fehér (`--color-accent-
 * foreground`) fele es nem tisztan a tokent hasznalja. Ez az az egy
 * keveresi irany, ami MINDKET temaban a hattertol elfele mozdul: a szoveg a
 * tema sajat elotérszine fele halad. A merteket lasd a style.css
 * kommentjeiben; a szamok (vilagos / sotet):
 *   .crm-pill-sajat  5.37 / 6.10    .crm-pill-valasz 5.28 / 11.18
 *   .crm-pill-nema   5.98 / 5.71    .crm-pill-ok     5.35 / 9.85
 *   .crm-elavult     5.50 / 13.31   .crm-hiba        5.32 / 6.40
 * A korabbi ertekek: 3.56 / 1.37 / 2.22 / 2.88 / 1.43 / 3.53 (vilagos).
 */
test('minden jelentest hordozo szinesszoveg a --color-text fele keverve all', () => {
  const blokkok = szabalyBlokkok(kommentNelkul)
  for (const szelektor of ['.crm-pill-sajat', '.crm-pill-valasz', '.crm-pill-nema', '.crm-pill-ok', '.crm-elavult', '.crm-hiba']) {
    const szabaly = blokkok.find((b) => b.szelektorok.includes(szelektor) && /(^|[;{])\s*color:/.test(b.torzs))
    assert.ok(szabaly, `${szelektor}: nincs color deklaracio`)
    const ertek = szabaly.torzs.match(/(?:^|[;{])\s*color:\s*([^;}]+)/)[1]
    assert.match(
      ertek, /color-mix\(in srgb,[\s\S]*var\(--color-text\b/,
      `${szelektor} szovegszine nem a --color-text fele keveredik: ${ertek.trim()} -- `
      + 'a tiszta tokenszin (vagy a feher fele keveres) vilagos temaban 4.5:1 ala esik',
    )
  }
})

/**
 * A jelzes-szin viszont NEM tunhet el: a csik, a keret es a hatter-tint
 * tovabbra is tiszta tokenszint tart. Enelkul a fenti javitas ugy oldana meg
 * az olvashatosagot, hogy kozben elveszi a szinbeli jelzest -- pont azt,
 * amiert a pill szines.
 */
test('a pillek hattere es kerete tiszta tokenszin marad -- a jelzes nem tunik el', () => {
  const blokkok = szabalyBlokkok(kommentNelkul)
  const vart = {
    '.crm-pill-sajat': '--color-danger',
    '.crm-pill-valasz': '--color-warning',
    '.crm-pill-nema': '--color-accent',
    '.crm-pill-ok': '--color-success',
  }
  for (const [szelektor, token] of Object.entries(vart)) {
    const szabaly = blokkok.find((b) => b.szelektorok.includes(szelektor))
    for (const tulajdonsag of ['background', 'border-color']) {
      const ertek = szabaly.torzs.match(new RegExp(`(?:^|[;{])\\s*${tulajdonsag}:\\s*([^;}]+)`))
      assert.ok(ertek, `${szelektor}: hianyzik a ${tulajdonsag}`)
      assert.match(
        ertek[1], new RegExp(`color-mix\\(in srgb,\\s*var\\(${token}\\b`),
        `${szelektor} ${tulajdonsag}-janak a sajat jelzes-tokenjebol (${token}) kell kevernie`,
      )
    }
  }
})

/* ---------------------------------------------------------------------- *
 * I6: szabaly-torzsek, amiket korabban csak a bundle-ben szereplo
 * className-string "orzott".
 * ---------------------------------------------------------------------- */

/**
 * Az `ugyek.test.mjs` a `crm-lanehead` / `crm-lanen` STRINGET kereste a
 * bundle-ben -- de az a string a JSX `className`-jeben el, tehat a
 * `.crm-lanehead` CSS-szabaly TELJES torlese is zolden hagyta a csomagot.
 * Amit az a teszt allitott vedeni (a szakasz-oszlop fejlece egy sorban all,
 * a darabszam a sor vegen), az itt, a stiluslapban el.
 */
test('a .crm-lanehead egy soros fejlec, a .crm-lanen a sor vegere kerul', () => {
  const blokkok = szabalyBlokkok(kommentNelkul)
  const fejlec = blokkok.find((b) => b.szelektorok.includes('.crm-lanehead'))
  assert.ok(fejlec, 'a .crm-lanehead szabalynak leteznie kell')
  assert.match(fejlec.torzs, /display:\s*flex/, 'a fejlec egy sorban all')
  assert.match(fejlec.torzs, /align-items:\s*center/, 'a csik, a cim es a darabszam egy alapvonalon')

  const darab = blokkok.find((b) => b.szelektorok.includes('.crm-lanen'))
  assert.ok(darab, 'a .crm-lanen szabalynak leteznie kell')
  assert.match(darab.torzs, /margin-left:\s*auto/, 'a darabszam a fejlec vegere kerul')
})

/**
 * Ugyanaz a mintazat az `ugyfel-lap.test.mjs` `crm-tl-out` allitasara: az
 * idovonal IRANYT jelol, es ezt egy csomopont-keret szine mondja el. A
 * string a bundle-ben akkor is ott van, ha a szabaly nincs.
 */
test('az idovonal csomopontja iranyt jelol: a kimeno level mas keretszint kap', () => {
  const blokkok = szabalyBlokkok(kommentNelkul)
  const alap = blokkok.find((b) => b.szelektorok.includes('.crm-tlnode'))
  assert.ok(alap, 'a .crm-tlnode szabalynak leteznie kell')
  assert.match(alap.torzs, /border:\s*2px solid var\(--color-accent/, 'a bejovo esemeny az akcent keretet viseli')

  const ki = blokkok.find((b) => b.szelektorok.some((sz) => sz === '.crm-tl-out .crm-tlnode'))
  assert.ok(ki, 'a .crm-tl-out .crm-tlnode szabalynak leteznie kell')
  assert.match(ki.torzs, /border-color:\s*var\(--color-success/, 'a kimeno level a siker keretet viseli')

  const jegyzet = blokkok.find((b) => b.szelektorok.some((sz) => sz === '.crm-tl-note .crm-tlnode'))
  assert.ok(jegyzet, 'a .crm-tl-note .crm-tlnode szabalynak leteznie kell')
  assert.match(jegyzet.torzs, /border-color:\s*var\(--color-text-3/, 'a jegyzet semleges keretet visel')
})

/**
 * Es az `ui.test.mjs` `crm-accts` / `crm-pill-*` allitasaira: az ugyfellista
 * fuggoleges lista, a pillek pedig valodi chipek (kerekitett, nem tordelo,
 * sajat kerettel) -- e nelkul a "statusz pillt kap" allitas csak annyit
 * mondana, hogy a string szerepel valahol a bundle-ben.
 */
test('a .crm-accts fuggoleges lista, a .crm-pill valodi chip', () => {
  const blokkok = szabalyBlokkok(kommentNelkul)
  const lista = blokkok.find((b) => b.szelektorok.includes('.crm-accts'))
  assert.ok(lista, 'a .crm-accts szabalynak leteznie kell')
  assert.match(lista.torzs, /display:\s*flex/)
  assert.match(lista.torzs, /flex-direction:\s*column/, 'az ugyfelek egymas alatt allnak')
  assert.match(lista.torzs, /list-style:\s*none/, 'a hoszt lista-pontjai nem latszanak')

  const pill = blokkok.find((b) => b.szelektorok.includes('.crm-pill'))
  assert.ok(pill, 'a .crm-pill szabalynak leteznie kell')
  assert.match(pill.torzs, /border-radius:\s*999px/, 'a pill teljesen kerekitett chip')
  assert.match(pill.torzs, /white-space:\s*nowrap/, 'a rovid statusz-cimke nem torik ket sorba')
  assert.match(pill.torzs, /border:\s*1px solid/, 'a pill sajat kerettel valik el a hatteretol')
})

/**
 * Egy osztaly, amit senki nem hasznal, hazugsag: ugy nez ki, mint egy
 * dontes, kozben halott kod. A `.crm-spacer` es a `.crm-strip-good` ilyen
 * volt. Ez a teszt a stiluslap MINDEN `crm-` osztalyat osszeveti a bundle-ben
 * ténylegesen kiadott `className`-ekkel.
 */
test('a stiluslap egyetlen osztalya sem halott -- mindegyiket hasznalja a bundle', async () => {
  const out = await bundle({ write: false })
  const js = out.outputFiles[0].text
  const osztalyok = [...new Set([...kommentNelkul.matchAll(/\.(crm-[a-z0-9-]+)/g)].map((m) => m[1]))]
  const nemHasznalt = osztalyok.filter((o) => !new RegExp(`\\b${o}\\b`).test(js))
  assert.deepEqual(nemHasznalt, [], 'ezeket az osztalyokat semmi nem adja ki -- torolni kell oket, vagy hasznalni')
})
