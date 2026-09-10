import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseSwarmOutput, parseSwarmStatusOutput } from './swarm-panel'

describe('parseSwarmOutput', () => {
  it('returns null for non-spawn_subagent tools', () => {
    assert.equal(parseSwarmOutput('execute_command', '{}'), null)
    assert.equal(parseSwarmOutput('delegate_to_agent', '{}'), null)
  })

  it('returns null for invalid JSON', () => {
    assert.equal(parseSwarmOutput('spawn_subagent', 'not json'), null)
  })

  it('returns null for unrecognized output shapes', () => {
    assert.equal(parseSwarmOutput('spawn_subagent', '{"foo":"bar"}'), null)
  })

  it('parses batch running output', () => {
    const output = JSON.stringify({
      action: 'batch',
      status: 'running',
      jobIds: ['job-1', 'job-2', 'job-3'],
      taskCount: 3,
    })

    const result = parseSwarmOutput('spawn_subagent', output)
    assert.ok(result)
    assert.equal(result.kind, 'batch')
    assert.equal(result.status, 'running')
    assert.equal(result.agents.length, 3)
    assert.deepEqual(result.jobIds, ['job-1', 'job-2', 'job-3'])
    assert.equal(result.agents[0].status, 'running')
    assert.equal(result.agents[0].agentName, 'Agent 1')
  })

  it('parses batch completed output', () => {
    const output = JSON.stringify({
      action: 'batch',
      status: 'completed',
      jobIds: ['job-1', 'job-2'],
      completed: 1,
      failed: 1,
      cancelled: 0,
      timedOut: 0,
      totalDurationMs: 5000,
      results: [
        { jobId: 'job-1', agentName: 'Research Agent', status: 'completed', response: 'Found results' },
        { jobId: 'job-2', agentName: 'Code Agent', status: 'failed', error: 'Compilation error' },
      ],
    })

    const result = parseSwarmOutput('spawn_subagent', output)
    assert.ok(result)
    assert.equal(result.kind, 'batch')
    assert.equal(result.status, 'partial') // has failures
    assert.equal(result.agents.length, 2)
    assert.equal(result.completed, 1)
    assert.equal(result.failed, 1)
    assert.equal(result.totalDurationMs, 5000)

    assert.equal(result.agents[0].agentName, 'Research Agent')
    assert.equal(result.agents[0].status, 'completed')
    assert.equal(result.agents[0].response, 'Found results')

    assert.equal(result.agents[1].agentName, 'Code Agent')
    assert.equal(result.agents[1].status, 'failed')
    assert.equal(result.agents[1].error, 'Compilation error')
  })

  it('parses batch completed all-success output', () => {
    const output = JSON.stringify({
      action: 'batch',
      status: 'completed',
      jobIds: ['job-1'],
      completed: 1,
      failed: 0,
      cancelled: 0,
      timedOut: 0,
      totalDurationMs: 2000,
      results: [
        { jobId: 'job-1', agentName: 'Solo Agent', status: 'completed', response: 'Done' },
      ],
    })

    const result = parseSwarmOutput('spawn_subagent', output)
    assert.ok(result)
    assert.equal(result.status, 'completed') // no failures
  })

  it('parses single spawn running output', () => {
    const output = JSON.stringify({
      jobId: 'job-abc',
      status: 'running',
      agentId: 'research-agent',
      agentName: 'Research Agent',
      sessionId: 'sess-123',
      lineageId: 'lin-456',
      lifecycleState: 'running',
    })

    const result = parseSwarmOutput('spawn_subagent', output)
    assert.ok(result)
    assert.equal(result.kind, 'single')
    assert.equal(result.status, 'running')
    assert.equal(result.agents.length, 1)
    assert.equal(result.agents[0].agentName, 'Research Agent')
    assert.equal(result.agents[0].status, 'running')
    assert.equal(result.agents[0].lineageId, 'lin-456')
  })

  it('parses single spawn completed output', () => {
    const output = JSON.stringify({
      jobId: 'job-xyz',
      status: 'completed',
      agentId: 'code-agent',
      agentName: 'Code Agent',
      sessionId: 'sess-789',
      lineageId: 'lin-012',
      response: 'All tests passing',
      depth: 1,
      childCount: 0,
      durationMs: 15000,
      stateHistory: [],
    })

    const result = parseSwarmOutput('spawn_subagent', output)
    assert.ok(result)
    assert.equal(result.kind, 'single')
    assert.equal(result.status, 'completed')
    assert.equal(result.agents[0].agentName, 'Code Agent')
    assert.equal(result.agents[0].response, 'All tests passing')
    assert.equal(result.agents[0].durationMs, 15000)
    assert.equal(result.completed, 1)
    assert.equal(result.totalDurationMs, 15000)
  })

  it('parses single spawn failed output', () => {
    const output = JSON.stringify({
      jobId: 'job-fail',
      status: 'failed',
      agentId: 'bad-agent',
      agentName: 'Bad Agent',
      sessionId: 'sess-bad',
      error: 'Connection timeout',
    })

    const result = parseSwarmOutput('spawn_subagent', output)
    assert.ok(result)
    assert.equal(result.kind, 'single')
    assert.equal(result.status, 'failed')
    assert.equal(result.agents[0].error, 'Connection timeout')
    assert.equal(result.failed, 1)
  })

  it('parses swarm completed output with snapshot', () => {
    const output = JSON.stringify({
      action: 'swarm',
      status: 'completed',
      swarmId: 'swarm-1',
      snapshot: {
        swarmId: 'swarm-1',
        parentSessionId: 'parent-1',
        status: 'completed',
        createdAt: 1000,
        completedAt: 5000,
        memberCount: 2,
        completedCount: 2,
        failedCount: 0,
        members: [
          { index: 0, agentId: 'a1', agentName: 'Agent A', jobId: 'j1', sessionId: 's1', task: 'Do X', status: 'completed', resultPreview: 'Done X', error: null, durationMs: 2000 },
          { index: 1, agentId: 'a2', agentName: 'Agent B', jobId: 'j2', sessionId: 's2', task: 'Do Y', status: 'completed', resultPreview: 'Done Y', error: null, durationMs: 3000 },
        ],
      },
    })

    const result = parseSwarmOutput('spawn_subagent', output)
    assert.ok(result)
    assert.equal(result.kind, 'batch')
    assert.equal(result.status, 'completed')
    assert.equal(result.agents.length, 2)
    assert.equal(result.agents[0].agentName, 'Agent A')
    assert.equal(result.agents[0].response, 'Done X')
    assert.equal(result.agents[1].agentName, 'Agent B')
    assert.equal(result.completed, 2)
    assert.equal(result.failed, 0)
  })

  it('parses swarm running output without snapshot', () => {
    const output = JSON.stringify({
      action: 'swarm',
      status: 'running',
      swarmId: 'swarm-2',
      memberCount: 3,
    })

    const result = parseSwarmOutput('spawn_subagent', output)
    assert.ok(result)
    assert.equal(result.kind, 'batch')
    assert.equal(result.status, 'running')
    assert.equal(result.agents.length, 3)
    assert.equal(result.agents[0].status, 'running')
  })

  it('parses swarm with spawn errors as failed', () => {
    const output = JSON.stringify({
      action: 'swarm',
      status: 'partial',
      swarmId: 'swarm-3',
      snapshot: {
        swarmId: 'swarm-3',
        status: 'partial',
        memberCount: 2,
        completedCount: 1,
        failedCount: 1,
        members: [
          { index: 0, agentId: 'a1', agentName: 'OK Agent', status: 'completed', resultPreview: 'Done', error: null, durationMs: 1000 },
          { index: 1, agentId: '', agentName: '', status: 'spawn_error', resultPreview: null, error: 'Agent not found', durationMs: 0 },
        ],
      },
    })

    const result = parseSwarmOutput('spawn_subagent', output)
    assert.ok(result)
    assert.equal(result.status, 'partial')
    assert.equal(result.agents[1].status, 'failed') // spawn_error mapped to failed
    assert.equal(result.agents[1].error, 'Agent not found')
  })
})

