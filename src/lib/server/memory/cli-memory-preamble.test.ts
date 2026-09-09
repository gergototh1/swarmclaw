import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'

const originalEnv = {
  DATA_DIR: process.env.DATA_DIR,
  WORKSPACE_DIR: process.env.WORKSPACE_DIR,
  SWARMCLAW_BUILD_MODE: process.env.SWARMCLAW_BUILD_MODE,
}

let tempDir = ''
let memDb: typeof import('@/lib/server/memory/memory-db')
let mod: typeof import('@/lib/server/memory/cli-memory-preamble')

const AGENT = 'cli-preamble-agent'

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-cli-preamble-'))
  process.env.DATA_DIR = path.join(tempDir, 'data')
  process.env.WORKSPACE_DIR = path.join(tempDir, 'workspace')
  process.env.SWARMCLAW_BUILD_MODE = '1'
  memDb = await import('@/lib/server/memory/memory-db')
  mod = await import('@/lib/server/memory/cli-memory-preamble')

  const db = memDb.getMemoryDb()
  db.add({
    agentId: AGENT,
    category: 'identity/owner',
    title: 'Tulajdonos: Tóth Gergő',
    content: 'Tulajdonos: Tóth Gergő.\nNyelv: MAGYAR — mindig magyarul válaszolj.',
    pinned: true,
  })
  db.add({
    agentId: AGENT,
    category: 'decision/video-strategy',
    title: 'DÖNTÉS: videó stratégia',
    content: 'A videó stratégia 70/30 screen vs motion arányban megy tovább.',
  })
  db.add({
    agentId: AGENT,
    category: 'operations/environment',
    title: 'YouTube OAuth',
    content: 'A YouTube OAuth token lejárt, újra kell hitelesíteni.',
  })
  // The same fact copied into a second agent and shared with everyone. The
  // live store holds nine such facts in triplicate; recall must show one.
  db.add({
    agentId: 'some-other-agent',
    category: 'decision/video-strategy',
    title: 'DÖNTÉS: videó stratégia',
    content: 'A videó stratégia 70/30 screen vs motion arányban megy tovább.',
    sharedWith: ['*'],
  })
  // Enough pinned noise to crowd out a relevance hit if ordering is naive.
  for (let i = 0; i < 6; i++) {
    db.add({
      agentId: AGENT,
      category: 'infra/swarmclaw',
      title: `Kitűzött jegyzet ${i}`,
      content: `Egy kitűzött infrastruktúra-jegyzet, sorszám ${i}.`,
      pinned: true,
    })
  }
  db.add({
    agentId: AGENT,
    category: 'session_archive',
    title: 'Session archive',
    content: 'Egy régi beszélgetés teljes átirata a videó stratégiáról és minden másról.',
  })
  db.add({
    agentId: AGENT,
    category: 'consolidated_insight',
    title: 'Consolidated insight: 2026-09-09',
    content: 'Consolidated insight from 6 frequently accessed memories a videó stratégiáról.',
  })
  db.add({
    agentId: AGENT,
    category: 'operations/execution',
    title: '[auto] videó stratégia kérdés',
    content: 'source: chat user_request: mi a videó stratégia assistant_outcome: elmondtam.',
  })
})

after(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true })
})

const agent = { id: AGENT, tools: ['memory'], proactiveMemory: true }

