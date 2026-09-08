import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { STREAM_REDIRECTS, STREAM_TABS, streamTabFromSearch } from './stream-tabs'

describe('stream tab resolution', () => {
  it('offers exactly the three views the merge absorbed', () => {
    assert.deepEqual(STREAM_TABS.map((t) => t.key), ['runs', 'activity', 'logs'])
  })

  it('defaults to runs when no tab is named', () => {
    assert.equal(streamTabFromSearch(null), 'runs')
    assert.equal(streamTabFromSearch(''), 'runs')
  })

  it('honours a named tab', () => {
    assert.equal(streamTabFromSearch('logs'), 'logs')
    assert.equal(streamTabFromSearch('activity'), 'activity')
  })

  it('falls back to runs for a tab that does not exist', () => {
    assert.equal(streamTabFromSearch('nonsense'), 'runs')
  })

  it('sends each retired route at a tab that exists', () => {
    // The redirect stubs import these, so a tab renamed here cannot leave a
    // stub pointing at a tab that is gone.
    assert.deepEqual(Object.keys(STREAM_REDIRECTS).sort(), ['activity', 'logs', 'runs'])
    for (const [from, to] of Object.entries(STREAM_REDIRECTS)) {
      assert.ok(STREAM_TABS.some((t) => t.href === to), `${from} redirects to ${to}, which is not a tab`)
    }
  })
})
