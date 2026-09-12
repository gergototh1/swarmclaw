import assert from 'node:assert/strict'
import { test } from 'node:test'

import { dontsUtkozesrol, valaszElavult } from '../ui/utkozes-dontes.ts'

test('jelentett verzió újabb -> sáv', () => {
  assert.equal(dontsUtkozesrol({ jelenlegiVerzio: 6, jelenlegi: 5 }), 'sav')
})

test('jelentett verzió egyenlő -> eldob', () => {
  assert.equal(dontsUtkozesrol({ jelenlegiVerzio: 5, jelenlegi: 5 }), 'eldob')
})

test('jelentett verzió régebbi -> eldob', () => {
  assert.equal(dontsUtkozesrol({ jelenlegiVerzio: 4, jelenlegi: 5 }), 'eldob')
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
