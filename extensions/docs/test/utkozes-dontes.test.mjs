import assert from 'node:assert/strict'
import { test } from 'node:test'

import { dontsUtkozesrol, valaszElavult } from '../ui/utkozes-dontes.ts'

// Önokozott ütközés: masikMentesFolyamatban && !marUjraprobalt -> mindig
// újrapróbáljuk, FÜGGETLENÜL a verziók viszonyától (ez a lényeg: az érkezési
// sorrend és a jelentett verzió nem dönt, csak az, hogy önokozott-e).

test('önokozott, még nem próbáltuk újra, jelentett verzió újabb -> újrapróbál', () => {
  assert.equal(
    dontsUtkozesrol({ masikMentesFolyamatban: true, marUjraprobalt: false, jelenlegiVerzio: 6, jelenlegi: 5 }),
    'ujraprobal',
  )
})

test('önokozott, még nem próbáltuk újra, jelentett verzió egyenlő -> újrapróbál', () => {
  assert.equal(
    dontsUtkozesrol({ masikMentesFolyamatban: true, marUjraprobalt: false, jelenlegiVerzio: 5, jelenlegi: 5 }),
    'ujraprobal',
  )
})

test('önokozott, még nem próbáltuk újra, jelentett verzió régebbi -> újrapróbál (a másik körben elindult, később landolt mentésünk verziója)', () => {
  // Ez a review 2. találatának pontos esete: S1 (régebbi szöveg) előbb landol,
  // a tartott verzió 5-re nő; S2 (újabb szöveg) ütközése 5-öt jelent, ami nem
  // újabb, mint amit már tartunk -- a régi két-lépéses döntés ezt itt eldobta
  // volna a retry-ellenőrzés előtt. Az egylépéses szabály helyesen újrapróbál.
  assert.equal(
    dontsUtkozesrol({ masikMentesFolyamatban: true, marUjraprobalt: false, jelenlegiVerzio: 5, jelenlegi: 5 }),
    'ujraprobal',
  )
})

test('önokozott, de már próbáltuk újra, jelentett verzió újabb -> sáv', () => {
  assert.equal(
    dontsUtkozesrol({ masikMentesFolyamatban: true, marUjraprobalt: true, jelenlegiVerzio: 6, jelenlegi: 5 }),
    'sav',
  )
})

test('önokozott, de már próbáltuk újra, jelentett verzió egyenlő -> eldob', () => {
  assert.equal(
    dontsUtkozesrol({ masikMentesFolyamatban: true, marUjraprobalt: true, jelenlegiVerzio: 5, jelenlegi: 5 }),
    'eldob',
  )
})

test('önokozott, de már próbáltuk újra, jelentett verzió régebbi -> eldob', () => {
  assert.equal(
    dontsUtkozesrol({ masikMentesFolyamatban: true, marUjraprobalt: true, jelenlegiVerzio: 4, jelenlegi: 5 }),
    'eldob',
  )
})

test('nem önokozott, még nem próbáltuk újra, jelentett verzió újabb -> sáv', () => {
  assert.equal(
    dontsUtkozesrol({ masikMentesFolyamatban: false, marUjraprobalt: false, jelenlegiVerzio: 6, jelenlegi: 5 }),
    'sav',
  )
})

test('nem önokozott, még nem próbáltuk újra, jelentett verzió egyenlő -> eldob', () => {
  assert.equal(
    dontsUtkozesrol({ masikMentesFolyamatban: false, marUjraprobalt: false, jelenlegiVerzio: 5, jelenlegi: 5 }),
    'eldob',
  )
})

test('nem önokozott, még nem próbáltuk újra, jelentett verzió régebbi -> eldob', () => {
  assert.equal(
    dontsUtkozesrol({ masikMentesFolyamatban: false, marUjraprobalt: false, jelenlegiVerzio: 4, jelenlegi: 5 }),
    'eldob',
  )
})

test('nem önokozott, már próbáltuk újra, jelentett verzió újabb -> sáv', () => {
  assert.equal(
    dontsUtkozesrol({ masikMentesFolyamatban: false, marUjraprobalt: true, jelenlegiVerzio: 6, jelenlegi: 5 }),
    'sav',
  )
})

test('nem önokozott, már próbáltuk újra, jelentett verzió egyenlő -> eldob', () => {
  assert.equal(
    dontsUtkozesrol({ masikMentesFolyamatban: false, marUjraprobalt: true, jelenlegiVerzio: 5, jelenlegi: 5 }),
    'eldob',
  )
})

test('nem önokozott, már próbáltuk újra, jelentett verzió régebbi -> eldob', () => {
  assert.equal(
    dontsUtkozesrol({ masikMentesFolyamatban: false, marUjraprobalt: true, jelenlegiVerzio: 4, jelenlegi: 5 }),
    'eldob',
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
