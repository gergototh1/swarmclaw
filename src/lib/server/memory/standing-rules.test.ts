import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'

/*
 * A tulajdonos szabálya nem jutott el az ügynökhöz.
 *
 * Élő eset (2026-09-16): a "minden fejlesztési feladat a Fejlesztő agentnek
 * megy" szabály `protocol/delegation` kategóriában volt. A kitűzött jegyzetek
 * (9 db) elfoglalták az első kör mind a 6 helyét, a `protocol/*` pedig nem is
 * számított szabálynak, így a fejlesztési feladatot az ügynök maga csinálta
 * meg. A szabályok azóta saját, karakterkeretes blokkban mennek, teljes
 * szöveggel (a Hermes USER.md mintájára).
 */

const originalEnv = {
  DATA_DIR: process.env.DATA_DIR,
  WORKSPACE_DIR: process.env.WORKSPACE_DIR,
  SWARMCLAW_BUILD_MODE: process.env.SWARMCLAW_BUILD_MODE,
}

let tempDir = ''
let memDb: typeof import('@/lib/server/memory/memory-db')
let rules: typeof import('@/lib/server/memory/standing-rules')
let preamble: typeof import('@/lib/server/memory/cli-memory-preamble')
let policy: typeof import('@/lib/server/memory/memory-policy')

const DELEGATION_RULE = 'MINDEN fejlesztési feladatot a Fejlesztő agentnek kell delegálni (777e99a7), spawn_subagent action="start" hívással.'

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-standing-rules-'))
  process.env.DATA_DIR = path.join(tempDir, 'data')
  process.env.WORKSPACE_DIR = path.join(tempDir, 'workspace')
  process.env.SWARMCLAW_BUILD_MODE = '1'
  memDb = await import('@/lib/server/memory/memory-db')
  rules = await import('@/lib/server/memory/standing-rules')
  preamble = await import('@/lib/server/memory/cli-memory-preamble')
  policy = await import('@/lib/server/memory/memory-policy')
})

after(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true })
})

function agentFor(id: string) {
  return { id, tools: ['memory'], proactiveMemory: true }
}

describe('standing rules reach the agent', () => {
  it('delivers a protocol rule in full even when pinned notes fill every slot', () => {
    const agentId = 'rules-crowded'
    const db = memDb.getMemoryDb()
    for (let i = 0; i < 9; i++) {
      db.add({ agentId, category: 'infra/swarmclaw', title: `Kitűzött ${i}`, content: `Kitűzött jegyzet ${i}.`, pinned: true })
    }
    // Global, like the live rule: no owning agent.
    db.add({ agentId: null, category: 'protocol/delegation', title: 'SZABÁLY: fejlesztés a Fejlesztőnek', content: DELEGATION_RULE })
    db.add({ agentId, category: 'preference/dev-workflow', title: 'Merge-szabály', content: 'Minden kódoló munka vége: visszamerge mainre, commit, push.' })

    const out = preamble.buildCliMemoryPreamble({
      session: { id: 'sr1', agentId },
      agent: agentFor(agentId),
      // Shares no word with either rule.
      message: 'ezeket csináld meg légyszi',
    })
    const text = out.preamble || ''
    assert.ok(text.includes(DELEGATION_RULE), `the whole delegation rule must arrive:\n${text}`)
    assert.ok(text.includes('Merge-szabály'), text)
    assert.ok(text.indexOf('## Standing rules') < text.indexOf('## What I already know'), text)
    assert.ok(text.includes('[pinned]'), 'pinned notes still arrive beside the rules')
  })

  it('sends the rule set once per transcript, and again when a rule changes', () => {
    const agentId = 'rules-refresh'
    const db = memDb.getMemoryDb()
    const rule = db.add({ agentId, category: 'protocol/language', title: 'Nyelv', content: 'Mindig magyarul válaszolj.' })

    const first = preamble.buildCliMemoryPreamble({ session: { id: 'sr2', agentId }, agent: agentFor(agentId), message: 'szia, kezdjünk bele' })
    assert.ok(first.preamble?.includes('Mindig magyarul'))

    const second = preamble.buildCliMemoryPreamble({
      session: { id: 'sr2', agentId, injectedMemoryIds: first.injectedMemoryIds },
      agent: agentFor(agentId),
      message: 'folytassuk a munkát kérlek',
    })
    assert.ok(!(second.preamble || '').includes('Mindig magyarul'), 'an unchanged rule set is not re-sent')

    db.update(rule.id, { content: 'Mindig magyarul válaszolj, tegezve.' })
    const third = preamble.buildCliMemoryPreamble({
      session: { id: 'sr2', agentId, injectedMemoryIds: second.injectedMemoryIds },
      agent: agentFor(agentId),
      message: 'folytassuk a munkát kérlek',
    })
    assert.ok(third.preamble?.includes('tegezve'), third.preamble || '')
    assert.ok(third.preamble?.includes('replaces any earlier copy'), third.preamble || '')
  })

  it('names the rules that do not fit instead of dropping them', () => {
    const agentId = 'rules-overflow'
    const db = memDb.getMemoryDb()
    const list = [
      db.add({ agentId, category: 'preference/a', title: 'Első', content: 'a'.repeat(60) }),
      db.add({ agentId, category: 'preference/b', title: 'Második', content: 'b'.repeat(60) }),
    ]
    const block = rules.buildStandingRulesBlock(list, { budget: 100 })
    assert.equal(block.included.length, 1)
    assert.equal(block.overflow.length, 1)
    assert.ok(block.text?.includes(`memory_get id ${list[1].id}`), block.text || '')
  })

  it('does not resend the rubric on the turn after an empty first turn', () => {
    const agentId = 'rules-empty'
    const first = preamble.buildCliMemoryPreamble({ session: { id: 'sr3', agentId }, agent: agentFor(agentId), message: 'szia, mi újság ma?' })
    assert.ok(first.preamble?.includes('## My durable memory'))
    const second = preamble.buildCliMemoryPreamble({
      session: { id: 'sr3', agentId, injectedMemoryIds: first.injectedMemoryIds },
      agent: agentFor(agentId),
      message: 'és holnap mi lesz?',
    })
    assert.equal(second.preamble, null)
  })
})

