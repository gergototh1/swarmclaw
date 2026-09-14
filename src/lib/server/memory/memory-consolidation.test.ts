import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import type { Agent } from '@/types'

const originalEnv = {
  DATA_DIR: process.env.DATA_DIR,
  WORKSPACE_DIR: process.env.WORKSPACE_DIR,
  SWARMCLAW_BUILD_MODE: process.env.SWARMCLAW_BUILD_MODE,
}

let tempDir = ''
let memDb: typeof import('@/lib/server/memory/memory-db')
let storage: typeof import('@/lib/server/storage')
let consolidation: typeof import('@/lib/server/memory/memory-consolidation')

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-memory-consolidation-'))
  process.env.DATA_DIR = path.join(tempDir, 'data')
  process.env.WORKSPACE_DIR = path.join(tempDir, 'workspace')
  process.env.SWARMCLAW_BUILD_MODE = '1'

  memDb = await import('@/lib/server/memory/memory-db')
  storage = await import('@/lib/server/storage')
  consolidation = await import('@/lib/server/memory/memory-consolidation')
})

after(() => {
  if (originalEnv.DATA_DIR === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = originalEnv.DATA_DIR
  if (originalEnv.WORKSPACE_DIR === undefined) delete process.env.WORKSPACE_DIR
  else process.env.WORKSPACE_DIR = originalEnv.WORKSPACE_DIR
  if (originalEnv.SWARMCLAW_BUILD_MODE === undefined) delete process.env.SWARMCLAW_BUILD_MODE
  else process.env.SWARMCLAW_BUILD_MODE = originalEnv.SWARMCLAW_BUILD_MODE
  fs.rmSync(tempDir, { recursive: true, force: true })
})

test('runDailyConsolidation skips orphaned and CLI-only agent namespaces without reporting errors', async () => {
  storage.saveSettings({})
  const db = memDb.getMemoryDb()
  const now = Date.now()
  const orphanId = 'live-orphan-agent'
  const cliOnlyId = 'live-cli-agent'

  storage.saveAgents({
    [cliOnlyId]: {
      id: cliOnlyId,
      name: 'CLI-only Agent',
      description: '',
      systemPrompt: '',
      provider: 'claude-cli',
      model: 'claude-sonnet-4-5',
      credentialId: null,
      fallbackCredentialIds: [],
      apiEndpoint: null,
      createdAt: now,
      updatedAt: now,
    } as Agent,
  })

  for (let index = 0; index < 5; index += 1) {
    db.add({
      agentId: orphanId,
      category: 'note',
      title: `Orphan note ${index + 1}`,
      content: `orphan content ${index + 1}`,
    })
    db.add({
      agentId: cliOnlyId,
      category: 'note',
      title: `CLI note ${index + 1}`,
      content: `cli content ${index + 1}`,
    })
  }

  const stats = await consolidation.runDailyConsolidation()
  const digestTitle = `Daily digest: ${new Date().toISOString().slice(0, 10)}`

  assert.deepEqual(stats.errors, [])
  assert.equal(
    db.search(digestTitle, orphanId).some((entry) => entry.category === 'daily_digest'),
    false,
  )
  assert.equal(
    db.search(digestTitle, cliOnlyId).some((entry) => entry.category === 'daily_digest'),
    false,
  )
})

test('canCreateDailyDigestForAgent allows CLI-only agents when a dream model is configured', async () => {
  const now = Date.now()
  const agentId = 'dream-routed-cli-agent'
  storage.saveAgents({
    [agentId]: {
      id: agentId,
      name: 'Dream Routed CLI Agent',
      description: '',
      systemPrompt: '',
      provider: 'claude-cli',
      model: 'claude-sonnet-4-5',
      credentialId: null,
      fallbackCredentialIds: [],
      apiEndpoint: null,
      createdAt: now,
      updatedAt: now,
    } as Agent,
  })

  storage.saveSettings({})
  assert.equal(
    consolidation.canCreateDailyDigestForAgent(agentId, storage.loadAgents({ includeTrashed: true }), storage.loadSettings()),
    false,
  )

  storage.saveSettings({
    dreamProvider: 'ollama',
    dreamModel: 'llama3.2',
    dreamEndpoint: 'http://127.0.0.1:11434',
  })
  assert.equal(
    consolidation.canCreateDailyDigestForAgent(agentId, storage.loadAgents({ includeTrashed: true }), storage.loadSettings()),
    true,
  )
})

test('canCreateDailyDigestForAgent allows CLI-only agents with a per-agent dream model override', async () => {
  const now = Date.now()
  const agentId = 'agent-dream-override-cli'
  storage.saveSettings({})
  storage.saveAgents({
    [agentId]: {
      id: agentId,
      name: 'Per-Agent Dream Routed CLI Agent',
      description: '',
      systemPrompt: '',
      provider: 'claude-cli',
      model: 'claude-sonnet-4-5',
      credentialId: null,
      fallbackCredentialIds: [],
      apiEndpoint: null,
      dreamConfig: {
        provider: 'ollama',
        model: 'llama3.2',
        endpoint: 'http://127.0.0.1:11434',
      },
      createdAt: now,
      updatedAt: now,
    } as Agent,
  })

  assert.equal(
    consolidation.canCreateDailyDigestForAgent(agentId, storage.loadAgents({ includeTrashed: true }), storage.loadSettings()),
    true,
  )
})

/*
 * A hozzáférés-alapú tömörítés nem hízlalhatja a tárat.
 *
 * A 3. lépés minden idle ablakban ÚJ `consolidated_insight` sort írt, ha
 * legalább két memória "gyakran elért" volt -- létezés-ellenőrzés és
 * szuperszedálás nélkül. Mivel ugyanaz a top-lista jön vissza minden futásnál,
 * ugyanaz a digest keletkezett újra és újra: az élő tárban 191 ilyen sor van
 * (a 347-ből), egyetlen napon egy ügynökre 67, és 1174 gráf-él lóg rajtuk --
 * miközben a felidézés kategória szerint mindet kiszűri. Írásra létező szemét.
 *
 * A referencia-rendszerek egyike sem így csinálja: a Letta sleep-time ügynöke
 * a memória-blokkot HELYBEN írja át, a Zep/Graphiti a felülírt élt
 * érvényteleníti, a mem0 pedig ADD/UPDATE/DELETE/NOOP-ot dönt vektoros
 * hasonlóság alapján. Mind a három felülír, nem hozzáfűz.
 */
test('runAccessBasedCompaction keeps one digest per agent instead of appending one per run', async () => {
  storage.saveSettings({})
  const db = memDb.getMemoryDb()
  const agentId = 'compaction-idempotent-agent'

  storage.saveAgents({
    [agentId]: {
      id: agentId,
      name: 'Compaction Agent',
      provider: 'claude-cli',
      description: '',
      soul: '',
      tools: ['memory'],
    } as unknown as Agent,
  })

  // Two entries that read as "frequently accessed" so step 3 has something to
  // merge on every run. `get` is what bumps the counter, and it does so on a
  // timer, so the reads are real reads and the test waits for them.
  for (const title of ['Gyakori A', 'Gyakori B']) {
    const entry = db.add({ agentId, category: 'knowledge/facts', title, content: `${title} tartalma.` })
    for (let i = 0; i < 6; i++) db.get(entry.id)
  }
  await new Promise((resolve) => setTimeout(resolve, 20))

  const digests = () => db.list(agentId, 500).filter((m) => m.category === 'consolidated_insight')

  await consolidation.runAccessBasedCompaction()
  const afterFirst = digests()
  assert.equal(afterFirst.length, 1, 'the first run writes the digest')

  await consolidation.runAccessBasedCompaction()
  await consolidation.runAccessBasedCompaction()
  const afterThird = digests()

  assert.equal(afterThird.length, 1, `three runs must leave one digest, found ${afterThird.length}`)
  assert.equal(afterThird[0].id, afterFirst[0].id, 'the digest is rewritten in place, not replaced')
})
