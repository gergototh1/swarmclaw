import assert from 'node:assert/strict'
import test from 'node:test'

import { MIGRATIONS, createRepo } from '../src/db.mjs'
import { memStorage } from './helpers.mjs'

function fresh() {
  const s = memStorage()
  for (const m of MIGRATIONS) s.raw.exec(m.sql)
  return createRepo(s)
}

function doc(over = {}) {
  return {
    id: 'doc_1',
    path: 'agents/marketing/a.md',
    title: 'Ügyfélprofil',
    owner: 'agent:marketing',
    tags: ['ügyfél'],
    created: '2026-09-05T10:00:00.000Z',
    updated: '2026-09-05T10:00:00.000Z',
    size: 120,
    hash: 'h1',
    version: 1,
    body: 'Morvai kőműves jegyzet.',
    ...over,
  }
}

test('every migration table uses the ext_docs_ prefix, lower case', () => {
  for (const m of MIGRATIONS) {
    for (const t of m.sql.matchAll(/CREATE (?:VIRTUAL )?TABLE IF NOT EXISTS (\w+)/g)) {
      assert.ok(t[1].startsWith('ext_docs_'), `wrong prefix: ${t[1]}`)
      assert.equal(t[1], t[1].toLowerCase())
    }
  }
})

test('upsert then read back by id and by path, with tags as a list', () => {
  const r = fresh()
  r.upsertDoc(doc())
  assert.deepEqual(r.getById('doc_1').tags, ['ügyfél'])
  assert.equal(r.getByPath('agents/marketing/a.md').id, 'doc_1')
  assert.equal(r.getById('nincs'), undefined)
  assert.equal(r.getByPath('nincs/ilyen.md'), undefined)
})

test('upsert on the same id replaces the row instead of adding one', () => {
  const r = fresh()
  r.upsertDoc(doc())
  r.upsertDoc(doc({ path: 'kozos/a.md', title: 'Új cím', version: 2 }))
  assert.equal(r.listDocs({}).length, 1)
  assert.equal(r.getById('doc_1').title, 'Új cím')
  assert.equal(r.getById('doc_1').version, 2)
  assert.equal(r.getByPath('agents/marketing/a.md'), undefined)
})

test('search folds Hungarian diacritics both ways', () => {
  const r = fresh()
  r.upsertDoc(doc())
  for (const q of ['ügyfélprofil', 'ugyfelprofil', 'kőműves', 'komuves', 'MORVAI']) {
    assert.equal(r.search(q, {}).length, 1, `did not find it: ${q}`)
  }
  assert.equal(r.search('nincsilyen', {}).length, 0)
})

test('search survives punctuation that would be FTS5 syntax', () => {
  const r = fresh()
  r.upsertDoc(doc({ body: 'A B2B-ügyfél "idézve" (zárójel) is.' }))
  for (const q of ['B2B-ügyfél', '"idézve"', 'zárójel)', 'A*', '-', '^x']) {
    assert.doesNotThrow(() => r.search(q, {}), `threw: ${q}`)
  }
})

test('search returns a snippet and can be scoped to a folder', () => {
  const r = fresh()
  r.upsertDoc(doc())
  r.upsertDoc(doc({ id: 'doc_2', path: 'kozos/b.md', title: 'Másik', body: 'Morvai máshol.' }))
  assert.equal(r.search('morvai', {}).length, 2)
  const scoped = r.search('morvai', { folder: 'kozos' })
  assert.equal(scoped.length, 1)
  assert.equal(scoped[0].id, 'doc_2')
  assert.ok(scoped[0].snippet.includes('Morvai'))
})

test('a folder scope does not leak into a sibling with the same prefix', () => {
  const r = fresh()
  r.upsertDoc(doc({ id: 'doc_1', path: 'kozos/a.md', body: 'Morvai.' }))
  r.upsertDoc(doc({ id: 'doc_2', path: 'kozosseg/b.md', body: 'Morvai.' }))
  assert.deepEqual(r.search('morvai', { folder: 'kozos' }).map((t) => t.id), ['doc_1'])
  assert.deepEqual(r.listDocs({ folder: 'kozos' }).map((d) => d.id), ['doc_1'])
})

test('a soft-deleted doc leaves the listing and the search but keeps its row', () => {
  const r = fresh()
  r.upsertDoc(doc())
  r.softDelete('doc_1', '2026-09-05T12:00:00.000Z')
  assert.equal(r.listDocs({}).length, 0)
  assert.equal(r.search('morvai', {}).length, 0)
  assert.equal(r.listDocs({ includeDeleted: true }).length, 1)

  r.addVersion('doc_1', { version: 1, content: 'Morvai kőműves jegyzet.', author: 'user', createdAt: 'x' })
  r.restore('doc_1')
  assert.equal(r.listDocs({}).length, 1)
  assert.equal(r.search('morvai', {}).length, 1)

  r.purge('doc_1')
  assert.equal(r.listDocs({ includeDeleted: true }).length, 0)
  assert.equal(r.listVersions('doc_1').length, 0)
})

