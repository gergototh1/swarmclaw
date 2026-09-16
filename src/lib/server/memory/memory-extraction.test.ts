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

/*
 * A "busy" nem indok a munka eldobására.
 *
 * ÉLESBEN MÉRVE (2026-09-15): a hűtés célonkénti szétválasztása után a
 * kivonatolás már nem `cooldown`-ra bukott, hanem `busy`-ra -- az egyidejűségi
 * korlátot elvitték az ütemezett futások, amik ugyanabban a percben dolgoztak.
 * Az osztályozó és a working-state a fordulóval EGYÜTT fut, tehát mindig
 * előbb kér slotot; a kivonatolás pedig, ami utánuk indul, mindig veszít.
 *
 * A kivonatolás viszont halasztható: senki nem vár rá. Ezért nem eldobja
 * magát, hanem vár és újrapróbálja -- ez a különbség a fék és a kiéheztetés
 * között.
 */
describe('extractTurnCandidates retries a busy helper', () => {
  it('waits and tries again rather than dropping the turn', async () => {
    let calls = 0
    const stored = await extraction.extractTurnCandidates(
      {
        agentId: 'retry-1',
        sessionId: 'rs1',
        message: 'A build-gépünk neve ZORPHAX-7 és a CI a 9911-es porton figyel, ezt jegyezd meg kérlek.',
        response: 'Rendben, megjegyeztem a gép nevét és a portot is.',
      },
      {
        retryDelayMs: 1,
        generate: async () => {
          calls++
          if (calls === 1) throw new Error('utility model refused by budget: busy')
          return '{"facts":["A build-gép neve ZORPHAX-7, a CI a 9911-es porton figyel."]}'
        },
      },
    )
    assert.ok(calls >= 2, `expected a retry, got ${calls} call(s)`)
    assert.equal(stored, 1)
  })

  it('gives up after a bounded number of attempts', async () => {
    let calls = 0
    const stored = await extraction.extractTurnCandidates(
      { agentId: 'retry-2', sessionId: 'rs2', message: 'Egy elég hosszú kérdés ahhoz hogy kivonatolásra érdemes legyen.', response: 'Egy elég hosszú válasz is hozzá.' },
      {
        retryDelayMs: 1,
        generate: async () => { calls++; throw new Error('utility model refused by budget: busy') },
      },
    )
    assert.equal(stored, 0)
    assert.ok(calls <= 4, `a retry loop must be bounded, got ${calls}`)
  })

  it('does not retry a refusal that will not change', async () => {
    // Elfogyott a napi keret vagy ki van kapcsolva: várni értelmetlen.
    let calls = 0
    await extraction.extractTurnCandidates(
      { agentId: 'retry-3', sessionId: 'rs3', message: 'Egy elég hosszú kérdés ahhoz hogy kivonatolásra érdemes legyen.', response: 'Egy elég hosszú válasz is hozzá.' },
      {
        retryDelayMs: 1,
        generate: async () => { calls++; throw new Error('utility model refused by budget: daily_cap') },
      },
    )
    assert.equal(calls, 1)
  })
})

/*
 * A beszélgetésben kimondott szabály tényként végezte.
 *
 * A kivonatoló mindent `knowledge/facts`-ba írt, amit csak kulcsszóra hív elő a
 * rendszer, és háttérinfóként keretez. Egy "mostantól minden fejlesztést a
 * Fejlesztő csinál" így sosem lett utasítás. Most külön gyűjti a szabályokat,
 * látja a már rögzítetteket, és szabályként menti őket, a szabálykereten belül.
 */
