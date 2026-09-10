import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { mergeSubagentEvents } from './subagent-row'
import type { SwarmPanelData } from './swarm-panel'

/*
 * Egy spawn tipikusan két tool-eseményt ír a transzkriptbe egyazon
 * üzeneten belül: egy `running`-ot, majd egy később érkező terminálisat
 * (completed/failed/...) ugyanahhoz a gyerek session-höz vagy job id-hoz.
 * `mergeSubagentEvents` ezeket egyetlen sorba vonja össze session id (job
 * id fallback) szerint, és minden taghoz a legkésőbbi eseményt tartja meg.
 */
describe('mergeSubagentEvents', () => {
  it('returns null when there are no spawn_subagent events', () => {
    assert.equal(mergeSubagentEvents([]), null)
  })

  it('merges a running + terminal pair for the same child session into one member', () => {
    const running: SwarmPanelData = {
      kind: 'single',
      status: 'running',
      agents: [{ jobId: 'job-1', sessionId: 'sess-child-1', agentName: 'Fejlesztő', status: 'running' }],
    }
    const completed: SwarmPanelData = {
      kind: 'single',
      status: 'completed',
      agents: [{
        jobId: 'job-1',
        sessionId: 'sess-child-1',
        agentName: 'Fejlesztő',
        status: 'completed',
        durationMs: 4200,
        response: 'Kész',
      }],
    }

    const merged = mergeSubagentEvents([running, completed])
    assert.ok(merged)
    // Exactly one row for the subagent -- not one per tool event.
    assert.equal(merged.agents.length, 1)
    // The terminal status wins -- a finished subagent must not still say "running".
    assert.equal(merged.agents[0].status, 'completed')
    assert.equal(merged.agents[0].durationMs, 4200)
    assert.equal(merged.status, 'completed')
  })

  it('keeps the terminal status even when the terminal event arrives before the running one', () => {
    // Order in the array reflects "latest wins" regardless of the running/
    // terminal label -- whichever element is later in the list wins.
    const completed: SwarmPanelData = {
      kind: 'single',
      status: 'completed',
      agents: [{ jobId: 'job-2', sessionId: 'sess-child-2', agentName: 'Kutató', status: 'completed' }],
    }
    const runningAfter: SwarmPanelData = {
      kind: 'single',
      status: 'running',
      agents: [{ jobId: 'job-2', sessionId: 'sess-child-2', agentName: 'Kutató', status: 'running' }],
    }

    const merged = mergeSubagentEvents([completed, runningAfter])
    assert.ok(merged)
    assert.equal(merged.agents.length, 1)
    assert.equal(merged.agents[0].status, 'running')
  })

  it('keeps merging by job id across the running -> terminal transition even once a session id appears', () => {
    // The job id is assigned at spawn start and stays identical through the
    // terminal event (verified against real job records in
    // swarm-panel.test.ts); the child session id can still be missing on
    // the very first running event. Job id is therefore the primary key so
    // the pair keeps collapsing into one row once the session id shows up.
    const started: SwarmPanelData = {
      kind: 'single',
      status: 'running',
      agents: [{ jobId: 'job-3', agentName: 'Kutató', status: 'running' }],
    }
    const withSession: SwarmPanelData = {
      kind: 'single',
      status: 'completed',
      agents: [{ jobId: 'job-3', sessionId: 'sess-child-3', agentName: 'Kutató', status: 'completed' }],
    }

    const merged = mergeSubagentEvents([started, withSession])
    assert.ok(merged)
    assert.equal(merged.agents.length, 1)
    assert.equal(merged.agents[0].status, 'completed')
    assert.equal(merged.agents[0].sessionId, 'sess-child-3')
  })

  it('falls back to session id when a member has no job id at all', () => {
    // A batch result entry can carry only a session id (RawBatchResult.jobId
    // is optional) -- without the session-id fallback these would never
    // merge with each other.
    const first: SwarmPanelData = {
      kind: 'batch',
      status: 'running',
      agents: [{ jobId: '', sessionId: 'sess-child-4', agentName: 'Kutató', status: 'running' }],
    }
    const second: SwarmPanelData = {
      kind: 'batch',
      status: 'completed',
      agents: [{ jobId: '', sessionId: 'sess-child-4', agentName: 'Kutató', status: 'completed' }],
    }

    const merged = mergeSubagentEvents([first, second])
    assert.ok(merged)
    assert.equal(merged.agents.length, 1)
    assert.equal(merged.agents[0].status, 'completed')
  })

  it('keeps distinct subagents from the same message as separate rows', () => {
    const batch: SwarmPanelData = {
      kind: 'batch',
      status: 'running',
      agents: [
        { jobId: 'job-a', sessionId: 'sess-a', agentName: 'Fejlesztő', status: 'running' },
        { jobId: 'job-b', sessionId: 'sess-b', agentName: 'Kutató', status: 'completed' },
      ],
    }

    const merged = mergeSubagentEvents([batch])
    assert.ok(merged)
    assert.equal(merged.agents.length, 2)
    assert.equal(merged.kind, 'batch')
  })

  it('does not merge two identity-less placeholder members from different events', () => {
    const startedA: SwarmPanelData = {
      kind: 'batch',
      status: 'running',
      agents: [{ jobId: '', agentName: 'Agent 1', status: 'running' }],
    }
    const startedB: SwarmPanelData = {
      kind: 'batch',
      status: 'running',
      agents: [{ jobId: '', agentName: 'Agent 1', status: 'running' }],
    }

    const merged = mergeSubagentEvents([startedA, startedB])
    assert.ok(merged)
    assert.equal(merged.agents.length, 2)
  })
})
