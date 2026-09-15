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
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-candidates-'))
  process.env.DATA_DIR = path.join(tempDir, 'data')
  process.env.WORKSPACE_DIR = path.join(tempDir, 'workspace')
  process.env.SWARMCLAW_BUILD_MODE = '1'
  memDb = await import('@/lib/server/memory/memory-db')
})

after(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true })
})

/*
 * A kivonat jelölt, nem kész emlék.
 *
 * Minden komoly rendszer így csinálja: a kinyert tény először jelölt, és csak
 * egy döntés után lesz belőle tartós emlék. A Hermes `candidates` táblájában
 * 3658 sor van `state` mezővel és `content_sha256` deduppal; a mem0 ugyanezt a
 * döntést ADD/UPDATE/DELETE/NOOP-nak hívja.
 *
 * Miért nem írunk egyből memóriát: a kivonatoló egy olcsó modell, és sokat fut.
 * Ha közvetlenül a tartós tárba írna, egy rossz forduló azonnal szemetet
 * hagyna a felidézésben, visszavonhatatlanul. Jelöltként viszont eldobható.
 */
describe('memory candidates', () => {
  it('stores a candidate and hands it back for promotion', () => {
    const db = memDb.getMemoryDb()
    const created = db.addCandidate({
      agentId: 'a1',
      sessionId: 's1',
      text: 'A Kreatív angol app a localhost:8765 porton fut.',
      source: 'chat-turn',
    })
    assert.ok(created.id)
    const pending = db.listCandidates({ state: 'candidate', limit: 10 })
    assert.equal(pending.some((c) => c.id === created.id), true)
  })

  it('drops a candidate whose text it already holds', () => {
    // A kivonatoló minden fordulóban fut, és ugyanazt a tényt többször is
    // észreveszi. Duplikátum nélkül a jelölt-tábla ugyanúgy hízna, mint a
    // digestek híztak.
    const db = memDb.getMemoryDb()
    const text = 'Gergő magyarul kér választ.'
    const first = db.addCandidate({ agentId: 'a2', text, source: 'chat-turn' })
    const second = db.addCandidate({ agentId: 'a2', text: `  ${text}  `, source: 'chat-turn' })
    assert.equal(second.id, first.id, 'the same fact must not become two candidates')
  })

  it('keeps the same text apart for different agents', () => {
    const db = memDb.getMemoryDb()
    const text = 'Ugyanaz a mondat, másik ügynök.'
    const a = db.addCandidate({ agentId: 'a3', text, source: 'chat-turn' })
    const b = db.addCandidate({ agentId: 'a4', text, source: 'chat-turn' })
    assert.notEqual(a.id, b.id)
  })

  it('stops handing back a candidate once it has been decided', () => {
    const db = memDb.getMemoryDb()
    const created = db.addCandidate({ agentId: 'a5', text: 'Eldöntendő tény.', source: 'chat-turn' })
    db.markCandidate(created.id, 'promoted', { memoryId: 'mem-1' })
    const pending = db.listCandidates({ state: 'candidate', limit: 50 })
    assert.equal(pending.some((c) => c.id === created.id), false)
    const promoted = db.listCandidates({ state: 'promoted', limit: 50 })
    assert.equal(promoted.some((c) => c.id === created.id), true)
  })

  it('records a rejection too, so the same fact is not re-extracted forever', () => {
    const db = memDb.getMemoryDb()
    const created = db.addCandidate({ agentId: 'a6', text: 'Nem éri meg megjegyezni.', source: 'chat-turn' })
    db.markCandidate(created.id, 'rejected')
    assert.equal(db.listCandidates({ state: 'candidate', limit: 50 }).some((c) => c.id === created.id), false)
    // A dedup a döntés UTÁN is véd: ugyanaz a szöveg nem jön vissza jelöltként.
    const again = db.addCandidate({ agentId: 'a6', text: 'Nem éri meg megjegyezni.', source: 'chat-turn' })
    assert.equal(again.id, created.id)
    assert.equal(db.listCandidates({ state: 'candidate', limit: 50 }).some((c) => c.id === created.id), false)
  })

  it('refuses an empty candidate rather than storing a blank row', () => {
    const db = memDb.getMemoryDb()
    assert.throws(() => db.addCandidate({ agentId: 'a7', text: '   ', source: 'chat-turn' }), /empty|text/i)
  })

  it('returns the oldest pending candidates first, so nothing starves', () => {
    const db = memDb.getMemoryDb()
    const first = db.addCandidate({ agentId: 'a8', text: 'Első jelölt a sorban.', source: 'chat-turn' })
    db.addCandidate({ agentId: 'a8', text: 'Második jelölt a sorban.', source: 'chat-turn' })
    const pending = db.listCandidates({ agentId: 'a8', state: 'candidate', limit: 10 })
    assert.equal(pending[0]?.id, first.id)
  })
})
