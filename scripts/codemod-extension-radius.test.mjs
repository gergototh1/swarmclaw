import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mapRadiusValue, findRadiusValues } from './codemod-extension-radius.mjs'

test('a pixel value lands on the first step it does not exceed', () => {
  assert.equal(mapRadiusValue('2px'), 'var(--radius-xs)')
  assert.equal(mapRadiusValue('4px'), 'var(--radius-xs)')
  assert.equal(mapRadiusValue('6px'), 'var(--radius-sm)')
  assert.equal(mapRadiusValue('8px'), 'var(--radius-sm)')
  assert.equal(mapRadiusValue('10px'), 'var(--radius-md)')
  assert.equal(mapRadiusValue('12px'), 'var(--radius-lg)')
  assert.equal(mapRadiusValue('16px'), 'var(--radius-lg)')
})

test('12px becomes a card, not a control', () => {
  // The one mapping worth stating on its own. These stylesheets were written
  // against a scale whose card step was 12; the host's is 18. Rounding down to
  // the 11px control step would flatten every extension card into a button.
  assert.equal(mapRadiusValue('12px'), 'var(--radius-lg)')
})

test('circles and pills reach the full step whatever they spell', () => {
  for (const v of ['50%', '999px', '9999px']) {
    assert.equal(mapRadiusValue(v), 'var(--radius-full)', v)
  }
})

test('a deliberate square is left square', () => {
  // Returns null rather than a token, so main() counts it as refused and does
  // not rewrite a file for it.
  assert.equal(mapRadiusValue('0'), null)
  assert.equal(mapRadiusValue('0px'), null)
})

test('the two var() forms map by what they actually rendered', () => {
  // `--radius-sm` is a Tailwind theme key, not a CSS variable, so this
  // reference never resolved and always rendered its 6px fallback. Mapping it
  // by the fallback is mapping it by what was on screen.
  assert.equal(mapRadiusValue('var(--radius-sm, .375rem)'), 'var(--radius-sm)')
  assert.equal(mapRadiusValue('var(--radius, .625rem)'), 'var(--radius-md)')
})

test('an unrecognised var() is refused, not guessed', () => {
  // The extension is asking the host for something. Replacing that with a
  // literal would break the link it was reaching for.
  assert.equal(mapRadiusValue('var(--something-else, 4px)'), null)
  assert.equal(mapRadiusValue('var(--radius-lg)'), null)
})

test('a unit the scale does not express is refused', () => {
  assert.equal(mapRadiusValue('2em'), null)
  assert.equal(mapRadiusValue('clamp(4px, 1vw, 12px)'), null)
})

test('rem is converted before it is mapped', () => {
  assert.equal(mapRadiusValue('0.5rem'), 'var(--radius-sm)')   // 8px
  assert.equal(mapRadiusValue('1rem'), 'var(--radius-lg)')     // 16px
})

test('the finder sees every declaration, including the ones left alone', () => {
  const found = findRadiusValues('.a{border-radius:12px}.b{border-top-left-radius:0}.c{border-radius:50%}')
  assert.deepEqual(found, ['12px', '0', '50%'])
})

/**
 * Discrimination proofs. Each mutation was applied to a temp copy of
 * codemod-extension-radius.mjs and the named test confirmed to fail:
 *
 *   1. change the 11 bound to 12          breaks "12px becomes a card"
 *   2. return 'var(--radius-xs)' for '0'  breaks "a deliberate square"
 *   3. map any var() by its fallback      breaks "an unrecognised var() is refused"
 *   4. drop the rem branch                breaks "rem is converted"
 *
 * (1) is the one that matters: rounding 12 down reads as the more conservative
 * choice and would flatten every card these six extensions draw.
 */
