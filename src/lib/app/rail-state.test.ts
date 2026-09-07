import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { railExpandedFromStorage, railSectionForPath, resolveOpenSection } from './rail-state'

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

  it('lights up nothing for a view deliberately exempt from the rail', () => {
    assert.equal(railSectionForPath('/swarmfeed', 'swarmfeed', pages), null)
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

describe('resolveOpenSection', () => {
  it('follows the route when nothing has been picked yet', () => {
    assert.equal(resolveOpenSection('work', null), 'work')
    assert.equal(resolveOpenSection(null, null), null)
  })

  it('opens the section a click named, overriding a route that implies a different one', () => {
    const pick = { section: 'operations', route: 'work' } as const
    assert.equal(resolveOpenSection('work', pick), 'operations')
  })

  it('switches to a newly clicked section', () => {
    const pick = { section: 'operations', route: 'work' } as const
    assert.equal(resolveOpenSection('work', pick), 'operations')
    const switched = { section: 'chat', route: 'work' } as const
    assert.equal(resolveOpenSection('work', switched), 'chat')
  })

  it('closes the panel when the pick records an explicit close, and the close survives its own render', () => {
    // Clicking the open section records { section: null, route: 'work' }.
    // Re-deriving against the same, unchanged route must keep returning null
    // rather than snapping back to 'work' — this is the case that makes the
    // toggle look broken if it regresses.
    const closed = { section: null, route: 'work' } as const
    assert.equal(resolveOpenSection('work', closed), null)
    assert.equal(resolveOpenSection('work', closed), null)
  })

  it('lets a route change override a stale close', () => {
    // Work was closed while standing on a 'work' route. Navigating to a
    // /missions link keeps the route at 'work' (still Work's own view), so
    // the close correctly persists...
    const closedOnWork = { section: null, route: 'work' } as const
    assert.equal(resolveOpenSection('work', closedOnWork), null)

    // ...but once the route itself moves to a different section (a click
    // into Chat, or a bookmark landing on an Operations extension page), the
    // stale close no longer applies and the new route's section surfaces so
    // the reader is never left with no panel and no cue where they landed.
    assert.equal(resolveOpenSection('chat', closedOnWork), 'chat')
    assert.equal(resolveOpenSection('operations', closedOnWork), 'operations')
  })
})
