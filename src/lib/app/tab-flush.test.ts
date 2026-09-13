import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { onTabFlushRequest, runTabFlushHandlers } from './tab-flush'

describe('tab flush handlers', () => {
  it('is true with no handlers', async () => {
    assert.equal(await runTabFlushHandlers(), true)
  })

  it('is true only when every handler answers true, and a throw counts as false', async () => {
    const offA = onTabFlushRequest(async () => true)
    assert.equal(await runTabFlushHandlers(), true)
    const offB = onTabFlushRequest(async () => { throw new Error('boom') })
    assert.equal(await runTabFlushHandlers(), false)
    offB()
    assert.equal(await runTabFlushHandlers(), true)
    offA()
  })
})
