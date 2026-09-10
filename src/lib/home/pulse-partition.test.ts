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
    // ALL_PULSE_KINDS is derived from a Record keyed by the full union, so
    // tsc itself fails a member added to OperationPulseActionKind and left
    // unassigned to a tier — that's the compile-time guard. This hand-typed
    // literal is a second, independent copy that a Record alone can't
    // replace: it catches a kind being *removed* from the union (or its name
    // changed) without ALL_PULSE_KINDS necessarily shrinking to match, since
    // Object.keys always reflects whatever the record currently declares.
    const declared: OperationPulseActionKind[] = [
      'mission', 'run', 'approval', 'connector', 'gateway', 'budget', 'quality',
    ]
    assert.deepEqual([...ALL_PULSE_KINDS].sort(), declared.sort())
  })

  it('assigns each kind to exactly its documented tier', () => {
    assert.deepEqual([...NEEDS_YOU_PULSE_KINDS].sort(), ['budget', 'mission'])
    assert.deepEqual([...OPERATIONS_PULSE_KINDS].sort(), ['connector', 'gateway', 'quality', 'run'])
    assert.deepEqual([...HOME_SUPPRESSED_PULSE_KINDS].sort(), ['approval'])
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
