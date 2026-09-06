import assert from 'node:assert/strict'
import test from 'node:test'

import { createMcpBridge } from '../src/mcp-bridge.mjs'
import { createTervTools } from '../src/terv.mjs'
import { PELDA_JELENETEK, PELDA_NARRACIO, fakeProject, freshRepo } from './helpers.mjs'

/**
 * THE REVIEWER GATE, THROUGH THE BRIDGE.
 *
 * `src/agents.mjs` states the rule this file defends: "THE REVIEWER IS
 * IDENTIFIED BY BEING A DIFFERENT AGENT, NOT BY SAYING SO. `videoVerdict` reads
 * the caller from `ctx.session.agentId`, refuses the plan's own author
 * (`onlektoralas`) and refuses a session with no agent at all
 * (`agent_hianyzik`), because two blanks compare equal and would let a
 * self-review through. One agent cannot run this design, and no argument can
 * name a reviewer."
 *
 * MCP carries no caller identity, so putting these tools behind a shim is
 * exactly the move that could lose that rule without anything failing loudly.
 * It does not, because the caller is not something the agent supplies: the host
 * stamps it into the shim's env when it writes the per-turn MCP config
 * (`addAssignedMcpServers`, src/lib/providers/claude-cli.ts), the shim forwards
 * it, and `mcpCall` builds `ctx.session` from it.
 *
 * The three cases below are the three ways that could go wrong: the gate stops
 * refusing, an agent names itself in the arguments, or a caller-less shim is
 * treated as somebody.
 */

function harness() {
  const { repo } = freshRepo()
  // remotionDir is not optional: without it videoDraft refuses with
  // `remotion_dir_hianyzik` before the gate is ever reached, and every case
  // below would pass while asserting nothing.
  const state = { repo, log: { info() {}, warn() {}, error() {} }, settings: () => ({ remotionDir: fakeProject(), napiSapka: 20 }) }
  const tools = createTervTools(state)
  const { mcpCall } = createMcpBridge(() => tools)
  /** One call as it arrives from the shim: the caller is stamped, never in `args`. */
  const asAgent = (tool, args, agentId) => mcpCall({ tool, args, agentId, sessionId: 's-1' })
  return { repo, mcpCall, asAgent }
}

async function openAndDraft(h, agentId) {
  const opened = await h.asAgent('videoOpen', { forras: 'kezi', szoveg: 'Egy forrásszöveg a tervhez.' }, agentId)
  assert.ok(opened.videoId, `videoOpen failed: ${JSON.stringify(opened)}`)
  const drafted = await h.asAgent('videoDraft', {
    videoId: opened.videoId,
    // The suite's own known-good scenes: this file is about the gate, and a
    // hand-written scene set only re-tests the catalogue validator.
    jelenetek: PELDA_JELENETEK,
    narracio: PELDA_NARRACIO,
  }, agentId)
  assert.ok(drafted.tervId, `videoDraft failed, so the gate is never reached: ${JSON.stringify(drafted)}`)
  return { opened, drafted }
}

test('the author cannot pass their own plan through the bridge', async () => {
  const h = harness()
  const { drafted } = await openAndDraft(h, 'video-gyarto')
  const out = await h.asAgent('videoVerdict', { tervId: drafted.tervId, verdikt: 'atmegy' }, 'video-gyarto')
  assert.equal(out.error?.code ?? out.kod, 'onlektoralas', `self-review was not refused: ${JSON.stringify(out)}`)
})

test('an agent naming itself in the arguments is not the caller', async () => {
  // This is the attack the rule exists for: the argument stays inside `args`,
  // where the tool sees it as data, and the caller stays the stamped one.
  const h = harness()
  const { drafted } = await openAndDraft(h, 'video-gyarto')
  const out = await h.mcpCall({
    tool: 'videoVerdict',
    args: { tervId: drafted.tervId, verdikt: 'atmegy', agentId: 'video-lektor' },
    agentId: 'video-gyarto',
    sessionId: 's-1',
  })
  assert.equal(out.error?.code ?? out.kod, 'onlektoralas', `an argument named the reviewer: ${JSON.stringify(out)}`)
})

test('a shim the host never stamped has no caller, and the gate refuses it', async () => {
  // Two blanks compare equal, so an unstamped shim must be refused rather than
  // read as "some agent". This is what a misconfigured MCP entry looks like.
  const h = harness()
  const { drafted } = await openAndDraft(h, 'video-gyarto')
  const out = await h.mcpCall({ tool: 'videoVerdict', args: { tervId: drafted.tervId, verdikt: 'atmegy' } })
  assert.equal(out.error?.code ?? out.kod, 'agent_hianyzik', `an unstamped caller got through: ${JSON.stringify(out)}`)
})

test('a different agent is accepted, so the gate refuses the right thing and not everything', async () => {
  // A gate that refused every verdict would pass the three tests above while
  // making the module unusable.
  const h = harness()
  const { drafted } = await openAndDraft(h, 'video-gyarto')
  const out = await h.asAgent('videoVerdict', { tervId: drafted.tervId, verdikt: 'atmegy' }, 'video-lektor')
  const code = out.error?.code ?? out.kod
  assert.notEqual(code, 'onlektoralas')
  assert.notEqual(code, 'agent_hianyzik')
})
