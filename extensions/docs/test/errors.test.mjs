import assert from 'node:assert/strict'
import test from 'node:test'

import { DocsError, HIBA, hiba } from '../src/errors.mjs'

test('DocsError carries a code from the table', () => {
  const err = new DocsError(HIBA.gyoker_nem_irhato, 'A doksi-gyökér nem írható: /tmp/x')
  assert.ok(err instanceof Error)
  assert.equal(err.code, 'gyoker_nem_irhato')
  assert.equal(err.message, 'A doksi-gyökér nem írható: /tmp/x')
})

test('hiba() builds the tool response shape', () => {
  assert.deepEqual(hiba(HIBA.nincs_jog, 'Ebbe a mappába nem írhatsz.'), {
    hiba: 'nincs_jog',
    uzenet: 'Ebbe a mappába nem írhatsz.',
  })
})

test('the code table is frozen and every value equals its key', () => {
  assert.ok(Object.isFrozen(HIBA))
  for (const [key, value] of Object.entries(HIBA)) assert.equal(value, key)
})
