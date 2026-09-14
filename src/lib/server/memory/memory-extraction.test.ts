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
let extraction: typeof import('@/lib/server/memory/memory-extraction')

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-extraction-'))
  process.env.DATA_DIR = path.join(tempDir, 'data')
  process.env.WORKSPACE_DIR = path.join(tempDir, 'workspace')
  process.env.SWARMCLAW_BUILD_MODE = '1'
  memDb = await import('@/lib/server/memory/memory-db')
  extraction = await import('@/lib/server/memory/memory-extraction')
})

after(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true })
})

/*
 * Ez a hiányzó kiváltó ok.
 *
 * Az élő tárban 165 sorból 122 gépi és mind ki van zárva a felidézésből; ami
 * marad, az kizárólag az, amit az ügynök magától leírt: 43 db, nagyjából egy
 * emlék 5-8 munkamenetenként. Nem azért, mert nincs mit menteni -- 94 teljes
 * átirat van róla --, hanem mert semmi nem vonja ki belőlük a tényeket.
 *
 * Összehasonlításul ugyanezen a gépen a Hermes 3658 jelöltet gyűjtött, mert
 * MINDEN fordulóban kivonatol (`retain_every_n_turns: 1`), aszinkron, egy olcsó
 * modellel.
 */
describe('parseExtractedFacts', () => {
  it('reads the fact list out of the model\'s json', () => {
    const facts = extraction.parseExtractedFacts('{"facts":["A app a 8765 porton fut.","Gergő magyarul kér választ."]}')
    assert.deepEqual(facts, ['A app a 8765 porton fut.', 'Gergő magyarul kér választ.'])
  })

  it('survives the chattiness of a small model', () => {
    // Egy olcsó modell szívesen keretezi a választ; a hasznos rész attól még ott van.
    const facts = extraction.parseExtractedFacts('Persze!\n```json\n{"facts":["Gergő mindig magyarul kér választ."]}\n```\nRemélem segít.')
    assert.deepEqual(facts, ['Gergő mindig magyarul kér választ.'])
  })

  it('accepts a bare array too', () => {
    assert.deepEqual(extraction.parseExtractedFacts('["Gergő mindig magyarul kér választ."]'), ['Gergő mindig magyarul kér választ.'])
  })

  it('returns nothing rather than guessing when the answer is unusable', () => {
    for (const bad of ['', 'nem volt semmi', '{"facts": "nem tömb"}', '{']) {
      assert.deepEqual(extraction.parseExtractedFacts(bad), [], JSON.stringify(bad))
    }
  })

  it('drops blanks, duplicates and one-word noise', () => {
    // "ok" a zaj: egy szó nem mondat, és egy hónap múlva semmit nem jelent.
    const facts = extraction.parseExtractedFacts('{"facts":["  ","ok","A app a localhost:8765 porton fut.","A app a localhost:8765 porton fut."]}')
    assert.deepEqual(facts, ['A app a localhost:8765 porton fut.'])
  })

  it('caps how many facts one turn may produce', () => {
    const many = Array.from({ length: 30 }, (_, i) => `Ez a(z) ${i}. rendes hosszú tény a fordulóból.`)
    const facts = extraction.parseExtractedFacts(JSON.stringify({ facts: many }))
    assert.ok(facts.length <= extraction.MAX_FACTS_PER_TURN, `got ${facts.length}`)
  })
})

describe('extractTurnCandidates', () => {
  it('stores what the model found as candidates, not as memories', async () => {
    const before = memDb.getMemoryDb().list('extract-1', 100).length
    await extraction.extractTurnCandidates({
      agentId: 'extract-1',
      sessionId: 's1',
      message: 'A Kreatív angol app a localhost:8765 porton fut, a repo a ~/DEV/kreativ-angol mappában van. Jegyezd meg.',
      response: 'Rendben, megjegyeztem a portot és a repó helyét is.',
    }, { generate: async () => '{"facts":["A Kreatív angol app a localhost:8765 porton fut."]}' })

    const pending = memDb.getMemoryDb().listCandidates({ agentId: 'extract-1', state: 'candidate' })
    assert.equal(pending.length, 1)
    assert.match(pending[0].text, /8765/)
    assert.equal(memDb.getMemoryDb().list('extract-1', 100).length, before, 'extraction must not write memories directly')
  })

  it('never lets a failing helper break the turn', async () => {
    await assert.doesNotReject(extraction.extractTurnCandidates(
      { agentId: 'extract-2', sessionId: 's2', message: 'kérdés ami elég hosszú ahhoz hogy számítson', response: 'válasz' },
      { generate: async () => { throw new Error('budget') } },
    ))
  })

  it('does not call the model for a turn with nothing in it', async () => {
    let calls = 0
    await extraction.extractTurnCandidates(
      { agentId: 'extract-3', sessionId: 's3', message: 'ok', response: 'ok' },
      { generate: async () => { calls++; return '{"facts":[]}' } },
    )
    assert.equal(calls, 0, 'a two-word exchange is not worth a model call')
  })
})

describe('promoteCandidates', () => {
  it('turns a candidate into a durable memory and records the decision', async () => {
    const db = memDb.getMemoryDb()
    const candidate = db.addCandidate({ agentId: 'promo-1', sessionId: 's1', text: 'A promóciós teszt ténye, elég hosszú ahhoz hogy megálljon.', source: 'chat-turn' })
    const result = await extraction.promoteCandidates({ limit: 10 })
    assert.ok(result.promoted >= 1)

    const stored = db.list('promo-1', 100)
    assert.equal(stored.some((m) => m.content.includes('promóciós teszt')), true)
    const decided = db.listCandidates({ agentId: 'promo-1', state: 'promoted' })
    assert.equal(decided.some((c) => c.id === candidate.id), true)
    assert.ok(decided.find((c) => c.id === candidate.id)?.memoryId, 'the decision must point at the memory it made')
  })

  it('leaves nothing pending twice', async () => {
    const db = memDb.getMemoryDb()
    db.addCandidate({ agentId: 'promo-2', text: 'Egy másik tény, szintén elég hosszú ehhez.', source: 'chat-turn' })
    await extraction.promoteCandidates({ limit: 10 })
    const second = await extraction.promoteCandidates({ limit: 10 })
    assert.equal(second.promoted, 0)
  })

  it('scores a promoted memory, so it can outrank the noise', () => {
    // Az `importance` a salience szorzója; pontozatlan bejegyzés soha nem kerül
    // előre. A kategória adja az alapot, ahogy a kézi íráskor is.
    const db = memDb.getMemoryDb()
    const stored = db.list('promo-1', 100).find((m) => m.content.includes('promóciós teszt'))
    assert.ok(stored)
    assert.ok((stored.importance || 0) > 0, `expected a score, got ${stored.importance}`)
  })
})
