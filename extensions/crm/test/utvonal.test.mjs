import assert from 'node:assert/strict'
import test from 'node:test'

import { alapHely, helyAzUtbol, utAHelybol } from '../ui/utvonal.ts'

test('a gyökér a Ma nézet', () => {
  assert.deepEqual(helyAzUtbol(''), { nezet: 'ma' })
})

test('ismeretlen útvonal a Ma nézetre esik vissza, nem üres lapra', () => {
  assert.deepEqual(helyAzUtbol('nincs-ilyen/x'), { nezet: 'ma' })
})

test('a lista és az ügyek saját útvonalat kapnak', () => {
  assert.deepEqual(helyAzUtbol('ugyfelek'), { nezet: 'ugyfelek', accountId: null })
  assert.deepEqual(helyAzUtbol('ugyek'), { nezet: 'ugyek' })
})

test('az ügyféllap az ügyfél azonosítóját hordozza, kódolva is', () => {
  assert.deepEqual(helyAzUtbol('ugyfelek/acc_1'), { nezet: 'ugyfelek', accountId: 'acc_1' })
  assert.deepEqual(helyAzUtbol('ugyfelek/a%20b'), { nezet: 'ugyfelek', accountId: 'a b' })
})

test('hibás kódolás a listára visz, nem dob', () => {
  assert.deepEqual(helyAzUtbol('ugyfelek/%E0%A4%A'), { nezet: 'ugyfelek', accountId: null })
})

test('oda-vissza: minden hely ugyanarra az útvonalra képződik, amiből jött', () => {
  for (const ut of ['', 'ugyfelek', 'ugyfelek/acc_1', 'ugyfelek/a%20b', 'ugyek']) {
    assert.equal(utAHelybol(helyAzUtbol(ut)), ut)
  }
})

test('a fülek a nézet gyökerére visznek', () => {
  assert.deepEqual(alapHely('ma'), { nezet: 'ma' })
  assert.deepEqual(alapHely('ugyfelek'), { nezet: 'ugyfelek', accountId: null })
  assert.deepEqual(alapHely('ugyek'), { nezet: 'ugyek' })
})
