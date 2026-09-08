import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { HOME_TABS } from './home-tabs'

describe('home tabs', () => {
  it('pairs the launchpad with the feed', () => {
    assert.deepEqual(HOME_TABS.map((t) => t.key), ['home', 'feed'])
  })

  it('keeps both as real routes, so each stays linkable', () => {
    assert.deepEqual(HOME_TABS.map((t) => t.href), ['/home', '/swarmfeed'])
  })
})
