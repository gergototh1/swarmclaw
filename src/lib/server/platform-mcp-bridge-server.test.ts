import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { findPlatformBridgeServerIds, withPlatformBridge } from './platform-mcp-bridge-server'

/*
 * A platform-híd nem per-agent beállítás kérdése.
 *
 * A híd a SwarmClaw SAJÁT tooljait adja, és azt, hogy egy agent mit kap belőle,
 * már az agent saját capability-listája dönti el (`toolsForAgent` ->
 * `getEnabledCapabilityIds` + `delegationEnabled`). Az `mcpServerIds` mező
 * ezzel szemben csak annyit mondott meg, hogy a híd egyáltalán ELINDUL-e --
 * és három agentnél (Fejlesztő, Kutató, Ügyfélkezelő) nem volt bejelölve, tehát
 * a memória-írás, az ébresztő és a delegálás közülük egyikhez sem jutott el.
 *
 * Rosszabb: ezek az agentek a felidézési blokkot MEGKAPTÁK, benne a rubrikával,
 * ami egy olyan `memory` tool használatára utasítja őket, ami náluk nem
 * létezik.
 *
 * Ezért a hidat mindig hozzáfűzzük, az agent saját listája mellé. Ez nem
 * jogosultság-bővítés: amit az agent nem engedélyezett magának, azt a híd
 * továbbra sem adja oda.
 */
const PLATFORM = {
  id: 'ca57d040',
  name: 'Platform MCP',
  transport: 'stdio',
  command: '/usr/local/bin/node',
  args: ['/Users/x/Library/Application Support/@swarmclawai/swarmclaw/home/data/mcp/platform-server.mjs'],
}
const REPO_PLATFORM = {
  id: 'repo1',
  name: 'Platform',
  transport: 'stdio',
  command: 'node',
  args: ['/Users/x/DEV/swarmclaw/scripts/platform-mcp/server.mjs'],
}
const GMAIL = {
  id: 'ba9b0da5',
  name: 'Gmail MCP',
  transport: 'stdio',
  command: 'node',
  args: ['/Users/x/data/extensions/gmail/mcp/server.mjs'],
}
const REMOTE = {
  id: 'r1',
  name: 'Remote thing',
  transport: 'streamable-http',
  url: 'https://example.invalid/mcp',
}

describe('findPlatformBridgeServerIds', () => {
  it('finds the installed shim by its file name', () => {
    assert.deepEqual(findPlatformBridgeServerIds({ ca57d040: PLATFORM, ba9b0da5: GMAIL }), ['ca57d040'])
  })

  it('finds the shim as it sits in the repo checkout', () => {
    assert.deepEqual(findPlatformBridgeServerIds({ repo1: REPO_PLATFORM }), ['repo1'])
  })

  it('does not mistake another extension shim for the bridge', () => {
    // Every extension ships an `mcp/server.mjs`; only the platform one counts.
    assert.deepEqual(findPlatformBridgeServerIds({ ba9b0da5: GMAIL }), [])
  })

  it('ignores a server someone else runs', () => {
    // A url transport is not this host's bridge, whatever it is called.
    assert.deepEqual(findPlatformBridgeServerIds({ r1: { ...REMOTE, name: 'Platform MCP' } }), [])
  })

  it('returns nothing when no bridge is registered', () => {
    assert.deepEqual(findPlatformBridgeServerIds({}), [])
  })
})

describe('withPlatformBridge', () => {
  const all = { ca57d040: PLATFORM, ba9b0da5: GMAIL }

  it('adds the bridge to an agent that has none assigned', () => {
    assert.deepEqual(withPlatformBridge([], all), ['ca57d040'])
    assert.deepEqual(withPlatformBridge(null, all), ['ca57d040'])
  })

  it('keeps the agent\'s own servers and does not duplicate the bridge', () => {
    assert.deepEqual(withPlatformBridge(['ba9b0da5', 'ca57d040'], all), ['ba9b0da5', 'ca57d040'])
  })

  it('puts the agent\'s own servers first, so a name clash renames the bridge', () => {
    assert.deepEqual(withPlatformBridge(['ba9b0da5'], all), ['ba9b0da5', 'ca57d040'])
  })

  it('changes nothing when no bridge is registered', () => {
    assert.deepEqual(withPlatformBridge(['ba9b0da5'], { ba9b0da5: GMAIL }), ['ba9b0da5'])
  })

  it('drops blank ids rather than passing them on', () => {
    assert.deepEqual(withPlatformBridge(['', '  ', 'ba9b0da5'], all), ['ba9b0da5', 'ca57d040'])
  })
})
