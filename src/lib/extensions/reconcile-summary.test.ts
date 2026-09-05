import assert from 'node:assert/strict'
import { test } from 'node:test'

import { summarizeManagedReconcile } from './reconcile-summary'

/**
 * The one property this module exists for: a reconcile that did nothing and a
 * reconcile that worked must not read alike. Everything below is a case where
 * the count-the-arrays-and-say-"Reconciled N" message the manager view used to
 * build says "0" and means something different each time.
 */

test('a reconcile that created the declared resources reports them and is ok', () => {
  const summary = summarizeManagedReconcile({
    createdAgents: ['a1', 'a2'],
    updatedAgents: [],
    createdSchedules: ['s1', 's2', 's3'],
    updatedSchedules: [],
    skipped: [],
  })
  assert.equal(summary.ok, true)
  assert.equal(summary.text, 'Reconcile: agents 2 created, 0 updated; routines 3 created, 0 updated.')
})

test('a second reconcile that only updates is still ok and says so with its own numbers', () => {
  const summary = summarizeManagedReconcile({
    createdAgents: [],
    updatedAgents: ['a1', 'a2'],
    createdSchedules: [],
    updatedSchedules: ['s1', 's2', 's3'],
  })
  assert.equal(summary.ok, true)
  assert.equal(summary.text, 'Reconcile: agents 0 created, 2 updated; routines 0 created, 3 updated.')
})

test('a reconcile that skipped a declaration is not ok, and names the reason', () => {
  const summary = summarizeManagedReconcile({
    createdAgents: ['a1'],
    updatedAgents: [],
    createdSchedules: [],
    updatedSchedules: [],
    skipped: [
      { resourceKind: 'schedule', resourceKey: 'daily', reason: 'missing_agent_ref' },
      { resourceKind: 'schedule', resourceKey: 'weekly', reason: 'missing_agent_ref' },
    ],
  })
  assert.equal(summary.ok, false, 'two routines were silently not created; that is not a success')
  assert.match(summary.text, /2 declarations skipped \(missing_agent_ref\)/)
  assert.match(summary.text, /agents 1 created/)
})

test('distinct skip reasons are all named, once each, in first-seen order', () => {
  const summary = summarizeManagedReconcile({
    createdAgents: ['a1'],
    skipped: [
      { resourceKind: 'schedule', resourceKey: 's1', reason: 'invalid_schedule_declaration' },
      { resourceKind: 'agent', resourceKey: 'a2', reason: 'invalid_agent_declaration' },
      { resourceKind: 'schedule', resourceKey: 's2', reason: 'invalid_schedule_declaration' },
    ],
  })
  assert.match(summary.text, /3 declarations skipped \(invalid_schedule_declaration, invalid_agent_declaration\)/)
  assert.equal(summary.ok, false)
})

test('a reconcile that touched nothing at all is reported as having done nothing, not as a success', () => {
  for (const empty of [
    { createdAgents: [], updatedAgents: [], createdSchedules: [], updatedSchedules: [], skipped: [] },
    {},
    null,
    undefined,
  ]) {
    const summary = summarizeManagedReconcile(empty)
    assert.equal(summary.ok, false, `${JSON.stringify(empty)} reported as ok`)
    assert.match(summary.text, /created and updated nothing/)
  }
})

test('a skip entry with no usable reason is still counted and named, never dropped', () => {
  const summary = summarizeManagedReconcile({
    createdAgents: ['a1'],
    // A shape the server does not currently produce; dropping it would under-report.
    skipped: [{ resourceKind: 'schedule', resourceKey: 's1', reason: '' }],
  })
  assert.match(summary.text, /1 declaration skipped \(unknown\)/)
  assert.equal(summary.ok, false)
})
