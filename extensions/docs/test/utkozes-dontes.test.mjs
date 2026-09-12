import assert from 'node:assert/strict'
import { test } from 'node:test'

import { dontsUjraprobalni } from '../ui/utkozes-dontes.ts'

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