describe('checkStandingRulesBudget', () => {
  it('refuses a rule that would overflow the cap and lists what is there', () => {
    const agentId = 'budget-full'
    const db = memDb.getMemoryDb()
    // Global rules from earlier tests reach this agent too; they count.
    const base = rules.standingRulesTotalChars(rules.listStandingRules(agentId))
    const existing = db.add({ agentId, category: 'protocol/x', title: 'Hosszú szabály', content: 'x'.repeat(90) })
    const refusal = rules.checkStandingRulesBudget({
      agentId,
      next: { category: 'preference/y', title: 'Új', content: 'y'.repeat(20) },
      budget: base + 100,
    })
    assert.ok(refusal?.startsWith('Error: standing rules are full'), refusal || '')
    assert.ok(refusal?.includes(existing.id), refusal || '')
  })

  it('lets a rule be shortened in place and ignores non-rule categories', () => {
    const agentId = 'budget-replace'
    const db = memDb.getMemoryDb()
    const base = rules.standingRulesTotalChars(rules.listStandingRules(agentId))
    const existing = db.add({ agentId, category: 'protocol/x', title: 'Hosszú szabály', content: 'x'.repeat(90) })
    assert.equal(rules.checkStandingRulesBudget({
      agentId,
      next: { category: 'protocol/x', title: 'Rövidebb', content: 'x'.repeat(50) },
      replacingId: existing.id,
      budget: base + 100,
    }), null)
    assert.equal(rules.checkStandingRulesBudget({
      agentId,
      next: { category: 'knowledge/facts', title: 'Tény', content: 'z'.repeat(500) },
      budget: base + 100,
    }), null)
  })

  it('keeps contacts out of the rules budget', () => {
    assert.equal(rules.isStandingRuleCategory('identity/contacts'), false)
    assert.equal(rules.isStandingRuleCategory('identity/relationships'), false)
    assert.equal(rules.isStandingRuleCategory('identity/preferences'), true)
    assert.equal(rules.isStandingRuleCategory('protocol/delegation'), true)
  })

  it('files a category named "rule" where the rules block reads it', () => {
    const category = policy.normalizeMemoryCategory('rule')
    assert.ok(rules.isStandingRuleCategory(category), category)
  })
})
