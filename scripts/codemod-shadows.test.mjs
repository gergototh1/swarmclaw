import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isRemovableShadow, removeClass, findArbitraryShadows, FOCUS_RING } from './codemod-shadows.mjs'

test('the focus ring is the one arbitrary shadow that stays', () => {
  // The single exception, and the reason the check is on an exact spelling
  // rather than a shape. See the next test for what a heuristic would cost.
  assert.equal(isRemovableShadow(FOCUS_RING), false)
  assert.equal(isRemovableShadow(`focus:${FOCUS_RING}`), false)
  assert.equal(isRemovableShadow(`focus-within:${FOCUS_RING}`), false)
})

test('a decorative halo is removed even though it has no offset either', () => {
  // This is why the rule is not "keep anything with no offset and no blur":
  // an accent glow around a dot has no offset, is not a focus ring, and is
  // exactly the idiom the pass exists to delete.
  assert.equal(isRemovableShadow('shadow-[0_0_8px_var(--color-accent-glow)]'), true)
  assert.equal(isRemovableShadow('shadow-[0_0_6px_rgba(52,211,153,0.4)]'), true)
})

test('lifts and inset highlights are removed, variants and all', () => {
  assert.equal(isRemovableShadow('shadow-[0_24px_64px_rgba(0,0,0,0.6)]'), true)
  // A hovered lift is still a lift -- the variant is stripped before judging.
  assert.equal(isRemovableShadow('hover:shadow-[0_8px_32px_rgba(0,0,0,0.5)]'), true)
  // An inset top highlight is a fake light source along a panel's edge, and
  // this design has no light source at all.
  assert.equal(isRemovableShadow('shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]'), true)
})

test('a named step is not this codemod\'s business', () => {
  // shadow-lg is killed by the namespace reset in globals.css, which is a
  // better tool for it: the reset also kills the one typed next month. If this
  // ever returns true, two mechanisms are fighting over the same class.
  assert.equal(isRemovableShadow('shadow-lg'), false)
  assert.equal(isRemovableShadow('shadow'), false)
})

test('removing a class closes the gap without touching the ends', () => {
  assert.equal(
    removeClass('className="p-2 shadow-[0_1px_2px_red] gap-1"', 'shadow-[0_1px_2px_red]'),
    'className="p-2 gap-1"',
  )
  // Trailing position: the space before the quote goes too, or every diff
  // carries a stray character.
  assert.equal(
    removeClass('className="p-2 shadow-[0_1px_2px_red]"', 'shadow-[0_1px_2px_red]'),
    'className="p-2"',
  )
})

test('the finder sees the kept one too', () => {
  // Wider than what is removed, on purpose: a class this script decides to
  // keep must still be visible to an audit, which is the same reason
  // codemod-radius.mjs widens its TARGET_RE past what it maps.
  const found = findArbitraryShadows(`<i className="${FOCUS_RING} shadow-[0_2px_4px_red]" />`)
  assert.deepEqual(found, [FOCUS_RING, 'shadow-[0_2px_4px_red]'])
})

/**
 * Discrimination proofs. Each mutation was applied to a temp copy of
 * codemod-shadows.mjs and the named test confirmed to fail:
 *
 *   1. replace the FOCUS_RING equality with a
 *      "no offset and no blur" heuristic     breaks "a decorative halo is removed"
 *   2. stop stripping variants before judging breaks "lifts and inset highlights"
 *   3. drop the `startsWith('shadow-[')` guard breaks "a named step is not this
 *                                              codemod's business"
 *   4. drop the ` +"` collapse in removeClass  breaks "removing a class closes the gap"
 *
 * (1) is the one that matters: the heuristic reads as the more principled
 * rule and would have spared six accent halos, which are the most visible
 * thing this pass removes.
 */
