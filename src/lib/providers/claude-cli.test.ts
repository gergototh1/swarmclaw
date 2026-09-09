import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { addAssignedMcpServers, buildClaudeCliPrompt } from './claude-cli'
import { MCP_INJECTION_PROVIDER_IDS } from '@/lib/provider-sets'

/**
 * The Claude CLI runs its own tool loop and never sees the LangChain array
 * buildSessionTools() assembles, so the servers an operator assigns to an agent
 * are the only SwarmClaw-side capability that reaches it. Every case below is
 * one way that delivery used to fail silently: before this, claude-cli.ts wrote
 * a --mcp-config for the browser proxy and nothing else, so an agent showed its
 * assigned servers in the UI and received none of them.
 */
describe('addAssignedMcpServers', () => {
  it('translates a stdio server into a command entry', () => {
    const out = addAssignedMcpServers({}, ['s1'], {
      s1: { name: 'Soniox MCP', transport: 'stdio', command: '/opt/homebrew/bin/node', args: ['/data/shim.mjs'] },
    })
    assert.deepEqual(out, {
      'Soniox-MCP': { command: '/opt/homebrew/bin/node', args: ['/data/shim.mjs'] },
    })
  })

  it('carries env and cwd only when they hold something', () => {
    const out = addAssignedMcpServers({}, ['a', 'b'], {
      a: { name: 'withEnv', transport: 'stdio', command: 'node', env: { KEY: 'v' }, cwd: '/tmp' },
      b: { name: 'bare', transport: 'stdio', command: 'node', env: {} },
    })
    assert.deepEqual(out.withEnv, { command: 'node', args: [], env: { KEY: 'v' }, cwd: '/tmp' })
    assert.deepEqual(out.bare, { command: 'node', args: [] })
  })

  it('translates url transports and keeps their headers', () => {
    const out = addAssignedMcpServers({}, ['h'], {
      h: { name: 'remote', transport: 'streamable-http', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer x' } },
    })
    assert.deepEqual(out.remote, {
      type: 'streamable-http',
      url: 'https://example.test/mcp',
      headers: { Authorization: 'Bearer x' },
    })
  })

  it('does not overwrite a name already in the map', () => {
    // The browser tool puts `playwright` in first. An assigned server that
    // happens to carry the same name must not replace it — that would take the
    // agent's browser away as a side effect of assigning an MCP server.
    const existing = { playwright: { command: 'node', args: ['proxy.mjs'] } }
    const out = addAssignedMcpServers(existing, ['p2'], {
      p2: { name: 'playwright', transport: 'stdio', command: 'other' },
    })
    assert.deepEqual(out.playwright, { command: 'node', args: ['proxy.mjs'] })
    assert.deepEqual(out['playwright-p2'], { command: 'other', args: [] })
  })

  it('keeps two assigned servers that share a name', () => {
    const out = addAssignedMcpServers({}, ['first', 'second'], {
      first: { name: 'Gmail MCP', transport: 'stdio', command: 'node', args: ['one.mjs'] },
      second: { name: 'Gmail MCP', transport: 'stdio', command: 'node', args: ['two.mjs'] },
    })
    assert.equal(Object.keys(out).length, 2, 'a duplicate name must not collapse two servers into one')
  })

  it('skips unknown ids and entries with no usable transport', () => {
    const out = addAssignedMcpServers({}, ['missing', 'noCommand', 'noUrl'], {
      noCommand: { name: 'noCommand', transport: 'stdio' },
      noUrl: { name: 'noUrl', transport: 'sse' },
    })
    assert.deepEqual(out, {}, 'a half-written entry would make the CLI fail to start')
  })

  it('leaves the map untouched when the agent has no assignments', () => {
    const existing = { playwright: { command: 'node', args: [] } }
    assert.deepEqual(addAssignedMcpServers(existing, [], {}), existing)
  })
})

/**
 * MCP carries no caller identity, so a shim that fronts an extension can only
 * learn who is asking from the env the host spawns it with. These cases are the
 * ones that would silently pass a self-review in the video extension or write
 * to the wrong agent folder in the docs extension.
 */
describe('addAssignedMcpServers — caller stamp', () => {
  const servers = {
    s: { name: 'video', transport: 'stdio', command: 'node', args: ['shim.mjs'], env: { EXISTING: 'kept' } },
  }

  it('stamps the agent and session onto a stdio server, keeping its own env', () => {
    const out = addAssignedMcpServers({}, ['s'], servers, { agentId: 'agent-7', sessionId: 'sess-9' })
    assert.deepEqual(out.video.env, {
      EXISTING: 'kept',
      SWARMCLAW_AGENT_ID: 'agent-7',
      SWARMCLAW_SESSION_ID: 'sess-9',
    })
  })

  it('lets the stamp win over a value pinned in the server config', () => {
    // An operator pinning another agent's id into the server env would be
    // exactly the self-named caller the stamp exists to rule out.
    const out = addAssignedMcpServers({}, ['s'], {
      s: { name: 'video', transport: 'stdio', command: 'node', env: { SWARMCLAW_AGENT_ID: 'someone-else' } },
    }, { agentId: 'real-caller' })
    assert.equal((out.video.env as Record<string, string>).SWARMCLAW_AGENT_ID, 'real-caller')
  })

  it('omits a blank id rather than writing an empty string', () => {
    // The extensions resolve the actor with `??`, so a present-but-empty value
    // defeats their own fallback instead of triggering it.
    const out = addAssignedMcpServers({}, ['s'], servers, { agentId: '', sessionId: null })
    assert.deepEqual(out.video.env, { EXISTING: 'kept' })
  })

  it('does not stamp a url transport', () => {
    // A remote server is someone else's process on a shared connection; an
    // identity claim in a header would leave this machine and would not be
    // this turn's by the time it arrived.
    const out = addAssignedMcpServers({}, ['r'], {
      r: { name: 'remote', transport: 'streamable-http', url: 'https://example.test/mcp' },
    }, { agentId: 'agent-7' })
    assert.deepEqual(out.remote, { type: 'streamable-http', url: 'https://example.test/mcp' })
  })

  it('is absent entirely when the host has no session identity to give', () => {
    const out = addAssignedMcpServers({}, ['s'], {
      s: { name: 'video', transport: 'stdio', command: 'node' },
    })
    assert.deepEqual(out.video, { command: 'node', args: [] })
  })
})

describe('provider registry', () => {
  it('declares claude-cli as an MCP-injecting provider', () => {
    // The agent editor hides the MCP servers picker for a worker-only provider
    // unless it is in this set (agent-sheet.tsx). While claude-cli ignored
    // agent.mcpServerIds the omission was correct; now it would leave the one
    // provider every agent in a CLI-only fleet uses unable to be given a
    // server from the UI at all.
    assert.ok(MCP_INJECTION_PROVIDER_IDS.has('claude-cli'))
  })
})


/**
 * Every agent in this install runs on claude-cli, and this provider read
 * `imagePath` and nothing else: a second attachment was dropped before the CLI
 * saw it, and a .docx was announced as an image. These cover the seam -- the
 * extraction itself is covered in `attachment-text.test.ts`.
 */
describe('buildClaudeCliPrompt', () => {
  it('leaves a message with no attachments exactly as it is', async () => {
    assert.equal(await buildClaudeCliPrompt('szia'), 'szia')
  })

  it('carries every attachment, not just the first', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-cli-prompt-'))
    try {
      const a = path.join(dir, 'elso.md')
      const b = path.join(dir, 'masodik.md')
      fs.writeFileSync(a, 'ELSO-TARTALOM')
      fs.writeFileSync(b, 'MASODIK-TARTALOM')
      const prompt = await buildClaudeCliPrompt('nézd meg', undefined, [a, b])
      assert.match(prompt, /ELSO-TARTALOM/)
      assert.match(prompt, /MASODIK-TARTALOM/, 'a második csatolmány elveszett')
      assert.ok(prompt.endsWith('nézd meg'), 'a felhasználó üzenete a blokk után áll')
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  it('does not call a document an image', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-cli-prompt-'))
    try {
      const doc = path.join(dir, 'ajanlat.docx')
      // Nem valódi docx: a kibontó visszautasítja, a lényeg a MEGNEVEZÉS.
      fs.writeFileSync(doc, 'not a zip')
      const prompt = await buildClaudeCliPrompt('mennyi az ár?', doc)
      assert.ok(!/shared an image/.test(prompt), 'a dokumentumot képként jelentette be')
      assert.match(prompt, /ajanlat\.docx/)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  it('names an image by its path, which is what a CLI can open', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-cli-prompt-'))
    try {
      const img = path.join(dir, 'kep.png')
      fs.writeFileSync(img, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
      const prompt = await buildClaudeCliPrompt('mi ez?', img)
      assert.match(prompt, /Attached image: kep\.png at /)
      assert.ok(prompt.includes(img))
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})
