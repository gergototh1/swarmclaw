import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mapDimClass, stateVariantSteps, planSource, isDimToken, splitVariants } from './codemod-text-dim.mjs'

test('a bare opacity modifier on a dim token is stripped', () => {
  assert.deepEqual(mapDimClass('text-text-3/60'), { action: 'rewrite', to: 'text-text-3' })
  assert.deepEqual(mapDimClass('text-text-3/40'), { action: 'rewrite', to: 'text-text-3' })
  assert.deepEqual(mapDimClass('text-text-2/80'), { action: 'rewrite', to: 'text-text-2' })
})

test('a token with no modifier is left alone and not reported', () => {
  assert.deepEqual(mapDimClass('text-text-3'), { action: 'refuse', reason: 'no-modifier' })
  assert.deepEqual(mapDimClass('text-text-2'), { action: 'refuse', reason: 'no-modifier' })
})

test('a state variant makes the modifier a treatment, so it is refused', () => {
  for (const cls of [
    'hover:text-text-3/60',
    'focus:text-text-3/60',
    'disabled:text-text-3/50',
    'group-hover:text-text-3/70',
    'group-hover/resume:text-text-3/60',
    'peer-checked:text-text-3/40',
    'data-[state=open]:text-text-3/60',
    'aria-expanded:text-text-2/80',
  ]) {
    const result = mapDimClass(cls)
    assert.equal(result.action, 'refuse', `${cls} should be refused`)
    assert.match(result.reason, /^state-variant:/, `${cls}: ${result.reason}`)
  }
})

test('a named group suffix is stripped before the variant is judged', () => {
  assert.deepEqual(mapDimClass('group-hover/resume:text-text-3/60'), {
    action: 'refuse',
    reason: 'state-variant:group-hover',
  })
})

test('a breakpoint, colour scheme or pseudo-element is not a state, so it is stripped', () => {
  assert.deepEqual(mapDimClass('md:text-text-3/60'), { action: 'rewrite', to: 'md:text-text-3' })
  assert.deepEqual(mapDimClass('placeholder:text-text-3/50'), { action: 'rewrite', to: 'placeholder:text-text-3' })
  assert.deepEqual(mapDimClass('dark:text-text-3/70'), { action: 'rewrite', to: 'dark:text-text-3' })
  assert.deepEqual(mapDimClass('lg:placeholder:text-text-3/45'), { action: 'rewrite', to: 'lg:placeholder:text-text-3' })
})

test('a variant on none of the three lists is refused rather than assumed safe', () => {
  assert.deepEqual(mapDimClass('supports-grid:text-text-3/60'), {
    action: 'refuse',
    reason: 'unknown-variant:supports-grid',
  })
})

test('a modifier that is not a plain percentage is refused', () => {
  assert.deepEqual(mapDimClass('text-text-3/[0.35]'), { action: 'refuse', reason: 'unrecognized-modifier' })
  assert.deepEqual(mapDimClass('text-text-3/[var(--o)]'), { action: 'refuse', reason: 'unrecognized-modifier' })
})

test('a colon inside brackets does not split a variant in half', () => {
  // A naive split(':') reports a variant named `supports-[display`, which is a
  // refusal whose reason names nothing that exists.
  assert.deepEqual(splitVariants('supports-[display:grid]:text-text-3/60'), {
    variants: ['supports-[display:grid]'],
    utility: 'text-text-3/60',
  })
  assert.deepEqual(mapDimClass('supports-[display:grid]:text-text-3/60'), {
    action: 'refuse',
    reason: 'unknown-variant:supports-[display:grid]',
  })
})

test('a token this codemod does not understand is refused, not silently skipped', () => {
  assert.deepEqual(mapDimClass('mytext-text-3/60'), { action: 'refuse', reason: 'unrecognized-token' })
  assert.deepEqual(mapDimClass('text-text-3/60/70'), { action: 'refuse', reason: 'unrecognized-modifier' })
})

test('isDimToken is wider than the shapes mapDimClass understands', () => {
  // Same asymmetry codemod-radius.mjs records: the scan has to *see* a token
  // it cannot map so the refusal report can name it. If isDimToken narrowed to
  // the mappable shapes, `text-text-3/[0.35]` would vanish instead of being
  // reported.
  for (const token of ['text-text-3/[0.35]', 'supports-[display:grid]:text-text-3/60', 'text-text-2']) {
    assert.equal(isDimToken(token), true, `${token} should be seen by the scan`)
  }
  assert.equal(isDimToken('text-text'), false)
  assert.equal(isDimToken('text-accent-bright/60'), false)
})