describe('parseSwarmStatusOutput', () => {
  it('returns null for non-swarm output', () => {
    assert.equal(parseSwarmStatusOutput('spawn_subagent', JSON.stringify({ action: 'batch', results: [] })), null)
    assert.equal(parseSwarmStatusOutput('other_tool', '{}'), null)
    assert.equal(parseSwarmStatusOutput('spawn_subagent', 'invalid'), null)
  })

  it('returns null when no snapshot is present', () => {
    assert.equal(parseSwarmStatusOutput('spawn_subagent', JSON.stringify({ action: 'swarm', status: 'running' })), null)
  })

  it('parses swarm output into SwarmStatusData', () => {
    const output = JSON.stringify({
      action: 'swarm',
      swarmId: 'swarm-rich',
      snapshot: {
        swarmId: 'swarm-rich',
        parentSessionId: 'parent-1',
        status: 'completed',
        createdAt: 1000,
        completedAt: 5000,
        memberCount: 2,
        completedCount: 2,
        failedCount: 0,
        members: [
          { index: 0, agentId: 'researcher', agentName: 'Researcher', jobId: 'j1', sessionId: 's1', task: 'Research APIs', status: 'completed', resultPreview: 'Found 3 APIs', error: null, durationMs: 2500 },
          { index: 1, agentId: 'coder', agentName: 'Coder', jobId: 'j2', sessionId: 's2', task: 'Write code', status: 'completed', resultPreview: 'Module ready', error: null, durationMs: 4000 },
        ],
      },
    })

    const result = parseSwarmStatusOutput('spawn_subagent', output)
    assert.ok(result)
    assert.equal(result.swarmId, 'swarm-rich')
    assert.equal(result.status, 'completed')
    assert.equal(result.memberCount, 2)
    assert.equal(result.completedCount, 2)
    assert.equal(result.members.length, 2)
    assert.equal(result.members[0].agentName, 'Researcher')
    assert.equal(result.members[0].task, 'Research APIs')
    assert.equal(result.members[1].resultPreview, 'Module ready')
    assert.equal(result.parentAgentName, 'Delegating Agent')
  })
})