describe('buildCliMemoryPreamble', () => {
  it('returns nothing when the agent has no memory capability', () => {
    const out = mod.buildCliMemoryPreamble({
      session: { id: 's1', agentId: AGENT },
      agent: { id: AGENT, tools: ['files'], proactiveMemory: true },
      message: 'Mi a videó stratégia?',
    })
    assert.equal(out.preamble, null)
  })

  it('surfaces a relevant memory for an accented query', () => {
    const out = mod.buildCliMemoryPreamble({
      session: { id: 's2', agentId: AGENT },
      agent,
      message: 'Emlékszel mi volt a videó stratégia?',
    })
    assert.ok(out.preamble, 'expected a preamble')
    assert.ok(out.preamble!.includes('70/30'), out.preamble!)
  })

  it('always carries pinned memories on the first turn', () => {
    const out = mod.buildCliMemoryPreamble({
      session: { id: 's3', agentId: AGENT },
      agent,
      message: 'Kérlek nézd meg a build naplót és mondd meg mi a baj vele.',
    })
    assert.ok(out.preamble!.includes('[pinned]'), out.preamble!)
  })

  it('renders one line per memory', () => {
    const out = mod.buildCliMemoryPreamble({
      session: { id: 's4', agentId: AGENT },
      agent,
      message: 'Mit tudsz a videó stratégiáról és a YouTube hitelesítésről?',
    })
    const bullets = out.preamble!.split('\n').filter((line) => line.startsWith('- '))
    assert.ok(bullets.length >= 2, out.preamble!)
    for (const line of bullets) assert.ok(!line.includes('\n'), line)
  })

  it('teaches the memory rubric once, then stops repeating it', () => {
    const first = mod.buildCliMemoryPreamble({
      session: { id: 's5', agentId: AGENT },
      agent,
      message: 'Mit tudsz a videó stratégiáról?',
    })
    assert.ok(first.preamble!.includes('## My durable memory'), first.preamble!)

    const second = mod.buildCliMemoryPreamble({
      session: { id: 's5', agentId: AGENT, injectedMemoryIds: first.injectedMemoryIds },
      agent,
      message: 'És a YouTube hitelesítés?',
    })
    assert.ok(second.preamble, 'second turn should still surface new memories')
    assert.ok(!second.preamble!.includes('## My durable memory'), second.preamble!)
  })

  it('never repeats a memory already injected in this session', () => {
    // Anything put into a resumed CLI prompt stays in that transcript for the
    // rest of the session, so re-injecting is pure waste — and it compounds.
    const first = mod.buildCliMemoryPreamble({
      session: { id: 's6', agentId: AGENT },
      agent,
      message: 'Mi volt a videó stratégia?',
    })
    assert.ok(first.preamble!.includes('70/30'))

    const second = mod.buildCliMemoryPreamble({
      session: { id: 's6', agentId: AGENT, injectedMemoryIds: first.injectedMemoryIds },
      agent,
      message: 'Mi volt a videó stratégia?',
    })
    assert.equal(second.preamble, null, 'the same memory must not be sent twice')
  })

  it('records what it injected so the caller can persist it', () => {
    const out = mod.buildCliMemoryPreamble({
      session: { id: 's7', agentId: AGENT },
      agent,
      message: 'Mi volt a videó stratégia?',
    })
    assert.ok(Object.keys(out.injectedMemoryIds).length > 0)
  })

  it('shows a fact once even when it is stored under several agents', () => {
    const out = mod.buildCliMemoryPreamble({
      session: { id: 'd1', agentId: AGENT },
      agent,
      message: 'Mi volt a videó stratégia?',
    })
    const hits = (out.preamble!.match(/70\/30/g) || []).length
    assert.equal(hits, 1, out.preamble!)
  })

  it('puts the answer to this message above always-on noise', () => {
    const out = mod.buildCliMemoryPreamble({
      session: { id: 'd2', agentId: AGENT },
      agent,
      message: 'Mi volt a videó stratégia?',
    })
    assert.ok(out.preamble!.includes('70/30'), out.preamble!)
  })

  it('does not echo the title back inside its own snippet', () => {
    const db = memDb.getMemoryDb()
    db.add({
      agentId: AGENT,
      category: 'identity/owner',
      title: 'Tulajdonos: Kovács Anna',
      content: 'Tulajdonos: Kovács Anna\nNyelv: magyar.',
      pinned: true,
    })
    const out = mod.buildCliMemoryPreamble({
      session: { id: 'd3', agentId: AGENT },
      agent,
      message: 'Ki a tulajdonos és milyen nyelven válaszoljak neki?',
    })
    const line = out.preamble!.split('\n').find((l) => l.includes('Kovács Anna'))
    assert.ok(line, out.preamble!)
    assert.equal((line!.match(/Kovács Anna/g) || []).length, 1, line!)
  })

  it('keeps session archives out of the always-on tier', () => {
    const out = mod.buildCliMemoryPreamble({
      session: { id: 'd4', agentId: AGENT },
      agent,
      message: 'Kérlek nézd meg a build naplót és mondd meg mi a baj vele.',
    })
    assert.ok(!(out.preamble || '').includes('[session_archive]'), out.preamble || '')
  })

  it('carries only durable facts, never machine bulk', () => {
    // Consolidated digests and raw turn dumps are the two categories that grow
    // on their own. They are searchable on purpose; they must not spend a
    // recall slot, and a digest quoting an archive is the worst of both.
    const out = mod.buildCliMemoryPreamble({
      session: { id: 'd5', agentId: AGENT },
      agent,
      message: 'Mi volt a videó stratégia és mit csináltunk vele?',
    })
    const block = out.preamble || ''
    assert.ok(!block.includes('[consolidated_insight]'), block)
    assert.ok(!block.includes('[operations/execution]'), block)
    assert.ok(!block.includes('[session_archive]'), block)
  })

  it('shows one chunk per knowledge source, not the whole document', () => {
    const db = memDb.getMemoryDb()
    for (let i = 0; i < 3; i++) {
      db.add({
        agentId: null,
        category: 'knowledge',
        title: 'Szolgáltatás és biznisz infók',
        content: `Egy hosszabb dokumentum ${i}. szelete a videó stratégiáról és a szolgáltatásokról.`,
        metadata: { sourceId: 'doc-1', chunkIndex: i },
      })
    }
    const out = mod.buildCliMemoryPreamble({
      session: { id: 'd6', agentId: AGENT },
      agent,
      message: 'Mit tudsz a szolgáltatásokról és a dokumentumról?',
    })
    const chunks = (out.preamble || '').split('\n').filter((l) => l.includes('Szolgáltatás és biznisz infók'))
    assert.ok(chunks.length <= 1, (out.preamble || ''))
  })

  it('sends nothing when a short message follows a fully injected session', () => {
    const seeded = mod.buildCliMemoryPreamble({
      session: { id: 's8', agentId: AGENT },
      agent,
      message: 'Mit tudsz a videó stratégiáról és a YouTube hitelesítésről?',
    })
    const out = mod.buildCliMemoryPreamble({
      session: { id: 's8', agentId: AGENT, injectedMemoryIds: seeded.injectedMemoryIds },
      agent,
      message: 'ok',
    })
    assert.equal(out.preamble, null)
  })
})
