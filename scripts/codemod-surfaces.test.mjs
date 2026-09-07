import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  findCollapsedVariantPairs,
  findShorthandOpacityClasses,
  findWhiteAlphaClasses,
  mapWhiteAlphaClass,
} from './codemod-surfaces.mjs'

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

test('text alphas map onto the three established text tokens', () => {
  assert.equal(mapWhiteAlphaClass('text-white/[0.9]'), 'text-text')
  assert.equal(mapWhiteAlphaClass('text-white/[0.6]'), 'text-text-2')
  assert.equal(mapWhiteAlphaClass('text-white/[0.3]'), 'text-text-3')
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

test('the scan feeds every utility prefix to the mapper, so a refusal is reported', () => {
  const found = findWhiteAlphaClasses('className="shadow-white/[0.04] from-white/[0.2] ring-offset-white/[0.1]"')
  assert.deepEqual(found, ['shadow-white/[0.04]', 'from-white/[0.2]', 'ring-offset-white/[0.1]'])
  for (const cls of found) assert.equal(mapWhiteAlphaClass(cls), null)
})

test('the shorthand opacity form is detected even though it is never rewritten', () => {
  const found = findShorthandOpacityClasses(
    'className="border-white/10 bg-white/20 hover:text-white/70 bg-white/[0.04]"'
  )
  assert.deepEqual(found, ['border-white/10', 'bg-white/20', 'hover:text-white/70'])
  assert.deepEqual(findShorthandOpacityClasses('className="bg-layer-2 border-line-default"'), [])
})

test('a base class and an interaction variant that collapse onto one token are reported', () => {
  const before = findCollapsedVariantPairs('className="bg-white/[0.04] p-4 hover:bg-white/[0.06]"')
  assert.deepEqual(before, [{ base: 'bg-white/[0.04]', variant: 'hover:bg-white/[0.06]', token: 'bg-layer-2', line: 1 }])

  const after = findCollapsedVariantPairs('className="bg-layer-2 rounded-[10px] hover:bg-layer-2"')
  assert.deepEqual(after, [{ base: 'bg-layer-2', variant: 'hover:bg-layer-2', token: 'bg-layer-2', line: 1 }])

  const multiline = findCollapsedVariantPairs('a\nclassName="border border-line-default\n  hover:border-line-default"')
  assert.equal(multiline.length, 1)
  assert.equal(multiline[0].variant, 'hover:border-line-default')
})

test('a variant that actually changes the token is not reported', () => {
  assert.deepEqual(findCollapsedVariantPairs('className="bg-layer-2 hover:bg-layer-3"'), [])
  assert.deepEqual(findCollapsedVariantPairs('className="bg-white/[0.04] hover:bg-white/[0.09]"'), [])
})

test('the two branches of a ternary are separate class lists', () => {
  assert.deepEqual(findCollapsedVariantPairs("cond ? 'bg-layer-2' : 'hover:bg-layer-2'"), [])
})
