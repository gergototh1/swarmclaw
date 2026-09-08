import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  panelClosedFromStorage,
  railExpandedFromStorage,
  railSectionForPath,
  resolveHighlightedSection,
  resolveOpenSection,
} from './rail-state'

describe('rail expanded state', () => {
  it('starts labelled when nothing is stored', () => {
    assert.equal(railExpandedFromStorage(null), true)
  })

  it('honours a stored collapse', () => {
    assert.equal(railExpandedFromStorage('false'), false)
  })

  it('honours a stored expand', () => {
    assert.equal(railExpandedFromStorage('true'), true)
  })

  it('treats a corrupted value as labelled rather than as bare icons', () => {
    assert.equal(railExpandedFromStorage(''), true)
    assert.equal(railExpandedFromStorage('yes'), true)
  })
})

describe('railSectionForPath', () => {
  const pages = [
    { path: '/x/crm' },
    { path: '/x/aisignal', section: 'operations' },
    { path: '/x/docs', section: 'not-a-section' },
  ]

  it('answers through the view a recognized route resolves to', () => {
    assert.equal(railSectionForPath('/tasks', 'tasks', pages), 'work')
    assert.equal(railSectionForPath('/agents/abc', 'agents', pages), 'chat')
    assert.equal(railSectionForPath('/settings', 'settings', pages), 'settings')
  })

  // /swarmfeed is the Feed half of the Home surface (src/app/home/home-tabs.ts).
  // It used to be rail-exempt, which left the Home icon dark and no section
  // open for the whole time a reader stood on that tab; `home` claims the view
  // now. Home is a `direct` section, so this lights its icon without opening a
  // panel -- `panelSection` in sidebar-rail.tsx filters `!s.direct`.
  it('lights up Home on the Feed half of the Home surface', () => {
    assert.equal(railSectionForPath('/swarmfeed', 'swarmfeed', pages), 'home')
    assert.equal(railSectionForPath('/home', 'home', pages), 'home')
  })

  it('reads an extension page section from the page itself', () => {
    assert.equal(railSectionForPath('/x/aisignal', null, pages), 'operations')
  })

  it('defaults an extension page that declares nothing to work', () => {
    assert.equal(railSectionForPath('/x/crm', null, pages), 'work')
    assert.equal(railSectionForPath('/x/docs', null, pages), 'work')
  })

  it('defaults an extension page the list has not delivered yet to work', () => {
    assert.equal(railSectionForPath('/x/crm', null, []), 'work')
  })

  it('matches a sub-path of an extension page', () => {
    assert.equal(railSectionForPath('/x/aisignal/item/7', null, pages), 'operations')
  })

  // The point of the isExtensionPagePath guard. `resolveSidebarActiveView`
  // returns null for every path it does not recognize, not only for /x/...,
  // and `resolvePageSection({})` answers 'work' — so without the guard a share
  // link would light up Work.
  it('lights up nothing on a route that is neither a view nor an extension page', () => {
    assert.equal(railSectionForPath('/s/some-share-token', null, pages), null)
    assert.equal(railSectionForPath('/definitely-not-a-route', null, pages), null)
  })
})

describe('panel closed state', () => {
  it('starts open when nothing is stored', () => {
    assert.equal(panelClosedFromStorage(null), false)
  })

  it('honours a stored close', () => {
    assert.equal(panelClosedFromStorage('true'), true)
  })

  it('honours a stored open', () => {
    assert.equal(panelClosedFromStorage('false'), false)
  })

  it('treats a corrupted value as open rather than as a stuck-closed panel', () => {
    assert.equal(panelClosedFromStorage(''), false)
    assert.equal(panelClosedFromStorage('yes'), false)
  })
})

describe('resolveOpenSection', () => {
  it('follows the route when nothing has been picked yet and nothing is persisted closed', () => {
    assert.equal(resolveOpenSection('work', null, false), 'work')
    assert.equal(resolveOpenSection(null, null, false), null)
  })

  it('opens the section a click named, overriding a route that implies a different one', () => {
    const pick = { section: 'operations', route: 'work' } as const
    assert.equal(resolveOpenSection('work', pick, false), 'operations')
  })

  it('switches to a newly clicked section', () => {
    const pick = { section: 'operations', route: 'work' } as const
    assert.equal(resolveOpenSection('work', pick, false), 'operations')
    const switched = { section: 'chat', route: 'work' } as const
    assert.equal(resolveOpenSection('work', switched, false), 'chat')
  })

  it('closes the panel when the pick records an explicit close, and the close survives its own render', () => {
    // Clicking the open section records { section: null, route: 'work' }.
    // Re-deriving against the same, unchanged route must keep returning null
    // rather than snapping back to 'work' — this is the case that makes the
    // toggle look broken if it regresses.
    const closed = { section: null, route: 'work' } as const
    assert.equal(resolveOpenSection('work', closed, false), null)
    assert.equal(resolveOpenSection('work', closed, false), null)
  })

  it('lets a route change override a same-render pick once the route has moved past it', () => {
    // Work was closed via a fresh pick while standing on a 'work' route.
    // Re-deriving against the same route keeps the pick's close...
    const closedOnWork = { section: null, route: 'work' } as const
    assert.equal(resolveOpenSection('work', closedOnWork, false), null)

    // ...but once the route itself moves, the stale pick no longer applies
    // (pick.route !== routeSection) and the decision falls through to the
    // persisted `closed` flag rather than the pick. With nothing persisted
    // (false), the new route's section surfaces exactly as it always did.
    assert.equal(resolveOpenSection('chat', closedOnWork, false), 'chat')
    assert.equal(resolveOpenSection('operations', closedOnWork, false), 'operations')
  })

  it('keeps a persisted close across a route change — this is the owner-requested behaviour', () => {
    // The reader closed the panel at some earlier point; that session's
    // transient pick is long gone (null), but `closed` is still true because
    // it was written to storage. Landing on a brand new route by any means
    // (a link, ⌘K, a redirect) must not spring the panel back open.
    assert.equal(resolveOpenSection('chat', null, true), null)
    assert.equal(resolveOpenSection('operations', null, true), null)
    assert.equal(resolveOpenSection(null, null, true), null)
  })

  it('opening a section against a persisted close overrides it immediately', () => {
    // Clicking a rail section while the panel is closed must open it — the
    // fresh pick from that click applies on this render regardless of the
    // persisted flag.
    const opened = { section: 'knowledge', route: 'work' } as const
    assert.equal(resolveOpenSection('work', opened, true), 'knowledge')
  })
})

describe('resolveHighlightedSection', () => {
  it('matches the open section when one is open', () => {
    assert.equal(resolveHighlightedSection('work', 'work'), 'work')
    // A section opened while standing on a different route (open Knowledge
    // from /tasks) is a more specific answer than the plain route.
    assert.equal(resolveHighlightedSection('work', 'knowledge'), 'knowledge')
  })

  it('falls back to the route section when nothing is open — this is what keeps the rail a valid orientation cue on its own once the panel can stay closed', () => {
    assert.equal(resolveHighlightedSection('work', null), 'work')
  })

  it('shows no highlight when neither the route nor the open section names one', () => {
    assert.equal(resolveHighlightedSection(null, null), null)
  })
})