test('a modifier in a ternary branch is refused', () => {
  const source = `const cls = active ? 'text-accent-bright' : 'text-text-3/60'`
  const { output, edits, refusals } = planSource(source, 'a.tsx')
  assert.equal(output, source)
  assert.equal(edits.length, 0)
  assert.deepEqual(refusals.map((r) => r.reason), ['conditional-context'])
})

test('a modifier on the right of && is refused', () => {
  const source = `const cls = muted && 'text-text-3/50'`
  const { edits, refusals } = planSource(source, 'a.tsx')
  assert.equal(edits.length, 0)
  assert.deepEqual(refusals.map((r) => r.reason), ['conditional-context'])
})

test('a ternary inside cn() and inside a template literal are both seen', () => {
  const source = [
    `const a = cn('base', on ? 'x' : 'text-text-3/60')`,
    'const b = `base ${on ? "y" : "text-text-3/40"}`',
  ].join('\n')
  const { edits, refusals } = planSource(source, 'a.tsx')
  assert.equal(edits.length, 0)
  assert.equal(refusals.length, 2)
  assert.ok(refusals.every((r) => r.reason === 'conditional-context'))
})

test('a whole element in a ternary branch is not a conditional class', () => {
  // The walk stops at the JsxAttribute: the ternary here decides whether the
  // paragraph renders, which says nothing about how dim its label should be.
  // Without that stop this returns a refusal and hundreds of ordinary sites
  // survive the sweep for no reason.
  const source = `const el = show ? <p className="text-text-3/60">hi</p> : null`
  const { output, edits, refusals } = planSource(source, 'a.tsx')
  assert.equal(edits.length, 1)
  assert.equal(refusals.length, 0)
  assert.match(output, /className="text-text-3">/)
})

test('the static head of a template literal is not conditional because a span is', () => {
  const source = 'const c = `text-text-3/60 ${on ? "a" : "b"}`'
  const { output, edits } = planSource(source, 'a.tsx')
  assert.equal(edits.length, 1)
  assert.match(output, /`text-text-3 \$\{/)
})

test('a base paired with a state variant of the same step keeps both halves', () => {
  // `text-text-3/40 group-hover/resume:text-text-3/60` -- stripping only the
  // base leaves a hover that dims rather than brightens, which is worse than
  // what it replaced. Filtering on the `hover:` prefix alone does exactly that.
  const source = `const c = 'text-[10px] text-text-3/40 group-hover/resume:text-text-3/60 truncate'`
  const { output, edits, refusals } = planSource(source, 'a.tsx')
  assert.equal(output, source)
  assert.equal(edits.length, 0)
  assert.deepEqual(refusals.map((r) => r.reason).sort(), [
    'paired-with-state-variant',
    'state-variant:group-hover',
  ])
})

test('the pairing rule is per text step, not per class string', () => {
  // A hover on text-text-2 must not freeze an unrelated text-text-3 sitting
  // beside it.
  const source = `const c = 'text-text-3/60 hover:text-text-2/80'`
  const { output, edits, refusals } = planSource(source, 'a.tsx')
  assert.equal(edits.length, 1)
  assert.match(output, /'text-text-3 hover:text-text-2\/80'/)
  assert.equal(output, `const c = 'text-text-3 hover:text-text-2/80'`)
  assert.deepEqual(refusals.map((r) => r.reason), ['state-variant:hover'])
})

test('stateVariantSteps reports the steps that carry a state variant', () => {
  assert.deepEqual([...stateVariantSteps('text-text-3/40 hover:text-text-3/60')], ['3'])
  assert.deepEqual([...stateVariantSteps('text-text-3/40 md:text-text-3/60')], [])
  assert.deepEqual([...stateVariantSteps('hover:text-text-2/80 text-text-3/60')], ['2'])
})

test('several modifiers in one class string are all rewritten, offsets and all', () => {
  const source = `const c = 'text-text-3/60 gap-2 text-text-2/80 md:text-text-3/40'`
  const { output, edits } = planSource(source, 'a.tsx')
  assert.equal(edits.length, 3)
  assert.equal(output, `const c = 'text-text-3 gap-2 text-text-2 md:text-text-3'`)
})

test('a file with nothing to change comes back byte-identical', () => {
  const source = `const c = 'text-text-3 text-text hover:text-text-2'`
  const { output, edits, refusals } = planSource(source, 'a.tsx')
  assert.equal(output, source)
  assert.equal(edits.length, 0)
  assert.equal(refusals.length, 0)
})
