import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { subagentPanelWarning } from './subagent-panel'

/*
 * Futó jobba írva a subagent kap egy sort a queue-jába, miközben a szülő
 * ügynök a handle.promise-ra vár -- az eredmény más lesz, mint amit a szülő
 * kért. Nem tiltjuk, de megmondjuk, mielőtt a felhasználó beleír.
 */
describe('subagentPanelWarning', () => {
  it('warns while the job is still running', () => {
    const text = subagentPanelWarning(true, 'Sidekick')
    assert.ok(text)
    assert.match(text as string, /Sidekick/)
  })

  it('says nothing once the job has finished', () => {
    assert.equal(subagentPanelWarning(false, 'Sidekick'), null)
  })

  it('falls back to a generic subject when the parent has no name', () => {
    const text = subagentPanelWarning(true, null)
    assert.ok(text)
    assert.doesNotMatch(text as string, /null/)
  })
})
