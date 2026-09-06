import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { WORKER_ONLY_PROVIDER_IDS } from '@/lib/provider-sets'
import { normalizeStoredRecord } from './storage-normalization'

/**
 * A DELIBERATE DIVERGENCE FROM UPSTREAM, pinned so a merge cannot take it back
 * quietly.
 *
 * Upstream's normalization forces `delegationEnabled = false` for every
 * worker-only provider, on every load. Its premise is that a CLI-provider agent
 * has no host tool loop and therefore nothing to delegate with. On this fork
 * `src/lib/server/platform-mcp.ts` gives it one, so the premise no longer holds
 * and the line is gone.
 *
 * Nothing fails loudly if a merge restores it: an operator ticks "Assign to
 * Other Agents", the UI accepts it, the next load silently clears it, and the
 * orchestrating agent goes back to being unable to hand out work. That silence
 * is what this file exists to break.
 *
 * The two rules that stayed are pinned here too, so removing the whole block by
 * mistake also fails.
 */
describe('worker-only providers and delegation', () => {
  const cliProvider = 'claude-cli'

  const normalizeOne = (agent: Record<string, unknown>) => {
    const { value } = normalizeStoredRecord('agents', { id: 'a1', name: 'A', ...agent }, () => null)
    return value as Record<string, unknown>
  }

  it('keeps delegation on for a CLI-provider agent whose operator enabled it', () => {
    const out = normalizeOne({ provider: cliProvider, delegationEnabled: true })
    assert.equal(out.delegationEnabled, true, 'the fork\'s platform MCP bridge is what makes this reachable; see platform-mcp.ts')
  })

  it('still refuses a CLI-provider agent a heartbeat', () => {
    // The expensive one: a CLI provider spends a subscription, and autonomous
    // wakes across a fleet is not a side effect of allowing delegation.
    const out = normalizeOne({ provider: cliProvider, heartbeatEnabled: true })
    assert.equal(out.heartbeatEnabled, false)
  })

  it('still forces a CLI-provider agent to the worker role', () => {
    const out = normalizeOne({ provider: cliProvider, role: 'coordinator' })
    assert.equal(out.role, 'worker')
  })

  it('leaves an API-provider agent alone', () => {
    const out = normalizeOne({ provider: 'anthropic', delegationEnabled: true, heartbeatEnabled: true })
    assert.equal(out.delegationEnabled, true)
    assert.equal(out.heartbeatEnabled, true)
    assert.equal(WORKER_ONLY_PROVIDER_IDS.has('anthropic'), false)
  })
})
