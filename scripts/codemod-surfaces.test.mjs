import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mapWhiteAlphaClass } from './codemod-surfaces.mjs'

test('background alphas map onto the four-step surface ladder', () => {
  assert.equal(mapWhiteAlphaClass('bg-white/[0.01]'), 'bg-layer-1')
  assert.equal(mapWhiteAlphaClass('bg-white/[0.03]'), 'bg-layer-1')
  assert.equal(mapWhiteAlphaClass('bg-white/[0.04]'), 'bg-layer-2')
  assert.equal(mapWhiteAlphaClass('bg-white/[0.06]'), 'bg-layer-2')
  assert.equal(mapWhiteAlphaClass('bg-white/[0.07]'), 'bg-layer-3')
  assert.equal(mapWhiteAlphaClass('bg-white/[0.12]'), 'bg-layer-3')
  assert.equal(mapWhiteAlphaClass('bg-white/[0.13]'), 'bg-layer-4')
  assert.equal(mapWhiteAlphaClass('bg-white/[0.2]'), 'bg-layer-4')
})

test('border and divide alphas share the line ladder', () => {
  assert.equal(mapWhiteAlphaClass('border-white/[0.04]'), 'border-line-subtle')
  assert.equal(mapWhiteAlphaClass('border-white/[0.10]'), 'border-line-default')
  assert.equal(mapWhiteAlphaClass('border-white/[0.2]'), 'border-line-strong')
  assert.equal(mapWhiteAlphaClass('divide-white/[0.06]'), 'divide-line-subtle')
  assert.equal(mapWhiteAlphaClass('ring-white/[0.15]'), 'ring-line-strong')
})

test('text alphas map onto the three foreground tokens', () => {
  assert.equal(mapWhiteAlphaClass('text-white/[0.9]'), 'text-fg-1')
  assert.equal(mapWhiteAlphaClass('text-white/[0.6]'), 'text-fg-2')
  assert.equal(mapWhiteAlphaClass('text-white/[0.3]'), 'text-fg-3')
})

test('variant prefixes are preserved', () => {
  assert.equal(mapWhiteAlphaClass('hover:bg-white/[0.06]'), 'hover:bg-layer-2')
  assert.equal(mapWhiteAlphaClass('dark:hover:border-white/[0.04]'), 'dark:hover:border-line-subtle')
})

test('an unmappable class returns null instead of a guess', () => {
  assert.equal(mapWhiteAlphaClass('bg-white/[0.5]'), null)
  assert.equal(mapWhiteAlphaClass('bg-white'), null)
  assert.equal(mapWhiteAlphaClass('shadow-white/[0.04]'), null)
  assert.equal(mapWhiteAlphaClass('bg-black/[0.04]'), null)
})

test('directional border/divide forms map onto the same line ladder', () => {
  assert.equal(mapWhiteAlphaClass('border-t-white/[0.1]'), 'border-t-line-default')
  assert.equal(mapWhiteAlphaClass('border-b-white/[0.03]'), 'border-b-line-subtle')
  assert.equal(mapWhiteAlphaClass('border-x-white/[0.2]'), 'border-x-line-strong')
  assert.equal(mapWhiteAlphaClass('divide-y-white/[0.06]'), 'divide-y-line-subtle')
  assert.equal(mapWhiteAlphaClass('hover:border-t-white/[0.06]'), 'hover:border-t-line-subtle')
  assert.equal(mapWhiteAlphaClass('border-t-white/[0.4]'), null)
})
