import assert from 'node:assert/strict'
import test from 'node:test'

import { bundle } from '../scripts/build.mjs'
import { kovetkezoSzakasz, szakaszCimke, SZAKASZOK, SZAKASZ_NEV } from '../ui/ugyek.tsx'

/**
 * `kovetkezoSzakasz`: a pipeline "Tovább" gombjának célja. A task-8-brief.md
 * szerint egy gomb, ami nem visz sehova (vagy rossz helyre), ugyanaz a hiba,
 * amit ez a projekt már háromszor javított -- ezért ezt a függvényt
 * közvetlenül, a rendertől függetlenül teszteljük minden nem-végállapot
 * szakaszra.
 */
test('minden nem-utolso szakaszra a SZAKASZOK-ban utana kovetkezot adja', () => {
  for (let i = 0; i < SZAKASZOK.length - 1; i += 1) {
    assert.equal(kovetkezoSzakasz(SZAKASZOK[i]), SZAKASZOK[i + 1], `${SZAKASZOK[i]} -> ${SZAKASZOK[i + 1]}`)
  }
})

test('az utolso szakaszon (negotiation) nincs kovetkezo -- onnan a lezaras visz tovabb', () => {
  assert.equal(kovetkezoSzakasz('negotiation'), null)
})

test('ismeretlen szakaszra sincs kovetkezo', () => {
  assert.equal(kovetkezoSzakasz('won'), null)
  assert.equal(kovetkezoSzakasz('nincs-ilyen'), null)
})

/**
 * I6: ez a teszt korabban a `crm-lanehead` / `crm-lanen` STRINGET kereste a
 * bundle-ben -- de az a string a JSX `className`-jeben el, tehat a
 * `.crm-lanehead` CSS-szabaly TELJES torlese is zolden hagyta. A szabalyok
 * torzset most a `test/style.test.mjs` orzi (ott van a stiluslap); itt az
 * marad, amit ez a fajl tud bizonyitani: hogy a fejlec a MAGYAR szakasznevet
 * es az oszlop TENYLEGES darabszamat adja ki, nem egy rogzitett szoveget.
 */
test('minden szakasz-oszlop a magyar szakasznevet es az oszlop darabszamat adja ki', async () => {
  const out = await bundle({ write: false })
  const js = out.outputFiles[0].text
  assert.match(
    js,
    /className:\s*"crm-lanehead",\s*children:\s*\[[\s\S]{0,400}?"h4",\s*\{\s*children:\s*szakaszCimke\(sz\)\s*\}/,
    'az oszlopfejlecnek a szakasz MAGYAR nevet kell mutatnia (szakaszCimke), nem a nyers kulcsot',
  )
  assert.match(
    js,
    /className:\s*"crm-lanen",\s*children:\s*oszlop\.length/,
    'a darabszamnak az oszlop TENYLEGES hosszat kell mutatnia',
  )
})

/**
 * Regresszios teszt az F3 review-talalatra: egy kartyan a "Tovább" (a
 * gyakori, konnyen visszavonhato lepes) volt a halk gomb, a "Nyert" (a
 * ritka, lezaro, nehezen visszavonhato dontes) pedig a hangsulyos primary
 * -- a leglathatobb gomb igy a legritkabb, leginkabb visszafordithatatlan
 * akciora hivott. A `crm-btn-primary` mostantol a "Tovább"-e, a "Nyert" es
 * az "Elvesztett" egyenrangu, halk kezelest kap. A bundle-szoveges teszt
 * a JSX kimenetenek TENYLEGES osztaly-hozzarendeleset vizsgalja, nem csak
 * azt, hogy a stringek szerepelnek valahol.
 */
test('a "Tovabb" a primary gomb, a "Nyert" es az "Elvesztett" egyenrangu, halk gombok', async () => {
  const out = await bundle({ write: false })
  const js = out.outputFiles[0].text

  const tovabbMatch = js.match(/className:\s*"([^"]*)"[^{}]*children:\s*"Tovább"/)
  assert.ok(tovabbMatch, 'nem talalhato a "Tovább" gomb JSX-e a bundle-ben')
  assert.match(tovabbMatch[1], /\bcrm-btn-primary\b/, 'a "Tovább"-nak crm-btn-primary-nak kell lennie')

  const nyertMatch = js.match(/className:\s*"([^"]*)"[^{}]*children:\s*"Nyert"/)
  assert.ok(nyertMatch, 'nem talalhato a "Nyert" gomb JSX-e a bundle-ben')
  assert.doesNotMatch(nyertMatch[1], /\bcrm-btn-primary\b/, 'a "Nyert" nem lehet primary tobbe')
  assert.match(nyertMatch[1], /\bcrm-btn-quiet\b/, 'a "Nyert"-nek halk (quiet) gombnak kell lennie')

  const elvesztettMatch = js.match(/className:\s*"([^"]*)"[^{}]*children:\s*"Elvesztett"/)
  assert.ok(elvesztettMatch, 'nem talalhato az "Elvesztett" gomb JSX-e a bundle-ben')
  assert.match(elvesztettMatch[1], /\bcrm-btn-quiet\b/, 'az "Elvesztett"-nek halk (quiet) gombnak kell maradnia')
})


/**
 * I4: a `SZAKASZ_NEV` szotar korabban NEM volt exportalva, ezert az ugyfel
 * lap ugy-listaja a nyers `stage` erteket mutatta (`new`, `proposal`) --
 * egy sorral a magyar „lezárt" alatt. Ez volt az utolsó angol allapotnev a
 * feluleten. A szotar mostantol exportalt, es a `szakaszCimke` ugyanazt a
 * visszaeses-mintat koveti, mint a `feladatStatuszCimke` es az
 * `esemenyFajtaCimke` (`ugyfel-lap.tsx`).
 */
test('szakaszCimke: ismert szakaszra magyar feliratot ad', () => {
  assert.equal(szakaszCimke('new'), 'Új')
  assert.equal(szakaszCimke('talking'), 'Egyeztetés')
  assert.equal(szakaszCimke('proposal'), 'Ajánlat')
  assert.equal(szakaszCimke('negotiation'), 'Tárgyalás')
  assert.equal(szakaszCimke('won'), 'Nyert')
  assert.equal(szakaszCimke('lost'), 'Elvesztett')
  assert.equal(szakaszCimke('running'), 'Fut')
})

test('szakaszCimke: ismeretlen szakaszra a nyers erteket adja vissza (visszaeses)', () => {
  assert.equal(szakaszCimke('barmi_ismeretlen'), 'barmi_ismeretlen')
  assert.equal(szakaszCimke(''), '')
})

test('a SZAKASZ_NEV minden lepteto szakaszt lefed -- egy uj szakasz nem eshet ki nyersen', () => {
  for (const sz of SZAKASZOK) {
    assert.equal(typeof SZAKASZ_NEV[sz], 'string', `${sz}: hianyzik a magyar felirat`)
    assert.notEqual(SZAKASZ_NEV[sz], sz, `${sz}: a felirat nem lehet maga a nyers kulcs`)
  }
})
