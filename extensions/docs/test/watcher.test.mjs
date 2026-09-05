import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { MIGRATIONS, createRepo } from '../src/db.mjs'
import { createIndexWriter } from '../src/index-writer.mjs'
import { createVault } from '../src/vault.mjs'
import { createWatcherControl } from '../src/watcher.mjs'
import { memStorage } from './helpers.mjs'

/**
 * A stand-in for `fs.watch` that records how often it was asked for a handle
 * and hands the test the callback, so no real filesystem watching happens and
 * the suite does not depend on platform timing.
 */
function fakeWatch() {
  const calls = []
  const impl = (root, opts, cb) => {
    const handle = { closed: false, close() { this.closed = true } }
    calls.push({ root, opts, cb, handle })
    return handle
  }
  impl.calls = calls
  impl.last = () => calls[calls.length - 1]
  return impl
}

function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-watch-'))
  const s = memStorage()
  for (const m of MIGRATIONS) s.raw.exec(m.sql)
  const vault = createVault({ root })
  vault.ensureRoot()
  const repo = createRepo(s)
  const writer = createIndexWriter({ vault, repo })
  const warnings = []
  const log = { info() {}, warn: (m, meta) => warnings.push({ m, meta }), error() {} }
  const watchImpl = fakeWatch()
  const control = createWatcherControl({ watchImpl, now: () => 12345 })
  const deps = { root: vault.root, enabled: true, writer, vault, log }
  return { vault, repo, writer, control, watchImpl, warnings, deps, log,
    cleanup: () => { control.stop(); fs.rmSync(root, { recursive: true, force: true }) } }
}

/** Lets the debounce timer fire. */
const settle = () => new Promise((r) => setTimeout(r, 260))

test('ensureWatcher twice on the same root opens one handle', () => {
  const h = harness()
  try {
    h.control.ensureWatcher(h.deps)
    h.control.ensureWatcher(h.deps)
    h.control.ensureWatcher(h.deps)
    assert.equal(h.watchImpl.calls.length, 1)
    assert.equal(h.control.status().fut, true)
    assert.equal(h.control.status().indultAt, 12345)
  } finally { h.cleanup() }
})

test('ensureWatcher on a new root closes the old handle and opens one', () => {
  const h = harness()
  try {
    h.control.ensureWatcher(h.deps)
    const first = h.watchImpl.last().handle
    h.control.ensureWatcher({ ...h.deps, root: '/tmp/masik-gyoker' })
    assert.equal(first.closed, true)
    assert.equal(h.watchImpl.calls.length, 2)
    assert.equal(h.control.status().root, '/tmp/masik-gyoker')
  } finally { h.cleanup() }
})

test('enabled false closes what runs and opens nothing', () => {
  const h = harness()
  try {
    h.control.ensureWatcher(h.deps)
    const handle = h.watchImpl.last().handle
    const s = h.control.ensureWatcher({ ...h.deps, enabled: false })
    assert.equal(handle.closed, true)
    assert.equal(s.fut, false)
    assert.equal(h.watchImpl.calls.length, 1)
  } finally { h.cleanup() }
})

test('a change to a .md file reaches the index', async () => {
  const h = harness()
  try {
    h.control.ensureWatcher(h.deps)
    fs.mkdirSync(path.join(h.vault.root, 'kozos'), { recursive: true })
    fs.writeFileSync(path.join(h.vault.root, 'kozos/kivul.md'), '# Kívülről\n\nMorvai.\n')

    h.watchImpl.last().cb('change', 'kozos/kivul.md')
    await settle()

    assert.equal(h.repo.search('morvai', {}).length, 1)
  } finally { h.cleanup() }
})

test('a non-.md file and anything under .swarmdocs are ignored', async () => {
  const h = harness()
  try {
    h.control.ensureWatcher(h.deps)
    fs.mkdirSync(path.join(h.vault.root, '.swarmdocs/trash/doc_1'), { recursive: true })
    fs.writeFileSync(path.join(h.vault.root, '.swarmdocs/trash/doc_1/a.md'), '# Kukás\n')
    fs.writeFileSync(path.join(h.vault.root, 'jegyzet.txt'), 'nem md')

    h.watchImpl.last().cb('change', '.swarmdocs/trash/doc_1/a.md')
    h.watchImpl.last().cb('change', 'jegyzet.txt')
    await settle()

    assert.equal(h.repo.listDocs({ includeDeleted: true }).length, 0)
  } finally { h.cleanup() }
})

