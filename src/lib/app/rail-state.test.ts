import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { railExpandedFromStorage, railSectionForPath } from './rail-state'

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
