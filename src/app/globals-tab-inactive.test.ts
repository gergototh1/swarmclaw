import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

/*
 * A background tab frame stops animating, but nothing it animates may get stuck.
 *
 * `animation-play-state: paused` is the obvious way to write this and the wrong
 * one: a paused animation never reaches its end, so it never fires
 * `animationend`, and `@radix-ui/react-presence` unmounts on exactly that event.
 * A dialog closing as its tab goes into the background would stay mounted until
 * the reader came back to it.
 */
describe('background tab frame CSS', () => {
  const css = readFileSync(new URL('./globals.css', import.meta.url), 'utf8')
  const rule = /html\[data-tab-inactive\][^{]*\{([^}]*)\}/.exec(css)?.[1]

  it('has a rule for the inactive-frame attribute the bridge sets', () => {
    assert.ok(rule, 'no html[data-tab-inactive] rule in globals.css')
  })

  it('collapses animations instead of pausing them', () => {
    assert.match(rule ?? '', /animation-duration:\s*0\.01ms\s*!important/)
    assert.match(rule ?? '', /animation-iteration-count:\s*1\s*!important/)
    assert.match(rule ?? '', /transition-duration:\s*0\.01ms\s*!important/)
  })

  it('never pauses an animation, and never kills a transition outright', () => {
    // `transition: none` has the same failure mode for `transitionend`.
    assert.doesNotMatch(css, /html\[data-tab-inactive\][\s\S]{0,200}animation-play-state:\s*paused/)
    assert.doesNotMatch(rule ?? 'x', /transition:\s*none/)
  })
})
