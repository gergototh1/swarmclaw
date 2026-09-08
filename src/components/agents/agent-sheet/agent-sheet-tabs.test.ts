import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { AGENT_SHEET_TABS } from './agent-sheet-tabs'

describe('agent sheet tabs', () => {
  it('opens on the fields that are actually edited', () => {
    assert.equal(AGENT_SHEET_TABS[0].key, 'essentials')
  })

  it('holds six tabs, in order', () => {
    assert.deepEqual(
      AGENT_SHEET_TABS.map((t) => t.key),
      ['essentials', 'behavior', 'tools', 'memory', 'network', 'advanced'],
    )
  })

  it('accounts for all sixteen sections of the old single scroll', () => {
    assert.equal(AGENT_SHEET_TABS.reduce((n, t) => n + t.sections, 0), 16)
  })

  it('gives every tab a label', () => {
    for (const tab of AGENT_SHEET_TABS) assert.ok(tab.label.length > 0, `${tab.key} has no label`)
  })
})
