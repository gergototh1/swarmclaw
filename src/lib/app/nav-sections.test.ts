import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { NAV_EXEMPT_VIEWS, NAV_SECTIONS, NAV_SECTION_IDS, sectionForView } from './nav-sections'
import { VIEW_LABELS } from './view-constants'
import type { AppView } from '@/types'

/** Every view a section claims, direct entries included. */
function claimedViews(): AppView[] {
  return NAV_SECTIONS.flatMap((s) => [...(s.direct ? [s.direct] : []), ...s.views])
}

describe('nav section table', () => {
  it('claims every AppView exactly once, or names it exempt', () => {
    const claimed = claimedViews()
    const exempt = Object.keys(NAV_EXEMPT_VIEWS)
    const all = Object.keys(VIEW_LABELS) as AppView[]

    const missing = all.filter((v) => !claimed.includes(v) && !exempt.includes(v))
    assert.deepEqual(missing, [], `these views would vanish from the rail: ${missing.join(', ')}`)

    const dupes = claimed.filter((v, i) => claimed.indexOf(v) !== i)
    assert.deepEqual(dupes, [], `these views appear in two sections: ${dupes.join(', ')}`)
  })

  it('does not claim a view it also exempts', () => {
    const claimed = claimedViews()
    for (const exempt of Object.keys(NAV_EXEMPT_VIEWS)) {
      assert.equal(claimed.includes(exempt as AppView), false, `${exempt} is both claimed and exempt`)
    }
  })

  it('gives every exemption a reason', () => {
    for (const [view, reason] of Object.entries(NAV_EXEMPT_VIEWS)) {
      assert.ok(reason.length > 20, `${view} needs a real reason, got: ${reason}`)
    }
  })

  it('holds seven sections, in rail order', () => {
    assert.deepEqual(NAV_SECTION_IDS, ['home', 'chat', 'work', 'knowledge', 'connect', 'operations', 'settings'])
  })

  it('resolves a view back to its section', () => {
    assert.equal(sectionForView('tasks'), 'work')
    assert.equal(sectionForView('stream'), 'operations')
    assert.equal(sectionForView('vault'), 'settings')
    assert.equal(sectionForView('home'), 'home')
    assert.equal(sectionForView('swarmfeed'), null)
  })

  it('puts Settings in the footer and nothing else', () => {
    assert.deepEqual(NAV_SECTIONS.filter((s) => s.footer).map((s) => s.id), ['settings'])
  })
})
