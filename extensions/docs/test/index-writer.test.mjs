import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { MIGRATIONS, createRepo } from '../src/db.mjs'
import { createIndexWriter } from '../src/index-writer.mjs'
import { createVault } from '../src/vault.mjs'
import { memStorage } from './helpers.mjs'

function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-idx-'))
  const s = memStorage()
  for (const m of MIGRATIONS) s.raw.exec(m.sql)
  const vault = createVault({ root })
  vault.ensureRoot()
  const repo = createRepo(s)
  let clock = 1_000_000
  const writer = createIndexWriter({ vault, repo, now: () => clock })
  return {
    vault,
    repo,
    writer,
    tick: (ms) => { clock += ms },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  }
}

function write(h, rel, meta, body) {
  return h.vault.writeDoc(rel, { meta: { owner: 'user', tags: [], ...meta }, body })
}

test('indexing a file written by the module keeps its id and title', () => {
  const h = harness()
  try {
    write(h, 'kozos/a.md', { id: 'doc_a', title: 'Ügyfélprofil', created: 'c', updated: 'u' }, 'Morvai jegyzet.\n')
    const res = h.writer.indexPath('kozos/a.md')
    assert.equal(res.id, 'doc_a')
    assert.equal(res.headerRepaired, false)
    assert.equal(res.changed, true)
    assert.equal(h.repo.getById('doc_a').title, 'Ügyfélprofil')
    assert.equal(h.repo.search('morvai', {}).length, 1)
  } finally { h.cleanup() }
})

test('a file with no front matter gets one written back into it', () => {
  const h = harness()
  try {
    fs.mkdirSync(path.join(h.vault.root, 'kozos'), { recursive: true })
    fs.writeFileSync(path.join(h.vault.root, 'kozos/kivulrol.md'), '# Kívülről jött\n\nSzöveg.\n')

    const res = h.writer.indexPath('kozos/kivulrol.md')
    assert.equal(res.headerRepaired, true)
    assert.match(res.id, /^doc_[0-9a-f]{8}$/)

    const read = h.vault.readDoc('kozos/kivulrol.md')
    assert.equal(read.meta.id, res.id)
    assert.equal(read.meta.title, 'Kívülről jött')
    assert.equal(read.body, '# Kívülről jött\n\nSzöveg.\n', 'a törzs nem maradt érintetlen')
  } finally { h.cleanup() }
})

test('a file with no heading falls back to the file name for its title', () => {
  const h = harness()
  try {
    fs.mkdirSync(path.join(h.vault.root, 'kozos'), { recursive: true })
    fs.writeFileSync(path.join(h.vault.root, 'kozos/nincs-cim.md'), 'Csak szöveg.\n')
    const res = h.writer.indexPath('kozos/nincs-cim.md')
    assert.equal(h.repo.getById(res.id).title, 'nincs-cim')
  } finally { h.cleanup() }
})

test('owner comes from the folder the file sits in', () => {
  const h = harness()
  try {
    fs.mkdirSync(path.join(h.vault.root, 'agents/marketing'), { recursive: true })
    fs.writeFileSync(path.join(h.vault.root, 'agents/marketing/a.md'), '# A\n')
    const agentDoc = h.writer.indexPath('agents/marketing/a.md')
    assert.equal(h.repo.getById(agentDoc.id).owner, 'agent:marketing')

    fs.mkdirSync(path.join(h.vault.root, 'kozos'), { recursive: true })
    fs.writeFileSync(path.join(h.vault.root, 'kozos/b.md'), '# B\n')
    const sharedDoc = h.writer.indexPath('kozos/b.md')
    assert.equal(h.repo.getById(sharedDoc.id).owner, 'user')
  } finally { h.cleanup() }
})

test('indexing is idempotent: the second run reports no change', () => {
  const h = harness()
  try {
    write(h, 'kozos/a.md', { id: 'doc_a', title: 'A' }, 'x\n')
    assert.equal(h.writer.indexPath('kozos/a.md').changed, true)
    assert.equal(h.writer.indexPath('kozos/a.md').changed, false)
    assert.equal(h.repo.listDocs({}).length, 1)
    assert.equal(h.repo.getById('doc_a').version, 1, 'a verzió nőtt, pedig semmi nem változott')
  } finally { h.cleanup() }
})

test('a changed file bumps the version', () => {
  const h = harness()
  try {
    write(h, 'kozos/a.md', { id: 'doc_a', title: 'A' }, 'x\n')
    h.writer.indexPath('kozos/a.md')
    write(h, 'kozos/a.md', { id: 'doc_a', title: 'A' }, 'MÁS\n')
    h.writer.indexPath('kozos/a.md')
    assert.equal(h.repo.getById('doc_a').version, 2)
  } finally { h.cleanup() }
})

