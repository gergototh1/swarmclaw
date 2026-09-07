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
