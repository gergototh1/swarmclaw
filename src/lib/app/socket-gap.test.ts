import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { hadSocketGap, markFrameDeactivated, markSocketReopened } from './socket-gap'

describe('socket gap', () => {
  it('reports no gap until a reconnect says otherwise', () => {
    markFrameDeactivated()
    assert.equal(hadSocketGap(), false)
  })

  it('a background close and reopen leaves a gap for every reader', () => {
    markFrameDeactivated()
    markSocketReopened()
    assert.equal(hadSocketGap(), true)
    // Sticky: every subscription in the frame reads it on the same
    // reactivation, and reading it is not what answers it.
    assert.equal(hadSocketGap(), true)
  })

  it('going back into the background starts a fresh gap', () => {
    markSocketReopened()
    markFrameDeactivated()
    assert.equal(hadSocketGap(), false)
  })

  it('a flick to another tab and back that kept the socket leaves no gap', () => {
    // The grace period never elapsed, so nothing disconnected and nothing
    // reconnected: the frame's missed-event bookkeeping is trustworthy on its
    // own and must not be overridden.
    markSocketReopened()
    markFrameDeactivated()
    assert.equal(hadSocketGap(), false)
    markFrameDeactivated()
    assert.equal(hadSocketGap(), false)
  })
})