test('two files carrying the same id: the second gets a fresh one', () => {
  const h = harness()
  try {
    write(h, 'kozos/a.md', { id: 'doc_a', title: 'A' }, 'x\n')
    write(h, 'kozos/masolat.md', { id: 'doc_a', title: 'A másolata' }, 'x\n')
    h.writer.indexPath('kozos/a.md')
    const res = h.writer.indexPath('kozos/masolat.md')

    assert.notEqual(res.id, 'doc_a')
    assert.equal(res.headerRepaired, true)
    assert.equal(h.repo.getByPath('kozos/a.md').id, 'doc_a')
    assert.equal(h.vault.readDoc('kozos/masolat.md').meta.id, res.id)
  } finally { h.cleanup() }
})

test('a moved file keeps its id and the old path stops resolving', () => {
  const h = harness()
  try {
    write(h, 'kozos/a.md', { id: 'doc_a', title: 'A' }, 'x\n')
    h.writer.indexPath('kozos/a.md')
    h.vault.move('kozos/a.md', 'agents/marketing/a.md')
    h.writer.indexPath('agents/marketing/a.md')

    assert.equal(h.repo.getById('doc_a').path, 'agents/marketing/a.md')
    assert.equal(h.repo.getByPath('kozos/a.md'), undefined)
  } finally { h.cleanup() }
})

test('links are recorded, and bind as soon as the target is indexed', () => {
  const h = harness()
  try {
    write(h, 'kozos/a.md', { id: 'doc_a', title: 'A' }, 'Lásd [[Cél]].\n')
    h.writer.indexPath('kozos/a.md')
    assert.deepEqual(h.repo.backlinks('doc_cel'), [])

    // A cél indexelése köti be a rá váró hivatkozást, a hivatkozó
    // újraindexelése nélkül.
    write(h, 'kozos/cel.md', { id: 'doc_cel', title: 'Cél' }, 'y\n')
    h.writer.indexPath('kozos/cel.md')

    assert.deepEqual(h.repo.backlinks('doc_cel').map((b) => b.fromId), ['doc_a'])
  } finally { h.cleanup() }
})

test('indexAll drops rows whose file is gone', () => {
  const h = harness()
  try {
    write(h, 'kozos/a.md', { id: 'doc_a', title: 'A' }, 'x\n')
    write(h, 'kozos/b.md', { id: 'doc_b', title: 'B' }, 'x\n')
    assert.deepEqual(h.writer.indexAll(), { scanned: 2, changed: 2, removed: 0 })

    fs.rmSync(path.join(h.vault.root, 'kozos/b.md'))
    assert.deepEqual(h.writer.indexAll(), { scanned: 1, changed: 0, removed: 1 })
    assert.equal(h.repo.getById('doc_b'), undefined)
  } finally { h.cleanup() }
})

test('indexAll keeps a trashed document, whose file is deliberately gone', () => {
  const h = harness()
  try {
    write(h, 'kozos/a.md', { id: 'doc_a', title: 'A' }, 'x\n')
    h.writer.indexPath('kozos/a.md')
    h.repo.addVersion('doc_a', { version: 1, content: 'x\n', author: 'user', createdAt: 'x' })
    h.repo.softDelete('doc_a', 'x')
    h.vault.trash('kozos/a.md', 'doc_a')

    assert.deepEqual(h.writer.indexAll(), { scanned: 0, changed: 0, removed: 0 })
    assert.equal(h.repo.listDocs({ includeDeleted: true }).length, 1)
  } finally { h.cleanup() }
})

test('a self-write is recognised by hash, and a real outside edit is not', () => {
  const h = harness()
  try {
    const w = write(h, 'kozos/a.md', { id: 'doc_a', title: 'A' }, 'x\n')
    h.writer.noteSelfWrite('kozos/a.md', w.hash)
    assert.equal(h.writer.isSelfWrite('kozos/a.md', w.hash), true)

    const w2 = write(h, 'kozos/a.md', { id: 'doc_a', title: 'A' }, 'MÁS\n')
    assert.equal(h.writer.isSelfWrite('kozos/a.md', w2.hash), false)
  } finally { h.cleanup() }
})

test('a self-write note expires after five seconds', () => {
  const h = harness()
  try {
    const w = write(h, 'kozos/a.md', { id: 'doc_a', title: 'A' }, 'x\n')
    h.writer.noteSelfWrite('kozos/a.md', w.hash)
    h.tick(4_999)
    assert.equal(h.writer.isSelfWrite('kozos/a.md', w.hash), true)
    h.tick(2)
    assert.equal(h.writer.isSelfWrite('kozos/a.md', w.hash), false)
  } finally { h.cleanup() }
})

test('indexPath names a missing file rather than inventing a row', () => {
  const h = harness()
  try {
    assert.throws(() => h.writer.indexPath('nincs.md'), (err) => err.code === 'doc_not_found')
  } finally { h.cleanup() }
})
