import assert from 'node:assert/strict'
import test from 'node:test'

import { createMcpBridge } from '../src/mcp-bridge.mjs'
import aisignal from '../index.mjs'

/**
 * The bridge is what an agent on a CLI provider reaches instead of the
 * extension tool layer, which that provider never receives. Every case here is
 * a way the trip through MCP could quietly change what the tool sees.
 */

const tools = () => [
  {
    name: 'echo',
    description: 'gives back what it got',
    parameters: { type: 'object', properties: { a: { type: 'string' } } },
    execute: (args, ctx) => ({ args, ctx }),
  },
  { name: 'bare', execute: () => ({ ok: true }) },
]

test('mcpTools renames parameters to inputSchema and changes nothing else', () => {
  const { mcpTools } = createMcpBridge(tools)
  const listed = mcpTools().tools
  assert.deepEqual(listed[0], {
    name: 'echo',
    description: 'gives back what it got',
    inputSchema: { type: 'object', properties: { a: { type: 'string' } } },
  })
})

test('a tool with no schema is advertised as taking an empty object, not dropped', () => {
  // Omitting it would hide a working tool, and MCP has no way to say
  // "arguments unspecified".
  const { mcpTools } = createMcpBridge(tools)
  const bare = mcpTools().tools.find((t) => t.name === 'bare')
  assert.deepEqual(bare, { name: 'bare', description: '', inputSchema: { type: 'object', properties: {} } })
})

test('mcpTools reads the tools on every call rather than capturing them', () => {
  let current = [{ name: 'first', execute: () => ({}) }]
  const { mcpTools } = createMcpBridge(() => current)
  assert.deepEqual(mcpTools().tools.map((t) => t.name), ['first'])
  current = [{ name: 'second', execute: () => ({}) }]
  assert.deepEqual(mcpTools().tools.map((t) => t.name), ['second'])
})

test('mcpCall runs the named tool and forwards its arguments unchanged', async () => {
  const { mcpCall } = createMcpBridge(tools)
  const out = await mcpCall({ tool: 'echo', args: { a: 'x' } })
  assert.deepEqual(out.args, { a: 'x' })
})

test('mcpCall builds the session shape a tool expects from the stamped caller', async () => {
  const { mcpCall } = createMcpBridge(tools)
  const out = await mcpCall({ tool: 'echo', args: {}, agentId: 'a1', agentName: 'Signal Scout', sessionId: 's1' })
  assert.equal(out.ctx.session.agentId, 'a1')
  assert.equal(out.ctx.session.id, 's1')
  // The docs extension reads the folder name off agentRecord; without it the
  // slug falls back to the head of the id.
  assert.deepEqual(out.ctx.session.agentRecord, { id: 'a1', name: 'Signal Scout' })
})

test('a missing caller leaves the session blank rather than inventing one', async () => {
  // A tool that gates on the caller must see "nobody" and refuse, not see a
  // plausible-looking stand-in and let the call through.
  const { mcpCall } = createMcpBridge(tools)
  const out = await mcpCall({ tool: 'echo', args: {} })
  assert.equal(out.ctx.session.agentId, null)
  assert.equal(out.ctx.session.id, null)
  assert.equal('agentRecord' in out.ctx.session, false)
})

test('an empty-string caller is treated as absent', async () => {
  const { mcpCall } = createMcpBridge(tools)
  const out = await mcpCall({ tool: 'echo', args: {}, agentId: '', agentName: '' })
  assert.equal(out.ctx.session.agentId, null)
  assert.equal('agentRecord' in out.ctx.session, false)
})

test('mcpCall refuses an unknown tool as a value and names the ones that exist', async () => {
  // A 500 here would read to the agent as "the extension is broken" and it
  // would stop rather than correct the name.
  const { mcpCall } = createMcpBridge(tools)
  const out = await mcpCall({ tool: 'nincs_ilyen', args: {} })
  assert.equal(out.error.code, 'mcp_ismeretlen_tool')
  assert.match(out.error.message, /echo/)
})

test('mcpCall refuses a body with no tool name', async () => {
  const { mcpCall } = createMcpBridge(tools)
  assert.equal((await mcpCall({})).error.code, 'mcp_rossz_keres')
  assert.equal((await mcpCall({ tool: '' })).error.code, 'mcp_rossz_keres')
})

test('a non-object args becomes an empty object rather than reaching the tool', async () => {
  const { mcpCall } = createMcpBridge(tools)
  assert.deepEqual((await mcpCall({ tool: 'echo', args: 'nem objektum' })).args, {})
})

test("a tool's own throw is left to propagate, so the host reports it", async () => {
  const { mcpCall } = createMcpBridge(() => [{ name: 'dobo', execute: () => { throw new Error('belso hiba') } }])
  await assert.rejects(() => mcpCall({ tool: 'dobo', args: {} }), /belso hiba/)
})

/** The wiring the host actually reads is the one on the manifest. */
test('every tool the extension declares is reachable over the bridge', () => {
  const listed = aisignal.rpc.mcpTools().tools.map((t) => t.name)
  assert.deepEqual(listed, aisignal.tools.map((t) => t.name))
  assert.ok(listed.includes('signalSweep'), 'the sweep tool is the one the agents actually run')
})
