import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { OperationPulseAction, OperationPulseActionKind } from '@/types'
import {
  ALL_PULSE_KINDS,
  HOME_SUPPRESSED_PULSE_KINDS,
  NEEDS_YOU_PULSE_KINDS,
  OPERATIONS_PULSE_KINDS,
  filterPulseActions,
} from './pulse-partition'

describe('pulse kind partition', () => {
  it('covers every kind exactly once', () => {
    const combined = [
      ...NEEDS_YOU_PULSE_KINDS,
      ...OPERATIONS_PULSE_KINDS,
      ...HOME_SUPPRESSED_PULSE_KINDS,
    ]
    assert.equal(combined.length, new Set(combined).size, 'a kind is claimed by two lists')
    assert.deepEqual([...combined].sort(), [...ALL_PULSE_KINDS].sort())
  })

  it('lists every kind the type declares', () => {
    // Adding a member to OperationPulseActionKind must fail here until it is
    // assigned to a tier. This literal is the second copy on purpose.
    const declared: OperationPulseActionKind[] = [
      'mission', 'run', 'approval', 'connector', 'gateway', 'budget', 'quality',
    ]
    assert.deepEqual([...ALL_PULSE_KINDS].sort(), declared.sort())
  })
})

describe('filterPulseActions', () => {
  const action = (kind: OperationPulseActionKind): OperationPulseAction => ({
    id: kind, kind, severity: 'low', title: kind, summary: '', href: '/', evidence: [], createdAt: null,
  })

  it('keeps only the requested kinds, in order', () => {
    const actions = [action('connector'), action('mission'), action('approval')]
    assert.deepEqual(filterPulseActions(actions, NEEDS_YOU_PULSE_KINDS).map((a) => a.kind), ['mission'])
    assert.deepEqual(filterPulseActions(actions, OPERATIONS_PULSE_KINDS).map((a) => a.kind), ['connector'])
  })

  it('returns everything when no filter is given', () => {
    const actions = [action('connector'), action('approval')]
    assert.equal(filterPulseActions(actions, undefined).length, 2)
  })
})
