import assert from 'node:assert/strict'
import test from 'node:test'

import { doksiIdAzUtbol, utADoksihoz } from '../ui/utvonal.ts'

test('a gyökéren nincs nyitott doksi', () => {
  assert.equal(doksiIdAzUtbol(''), null)
  assert.equal(utADoksihoz(null), '')
})

test('az első szegmens a doksi azonosítója', () => {
  assert.equal(doksiIdAzUtbol('doc_1a2b3c4d'), 'doc_1a2b3c4d')
  assert.equal(doksiIdAzUtbol('doc_1a2b3c4d/'), 'doc_1a2b3c4d')
})

test('oda-vissza kódol, ha az azonosító nem URL-biztos', () => {
  assert.equal(utADoksihoz('a/b c'), 'a%2Fb%20c')
  assert.equal(doksiIdAzUtbol(utADoksihoz('a/b c')), 'a/b c')
})

test('hibás kódolásnál nincs nyitott doksi, nem dob', () => {
  assert.equal(doksiIdAzUtbol('%E0%A4%A'), null)
})
