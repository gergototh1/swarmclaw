import assert from 'node:assert/strict'
import { test } from 'node:test'

import { dontsUjraprobalni, utkozesElavult, valaszElavult } from '../ui/utkozes-dontes.ts'

test('másik mentés volt folyamatban, és még nem próbáltuk újra: igen', () => {
  assert.equal(
    dontsUjraprobalni({ masikMentesFolyamatban: true, marUjraprobalt: false }),
    true,
  )
})

test('másik mentés volt folyamatban, de már próbáltuk újra: nem', () => {
  assert.equal(
    dontsUjraprobalni({ masikMentesFolyamatban: true, marUjraprobalt: true }),
    false,
  )
})

test('nem volt másik mentés folyamatban, és még nem próbáltuk újra: nem', () => {
  assert.equal(
    dontsUjraprobalni({ masikMentesFolyamatban: false, marUjraprobalt: false }),
    false,
  )
})

test('nem volt másik mentés folyamatban, és már próbáltuk újra: nem', () => {
  assert.equal(
    dontsUjraprobalni({ masikMentesFolyamatban: false, marUjraprobalt: true }),
    false,
  )
})

test('siker válasz: újabb verzió -> nem elavult, alkalmazzuk', () => {
  assert.equal(valaszElavult({ uj: 5, jelenlegi: 4 }), false)
})

test('siker válasz: egyenlő verzió -> elavult', () => {
  assert.equal(valaszElavult({ uj: 4, jelenlegi: 4 }), true)
})

test('siker válasz: régebbi verzió -> elavult', () => {
  assert.equal(valaszElavult({ uj: 3, jelenlegi: 4 }), true)
})

test('siker válasz: nincs verziószám -> nem elavult, alkalmazzuk', () => {
  assert.equal(valaszElavult({ uj: undefined, jelenlegi: 4 }), false)
})

test('ütközés: újabb jelenlegiVerzio -> nem elavult', () => {
  assert.equal(utkozesElavult({ jelenlegiVerzio: 5, jelenlegi: 4 }), false)
})

test('ütközés: egyenlő jelenlegiVerzio -> elavult', () => {
  assert.equal(utkozesElavult({ jelenlegiVerzio: 4, jelenlegi: 4 }), true)
})

test('ütközés: régebbi jelenlegiVerzio -> elavult', () => {
  assert.equal(utkozesElavult({ jelenlegiVerzio: 3, jelenlegi: 4 }), true)
})
