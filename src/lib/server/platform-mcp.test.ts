import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import { PLATFORM_MCP_TOOL_NAMES } from './platform-mcp'

/**
 * This bridge is the one place where SwarmClaw's own tools leave the process
 * that owns their gates, so what it may and may not offer is worth pinning.
 * The gate behaviour itself is not re-tested here: the bridge deliberately owns
 * no gate, it hands the whole decision to `buildSessionTools()`. What IS tested
 * is that the list stays an allow-list, and that the families a CLI provider
 * already has never appear on it.
 */
describe('PLATFORM_MCP_TOOL_NAMES', () => {
  it('offers the coordination tools, which are the reason the bridge exists', () => {
    for (const name of ['spawn_subagent', 'manage_tasks', 'manage_agents', 'manage_schedules']) {
      assert.ok(PLATFORM_MCP_TOOL_NAMES.includes(name), `${name} must be reachable or an agent cannot direct another`)
    }
  })

  it('never offers a family the CLI provider already ships', () => {
    // A second `files` next to Claude Code's own file tools gives the model two
    // ways to do one thing and a reason to pick wrong.
    const cliOwns = [
      'shell', 'execute', 'files', 'edit_file',
      'web', 'web_search', 'web_fetch', 'web_extract', 'web_crawl',
      'browser', 'openclaw_browser', 'extension_creator_tool',
    ]
    for (const name of cliOwns) {
      assert.equal(PLATFORM_MCP_TOOL_NAMES.includes(name), false, `${name} duplicates a tool the CLI already has`)
    }
  })

  it('does not offer `delegate`, which would be Claude Code delegating to Claude Code', () => {
    // Every agent reaching this bridge already runs on a coding CLI, so this
    // tool would spend a second subscription to do what the caller was about
    // to do itself. Agent-to-agent delegation is spawn_subagent.
    assert.equal(PLATFORM_MCP_TOOL_NAMES.includes('delegate'), false)
  })

  it('has no duplicates, so a name cannot be advertised twice', () => {
    assert.equal(new Set(PLATFORM_MCP_TOOL_NAMES).size, PLATFORM_MCP_TOOL_NAMES.length)
  })

  it('is a closed list rather than a pattern', () => {
    // An allow-list is the point: a deny-list would quietly start exporting the
    // next native tool somebody adds to the host.
    for (const name of PLATFORM_MCP_TOOL_NAMES) {
      assert.match(name, /^[a-z][a-z0-9_]*$/, `${name} is not a plain tool name`)
    }
  })
})

/*
 * A híd továbbadja, KI kérdez.
 *
 * A `spawn_subagent` ebből írja a gyerek session `parentSessionId`-jét
 * (`subagent-runtime.ts`: `context.sessionId || null`). Amíg a híd
 * bedrótozott `null`-t adott át, minden CLI-provider ügynök szülő nélküli
 * gyereket hagyott maga után -- és mivel MINDEN ilyen ügynök ezen a hídon jár,
 * a tárolt subagent sessionök egyikén sem volt szülő, tehát semmi nem tudta
 * őket a szülő chathez kötni.
 *
 * Ez forrás-szintű őrszem, nem viselkedési teszt: ez a modul `getAgent`-et és
 * `buildSessionTools`-t hív, amiket kimockolni itt aránytalan lenne. Annyit
 * bizonyít, hogy a bedrótozott `null` nem jön vissza észrevétlenül.
 */
describe('the platform MCP bridge passes the caller session on', () => {
  const src = readFileSync(new URL('./platform-mcp.ts', import.meta.url), 'utf8')

  it('does not hand buildSessionTools a hardcoded null session', () => {
    assert.doesNotMatch(src, /^\s*sessionId:\s*null,/m)
  })

  it('reads the session off the caller stamp', () => {
    assert.match(src, /function callerSessionId\(caller: PlatformMcpCaller\)/)
    assert.match(src, /toolsForAgent\(agentId, callerSessionId\(caller\)\)/)
  })
})
