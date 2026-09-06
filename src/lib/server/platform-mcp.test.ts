import assert from 'node:assert/strict'
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