test('listDocs filters by folder, owner and tag', () => {
  const r = fresh()
  r.upsertDoc(doc())
  r.upsertDoc(doc({ id: 'doc_2', path: 'kozos/b.md', owner: 'user', tags: ['avian'] }))
  assert.equal(r.listDocs({ folder: 'agents/marketing' }).length, 1)
  assert.equal(r.listDocs({ owner: 'user' })[0].id, 'doc_2')
  assert.equal(r.listDocs({ tag: 'ügyfél' })[0].id, 'doc_1')
  assert.equal(r.listDocs({ tag: 'nincs' }).length, 0)
})

test('listDocs returns the most recently updated first', () => {
  const r = fresh()
  r.upsertDoc(doc({ id: 'doc_1', path: 'kozos/a.md', updated: '2026-09-01T00:00:00.000Z' }))
  r.upsertDoc(doc({ id: 'doc_2', path: 'kozos/b.md', updated: '2026-09-09T00:00:00.000Z' }))
  assert.deepEqual(r.listDocs({}).map((d) => d.id), ['doc_2', 'doc_1'])
})

test('findByTitle matches exactly, then case-insensitively', () => {
  const r = fresh()
  r.upsertDoc(doc())
  assert.equal(r.findByTitle('Ügyfélprofil').id, 'doc_1')
  assert.equal(r.findByTitle('ügyfélprofil'), undefined)
  assert.equal(r.findByTitle('ÜGYFÉLPROFIL', { caseInsensitive: true }).id, 'doc_1')
  assert.equal(r.findByTitle('Nincs ilyen', { caseInsensitive: true }), undefined)
})

test('findByTitle ignores a deleted document', () => {
  const r = fresh()
  r.upsertDoc(doc())
  r.softDelete('doc_1', 'x')
  assert.equal(r.findByTitle('Ügyfélprofil'), undefined)
})

test('versions are listed newest first without content, and pruning keeps the newest', () => {
  const r = fresh()
  r.upsertDoc(doc())
  for (let v = 1; v <= 5; v += 1) {
    r.addVersion('doc_1', { version: v, content: `v${v}`, author: 'user', createdAt: `2026-09-0${v}T00:00:00.000Z` })
  }
  const list = r.listVersions('doc_1')
  assert.equal(list.length, 5)
  assert.equal(list[0].version, 5)
  assert.equal(list[0].content, undefined)
  assert.equal(list[0].size, 2)
  assert.equal(r.getVersion('doc_1', 3).content, 'v3')
  assert.equal(r.getVersion('doc_1', 99), undefined)

  assert.equal(r.pruneVersions('doc_1', 2), 3)
  assert.deepEqual(r.listVersions('doc_1').map((v) => v.version), [5, 4])
})

test('pruning with a limit above the count drops nothing', () => {
  const r = fresh()
  r.upsertDoc(doc())
  r.addVersion('doc_1', { version: 1, content: 'v1', author: 'user', createdAt: 'x' })
  assert.equal(r.pruneVersions('doc_1', 50), 0)
  assert.equal(r.listVersions('doc_1').length, 1)
})

test('links resolve to backlinks, and an unresolved one waits by its raw text', () => {
  const r = fresh()
  r.upsertDoc(doc())
  r.upsertDoc(doc({ id: 'doc_2', path: 'kozos/b.md', title: 'Másik' }))
  r.setLinks('doc_2', [{ toId: 'doc_1', toRaw: 'Ügyfélprofil' }, { toId: null, toRaw: 'Nincs még' }])

  const back = r.backlinks('doc_1')
  assert.equal(back.length, 1)
  assert.equal(back[0].fromId, 'doc_2')
  assert.equal(back[0].title, 'Másik')
  assert.equal(back[0].path, 'kozos/b.md')

  assert.deepEqual(r.unresolvedTo('Nincs még').map((l) => l.fromId), ['doc_2'])
  assert.deepEqual(r.unresolvedTo('Ügyfélprofil'), [])
})

test('setLinks replaces the previous set for that document', () => {
  const r = fresh()
  r.upsertDoc(doc())
  r.upsertDoc(doc({ id: 'doc_2', path: 'kozos/b.md', title: 'Másik' }))
  r.setLinks('doc_2', [{ toId: 'doc_1', toRaw: 'Ügyfélprofil' }])
  r.setLinks('doc_2', [])
  assert.deepEqual(r.backlinks('doc_1'), [])
})

test('resolveUnresolved binds the rows that were waiting for a title', () => {
  const r = fresh()
  r.upsertDoc(doc({ id: 'doc_2', path: 'kozos/b.md', title: 'Másik' }))
  r.setLinks('doc_2', [{ toId: null, toRaw: 'Ügyfélprofil' }])
  assert.deepEqual(r.backlinks('doc_1'), [])

  r.upsertDoc(doc())
  assert.equal(r.resolveUnresolved('Ügyfélprofil', 'doc_1'), 1)
  assert.deepEqual(r.backlinks('doc_1').map((b) => b.fromId), ['doc_2'])
})

test('allPaths gives what a reindex needs', () => {
  const r = fresh()
  r.upsertDoc(doc())
  assert.deepEqual(r.allPaths(), [{ id: 'doc_1', path: 'agents/marketing/a.md', hash: 'h1' }])
})
