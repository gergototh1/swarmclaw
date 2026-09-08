import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mapWeightClass, mapTrackingClass, findTypeClasses } from './codemod-type-ladder.mjs'

/**
 * Each assertion below is paired with the mutation that breaks it, because a
 * green suite proves nothing on its own -- see the note in
 * codemod-text-dim.test.mjs. The four mutations are listed at the bottom.
 */

test('the two weights off the ladder move onto it', () => {
  // 500 goes UP. Every one of the 124 sites is asking for emphasis, and
  // dropping to 400 would remove the emphasis rather than restate it.
  assert.equal(mapWeightClass('font-500'), 'font-600')
  // 800 goes DOWN to the top of the ladder.
  assert.equal(mapWeightClass('font-800'), 'font-700')
})

test('the weights already on the ladder are left alone', () => {
  // Not "returns the same string" -- returns null, so main() counts them as
  // untouched rather than rewriting a file for a no-op change.
  for (const w of ['font-300', 'font-400', 'font-600', 'font-700']) {
    assert.equal(mapWeightClass(w), null, `${w} is on Apple's ladder and must not move`)
  }
})

test('a variant on a weight is preserved, and the weight still moves', () => {
  // hover:font-500 is still a weight on a step that does not exist.
  assert.equal(mapWeightClass('hover:font-500'), 'hover:font-600')
  assert.equal(mapWeightClass('group-hover:font-800'), 'group-hover:font-700')
})

test('the wide tracking steps collapse to 0.03em', () => {
  assert.equal(mapTrackingClass('tracking-[0.08em]'), 'tracking-[0.03em]')
  assert.equal(mapTrackingClass('tracking-[0.12em]'), 'tracking-[0.03em]')
  // tracking-wider is 0.05em and compiles to the same treatment as the
  // bracketed values, so the bare Tailwind name has to be caught too.
  assert.equal(mapTrackingClass('tracking-wider'), 'tracking-[0.03em]')
  assert.equal(mapTrackingClass('tracking-widest'), 'tracking-[0.03em]')
})

test('negative tracking survives untouched -- it is the design language itself', () => {
  // This is the assertion that matters most. The whole redesign is built on
  // negative display tracking; a codemod that flattened it would delete the
  // thing it was written to serve.
  for (const t of ['tracking-[-0.02em]', 'tracking-[-0.03em]', 'tracking-[-0.04em]', 'tracking-tight', 'tracking-tighter']) {
    assert.equal(mapTrackingClass(t), null, `${t} is the signature and must not move`)
  }
})

test('tracking already at or below the target is left alone', () => {
  // `wide` is 0.025em, already under the 0.03em target: rewriting it would be
  // churn, and would widen it rather than narrow it.
  assert.equal(mapTrackingClass('tracking-wide'), null)
  assert.equal(mapTrackingClass('tracking-normal'), null)
})

test('an unrecognised tracking value is refused, not guessed', () => {
  // A unit this script was never told about must reach the refusal list rather
  // than be rewritten to a value nobody chose.
  assert.equal(mapTrackingClass('tracking-[2px]'), null)
  assert.equal(mapTrackingClass('tracking-[0.2em]'), null)
  assert.equal(mapTrackingClass('tracking-[var(--x)]'), null)
})

test('a partial match is not a match', () => {
  // `font-500` inside a longer token is not the class, and rewriting it would
  // corrupt the token. The maps require the match to span the whole string.
  assert.equal(mapWeightClass('sm:font-500 text-text'), null)
  assert.equal(mapTrackingClass('tracking-[0.08em] uppercase'), null)
})

test('the finder sees everything, including what the maps decline', () => {
  // Wider than what gets rewritten, on purpose: a class the maps refuse has to
  // be visible to the refusal report rather than filtered out upstream and
  // vanish. This is the bug class that hit codemod-surfaces twice.
  const found = findTypeClasses(
    '<p className="font-400 tracking-[0.2em] font-500 tracking-tight">x</p>',
  )
  assert.deepEqual(found.sort(), ['font-400', 'font-500', 'tracking-[0.2em]', 'tracking-tight'].sort())
})

/**
 * Discrimination proofs. Each mutation was applied to a temp copy of
 * codemod-type-ladder.mjs and the named test was confirmed to fail:
 *
 *   1. WEIGHT_MAP 500 -> '400'            breaks "the two weights off the ladder"
 *   2. add '−0.02em' to TRACKING_MAP      breaks "negative tracking survives"
 *   3. drop the `m[0] !== cls` guard       breaks "a partial match is not a match"
 *   4. narrow TRACKING_RE to `\[[^\]]+\]`  breaks "the finder sees everything"
 *
 * Without (2) in particular the suite would pass on a codemod that flattened
 * every display headline in the app.
 */
