import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { migrateLegacyFolders } from '../src/folder-migration.mjs'

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'docs-migrate-'))
}

function put(root, rel, text = '# x\n') {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  fs.writeFileSync(path.join(root, rel), text)
}

function countingWriter() {
  const calls = { indexAll: 0 }
  return { calls, indexAll() { calls.indexAll += 1; return { scanned: 0, changed: 0, removed: 0 } } }
}

const ledgerOf = (root) => JSON.parse(fs.readFileSync(path.join(root, '.swarmdocs', 'migrations.json'), 'utf8'))

test('kozos is renamed to shared, the index is rebuilt once, and the ledger records it', () => {
  const root = tmpRoot()
  put(root, 'kozos/a.md')
  const writer = countingWriter()
  const r = migrateLegacyFolders({ root, sharedFolderName: 'shared', writer, now: () => new Date('2026-09-11T10:00:00Z') })
  assert.deepEqual(r, { moved: ['kozos->shared'], blocked: [] })
  assert.equal(fs.existsSync(path.join(root, 'shared', 'a.md')), true)
  assert.equal(fs.existsSync(path.join(root, 'kozos')), false)
  assert.equal(writer.calls.indexAll, 1)
  assert.deepEqual(ledgerOf(root), { 'kozos->shared': '2026-09-11T10:00:00.000Z' })
})

test('_sablonok is renamed to _templates', () => {
  const root = tmpRoot()
  put(root, '_sablonok/meeting.md')
  const r = migrateLegacyFolders({ root, sharedFolderName: 'shared', writer: countingWriter() })
  assert.deepEqual(r.moved, ['_sablonok->_templates'])
  assert.equal(fs.existsSync(path.join(root, '_templates', 'meeting.md')), true)
})

test('when the new folder already exists nothing moves and the clash is reported', () => {
  const root = tmpRoot()
  put(root, 'kozos/a.md')
  put(root, 'shared/b.md')
  const writer = countingWriter()
  const r = migrateLegacyFolders({ root, sharedFolderName: 'shared', writer })
  assert.deepEqual(r, { moved: [], blocked: [{ from: 'kozos', to: 'shared' }] })
  assert.equal(fs.existsSync(path.join(root, 'kozos', 'a.md')), true)
  assert.equal(writer.calls.indexAll, 0)
})

test('an operator-chosen shared folder name leaves kozos alone', () => {
  const root = tmpRoot()
  put(root, 'kozos/a.md')
  const r = migrateLegacyFolders({ root, sharedFolderName: 'team', writer: countingWriter() })
  assert.deepEqual(r, { moved: [], blocked: [] })
  assert.equal(fs.existsSync(path.join(root, 'kozos', 'a.md')), true)
})

test('a recorded migration does not run again, even if kozos reappears', () => {
  const root = tmpRoot()
  put(root, 'kozos/a.md')
  migrateLegacyFolders({ root, sharedFolderName: 'shared', writer: countingWriter() })
  put(root, 'kozos/new.md')
  const writer = countingWriter()
  const r = migrateLegacyFolders({ root, sharedFolderName: 'shared', writer })
  assert.deepEqual(r, { moved: [], blocked: [] })
  assert.equal(fs.existsSync(path.join(root, 'kozos', 'new.md')), true)
  assert.equal(writer.calls.indexAll, 0)
})

test('a root with neither old folder is left untouched and writes no ledger', () => {
  const root = tmpRoot()
  const r = migrateLegacyFolders({ root, sharedFolderName: 'shared', writer: countingWriter() })
  assert.deepEqual(r, { moved: [], blocked: [] })
  assert.equal(fs.existsSync(path.join(root, '.swarmdocs', 'migrations.json')), false)
})
