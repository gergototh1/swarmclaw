import assert from 'node:assert/strict'
import test from 'node:test'

import { bundle } from '../scripts/build.mjs'
import { kovetkezoSzakasz, SZAKASZOK } from '../ui/ugyek.tsx'

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

test('minden szakasz-oszlop fejlecet es darabszamot visel', async () => {
  const out = await bundle({ write: false })
  const js = out.outputFiles[0].text
  assert.match(js, /crm-lanehead/, 'hianyzik az oszlopfejlec')
  assert.match(js, /crm-lanen/, 'hianyzik a darabszam az oszlopfejlecben')
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
