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

  it('holds eight sections, in rail order', () => {
    assert.deepEqual(NAV_SECTION_IDS, ['home', 'conversations', 'chat', 'work', 'knowledge', 'connect', 'operations', 'settings'])
  })

  it('keeps Chat and Agents apart, and stops the section sharing a name with its first child', () => {
    const conversations = NAV_SECTIONS.find((s) => s.id === 'conversations')
    const agents = NAV_SECTIONS.find((s) => s.id === 'chat')
    assert.equal(conversations?.label, 'Chat')
    assert.equal(conversations?.direct, 'conversations', 'a Chat szekció egyetlen lapra visz, nem nyílik ki')
    assert.equal(agents?.label, 'Agents')
    // A szekció és az első gyereke azonos néven két egyforma sornak látszik.
    assert.notEqual(VIEW_LABELS[agents?.views[0] ?? 'home'], agents?.label)
  })

  it('resolves a view back to its section', () => {
    assert.equal(sectionForView('tasks'), 'work')
    assert.equal(sectionForView('stream'), 'operations')
    assert.equal(sectionForView('vault'), 'settings')
    assert.equal(sectionForView('home'), 'home')
    // Both halves of the Home surface answer 'home': the launchpad through the
    // section's `direct`, the feed through its `views`.
    assert.equal(sectionForView('swarmfeed'), 'home')
  })

  // Home is the one section that navigates straight to a view, and
  // `panelSection` in sidebar-rail.tsx renders a panel only for sections
  // without a `direct`. That is what lets Home claim /swarmfeed for the rail
  // highlight without growing a panel nobody asked for.
  it('keeps Home out of the panel-rendering set by giving it a direct view', () => {
    assert.deepEqual(
      NAV_SECTIONS.filter((s) => !s.direct).map((s) => s.id),
      ['chat', 'work', 'knowledge', 'connect', 'operations', 'settings'],
    )
  })

  it('puts Settings in the footer and nothing else', () => {
    assert.deepEqual(NAV_SECTIONS.filter((s) => s.footer).map((s) => s.id), ['settings'])
  })
})