test('two events on one path within the debounce window index once', async () => {
  const h = harness()
  try {
    h.control.ensureWatcher(h.deps)
    fs.mkdirSync(path.join(h.vault.root, 'kozos'), { recursive: true })
    fs.writeFileSync(path.join(h.vault.root, 'kozos/a.md'), '# A\n')

    let indexelesek = 0
    const eredeti = h.writer.indexPath
    h.writer.indexPath = (p) => { indexelesek += 1; return eredeti(p) }

    const { cb } = h.watchImpl.last()
    cb('change', 'kozos/a.md')
    cb('change', 'kozos/a.md')
    cb('change', 'kozos/a.md')
    await settle()

    assert.equal(indexelesek, 1)
  } finally { h.cleanup() }
})

test('an event whose content matches a self-write is dropped', async () => {
  const h = harness()
  try {
    h.control.ensureWatcher(h.deps)
    const written = h.vault.writeDoc('kozos/a.md', {
      meta: { id: 'doc_a', title: 'A', owner: 'user', tags: [] },
      body: 'Morvai.\n',
    })
    h.writer.noteSelfWrite('kozos/a.md', written.hash)

    h.watchImpl.last().cb('change', 'kozos/a.md')
    await settle()

    assert.equal(h.repo.listDocs({}).length, 0, 'a saját írásunk visszhangját is indexelte')
  } finally { h.cleanup() }
})

test('an edit that really came from outside after our save is processed', async () => {
  const h = harness()
  try {
    h.control.ensureWatcher(h.deps)
    const written = h.vault.writeDoc('kozos/a.md', {
      meta: { id: 'doc_a', title: 'A', owner: 'user', tags: [] },
      body: 'Mienk.\n',
    })
    h.writer.noteSelfWrite('kozos/a.md', written.hash)
    // Valaki tényleg átírja: a hash már nem a miénk.
    h.vault.writeDoc('kozos/a.md', {
      meta: { id: 'doc_a', title: 'A', owner: 'user', tags: [] },
      body: 'Kívülről Morvai.\n',
    })

    h.watchImpl.last().cb('change', 'kozos/a.md')
    await settle()

    assert.equal(h.repo.search('morvai', {}).length, 1)
  } finally { h.cleanup() }
})

test('an indexing failure is logged and the watcher stays up', async () => {
  const h = harness()
  try {
    h.control.ensureWatcher(h.deps)
    fs.mkdirSync(path.join(h.vault.root, 'kozos'), { recursive: true })
    fs.writeFileSync(path.join(h.vault.root, 'kozos/a.md'), '# A\n')
    h.writer.indexPath = () => { throw new Error('szándékos hiba') }

    h.watchImpl.last().cb('change', 'kozos/a.md')
    await settle()

    assert.equal(h.control.status().fut, true)
    assert.equal(h.warnings.length, 1)
    assert.match(h.warnings[0].meta.error, /szándékos hiba/)
  } finally { h.cleanup() }
})

test('a watch that cannot start is reported in status, not thrown', () => {
  const failing = () => { throw new Error('ENOSPC: watcher limit') }
  const control = createWatcherControl({ watchImpl: failing })
  const warnings = []
  const s = control.ensureWatcher({
    root: '/tmp/barmi',
    enabled: true,
    writer: {},
    vault: {},
    log: { warn: (m, meta) => warnings.push(meta) },
  })
  assert.equal(s.fut, false)
  assert.match(s.hiba, /watcher limit/)
  assert.equal(warnings.length, 1)
})

test('an event with no filename is ignored rather than crashing', async () => {
  const h = harness()
  try {
    h.control.ensureWatcher(h.deps)
    h.watchImpl.last().cb('rename', null)
    await settle()
    assert.equal(h.control.status().fut, true)
  } finally { h.cleanup() }
})
