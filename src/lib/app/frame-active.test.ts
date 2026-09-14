import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isFrameActive, setFrameActive, subscribeFrameActive } from './frame-active'

describe('frame-active', () => {
  it('is active until something says otherwise', () => {
    assert.equal(isFrameActive(), true)
  })

  it('notifies subscribers only when the value actually changes', () => {
    let calls = 0
    const off = subscribeFrameActive(() => { calls++ })
    setFrameActive(false)
    setFrameActive(false)
    assert.equal(isFrameActive(), false)
    assert.equal(calls, 1)
    setFrameActive(true)
    assert.equal(calls, 2)
    off()
    setFrameActive(false)
    assert.equal(calls, 2, 'an unsubscribed listener is not called')
    setFrameActive(true)
  })
})
