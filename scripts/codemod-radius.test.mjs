import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mapRadiusClass } from './codemod-radius.mjs'

test('pixel radii collapse onto the five-step scale', () => {
  assert.equal(mapRadiusClass('rounded-[4px]'), 'rounded-xs')
  assert.equal(mapRadiusClass('rounded-[7px]'), 'rounded-xs')
  assert.equal(mapRadiusClass('rounded-[8px]'), 'rounded-sm')
  assert.equal(mapRadiusClass('rounded-[10px]'), 'rounded-sm')
  assert.equal(mapRadiusClass('rounded-[11px]'), 'rounded-md')
  assert.equal(mapRadiusClass('rounded-[14px]'), 'rounded-md')
  assert.equal(mapRadiusClass('rounded-[16px]'), 'rounded-lg')
  assert.equal(mapRadiusClass('rounded-[24px]'), 'rounded-lg')
})

test('anything at or above 999px is a pill', () => {
  assert.equal(mapRadiusClass('rounded-[999px]'), 'rounded-full')
  assert.equal(mapRadiusClass('rounded-[9999px]'), 'rounded-full')
})

test('side and corner variants keep their side', () => {
  assert.equal(mapRadiusClass('rounded-t-[12px]'), 'rounded-t-md')
  assert.equal(mapRadiusClass('rounded-bl-[8px]'), 'rounded-bl-sm')
  assert.equal(mapRadiusClass('hover:rounded-[16px]'), 'hover:rounded-lg')
  assert.equal(mapRadiusClass('sm:rounded-tr-[6px]'), 'sm:rounded-tr-xs')
})

test('non-pixel and non-radius classes are refused', () => {
  assert.equal(mapRadiusClass('rounded-[50%]'), null)
  assert.equal(mapRadiusClass('rounded-[var(--r)]'), null)
  assert.equal(mapRadiusClass('rounded-full'), null)
  assert.equal(mapRadiusClass('bg-[10px]'), null)
})

test('a radius of zero is refused rather than rounded up', () => {
  assert.equal(mapRadiusClass('rounded-[0px]'), null)
})
