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

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-memory-db-'))
  process.env.DATA_DIR = path.join(tempDir, 'data')
  process.env.WORKSPACE_DIR = path.join(tempDir, 'workspace')
  process.env.SWARMCLAW_BUILD_MODE = '1'
  memDb = await import('@/lib/server/memory/memory-db')
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

describe('memory-db', () => {
  // --- Basic CRUD ---

  describe('add and get', () => {
    it('stores a memory and retrieves it by ID', () => {
      const db = memDb.getMemoryDb()
      const entry = db.add({
        agentId: 'agent-1',
        sessionId: 'session-1',
        category: 'note',
        title: 'Test Memory',
        content: 'This is a test memory entry.',
      })
      assert.ok(entry.id)
      assert.equal(entry.title, 'Test Memory')
      assert.equal(entry.content, 'This is a test memory entry.')
      assert.equal(entry.category, 'note')
      assert.equal(entry.agentId, 'agent-1')

      const retrieved = db.get(entry.id)
      assert.ok(retrieved)
      assert.equal(retrieved!.id, entry.id)
      assert.equal(retrieved!.title, 'Test Memory')
    })

    it('generates unique IDs for each entry', () => {
      const db = memDb.getMemoryDb()
      const e1 = db.add({ agentId: null, category: 'note', title: 'A', content: 'a-content' })
      const e2 = db.add({ agentId: null, category: 'note', title: 'B', content: 'b-content' })
      assert.notEqual(e1.id, e2.id)
    })

    it('returns null for non-existent ID', () => {
      const db = memDb.getMemoryDb()
      assert.equal(db.get('nonexistent-id-xyz'), null)
    })
  })

  // --- Update ---

  describe('update', () => {
    it('updates a memory entry', () => {
      const db = memDb.getMemoryDb()
      const entry = db.add({
        agentId: 'agent-up',
        category: 'note',
        title: 'Original Title',
        content: 'Original content.',
      })
      const updated = db.update(entry.id, { title: 'Updated Title', content: 'Updated content.' })
      assert.ok(updated)
      assert.equal(updated!.title, 'Updated Title')
      assert.equal(updated!.content, 'Updated content.')
      assert.equal(updated!.agentId, 'agent-up')
    })

    it('returns null when updating non-existent entry', () => {
      const db = memDb.getMemoryDb()
      assert.equal(db.update('nonexistent-id', { title: 'Nope' }), null)
    })
  })

  // --- Delete ---

  describe('delete', () => {
    it('removes a memory entry', () => {
      const db = memDb.getMemoryDb()
      const entry = db.add({
        agentId: 'agent-del',
        category: 'note',
        title: 'To Delete',
        content: 'This will be deleted.',
      })
      assert.ok(db.get(entry.id))
      db.delete(entry.id)
      assert.equal(db.get(entry.id), null)
    })
  })

  // --- List ---

  describe('list', () => {
    it('lists memories for an agent', () => {
      const db = memDb.getMemoryDb()
      const agentId = `agent-list-${Date.now()}`
      db.add({ agentId, category: 'note', title: 'List 1', content: 'Content 1' })
      db.add({ agentId, category: 'note', title: 'List 2', content: 'Content 2' })
      db.add({ agentId: 'other-agent', category: 'note', title: 'Other', content: 'Other content' })

      const agentMemories = db.list(agentId)
      assert.ok(agentMemories.length >= 2, `Expected at least 2 agent memories, got ${agentMemories.length}`)
      const titles = agentMemories.map((m) => m.title)
      assert.ok(titles.includes('List 1'))
      assert.ok(titles.includes('List 2'))
    })

    it('respects limit parameter', () => {
      const db = memDb.getMemoryDb()
      const agentId = `agent-limit-${Date.now()}`
      for (let i = 0; i < 10; i++) {
        db.add({ agentId, category: 'note', title: `Mem ${i}`, content: `Content ${i}` })
      }
      const limited = db.list(agentId, 3)
      assert.equal(limited.length, 3)
    })
  })

  // --- FTS5 Search ---

  describe('search (FTS5)', () => {
    it('finds memories by content keyword', () => {
      const db = memDb.getMemoryDb()
      const agentId = `agent-fts-${Date.now()}`
      db.add({
        agentId,
        category: 'note',
        title: 'Kubernetes Deployment',
        content: 'Deployed the application to a Kubernetes cluster using Helm charts.',
      })
      db.add({
        agentId,
        category: 'note',
        title: 'Database Migration',
        content: 'Ran the PostgreSQL migration scripts successfully.',
      })

      const results = db.search('kubernetes deployment helm', agentId)
      assert.ok(results.length >= 1, `Expected FTS results for kubernetes, got ${results.length}`)
      const titles = results.map((r) => r.title)
      assert.ok(titles.includes('Kubernetes Deployment'))
    })

    it('returns empty for skip-query patterns', () => {
      const db = memDb.getMemoryDb()
      assert.deepEqual(db.search(''), [])
      assert.deepEqual(db.search('swarm_heartbeat_check'), [])
    })

    it('returns empty for very long queries', () => {
      const db = memDb.getMemoryDb()
      const longQuery = 'x'.repeat(1300)
      assert.deepEqual(db.search(longQuery), [])
    })
  })

  // --- buildFtsQuery ---

  describe('buildFtsQuery', () => {
    it('removes stop words', () => {
      const query = memDb.buildFtsQuery('what is the purpose of this')
      // 'what', 'is', 'the', 'of', 'this' are stop words; 'purpose' should remain
      assert.ok(query.includes('purpose'))
      assert.ok(!query.includes('"the"'))
    })

    it('returns empty for all stop words', () => {
      const query = memDb.buildFtsQuery('the is a an')
      assert.equal(query, '')
    })

    it('limits to MAX_FTS_QUERY_TERMS', () => {
      const query = memDb.buildFtsQuery('alpha bravo charlie delta echo foxtrot golf hotel india juliet')
      // Should have at most 4 terms (slice 0..4)
      const termCount = (query.match(/AND/g) || []).length + 1
      assert.ok(termCount <= 4, `Expected at most 4 terms, got ${termCount}`)
    })

    it('handles empty input', () => {
      assert.equal(memDb.buildFtsQuery(''), '')
    })

    it('deduplicates terms', () => {
      const query = memDb.buildFtsQuery('kubernetes kubernetes kubernetes')
      // Should only have one kubernetes
      const occurrences = (query.match(/kubernetes/g) || []).length
      assert.equal(occurrences, 1)
    })

    it('skips very short terms', () => {
      const query = memDb.buildFtsQuery('go is ok no')
      // All terms are <3 chars or stop words
      assert.equal(query, '')
    })

    it('returns a single-term FTS query for short (3-4 char) words', () => {
      // Single words like "cats", "blue", "dog" must produce a non-empty FTS
      // query so the memory lookup UI works for short meaningful terms.
      assert.equal(memDb.buildFtsQuery('cats'), 'cats*')
      assert.equal(memDb.buildFtsQuery('blue'), 'blue*')
      assert.equal(memDb.buildFtsQuery('dog'), 'dog*')
    })

    // --- Accented (Hungarian) input ---
    // The FTS5 unicode61 tokenizer folds diacritics on BOTH the index and the
    // query side, so an accented word is findable. The bug was upstream of
    // that: an ASCII-only token regex shredded the word before it ever
    // reached FTS. "határidő" became "hat" AND "rid" — two garbage prefixes
    // that match the wrong rows or nothing at all.

    it('keeps accented Hungarian words whole', () => {
      assert.equal(memDb.buildFtsQuery('határidő'), 'határidő*')
      assert.equal(memDb.buildFtsQuery('működik'), 'működik*')
      assert.equal(memDb.buildFtsQuery('ügyfél'), 'ügyfél*')
      assert.equal(memDb.buildFtsQuery('stratégia'), 'stratégia*')
    })

    it('does not shred a short accented word into nothing', () => {
      // Every fragment of "döntés" under the old ASCII regex was < 3 chars,
      // so the whole query came out empty and search skipped FTS entirely.
      assert.equal(memDb.buildFtsQuery('döntés'), 'döntés*')
    })

    it('keeps accents in a full sentence', () => {
      const query = memDb.buildFtsQuery('Mit döntöttünk a stratégiáról?')
      assert.ok(query.includes('döntöttünk*'), query)
      assert.ok(query.includes('stratégiáról*'), query)
      assert.ok(!query.includes('strat*'), query)
    })

    // --- Punctuation becomes a separator, never a fusion ---

    it('splits on punctuation instead of deleting it', () => {
      // Deleting the hyphen would fuse this into "rankcheck", a token the
      // index cannot contain. unicode61 indexed it as two tokens.
      const query = memDb.buildFtsQuery('rank-check')
      assert.ok(query.includes('rank*'), query)
      assert.ok(query.includes('check*'), query)
      assert.ok(!query.includes('rankcheck'), query)
    })

    it('splits on underscores too', () => {
      const query = memDb.buildFtsQuery('agent_identifier')
      assert.ok(query.includes('agent*'), query)
      assert.ok(query.includes('identifier*'), query)
    })

    // --- Prefix wildcard stands in for the stemmer we do not have ---

    it('appends a prefix wildcard to every term', () => {
      const query = memDb.buildFtsQuery('videó határidő')
      for (const term of query.split(/\s+AND\s+/)) {
        assert.ok(term.endsWith('*'), `term without wildcard: ${term}`)
      }
    })

    // --- Match mode ---

    it('joins with OR in "any" mode', () => {
      // Automatic recall searches with the raw user message, which carries
      // filler the stored memory will never contain. Under AND that recalls
      // nothing; ranking sorts out the noise instead.
      const query = memDb.buildFtsQuery('mit döntöttünk a stratégiáról', 'any')
      assert.ok(query.includes(' OR '), query)
      assert.ok(!query.includes(' AND '), query)
    })

    it('still joins with AND by default', () => {
      const query = memDb.buildFtsQuery('alpha bravo')
      assert.ok(query.includes(' AND '), query)
    })
  })

  // --- Abstracts without a generation model ---

  describe('abstract on insert', () => {
    const longNote = 'A YouTube OAuth token lejárt és újra kell hitelesíteni. '
      + 'A kliens-fájl a store könyvtárban van, a refresh token viszont érvénytelen lett. '
      + 'Ez a harmadik eset ebben a hónapban, ezért érdemes lenne automatizálni az ellenőrzést.'

    it('writes an abstract at insert time, without waiting for a model', () => {
      const db = memDb.getMemoryDb()
      const entry = db.add({
        agentId: `abstract-${Date.now()}`,
        category: 'operations/environment',
        title: 'YouTube OAuth',
        content: longNote,
      })
      // Read it back rather than trusting the returned object: the point is
      // that the column is populated, not that the caller got a value.
      const stored = db.get(entry.id)
      assert.ok(stored?.abstract, 'abstract should be written synchronously')
      assert.ok(stored!.abstract!.startsWith('A YouTube OAuth token lejárt'), stored!.abstract!)
      assert.ok(!stored!.abstract!.includes('\n'), 'abstract should be one line')
    })

    it('keeps an abstract the writer supplied itself', () => {
      const db = memDb.getMemoryDb()
      const entry = db.add({
        agentId: `abstract2-${Date.now()}`,
        category: 'operations/environment',
        title: 'YouTube OAuth',
        content: longNote,
        abstract: 'A YouTube feltöltés nem működik, újra-auth kell.',
      })
      assert.equal(db.get(entry.id)?.abstract, 'A YouTube feltöltés nem működik, újra-auth kell.')
    })
  })

  // --- Ranking ---

  describe('ranking weights', () => {
    it('does not let a heavily reinforced digest bury a relevant fact', () => {
      // reinforcementCount is non-zero on exactly one category in the live
      // store -- the machine's own consolidation digests, up to 803 -- so an
      // uncapped log multiplier hands them a 7.7x boost that no relevance
      // difference can overcome.
      const db = memDb.getMemoryDb()
      const agentId = `rank-${Date.now()}`
      const digest = db.add({
        agentId,
        category: 'note',
        title: 'Consolidated digest',
        content: 'kubernetes klaszter összefoglaló a gépi digestből',
      })
      for (let i = 0; i < 400; i++) {
        db.add({ agentId, category: 'note', title: 'Consolidated digest', content: 'kubernetes klaszter összefoglaló a gépi digestből' })
      }
      const reinforced = db.get(digest.id)
      assert.ok((reinforced?.reinforcementCount || 0) > 100, `expected heavy reinforcement, got ${reinforced?.reinforcementCount}`)

      const fact = db.add({
        agentId,
        category: 'projects/decisions',
        title: 'Kubernetes döntés',
        content: 'A kubernetes klaszter a frankfurti régióban fut, ezt döntöttük el.',
        importance: 9,
      })

      // A query that matches BOTH equally, so relevance cannot decide it and
      // the multipliers are what is actually under test.
      const results = db.search('kubernetes klaszter', agentId, { scope: { mode: 'agent', agentId } })
      const factRank = results.findIndex((r) => r.id === fact.id)
      const digestRank = results.findIndex((r) => r.id === digest.id)
      assert.ok(factRank >= 0, 'the relevant fact should be returned at all')
      assert.ok(factRank < digestRank || digestRank === -1, `fact at ${factRank}, digest at ${digestRank}`)
    })
  })

  // --- Importance ---

  describe('importance', () => {
    it('stores a score the writer supplied', () => {
      const db = memDb.getMemoryDb()
      const entry = db.add({
        agentId: `imp-${Date.now()}`,
        category: 'projects/decisions',
        title: 'Fontos döntés',
        content: 'Ez a döntés megváltoztatja, hogyan dolgozik a flotta.',
        importance: 9,
      })
      assert.equal(db.get(entry.id)?.importance, 9)
    })

    it('treats an out-of-range score as unscored rather than failing the write', () => {
      const db = memDb.getMemoryDb()
      for (const [i, bad] of [0, -3, 42, Number.NaN].entries()) {
        const entry = db.add({
          agentId: `imp-bad-${Date.now()}-${i}`,
          category: 'note',
          title: `Rossz pontszám ${i}`,
          content: `Tartalom ${i}.`,
          importance: bad as number,
        })
        assert.equal(db.get(entry.id)?.importance, 0, `importance=${String(bad)}`)
      }
    })

    it('defaults to unscored when nothing is supplied', () => {
      const db = memDb.getMemoryDb()
      const entry = db.add({
        agentId: `imp-none-${Date.now()}`,
        category: 'note',
        title: 'Pontszám nélkül',
        content: 'Nincs megadva fontosság.',
      })
      assert.equal(db.get(entry.id)?.importance, 0)
    })
  })

  // --- Fleet-wide sharing ---

  describe('sharedWith "everyone" sentinel', () => {
    it('treats a sharedWith of ["*"] as visible to any agent', () => {
      const db = memDb.getMemoryDb()
      const entry = db.add({
        agentId: `author-${Date.now()}`,
        category: 'knowledge/facts',
        title: 'Fleet-wide fact',
        content: 'Every agent should see this one.',
        sharedWith: ['*'],
      })
      const seen = memDb.filterMemoriesByScope([entry], { mode: 'agent', agentId: 'some-other-agent' })
      assert.equal(seen.length, 1)
    })

    it('still scopes a normal sharedWith list to its listed agents', () => {
      const db = memDb.getMemoryDb()
      const entry = db.add({
        agentId: `author2-${Date.now()}`,
        category: 'knowledge/facts',
        title: 'Narrowly shared fact',
        content: 'Only one other agent should see this.',
        sharedWith: ['agent-alpha'],
      })
      assert.equal(memDb.filterMemoriesByScope([entry], { mode: 'agent', agentId: 'agent-alpha' }).length, 1)
      assert.equal(memDb.filterMemoriesByScope([entry], { mode: 'agent', agentId: 'agent-beta' }).length, 0)
    })

    it('reads a legacy bare "global" marker as the everyone sentinel', async () => {
      // A seed script wrote the literal string "global" into sharedWith,
      // intending "share with the whole fleet". It is not JSON, so it parsed
      // to nothing and 30 live rows silently lost their sharing. Read it as
      // the sentinel rather than making the operator re-seed.
      const db = memDb.getMemoryDb()
      db.add({ agentId: 'warmup', category: 'note', title: 'warmup', content: 'warmup' })
      const { default: Database } = await import('better-sqlite3')
      const raw = new Database(path.join(tempDir, 'data', 'memory.db'))
      const id = `legacy-shared-${Date.now()}`
      const now = Date.now()
      raw.prepare(
        `INSERT INTO memories (id, agentId, sessionId, category, title, content, sharedWith, createdAt, updatedAt)
         VALUES (?, ?, NULL, ?, ?, ?, 'global', ?, ?)`,
      ).run(id, 'legacy-author', 'knowledge/facts', 'Legacy shared fact', 'Written by the old seed.', now, now)
      raw.close()

      const entry = db.get(id)
      assert.ok(entry, 'legacy row should load')
      assert.deepEqual(entry!.sharedWith, ['*'])
      assert.equal(memDb.filterMemoriesByScope([entry!], { mode: 'agent', agentId: 'any-agent' }).length, 1)
    })
  })

  // --- Content hash dedup ---

  describe('content hash dedup', () => {
    it('reinforces instead of duplicating same content for same agent', () => {
      const db = memDb.getMemoryDb()
      const agentId = `agent-dedup-${Date.now()}`
      const first = db.add({
        agentId,
        category: 'fact',
        title: 'Dedup Test',
        content: 'Identical content for dedup testing.',
      })
      const second = db.add({
        agentId,
        category: 'fact',
        title: 'Dedup Test Different Title',
        content: 'Identical content for dedup testing.',
      })
      // Should return the same ID (reinforced, not duplicated)
      assert.equal(second.id, first.id)
      assert.ok((second.reinforcementCount || 0) >= 1, 'Expected reinforcement count to increase')
    })
  })

  // --- Memory linking ---

  describe('link and unlink', () => {
    it('links two memories bidirectionally', () => {
      const db = memDb.getMemoryDb()
      const a = db.add({ agentId: 'agent-link', category: 'note', title: 'Memory A', content: 'Content A' })
      const b = db.add({ agentId: 'agent-link', category: 'note', title: 'Memory B', content: 'Content B' })

      db.link(a.id, [b.id])

      const aAfter = db.get(a.id)
      const bAfter = db.get(b.id)
      assert.ok(aAfter!.linkedMemoryIds?.includes(b.id), 'A should link to B')
      assert.ok(bAfter!.linkedMemoryIds?.includes(a.id), 'B should link back to A')
    })

    it('unlinks memories bidirectionally', () => {
      const db = memDb.getMemoryDb()
      const a = db.add({ agentId: 'agent-unlink', category: 'note', title: 'Unlink A', content: 'Unlink Content A' })
      const b = db.add({ agentId: 'agent-unlink', category: 'note', title: 'Unlink B', content: 'Unlink Content B' })

      db.link(a.id, [b.id])
      db.unlink(a.id, [b.id])

      const aAfter = db.get(a.id)
      const bAfter = db.get(b.id)
      const aLinks = aAfter?.linkedMemoryIds || []
      const bLinks = bAfter?.linkedMemoryIds || []
      assert.ok(!aLinks.includes(b.id), 'A should no longer link to B')
      assert.ok(!bLinks.includes(a.id), 'B should no longer link to A')
    })

    it('link returns null for non-existent source', () => {
      const db = memDb.getMemoryDb()
      assert.equal(db.link('nonexistent', ['also-nonexistent']), null)
    })
  })

  // --- Pinned memories ---

  describe('pinned memories', () => {
    it('lists pinned memories for an agent', () => {
      const db = memDb.getMemoryDb()
      const agentId = `agent-pinned-${Date.now()}`
      db.add({ agentId, category: 'note', title: 'Regular', content: 'Not pinned' })
      db.add({ agentId, category: 'note', title: 'Pinned One', content: 'This is pinned', pinned: true })

      const pinned = db.listPinned(agentId)
      assert.ok(pinned.length >= 1)
      assert.ok(pinned.some((m) => m.title === 'Pinned One'))
      assert.ok(pinned.every((m) => m.pinned === true))
    })
  })

  // --- Scope filtering ---

  describe('filterMemoriesByScope', () => {
    it('returns all entries with mode=all', () => {
      const entries = [
        { id: '1', agentId: 'a1', category: 'note', title: 'x', content: 'y', createdAt: 0, updatedAt: 0 },
        { id: '2', agentId: null, category: 'note', title: 'x', content: 'y', createdAt: 0, updatedAt: 0 },
      ]
      const result = memDb.filterMemoriesByScope(entries, { mode: 'all' })
      assert.equal(result.length, 2)
    })

    it('filters to global-only with mode=global', () => {
      const entries = [
        { id: '1', agentId: 'a1', category: 'note', title: 'x', content: 'y', createdAt: 0, updatedAt: 0 },
        { id: '2', agentId: null, category: 'note', title: 'x', content: 'y', createdAt: 0, updatedAt: 0 },
      ]
      const result = memDb.filterMemoriesByScope(entries, { mode: 'global' })
      assert.equal(result.length, 1)
      assert.equal(result[0].id, '2')
    })

    it('filters by agent with mode=agent', () => {
      const entries = [
        { id: '1', agentId: 'a1', category: 'note', title: 'x', content: 'y', createdAt: 0, updatedAt: 0 },
        { id: '2', agentId: 'a2', category: 'note', title: 'x', content: 'y', createdAt: 0, updatedAt: 0 },
      ]
      const result = memDb.filterMemoriesByScope(entries, { mode: 'agent', agentId: 'a1' })
      assert.equal(result.length, 1)
      assert.equal(result[0].agentId, 'a1')
    })

    it('includes shared-with entries in agent mode', () => {
      const entries = [
        { id: '1', agentId: 'a2', sharedWith: ['a1'], category: 'note', title: 'x', content: 'y', createdAt: 0, updatedAt: 0 },
      ]
      const result = memDb.filterMemoriesByScope(entries, { mode: 'agent', agentId: 'a1' })
      assert.equal(result.length, 1)
    })

    it('returns empty for agent mode without agentId', () => {
      const entries = [
        { id: '1', agentId: 'a1', category: 'note', title: 'x', content: 'y', createdAt: 0, updatedAt: 0 },
      ]
      const result = memDb.filterMemoriesByScope(entries, { mode: 'agent' })
      assert.equal(result.length, 0)
    })

    it('filters by session with mode=session', () => {
      const entries = [
        { id: '1', agentId: 'a1', sessionId: 's1', category: 'note', title: 'x', content: 'y', createdAt: 0, updatedAt: 0 },
        { id: '2', agentId: 'a1', sessionId: 's2', category: 'note', title: 'x', content: 'y', createdAt: 0, updatedAt: 0 },
      ]
      const result = memDb.filterMemoriesByScope(entries, { mode: 'session', sessionId: 's1' })
      assert.equal(result.length, 1)
      assert.equal(result[0].sessionId, 's1')
    })
  })

  // --- normalizeMemoryScopeMode ---

  describe('normalizeMemoryScopeMode', () => {
    it('normalizes known modes', () => {
      assert.equal(memDb.normalizeMemoryScopeMode('all'), 'all')
      assert.equal(memDb.normalizeMemoryScopeMode('global'), 'global')
      assert.equal(memDb.normalizeMemoryScopeMode('agent'), 'agent')
      assert.equal(memDb.normalizeMemoryScopeMode('session'), 'session')
      assert.equal(memDb.normalizeMemoryScopeMode('project'), 'project')
    })

    it('maps shared to global', () => {
      assert.equal(memDb.normalizeMemoryScopeMode('shared'), 'global')
    })

    it('defaults to auto for unknown', () => {
      assert.equal(memDb.normalizeMemoryScopeMode('invalid'), 'auto')
      assert.equal(memDb.normalizeMemoryScopeMode(''), 'auto')
      assert.equal(memDb.normalizeMemoryScopeMode(null), 'auto')
      assert.equal(memDb.normalizeMemoryScopeMode(undefined), 'auto')
    })
  })

  // --- getLatestBySessionCategory ---

  describe('getLatestBySessionCategory', () => {
    it('returns a memory for a valid session+category', () => {
      const db = memDb.getMemoryDb()
      const sessionId = `sess-latest-${Date.now()}`
      db.add({ agentId: 'a', sessionId, category: 'working/context', title: 'Entry A', content: 'content alpha unique' })
      db.add({ agentId: 'a', sessionId, category: 'working/context', title: 'Entry B', content: 'content beta unique' })

      const latest = db.getLatestBySessionCategory(sessionId, 'working/context')
      assert.ok(latest, 'Should return a memory entry')
      assert.equal(latest!.sessionId, sessionId)
      assert.equal(latest!.category, 'working/context')
    })

    it('returns null for non-matching category', () => {
      const db = memDb.getMemoryDb()
      const sessionId = `sess-nomatch-${Date.now()}`
      db.add({ agentId: 'a', sessionId, category: 'note', title: 'X', content: 'x content unique nomatch' })
      assert.equal(db.getLatestBySessionCategory(sessionId, 'working/context'), null)
    })

    it('returns null for empty session/category', () => {
      const db = memDb.getMemoryDb()
      assert.equal(db.getLatestBySessionCategory('', 'note'), null)
      assert.equal(db.getLatestBySessionCategory('valid', ''), null)
    })
  })

  // --- countsByAgent ---

  describe('countsByAgent', () => {
    it('returns counts grouped by agent', () => {
      const db = memDb.getMemoryDb()
      // Data already exists from previous tests — just verify the shape
      const counts = db.countsByAgent()
      assert.equal(typeof counts, 'object')
      // Should have at least one key
      assert.ok(Object.keys(counts).length >= 1)
      for (const [, val] of Object.entries(counts)) {
        assert.equal(typeof val, 'number')
        assert.ok(val > 0)
      }
    })
  })

  // --- Delete cleans up links ---

  describe('delete cleans up linked references', () => {
    it('removes deleted ID from other memories linkedMemoryIds', () => {
      const db = memDb.getMemoryDb()
      const a = db.add({ agentId: 'agent-cleanup', category: 'note', title: 'Cleanup A', content: 'Cleanup A content' })
      const b = db.add({ agentId: 'agent-cleanup', category: 'note', title: 'Cleanup B', content: 'Cleanup B content' })
      const c = db.add({ agentId: 'agent-cleanup', category: 'note', title: 'Cleanup C', content: 'Cleanup C content' })

      db.link(a.id, [b.id, c.id])

      // Verify links exist
      const bBefore = db.get(b.id)
      assert.ok(bBefore?.linkedMemoryIds?.includes(a.id))

      // Delete A
      db.delete(a.id)

      // B and C should no longer reference A
      const bAfter = db.get(b.id)
      const cAfter = db.get(c.id)
      const bLinks = bAfter?.linkedMemoryIds || []
      const cLinks = cAfter?.linkedMemoryIds || []
      assert.ok(!bLinks.includes(a.id), 'B should not reference deleted A')
      assert.ok(!cLinks.includes(a.id), 'C should not reference deleted A')
    })
  })

  // --- addKnowledge ---

  describe('addKnowledge', () => {
    it('creates a global knowledge entry', () => {
      const entry = memDb.addKnowledge({
        title: 'API Rate Limits',
        content: 'The API has a rate limit of 100 requests per minute.',
        tags: ['api', 'limits'],
      })
      assert.ok(entry.id)
      assert.equal(entry.category, 'knowledge')
      assert.equal(entry.agentId, null)
      assert.equal(entry.title, 'API Rate Limits')
    })
  })

  // --- searchKnowledge ---

  describe('searchKnowledge', () => {
    it('finds knowledge entries by query', () => {
      // Add a knowledge entry with a unique term
      memDb.addKnowledge({
        title: 'Photosynthesis Process',
        content: 'Chlorophyll absorbs sunlight to convert carbon dioxide into glucose.',
        tags: ['biology', 'science'],
      })

      const results = memDb.searchKnowledge('chlorophyll photosynthesis glucose')
      assert.ok(results.length >= 1, `Expected at least 1 result, got ${results.length}`)
      assert.ok(results.every((r) => r.category === 'knowledge'))
    })
  })
})
