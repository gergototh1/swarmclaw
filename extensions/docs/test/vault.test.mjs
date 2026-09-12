import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { ERR } from '../src/errors.mjs'
import { createVault, hashOf, newDocId, parseFrontMatter, serializeDoc } from '../src/vault.mjs'

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'docs-vault-'))
}

test('abs() refuses to leave the root', () => {
  const root = tempRoot()
  try {
    const vault = createVault({ root })
    for (const bad of ['../elsewhere.md', 'a/../../b.md', '/etc/passwd', 'a/../../']) {
      assert.throws(() => vault.abs(bad), (err) => err.code === ERR.path_forbidden, `elfogadta: ${bad}`)
    }
    assert.equal(vault.abs('agents/marketing/x.md'), path.join(vault.root, 'agents/marketing/x.md'))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('abs() refuses a symlink that points out of the root', () => {
  const root = tempRoot()
  const outside = tempRoot()
  try {
    const vault = createVault({ root })
    fs.symlinkSync(outside, path.join(vault.root, 'kifele'))
    assert.throws(() => vault.abs('kifele/x.md'), (err) => err.code === ERR.path_forbidden)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  }
})

test('front matter survives a round trip', () => {
  const meta = {
    id: 'doc_a1b2c3d4',
    title: 'Ügyfélprofil — Morvai: "nagy" ügy',
    owner: 'agent:marketing',
    tags: ['ügyfél', 'avian'],
    created: '2026-09-05T18:22:00.000Z',
    updated: '2026-09-05T18:41:12.000Z',
  }
  const body = '# Cím\n\nSzöveg [[Másik doksi]] után.\n'
  const parsed = parseFrontMatter(serializeDoc(meta, body))
  assert.deepEqual(parsed.meta, meta)
  assert.equal(parsed.body, body)
})

test('a file with no front matter parses as all body', () => {
  const parsed = parseFrontMatter('# Csak cím\n\nSemmi fejléc.\n')
  assert.deepEqual(parsed.meta, {})
  assert.equal(parsed.body, '# Csak cím\n\nSemmi fejléc.\n')
})

test('a broken front matter block is kept as body, not dropped', () => {
  const raw = '---\n  rossz behuzas\ntitle: x\n---\n\nTörzs.\n'
  const parsed = parseFrontMatter(raw)
  assert.deepEqual(parsed.meta, {})
  assert.equal(parsed.body, raw)
})

test('tags round-trip as a list even when empty', () => {
  const parsed = parseFrontMatter(serializeDoc({ id: 'doc_1', title: 'x', tags: [] }, 'y\n'))
  assert.deepEqual(parsed.meta.tags, [])
})

test('writeDoc is atomic and readDoc gives back what was written', () => {
  const root = tempRoot()
  try {
    const vault = createVault({ root })
    vault.ensureRoot()
    const meta = { id: newDocId(), title: 'Teszt', owner: 'user', tags: [] }
    const written = vault.writeDoc('kozos/teszt.md', { meta, body: 'Törzs.\n' })
    assert.equal(written.hash, hashOf(written.raw))

    const read = vault.readDoc('kozos/teszt.md')
    assert.equal(read.meta.id, meta.id)
    assert.equal(read.body, 'Törzs.\n')
    assert.equal(read.hash, written.hash)

    // The temp file used for the rename must not stay behind.
    assert.deepEqual(fs.readdirSync(path.join(vault.root, 'kozos')), ['teszt.md'])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('listDocs finds .md under the root and skips .swarmdocs', () => {
  const root = tempRoot()
  try {
    const vault = createVault({ root })
    vault.ensureRoot()
    vault.writeDoc('agents/a/egy.md', { meta: { id: 'doc_1', title: 'egy' }, body: 'x\n' })
    vault.writeDoc('kozos/ketto.md', { meta: { id: 'doc_2', title: 'kettő' }, body: 'x\n' })
    fs.mkdirSync(path.join(vault.root, '.swarmdocs/trash/doc_9'), { recursive: true })
    fs.writeFileSync(path.join(vault.root, '.swarmdocs/trash/doc_9/harom.md'), 'x')
    fs.writeFileSync(path.join(vault.root, 'kozos/nem-md.txt'), 'x')

    assert.deepEqual(vault.listDocs().sort(), ['agents/a/egy.md', 'kozos/ketto.md'])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('move refuses to overwrite, trash preserves the file', () => {
  const root = tempRoot()
  try {
    const vault = createVault({ root })
    vault.ensureRoot()
    vault.writeDoc('kozos/a.md', { meta: { id: 'doc_a', title: 'a' }, body: 'aaa\n' })
    vault.writeDoc('kozos/b.md', { meta: { id: 'doc_b', title: 'b' }, body: 'bbb\n' })

    assert.throws(() => vault.move('kozos/a.md', 'kozos/b.md'), (err) => err.code === ERR.already_exists)

    vault.move('kozos/a.md', 'agents/x/a.md')
    assert.equal(vault.exists('kozos/a.md'), false)
    assert.equal(vault.readDoc('agents/x/a.md').body, 'aaa\n')

    const { trashRel } = vault.trash('kozos/b.md', 'doc_b')
    assert.equal(vault.exists('kozos/b.md'), false)
    assert.ok(fs.readFileSync(path.join(vault.root, trashRel), 'utf8').includes('bbb'))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('ensureRoot names an unwritable root instead of failing silently', () => {
  const root = tempRoot()
  try {
    fs.chmodSync(root, 0o500)
    const vault = createVault({ root: path.join(root, 'alatta') })
    assert.throws(() => vault.ensureRoot(), (err) => err.code === ERR.root_not_writable)
  } finally {
    fs.chmodSync(root, 0o700)
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a root created after the vault was built still accepts paths', () => {
  // This broke in production: setup() built the vault BEFORE the root
  // existed, so the root stayed unresolved (/var/...), while the folder that
  // showed up later got resolved by abs() as /private/var/... -- and from
  // then on the vault judged every path an escape.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-later-'))
  const root = path.join(base, 'not-yet')
  try {
    const vault = createVault({ root })
    assert.equal(fs.existsSync(root), false)

    vault.ensureRoot()
    assert.equal(vault.root, fs.realpathSync(root), 'the root did not resolve after it was created')
    assert.doesNotThrow(() => vault.abs('kozos/a.md'))
    vault.writeDoc('kozos/a.md', { meta: { id: 'doc_a', title: 'A', owner: 'user', tags: [] }, body: 'x\n' })
    assert.equal(vault.readDoc('kozos/a.md').body, 'x\n')
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
})

test('readDoc names a missing file', () => {
  const root = tempRoot()
  try {
    const vault = createVault({ root })
    vault.ensureRoot()
    assert.throws(() => vault.readDoc('nincs.md'), (err) => err.code === ERR.doc_not_found)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('listFolders reports a folder that holds nothing', () => {
  // `mkdirp`'s only purpose is to let an empty folder exist at all. As long as
  // the tree derived folders from the docs' paths, a folder like this existed
  // on disk but never in the listing -- the operation succeeded and stayed
  // invisible.
  const root = tempRoot()
  try {
    const vault = createVault({ root })
    vault.ensureRoot()
    vault.mkdirp('kozos/ures')
    vault.writeDoc('kozos/telt/a.md', { meta: { id: 'doc_a', title: 'A', owner: 'user', tags: [] }, body: 'x\n' })

    const folders = vault.listFolders()
    assert.ok(folders.includes('kozos/ures'), 'the empty folder is missing')
    assert.ok(folders.includes('kozos/telt'), 'the folder holding the doc is missing')
    assert.ok(folders.includes('kozos'), 'the intermediate folder is missing')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('listFolders skips the index directory', () => {
  const root = tempRoot()
  try {
    const vault = createVault({ root })
    vault.ensureRoot()
    vault.mkdirp('.swarmdocs/belso')
    assert.deepEqual(vault.listFolders().filter((f) => f.startsWith('.swarmdocs')), [])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
