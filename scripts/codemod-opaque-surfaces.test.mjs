import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isFrosted, makeOpaque, findTranslucentSurfaces } from './codemod-opaque-surfaces.mjs'

test('a surface with an opacity modifier becomes the step it names', () => {
  assert.equal(makeOpaque('rounded-lg border bg-surface/70 p-4'), 'rounded-lg border bg-surface p-4')
  assert.equal(makeOpaque('bg-raised/95 bg-layer-2/50'), 'bg-raised bg-layer-2')
})

test('a frosted bar keeps its translucency', () => {
  // The single judgement call in the codemod. backdrop-blur is what makes
  // translucency mean something; without it a translucent surface is just a
  // colour nobody can predict.
  const frosted = 'sticky top-0 bg-surface/80 backdrop-blur-md border-b'
  assert.equal(isFrosted(frosted), true)
  assert.equal(makeOpaque(frosted), frosted)
})

test('a class list with no surface token is returned unchanged', () => {
  // Returns the identical string, so the caller can compare and count rather
  // than rewriting a file for a no-op.
  const input = 'flex items-center gap-2 text-text-3'
  assert.equal(makeOpaque(input), input)
})

test('a text or border token with a modifier is not a surface', () => {
  // Only `bg-` is a surface. text-text-3/60 is codemod-text-dim's business and
  // border-line-default/40 is a rule, and neither should move here.
  const input = 'text-text-3/60 border-line-default/40 bg-surface/70'
  assert.equal(makeOpaque(input), 'text-text-3/60 border-line-default/40 bg-surface')
})

test('a colour-family fill is not a surface either', () => {
  // bg-emerald-500/10 is a status wash on a badge, not a step on the ladder.
  // Flattening it to a solid emerald would repaint every status chip in the app.
  const input = 'bg-emerald-500/10 bg-accent-bright/15 bg-surface/60'
  assert.equal(makeOpaque(input), 'bg-emerald-500/10 bg-accent-bright/15 bg-surface')
})

test('the finder sees the frosted ones too', () => {
  // Wider than what is rewritten, for the reason recorded in
  // codemod-radius.mjs: a token the rule spares must still be visible to an
  // audit rather than filtered out upstream and vanish.
  assert.deepEqual(
    findTranslucentSurfaces('a bg-surface/80 backdrop-blur b bg-bg/50'),
    ['bg-surface/80', 'bg-bg/50'],
  )
})

/**
 * Discrimination proofs. Each mutation was applied to a temp copy of
 * codemod-opaque-surfaces.mjs and the named test confirmed to fail:
 *
 *   1. make isFrosted always return false     breaks "a frosted bar keeps"
 *   2. widen SURFACE_RE to `bg-[\w-]+/\d+`    breaks "a colour-family fill"
 *   3. drop the \b before bg-                 breaks "a text or border token"
 *
 * (2) is the one that matters: the wider regex reads as the simpler rule and
 * would have repainted every status chip in the app as a solid block.
 */