/*
 * A sessionId a kapocs a transzkript és a gyerek beszélgetés között.
 * A tool már küldi (subagent.ts:574,588) -- a parser eddig eldobta, és
 * enélkül az inline sor nem tud hova kattintani.
 */
describe('parseSwarmOutput keeps the child session id', () => {
  it('keeps it on a running single spawn', () => {
    const data = parseSwarmOutput('spawn_subagent', JSON.stringify({
      jobId: 'job-1', status: 'running', agentId: 'a1',
      agentName: 'Fejlesztő', sessionId: 'sess-child-1', lineageId: 'ln-1',
    }))
    assert.equal(data?.agents[0].sessionId, 'sess-child-1')
  })

  it('keeps it on a completed single spawn', () => {
    const data = parseSwarmOutput('spawn_subagent', JSON.stringify({
      jobId: 'job-1', status: 'completed', agentId: 'a1',
      agentName: 'Fejlesztő', sessionId: 'sess-child-1',
      response: 'Kész.', durationMs: 120_000,
    }))
    assert.equal(data?.agents[0].sessionId, 'sess-child-1')
  })

  it('keeps it for every member of a batch', () => {
    const data = parseSwarmOutput('spawn_subagent', JSON.stringify({
      action: 'batch', completed: 2, failed: 0,
      results: [
        { jobId: 'j1', agentName: 'Fejlesztő', status: 'completed', sessionId: 'sess-1' },
        { jobId: 'j2', agentName: 'Tesztelő', status: 'completed', sessionId: 'sess-2' },
      ],
    }))
    assert.deepEqual(data?.agents.map((a) => a.sessionId), ['sess-1', 'sess-2'])
  })

  it('keeps it for every member of a swarm snapshot', () => {
    const data = parseSwarmOutput('spawn_subagent', JSON.stringify({
      action: 'swarm',
      snapshot: {
        status: 'completed', completedCount: 1, failedCount: 0,
        members: [{ jobId: 'j1', agentId: 'a1', agentName: 'Fejlesztő', status: 'completed', sessionId: 'sess-1' }],
      },
    }))
    assert.equal(data?.agents[0].sessionId, 'sess-1')
  })

  it('leaves it undefined when the spawn has not produced a session yet', () => {
    const data = parseSwarmOutput('spawn_subagent', JSON.stringify({
      action: 'batch', status: 'running', jobIds: ['j1', 'j2'],
    }))
    assert.equal(data?.agents[0].sessionId, undefined)
  })
})

/*
 * The unit tests above all pass against fixtures shaped from the plan's
 * *assumptions*. None of them exercise what data/swarmclaw.db actually
 * stores, which is why the inline subagent row was dead in production while
 * this file was green. These fixtures come from real toolEvents rows in a
 * live install (session 6c24aacf, agent "Fejlesztő", verified with sqlite3
 * against data/swarmclaw.db) instead of from the plan.
 */
