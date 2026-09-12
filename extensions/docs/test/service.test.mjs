import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { MIGRATIONS, createRepo } from '../src/db.mjs'
import { ERR } from '../src/errors.mjs'
import { createIndexWriter } from '../src/index-writer.mjs'
import { createService, fileSlug } from '../src/service.mjs'
import { createVault } from '../src/vault.mjs'
import { memStorage } from './helpers.mjs'

const user = { kind: 'user' }
const marketing = { kind: 'agent', slug: 'marketing' }
const kutato = { kind: 'agent', slug: 'kutato' }

function harness({ versions = 50 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-svc-'))
  const s = memStorage()
  for (const m of MIGRATIONS) s.raw.exec(m.sql)
  const vault = createVault({ root })
  vault.ensureRoot()
  const repo = createRepo(s)
  const writer = createIndexWriter({ vault, repo })
  let clock = Date.parse('2026-09-06T10:00:00.000Z')
  const service = createService({
    vault,
    writer,
    repo,
    sharedFolder: () => 'kozos',
    versionsKept: () => versions,
    now: () => new Date(clock),
  })
  return {
    vault,
    repo,
    service,
    tick: (ms) => { clock += ms },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  }
}

test('fileSlug folds accents and never returns an empty name', () => {
  assert.equal(fileSlug('Ügyfélprofil — Morvai'), 'ugyfelprofil-morvai')
  assert.equal(fileSlug('Kőműves Űrhajós'), 'komuves-urhajos')
  assert.equal(fileSlug('!!!'), 'doc')
  assert.equal(fileSlug(''), 'doc')
})

test('create without a folder lands in the calling agent home', () => {
  const h = harness()
  try {
    const res = h.service.create(marketing, { title: 'Ügyfélprofil', content: 'Szöveg.\n' })
    assert.equal(res.path, 'agents/marketing/ugyfelprofil.md')
    assert.equal(res.version, 1)
    assert.equal(h.repo.getById(res.id).owner, 'agent:marketing')
  } finally { h.cleanup() }
})

test('create by the operator with no folder lands in the shared folder', () => {
  const h = harness()
  try {
    const res = h.service.create(user, { title: 'Közös jegyzet' })
    assert.equal(res.path, 'kozos/kozos-jegyzet.md')
  } finally { h.cleanup() }
})

test('create refuses another agent folder by name', () => {
  const h = harness()
  try {
    assert.throws(
      () => h.service.create(marketing, { folder: 'agents/kutato', title: 'Belenyúlás' }),
      (err) => err.code === ERR.forbidden,
    )
  } finally { h.cleanup() }
})

test('two documents with the same title get distinct file names', () => {
  const h = harness()
  try {
    const a = h.service.create(marketing, { title: 'Jegyzet' })
    const b = h.service.create(marketing, { title: 'Jegyzet' })
    assert.equal(a.path, 'agents/marketing/jegyzet.md')
    assert.equal(b.path, 'agents/marketing/jegyzet-2.md')
    assert.notEqual(a.id, b.id)
  } finally { h.cleanup() }
})

test('create from a template starts from the template body', () => {
  const h = harness()
  try {
    h.vault.writeDoc('_templates/jegyzokonyv.md', {
      meta: { id: 'doc_tpl', title: 'Jegyzőkönyv', owner: 'user', tags: [] },
      body: '## Résztvevők\n\n## Döntések\n',
    })
    const res = h.service.create(marketing, { title: 'Hétfői kör', template: 'jegyzokonyv' })
    assert.equal(h.service.read(res.id).content, '## Résztvevők\n\n## Döntések\n')
  } finally { h.cleanup() }
})

test('create names a missing template instead of writing an empty doc', () => {
  const h = harness()
  try {
    assert.throws(
      () => h.service.create(marketing, { title: 'X', template: 'nincs-ilyen' }),
      (err) => err.code === ERR.doc_not_found,
    )
  } finally { h.cleanup() }
})

test('update without baseVersion is refused, not silently applied', () => {
  const h = harness()
  try {
    const doc = h.service.create(marketing, { title: 'A', content: 'eredeti\n' })
    assert.throws(
      () => h.service.update(marketing, { id: doc.id, content: 'új\n' }),
      (err) => err.code === ERR.invalid_argument,
    )
    assert.equal(h.service.read(doc.id).content, 'eredeti\n')
  } finally { h.cleanup() }
})

test('update with a stale baseVersion conflicts and writes nothing', () => {
  const h = harness()
  try {
    const doc = h.service.create(marketing, { title: 'A', content: 'eredeti\n' })
    h.service.update(user, { id: doc.id, content: 'operátoré\n', baseVersion: 1 })

    let caught
    try {
      h.service.update(marketing, { id: doc.id, content: 'ügynöké\n', baseVersion: 1 })
    } catch (err) { caught = err }

    assert.equal(caught.code, ERR.conflict)
    assert.equal(caught.details.currentVersion, 2)
    assert.equal(caught.details.modifiedBy, 'user')
    assert.equal(caught.details.theirs, 'operátoré\n')
    assert.equal(h.service.read(doc.id).content, 'operátoré\n')
  } finally { h.cleanup() }
})

test('update with the right baseVersion writes and bumps the version', () => {
  const h = harness()
  try {
    const doc = h.service.create(marketing, { title: 'A', content: 'eredeti\n' })
    const res = h.service.update(marketing, { id: doc.id, content: 'új\n', baseVersion: 1 })
    assert.equal(res.version, 2)
    assert.equal(h.service.read(doc.id).content, 'új\n')
  } finally { h.cleanup() }
})

test('a version row holds the text of that version, not the one before it', () => {
  const h = harness()
  try {
    const doc = h.service.create(marketing, { title: 'A', content: 'egy\n' })
    h.service.update(marketing, { id: doc.id, content: 'ketto\n', baseVersion: 1 })
    assert.equal(h.service.version(doc.id, 1).content, 'egy\n')
    assert.equal(h.service.version(doc.id, 2).content, 'ketto\n')
  } finally { h.cleanup() }
})

test('versions are pruned to the configured limit', () => {
  const h = harness({ versions: 3 })
  try {
    const doc = h.service.create(marketing, { title: 'A', content: 'v1\n' })
    for (let v = 1; v <= 5; v += 1) {
      h.service.update(marketing, { id: doc.id, content: `v${v + 1}\n`, baseVersion: v })
    }
    assert.deepEqual(h.service.versions(doc.id).map((x) => x.version), [6, 5, 4])
  } finally { h.cleanup() }
})

test('renaming a document rewrites the links that point at its old title', () => {
  const h = harness()
  try {
    const target = h.service.create(user, { title: 'Ügyfélprofil', content: 'x\n' })
    const referrer = h.service.create(user, { title: 'Hivatkozó', content: 'Lásd [[Ügyfélprofil]].\n' })

    const res = h.service.update(user, { id: target.id, title: 'Morvai profil', baseVersion: 1 })
    assert.deepEqual(res.links.updated, [h.repo.getById(referrer.id).path])
    assert.equal(h.service.read(referrer.id).content, 'Lásd [[Morvai profil]].\n')
  } finally { h.cleanup() }
})

test('a rename skips a referrer the actor may not write, and names it', () => {
  const h = harness()
  try {
    const target = h.service.create(marketing, { title: 'Ügyfélprofil', content: 'x\n' })
    const referrer = h.service.create(kutato, { title: 'Kutató jegyzet', content: 'Lásd [[Ügyfélprofil]].\n' })

    const res = h.service.update(marketing, { id: target.id, title: 'Morvai profil', baseVersion: 1 })
    assert.deepEqual(res.links.updated, [])
    assert.deepEqual(res.links.skipped, ['agents/kutato/kutato-jegyzet.md'])
    assert.equal(h.service.read(referrer.id).content, 'Lásd [[Ügyfélprofil]].\n')
  } finally { h.cleanup() }
})

test('list gives an agent its own folder plus the shared one', () => {
  const h = harness()
  try {
    h.service.create(marketing, { title: 'Sajat' })
    h.service.create(user, { folder: 'kozos', title: 'Kozos' })
    h.service.create(kutato, { title: 'Masike' })

    const seen = h.service.list(marketing).map((d) => d.title).sort()
    assert.deepEqual(seen, ['Kozos', 'Sajat'])
    // But asked explicitly, it can see another agent's too: reading is unrestricted.
    assert.equal(h.service.list(marketing, { folder: 'agents/kutato' }).length, 1)
  } finally { h.cleanup() }
})

test('search folds diacritics and can be scoped', () => {
  const h = harness()
  try {
    h.service.create(marketing, { title: 'A', content: 'Kőműves Morvai.\n' })
    assert.equal(h.service.search('komuves').length, 1)
    assert.equal(h.service.search('komuves', { folder: 'kozos' }).length, 0)
    assert.throws(() => h.service.search('  '), (err) => err.code === ERR.invalid_argument)
  } finally { h.cleanup() }
})

test('move keeps the id and refuses a destination the actor cannot write', () => {
  const h = harness()
  try {
    const doc = h.service.create(marketing, { title: 'A' })
    const res = h.service.move(marketing, { id: doc.id, newFolder: 'kozos' })
    assert.equal(res.path, 'kozos/a.md')
    assert.equal(h.repo.getById(doc.id).path, 'kozos/a.md')

    assert.throws(
      () => h.service.move(marketing, { id: doc.id, newFolder: 'agents/kutato' }),
      (err) => err.code === ERR.forbidden,
    )
  } finally { h.cleanup() }
})

test('delete trashes the file, keeps the row, and restore brings it back', () => {
  const h = harness()
  try {
    const doc = h.service.create(marketing, { title: 'A', content: 'Morvai.\n' })
    const removed = h.service.remove(marketing, { id: doc.id })

    assert.equal(h.vault.exists('agents/marketing/a.md'), false)
    assert.ok(h.vault.exists(removed.trashPath))
    assert.equal(h.repo.listDocs({}).length, 0)
    assert.equal(h.repo.search('morvai', {}).length, 0)
    assert.equal(h.repo.listDocs({ includeDeleted: true }).length, 1)

    const back = h.service.restore(marketing, { id: doc.id })
    assert.equal(back.path, 'agents/marketing/a.md')
    assert.equal(h.service.read(doc.id).content, 'Morvai.\n')
    assert.equal(h.repo.search('morvai', {}).length, 1)
  } finally { h.cleanup() }
})

test('only the operator may purge', () => {
  const h = harness()
  try {
    const doc = h.service.create(marketing, { title: 'A' })
    h.service.remove(marketing, { id: doc.id })
    assert.throws(
      () => h.service.purge(marketing, { id: doc.id }),
      (err) => err.code === ERR.forbidden,
    )
    h.service.purge(user, { id: doc.id })
    assert.equal(h.repo.listDocs({ includeDeleted: true }).length, 0)
  } finally { h.cleanup() }
})

test('restoring an old version writes it forward instead of rewinding history', () => {
  const h = harness()
  try {
    const doc = h.service.create(marketing, { title: 'A', content: 'egy\n' })
    h.service.update(marketing, { id: doc.id, content: 'ketto\n', baseVersion: 1 })
    h.service.restoreVersion(marketing, { id: doc.id, version: 1, baseVersion: 2 })

    assert.equal(h.service.read(doc.id).content, 'egy\n')
    assert.deepEqual(h.service.versions(doc.id).map((v) => v.version), [3, 2, 1])
    assert.equal(h.service.version(doc.id, 2).content, 'ketto\n', 'the intermediate version is gone')
  } finally { h.cleanup() }
})

test('backlinks and templates answer through the service', () => {
  const h = harness()
  try {
    const target = h.service.create(user, { title: 'Cél', content: 'x\n' })
    h.service.create(user, { title: 'Forrás', content: 'Lásd [[Cél]].\n' })
    assert.deepEqual(h.service.backlinks(target.id).map((b) => b.title), ['Forrás'])

    assert.deepEqual(h.service.templates(), [])
    h.vault.writeDoc('_templates/jegyzokonyv.md', { meta: { id: 'doc_t', title: 'J', owner: 'user', tags: [] }, body: 'x\n' })
    assert.deepEqual(h.service.templates(), [{ name: 'jegyzokonyv', path: '_templates/jegyzokonyv.md' }])
  } finally { h.cleanup() }
})

test('every operation names a missing document rather than returning nothing', () => {
  const h = harness()
  try {
    for (const call of [
      () => h.service.read('doc_nincs'),
      () => h.service.update(user, { id: 'doc_nincs', baseVersion: 1 }),
      () => h.service.move(user, { id: 'doc_nincs', newFolder: 'kozos' }),
      () => h.service.remove(user, { id: 'doc_nincs' }),
      () => h.service.versions('doc_nincs'),
      () => h.service.backlinks('doc_nincs'),
    ]) {
      assert.throws(call, (err) => err.code === ERR.doc_not_found)
    }
  } finally { h.cleanup() }
})
