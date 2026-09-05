import assert from 'node:assert/strict'
import { test } from 'node:test'

import { summarizeLifecycleReconcile, summarizeManagedReconcile } from './reconcile-summary'

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

test('a reconcile over every extension that touched nothing does not blame one extension', () => {
  // The per-extension wording names "this extension", which is one the
  // operator never picked when the request carried no extensionId at all.
  const summary = summarizeManagedReconcile({ createdAgents: [], skipped: [] })
  assert.equal(summary.ok, false)
  assert.match(summary.text, /created and updated nothing/)
  assert.match(summary.text, /no installed extension declared/)
  assert.doesNotMatch(summary.text, /this extension/)
})

test('a reconcile for one named extension still says it was that extension', () => {
  const summary = summarizeManagedReconcile({ extensionId: 'video.mjs', createdAgents: [], skipped: [] })
  assert.equal(summary.ok, false)
  assert.match(summary.text, /this extension declared no agents or routines/)
})

/**
 * The lifecycle wrapper. An install, an enable and an upgrade now run a
 * reconcile without being asked, so what they report is the thing an operator
 * reads first, and it must not be a reassurance the host has not earned.
 */
test('nothing is reported when the extension declared no agents or routines', () => {
  for (const outcome of [
    null,
    undefined,
    { trigger: 'install', extensionId: 'x.mjs', status: 'not_declared' },
  ]) {
    assert.equal(
      summarizeLifecycleReconcile(outcome),
      null,
      `${JSON.stringify(outcome)} produced a message about work that was never attempted`,
    )
  }
})

test('a lifecycle reconcile that created the declared resources reports them and is ok', () => {
  const summary = summarizeLifecycleReconcile({
    trigger: 'install',
    extensionId: 'video.mjs',
    status: 'reconciled',
    result: { extensionId: 'video.mjs', createdAgents: ['a1'], createdSchedules: ['s1', 's2'] },
  })
  assert.equal(summary?.ok, true)
  assert.equal(summary?.text, 'Reconcile: agents 1 created, 0 updated; routines 2 created, 0 updated.')
})

test('a lifecycle reconcile that skipped a declaration is not ok, so the install toast is not the last word', () => {
  const summary = summarizeLifecycleReconcile({
    trigger: 'enable',
    extensionId: 'video.mjs',
    status: 'reconciled',
    result: {
      extensionId: 'video.mjs',
      createdAgents: ['a1'],
      skipped: [{ resourceKind: 'schedule', resourceKey: 'daily', reason: 'missing_agent_ref' }],
    },
  })
  assert.equal(summary?.ok, false)
  assert.match(summary?.text ?? '', /1 declaration skipped \(missing_agent_ref\)/)
})

test('a failed lifecycle reconcile names the reason and says the extension is installed anyway', () => {
  const summary = summarizeLifecycleReconcile({
    trigger: 'upgrade',
    extensionId: 'video.mjs',
    status: 'failed',
    error: 'Extension has no managed resources: video.mjs',
  })
  assert.equal(summary?.ok, false)
  assert.match(summary?.text ?? '', /The extension is installed/)
  assert.match(summary?.text ?? '', /Extension has no managed resources: video\.mjs/)
})

test('a failed lifecycle reconcile with no reason still reports a failure rather than nothing', () => {
  const summary = summarizeLifecycleReconcile({ status: 'failed' })
  assert.equal(summary?.ok, false)
  assert.match(summary?.text ?? '', /no reason given/)
})

test('a status this build does not know is reported as unknown, never as a success', () => {
  const summary = summarizeLifecycleReconcile({ status: 'deferred_until_restart' })
  assert.equal(summary?.ok, false, 'an unrecognised status passed as a success')
  assert.match(summary?.text ?? '', /unrecognised reconcile status \(deferred_until_restart\)/)
})