describe('parseSwarmOutput against real production payloads', () => {
  it('matches the namespaced tool name the MCP bridge actually sends', () => {
    // Every real record names the tool mcp__<server>__spawn_subagent. The
    // server name is operator configuration -- assert two different server
    // names both work, proving the match isn't hardcoded to "Platform-MCP".
    const output = JSON.stringify({
      jobId: 'job-1', status: 'running', agentId: 'a1',
      agentName: 'Fejlesztő', sessionId: 'sess-1',
    })
    assert.ok(parseSwarmOutput('mcp__Platform-MCP__spawn_subagent', output))
    assert.ok(parseSwarmOutput('mcp__Some-Other-Server__spawn_subagent', output))
    // A tool name that merely contains the string must not match.
    assert.equal(parseSwarmOutput('spawn_subagent_and_wait', output), null)
    assert.equal(parseSwarmOutput('mcp__Platform-MCP__spawn_subagent_v2', output), null)
  })

  it('unwraps the double-JSON-encoded output real records store', () => {
    // The DB stores `output` as a JSON string whose content is itself JSON.
    // A single JSON.parse yields a string, not an object.
    const inner = { jobId: 'job-1', status: 'running', agentId: 'a1', agentName: 'Fejlesztő', sessionId: 'sess-1' }
    const doubleEncoded = JSON.stringify(JSON.stringify(inner))
    const data = parseSwarmOutput('mcp__Platform-MCP__spawn_subagent', doubleEncoded)
    assert.ok(data)
    assert.equal(data.agents[0].sessionId, 'sess-1')
  })

  it('still parses a normal single-encoded output (does not double-unwrap)', () => {
    const singleEncoded = JSON.stringify({ jobId: 'job-1', status: 'running', agentId: 'a1', agentName: 'Fejlesztő', sessionId: 'sess-1' })
    const data = parseSwarmOutput('mcp__Platform-MCP__spawn_subagent', singleEncoded)
    assert.ok(data)
    assert.equal(data.agents[0].sessionId, 'sess-1')
  })

  it('returns null rather than throwing when the inner string is not valid JSON', () => {
    const doubleEncoded = JSON.stringify('not json')
    assert.equal(parseSwarmOutput('mcp__Platform-MCP__spawn_subagent', doubleEncoded), null)
  })

  it('parses the real "start" (running) job record — namespaced + double-encoded', () => {
    // Verbatim shape from job 6677d7b5092c1234a863 while still running.
    const inner = {
      jobId: '6677d7b5092c1234a863', status: 'running', selectionMode: 'explicit',
      agentId: '777e99a7', agentName: 'Fejlesztő', sessionId: '86142d3d',
      lineageId: '39682af6bca753c34d95', workType: null, requiredCapabilities: [],
    }
    const output = JSON.stringify(JSON.stringify(inner))
    const data = parseSwarmOutput('mcp__Platform-MCP__spawn_subagent', output)
    assert.ok(data)
    assert.equal(data.kind, 'single')
    assert.equal(data.status, 'running')
    assert.equal(data.agents[0].jobId, '6677d7b5092c1234a863')
    assert.equal(data.agents[0].sessionId, '86142d3d')
    assert.equal(data.agents[0].agentName, 'Fejlesztő')
  })

  it('parses the real terminal job record — failed (timed out), no jobId/sessionId keys at all', () => {
    // Verbatim shape (only pruned of the long `task` text) from the SAME job
    // (6677d7b5092c1234a863) once it reached its terminal state: the job id
    // moved to `id`, the child session moved to `childSessionId`, and there
    // is no `jobId` key anywhere on the record.
    const inner = {
      id: '6677d7b5092c1234a863', kind: 'subagent', status: 'failed', backend: null,
      parentSessionId: null, childSessionId: '86142d3d', agentId: '777e99a7',
      agentName: 'Fejlesztő', cwd: '/Users/tothgergo/DEV/swarmclaw', task: 'Javítandó bug…',
      startedAt: 1788979887034, createdAt: 1788979887031, updatedAt: 1788980487091,
      completedAt: null, result: null, resultPreview: null, error: null,
      artifacts: [], checkpoints: [
        { at: 1788979887031, note: 'Job queued', status: 'queued' },
        { at: 1788979887032, note: 'Initializing subagent Fejlesztő', status: 'queued' },
        { at: 1788979887034, note: 'Created child session 86142d3d', status: 'running' },
        { at: 1788980487091, note: 'Subagent timed out after 600s', status: 'failed' },
      ],
      lineage: { id: '39682af6bca753c34d95', depth: 0, status: 'failed', parentSessionId: null, childCount: 0, ancestors: [] },
      resumeId: null, resumeIds: {},
    }
    assert.equal('jobId' in inner, false)
    const output = JSON.stringify(JSON.stringify(inner))
    const data = parseSwarmOutput('mcp__Platform-MCP__spawn_subagent', output)
    assert.ok(data, 'a kind:"subagent" terminal record must produce a row, not null')
    assert.equal(data.kind, 'single')
    assert.equal(data.status, 'failed')
    assert.equal(data.agents[0].jobId, '6677d7b5092c1234a863') // from `id`, not `jobId`
    assert.equal(data.agents[0].sessionId, '86142d3d') // from `childSessionId`, not `sessionId`
    assert.equal(data.agents[0].status, 'failed')
    assert.equal(data.agents[0].agentName, 'Fejlesztő')
    assert.equal(data.failed, 1)
    // completedAt is null on every real terminal record seen; duration is
    // derived from updatedAt (the last checkpoint write) instead, never left
    // as the wrong/stale value.
    assert.equal(data.agents[0].durationMs, 1788980487091 - 1788979887031)
    assert.equal(data.totalDurationMs, 600060)
  })

  it('parses the real terminal job record — completed', () => {
    // Verbatim shape from job d9c7461e5c8125d96a39.
    const inner = {
      id: 'd9c7461e5c8125d96a39', kind: 'subagent', status: 'completed', backend: null,
      parentSessionId: null, childSessionId: '09c54c5b', agentId: '777e99a7',
      agentName: 'Fejlesztő', cwd: '/Users/tothgergo/DEV/swarmclaw', task: 'Egy másik feladat',
      startedAt: 1788982811217, createdAt: 1788982811216, updatedAt: 1788983000235,
      completedAt: null, result: null, resultPreview: null, error: null,
      artifacts: [], checkpoints: [
        { at: 1788982811216, note: 'Job queued', status: 'queued' },
        { at: 1788982811217, note: 'Created child session 09c54c5b', status: 'running' },
        { at: 1788983000235, note: 'Child session completed', status: 'completed' },
      ],
      lineage: { id: '4c025352819ccdbe0a80', depth: 0, status: 'completed', parentSessionId: null, childCount: 0, ancestors: [] },
      resumeId: null, resumeIds: {},
    }
    const output = JSON.stringify(JSON.stringify(inner))
    const data = parseSwarmOutput('mcp__Platform-MCP__spawn_subagent', output)
    assert.ok(data)
    assert.equal(data.status, 'completed')
    assert.equal(data.agents[0].sessionId, '09c54c5b')
    assert.equal(data.completed, 1)
    assert.equal(data.agents[0].durationMs, 1788983000235 - 1788982811216)
  })

  it('parses a still-running "kind: subagent" poll record (childSessionId set, no jobId, no completion time yet)', () => {
    // Real mid-flight shape: the job already has a child session, but is
    // still `status: "running"`, and has neither jobId nor a usable end
    // time -- durationMs must stay undefined rather than showing 0 or a
    // wrong number that would grow on every re-render.
    const inner = {
      id: '3990cb4d73f3745ceaff', kind: 'subagent', status: 'running',
      childSessionId: '7e78382a', agentId: '777e99a7', agentName: 'Fejlesztő',
      createdAt: 1788983406972, updatedAt: 1788983406974, completedAt: null,
      result: null, resultPreview: null, error: null, artifacts: [],
      checkpoints: [{ at: 1788983406972, note: 'Job queued', status: 'queued' }],
      lineage: null, resumeId: null, resumeIds: {},
    }
    const output = JSON.stringify(JSON.stringify(inner))
    const data = parseSwarmOutput('mcp__Platform-MCP__spawn_subagent', output)
    assert.ok(data)
    assert.equal(data.status, 'running')
    assert.equal(data.agents[0].sessionId, '7e78382a')
    assert.equal(data.agents[0].durationMs, undefined)
  })
})
