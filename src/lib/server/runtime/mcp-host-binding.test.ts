import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { refreshShimEnv, staleShimVars, type McpHostBinding } from './mcp-host-binding'

/**
 * The incident these tests hold shut: a second SwarmClaw sharing one
 * SWARMCLAW_HOME rewrote `run/port.json`, so the desktop app's shims reached
 * the dev server instead — with the desktop app's access key, which that host
 * refuses. The shim answers `tools/list` with an empty list when the host
 * refuses it (on purpose: a briefly-unreachable host must not cost the agent
 * its server for a whole session), so the only symptom was an agent that
 * quietly had no docs tools. It read as the CLI dropping the server, and the
 * hunt went looking for a peer-server eviction bug that does not exist.
 */
const BINDING: McpHostBinding = { accessKey: 'live-key', portFile: '/live/run/port.json', instanceId: 'live-instance' }

describe('refreshShimEnv', () => {
  it('replaces the stale key and port file an installer baked in, and names the instance', () => {
    const out = refreshShimEnv({ SWARMCLAW_ACCESS_KEY: 'old-key', SWARMCLAW_PORT_FILE: '/old/port.json' }, BINDING)
    assert.deepEqual(out, {
      SWARMCLAW_ACCESS_KEY: 'live-key',
      SWARMCLAW_PORT_FILE: '/live/run/port.json',
      SWARMCLAW_INSTANCE_ID: 'live-instance',
    })
  })

  it('supplies the key to an entry that stores only the port file', () => {
    // The shape an installer prints now: the key is not stored at all, so
    // storage cannot hold a stale copy of it and cannot leak one either. The
    // host is the only place the live value exists.
    const out = refreshShimEnv({ SWARMCLAW_PORT_FILE: '/live/run/port.json' }, BINDING)
    assert.deepEqual(out, {
      SWARMCLAW_ACCESS_KEY: 'live-key',
      SWARMCLAW_PORT_FILE: '/live/run/port.json',
      SWARMCLAW_INSTANCE_ID: 'live-instance',
    })
  })

  it('leaves a third-party stdio server alone rather than handing it the access key', () => {
    // The whole point of gating on "already declares one of ours": an operator's
    // own MCP server is a local program, and being assigned to an agent is not
    // a reason to give it the host's credentials.
    const env = { SOME_TOKEN: 'theirs' }
    assert.equal(refreshShimEnv(env, BINDING), env)
  })

  it('keeps the shim env other variables', () => {
    const out = refreshShimEnv({ SWARMCLAW_PORT_FILE: '/old/port.json', EXTRA: 'keep' }, BINDING)
    assert.equal(out.EXTRA, 'keep')
    assert.equal(out.SWARMCLAW_PORT_FILE, '/live/run/port.json')
  })

  it('writes no access key when the host runs without one', () => {
    // A blank value would defeat the shim's own "is a key set" test, which is
    // what tells "no key configured" from "the wrong key".
    const out = refreshShimEnv({ SWARMCLAW_ACCESS_KEY: 'old-key' }, { ...BINDING, accessKey: '' })
    assert.equal(out.SWARMCLAW_ACCESS_KEY, 'old-key')
  })
})

describe('staleShimVars', () => {
  it('names each host-bound variable the registration got wrong', () => {
    assert.deepEqual(
      staleShimVars({ SWARMCLAW_ACCESS_KEY: 'old-key', SWARMCLAW_PORT_FILE: '/old/port.json' }, BINDING),
      ['SWARMCLAW_ACCESS_KEY', 'SWARMCLAW_PORT_FILE'],
    )
  })

  it('is silent for a registration that is still current', () => {
    assert.deepEqual(
      staleShimVars({ SWARMCLAW_ACCESS_KEY: 'live-key', SWARMCLAW_PORT_FILE: '/live/run/port.json' }, BINDING),
      [],
    )
  })

  it('does not call an absent key stale, because absent is the shape we want', () => {
    // Reporting this would tell the operator to repair the very thing the
    // installer stopped writing on purpose.
    assert.deepEqual(staleShimVars({ SWARMCLAW_PORT_FILE: '/live/run/port.json' }, BINDING), [])
  })

  it('is silent for a server that is not one of our shims', () => {
    assert.deepEqual(staleShimVars({ SOME_TOKEN: 'theirs' }, BINDING), [])
  })
})