describe('rules the user gives in conversation', () => {
  it('parses rules separately from facts', () => {
    const rules = extraction.parseExtractedRules('{"facts":[],"rules":[{"text":"Minden fejlesztési feladatot a Fejlesztő agent kap.","replaces":null},"Mindig magyarul válaszolj a felhasználónak."]}')
    assert.deepEqual(rules, [
      { text: 'Minden fejlesztési feladatot a Fejlesztő agent kap.', replaces: null },
      { text: 'Mindig magyarul válaszolj a felhasználónak.', replaces: null },
    ])
    assert.deepEqual(extraction.parseExtractedRules('{"facts":["egy tény ami elég hosszú"]}'), [])
  })

  it('shows the extractor the rules already on record', async () => {
    const db = memDb.getMemoryDb()
    const recorded = db.add({ agentId: 'rules-seen', category: 'protocol/language', title: 'Nyelv', content: 'Mindig magyarul válaszolj.' })
    let prompt = ''
    await extraction.extractTurnCandidates(
      { agentId: 'rules-seen', sessionId: 'rx', message: 'Mostantól minden fejlesztést a Fejlesztő agent csináljon meg.', response: 'Rendben, ezentúl a Fejlesztőnek adom.' },
      { generate: async (p) => { prompt = p; return '{"facts":[],"rules":[]}' } },
    )
    assert.ok(prompt.includes(recorded.id), prompt)
    assert.ok(prompt.includes('Mindig magyarul'), prompt)
  })

  it('promotes a stated rule into the rules block, not into facts', async () => {
    const agentId = 'rules-learn'
    await extraction.extractTurnCandidates(
      { agentId, sessionId: 'rl', message: 'Mostantól minden fejlesztési feladatot a Fejlesztő agentnek adj ki.', response: 'Rendben, ezentúl így lesz.' },
      { generate: async () => '{"facts":[],"rules":[{"text":"Minden fejlesztési feladatot a Fejlesztő agentnek kell kiadni.","replaces":null}]}' },
    )
    await extraction.promoteCandidates({ limit: 50 })
    const { listStandingRules } = await import('@/lib/server/memory/standing-rules')
    const rule = listStandingRules(agentId).find((entry) => entry.content.includes('Fejlesztő agentnek'))
    assert.ok(rule, 'the rule must be readable by the rules block')
    assert.equal(rule.category, 'preference/learned')
  })

  it('rewrites a rule the agent owns when the user changes it', async () => {
    const agentId = 'rules-change'
    const db = memDb.getMemoryDb()
    const old = db.add({ agentId, category: 'preference/learned', title: 'Merge', content: 'Minden munka végén merge mainre.' })
    await extraction.extractTurnCandidates(
      { agentId, sessionId: 'rc', message: 'Ne merge-elj mainre, mostantól csak PR-t nyiss minden munka végén.', response: 'Rendben, ezentúl PR-t nyitok.' },
      { generate: async () => JSON.stringify({ facts: [], rules: [{ text: 'Minden munka végén PR-t kell nyitni, nem merge-elni mainre.', replaces: old.id }] }) },
    )
    await extraction.promoteCandidates({ limit: 50 })
    assert.match(db.get(old.id)?.content || '', /PR-t kell nyitni/)
  })

  it('never lets a guessed id overwrite a memory the extractor was not shown', async () => {
    const agentId = 'rules-guess'
    const db = memDb.getMemoryDb()
    const unrelated = db.add({ agentId, category: 'knowledge/facts', title: 'Port', content: 'Az app a 8765-ös porton fut.' })
    await extraction.extractTurnCandidates(
      { agentId, sessionId: 'rg', message: 'Mostantól mindig tegezve írj nekem minden üzenetben, ez egy fontos szabály.', response: 'Rendben, ezentúl tegezni foglak.' },
      { generate: async () => JSON.stringify({ facts: [], rules: [{ text: 'A felhasználót mindig tegezni kell.', replaces: unrelated.id }] }) },
    )
    const pending = db.listCandidates({ agentId, state: 'candidate' })
    assert.equal(pending.length, 1, 'the rule must reach the queue, or this test proves nothing')
    await extraction.promoteCandidates({ limit: 50 })
    assert.equal(db.get(unrelated.id)?.content, 'Az app a 8765-ös porton fut.')
  })

  it('keeps a rule as a fact when the rules are full, instead of losing it', async () => {
    const agentId = 'rules-full'
    const db = memDb.getMemoryDb()
    const { STANDING_RULES_CHAR_BUDGET } = await import('@/lib/server/memory/standing-rules')
    db.add({ agentId, category: 'protocol/big', title: 'Nagy', content: 'x'.repeat(STANDING_RULES_CHAR_BUDGET) })
    const candidate = db.addCandidate({ agentId, text: 'A felhasználónak mindig röviden kell válaszolni.', source: 'chat-turn-rule' })
    await extraction.promoteCandidates({ limit: 50 })
    const decided = db.listCandidates({ agentId, state: 'promoted' }).find((c) => c.id === candidate.id)
    assert.ok(decided?.memoryId)
    const kept = db.get(decided.memoryId)
    assert.equal(kept?.category, 'knowledge/facts')
    assert.equal(kept?.metadata?.ruleNotApplied, 'standing-rules-budget-full')
  })
})
