import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { DOCS_CONTRACT, createDocsContract } from '../src/contract.mjs'
import { MIGRATIONS, createRepo } from '../src/db.mjs'
import { ERR } from '../src/errors.mjs'
import { createIndexWriter } from '../src/index-writer.mjs'
import { createRpc, foldersOf } from '../src/rpc.mjs'
import { createService } from '../src/service.mjs'
import { createVault } from '../src/vault.mjs'
import { memStorage } from './helpers.mjs'

function harness({ root: rootOverride } = {}) {
  const root = rootOverride ?? fs.mkdtempSync(path.join(os.tmpdir(), 'docs-rpc-'))
  const s = memStorage()
  for (const m of MIGRATIONS) s.raw.exec(m.sql)
  const repo = createRepo(s)
  const errors = []
  const log = { info() {}, warn() {}, error: (m, meta) => errors.push({ m, meta }) }

  let built = null
  const build = () => {
    if (!built) {
      const vault = createVault({ root })
      const writer = createIndexWriter({ vault, repo })
      const service = createService({
        vault, writer, repo, sharedFolder: () => 'kozos', versionsKept: () => 50,
      })
      built = { vault, writer, service }
    }
    return built
  }

  let watcher = { running: true, root, indultAt: 1, error: null }
  const rpc = createRpc({
    serviceOf: () => build().service,
    vaultOf: () => build().vault,
    writerOf: () => build().writer,
    repoOf: () => repo,
    watcherStatus: () => watcher,
    restartWatcher: () => { watcher = { ...watcher, running: true, error: null }; return watcher },
    sharedFolder: () => 'kozos',
    rootSetting: () => root,
    logOf: () => log,
  })

  const contract = createDocsContract({
    serviceOf: () => build().service,
    extensionNameOf: (args) => args?.caller ?? 'ext',
  })

  return {
    rpc,
    repo,
    contract,
    errors,
    build,
    setWatcher: (w) => { watcher = w },
    cleanup: () => { if (!rootOverride) fs.rmSync(root, { recursive: true, force: true }) },
  }
}

test('foldersOf lists every intermediate folder, once, sorted', () => {
  assert.deepEqual(
    foldersOf(['agents/marketing/mely/a.md', 'kozos/b.md', 'c.md'], ['agents']),
    ['agents', 'agents/marketing', 'agents/marketing/mely', 'kozos'],
  )
})

test('tree answers an empty root without throwing', async () => {
  const h = harness()
  try {
    const res = await h.rpc.tree()
    assert.deepEqual(res.docs, [])
    assert.ok(res.folders.includes('kozos'))
    assert.equal(res.sharedFolderName, 'kozos')
  } finally { h.cleanup() }
})

test('create then tree shows the document and its folders', async () => {
  const h = harness()
  try {
    await h.rpc.create({ folder: 'agents/marketing/mely', title: 'Ügyfélprofil' })
    const res = await h.rpc.tree()
    assert.equal(res.docs.length, 1)
    assert.equal(res.docs[0].path, 'agents/marketing/mely/ugyfelprofil.md')
    assert.ok(res.folders.includes('agents/marketing/mely'))
    assert.deepEqual(res.titles, ['Ügyfélprofil'])
  } finally { h.cleanup() }
})

test('save with a stale baseVersion returns the conflict with the other text', async () => {
  const h = harness()
  try {
    const made = await h.rpc.create({ title: 'A', content: 'egy\n' })
    await h.rpc.save({ id: made.id, content: 'ketto\n', baseVersion: 1 })

    const res = await h.rpc.save({ id: made.id, content: 'harom\n', baseVersion: 1 })
    assert.equal(res.error, ERR.conflict)
    assert.equal(res.currentVersion, 2)
    assert.equal(res.theirs, 'ketto\n')
    assert.equal((await h.rpc.read({ id: made.id })).content, 'ketto\n')
  } finally { h.cleanup() }
})

test('rename rewrites the links that pointed at the old title', async () => {
  const h = harness()
  try {
    const target = await h.rpc.create({ title: 'Ügyfélprofil', content: 'x\n' })
    const referrer = await h.rpc.create({ title: 'Hivatkozó', content: 'Lásd [[Ügyfélprofil]].\n' })

    const res = await h.rpc.rename({ id: target.id, newTitle: 'Morvai profil', baseVersion: 1 })
    assert.deepEqual(res.links.updated, ['kozos/hivatkozo.md'])
    assert.equal((await h.rpc.read({ id: referrer.id })).content, 'Lásd [[Morvai profil]].\n')
  } finally { h.cleanup() }
})

test('delete, trash, restore round-trips a document', async () => {
  const h = harness()
  try {
    const made = await h.rpc.create({ title: 'A', content: 'Morvai.\n' })
    await h.rpc.delete({ id: made.id })

    const trash = await h.rpc.trash()
    assert.deepEqual(trash.items.map((e) => e.id), [made.id])
    assert.equal((await h.rpc.tree()).docs.length, 0)

    await h.rpc.restore({ id: made.id })
    assert.equal((await h.rpc.tree()).docs.length, 1)
    assert.deepEqual((await h.rpc.trash()).items, [])
  } finally { h.cleanup() }
})

test('purge removes the row and the trashed file for good', async () => {
  const h = harness()
  try {
    const made = await h.rpc.create({ title: 'A' })
    await h.rpc.delete({ id: made.id })
    await h.rpc.purge({ id: made.id })
    assert.deepEqual((await h.rpc.trash()).items, [])
    assert.equal(h.repo.listDocs({ includeDeleted: true }).length, 0)
  } finally { h.cleanup() }
})

test('restoreVersion writes the old text forward, keeping the history', async () => {
  const h = harness()
  try {
    const made = await h.rpc.create({ title: 'A', content: 'egy\n' })
    await h.rpc.save({ id: made.id, content: 'ketto\n', baseVersion: 1 })
    await h.rpc.restoreVersion({ id: made.id, version: 1, baseVersion: 2 })

    assert.equal((await h.rpc.read({ id: made.id })).content, 'egy\n')
    const v = await h.rpc.versions({ id: made.id })
    assert.deepEqual(v.versions.map((x) => x.version), [3, 2, 1])
    assert.equal((await h.rpc.version({ id: made.id, version: 2 })).content, 'ketto\n')
  } finally { h.cleanup() }
})

test('backlinks, templates and agents answer in the page shapes', async () => {
  const h = harness()
  try {
    const target = await h.rpc.create({ title: 'Cél', content: 'x\n' })
    await h.rpc.create({ title: 'Forrás', content: 'Lásd [[Cél]].\n' })
    await h.rpc.create({ folder: 'agents/marketing', title: 'Ügynöké' })

    assert.deepEqual((await h.rpc.backlinks({ id: target.id })).backlinks.map((b) => b.title), ['Forrás'])
    assert.deepEqual((await h.rpc.templates()).templates, [])
    assert.deepEqual((await h.rpc.agents()).agents, [
      { slug: 'marketing', folder: 'agents/marketing', docs: 1 },
    ])
  } finally { h.cleanup() }
})

test('createFolder makes an empty folder the tree can show', async () => {
  const h = harness()
  try {
    await h.rpc.createFolder({ folder: 'kozos/uj-mappa' })
    assert.equal(h.build().vault.exists('kozos/uj-mappa'), true)

    // THE NAME SHOWING UP HAS TO BE CHECKED TOO. This test used to look only at
    // disk, so it stayed green even when `tree` derived folders solely from
    // document paths -- the folder existed and the tree was missing it. The
    // operation only counts as done where the page can see it.
    const tree = await h.rpc.tree()
    assert.ok(tree.folders.includes('kozos/uj-mappa'), `the tree does not show it: ${tree.folders.join(', ')}`)

    const bad = await h.rpc.createFolder({ folder: '  ' })
    assert.equal(bad.error, ERR.invalid_argument)
  } finally { h.cleanup() }
})

test('createFolder refuses to leave the root', async () => {
  const h = harness()
  try {
    const res = await h.rpc.createFolder({ folder: '../outside' })
    assert.equal(res.error, ERR.path_forbidden)
  } finally { h.cleanup() }
})

test('status reports a broken root as state, not as a failed call', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-rpc-locked-'))
  fs.chmodSync(parent, 0o500)
  const h = harness({ root: path.join(parent, 'under-it') })
  try {
    const res = await h.rpc.status()
    assert.equal(res.error, undefined, 'the call itself failed')
    assert.equal(res.rootOk, false)
    assert.match(res.rootError, /cannot be created or is not writable/)
    assert.equal(res.docCount, 0)
  } finally {
    fs.chmodSync(parent, 0o700)
    fs.rmSync(parent, { recursive: true, force: true })
  }
})

test('status carries the watcher state and restartWatcher clears it', async () => {
  const h = harness()
  try {
    h.setWatcher({ running: false, root: null, indultAt: null, error: 'ENOSPC' })
    const down = await h.rpc.status()
    assert.equal(down.watcherRunning, false)
    assert.equal(down.watcherError, 'ENOSPC')

    await h.rpc.restartWatcher()
    const up = await h.rpc.status()
    assert.equal(up.watcherRunning, true)
    assert.equal(up.watcherError, null)
  } finally { h.cleanup() }
})

test('reindex rebuilds the index from the files on disk', async () => {
  const h = harness()
  try {
    await h.rpc.create({ title: 'A', content: 'x\n' })
    const res = await h.rpc.reindex()
    assert.equal(res.scanned, 1)
    assert.equal(res.removed, 0)
  } finally { h.cleanup() }
})

test('every handler answers a broken root with a named error, none of them throws', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-rpc-all-'))
  fs.chmodSync(parent, 0o500)
  const h = harness({ root: path.join(parent, 'alatta') })
  try {
    const calls = {
      tree: {}, read: { id: 'doc_x' }, save: { id: 'doc_x', baseVersion: 1 },
      create: { title: 'X' }, search: { q: 'x' }, move: { id: 'doc_x', newFolder: 'kozos' },
      rename: { id: 'doc_x', newTitle: 'Y', baseVersion: 1 }, delete: { id: 'doc_x' },
      restore: { id: 'doc_x' }, purge: { id: 'doc_x' }, trash: {},
      versions: { id: 'doc_x' }, version: { id: 'doc_x', version: 1 },
      restoreVersion: { id: 'doc_x', version: 1, baseVersion: 1 },
      backlinks: { id: 'doc_x' }, templates: {}, agents: {}, status: {},
      reindex: {}, restartWatcher: {}, createFolder: { folder: 'uj' },
    }
    for (const [name, body] of Object.entries(calls)) {
      const res = await h.rpc[name](body)
      assert.ok(res && typeof res === 'object', `${name} did not answer with an object`)
    }
    // Of the twenty, the obviously root-dependent ones name the trouble too.
    assert.equal((await h.rpc.create({ title: 'X' })).error, ERR.root_not_writable)
    assert.equal((await h.rpc.tree()).error, ERR.root_not_writable)
  } finally {
    fs.chmodSync(parent, 0o700)
    fs.rmSync(parent, { recursive: true, force: true })
  }
})

test('the contract writes into the calling extension folder and reads back', async () => {
  const h = harness()
  try {
    const made = await h.contract.methods.put({
      caller: 'video', title: 'Forgatókönyv', content: '## 1. jelenet\n',
    })
    assert.equal(made.path, 'agents/video/forgatokonyv.md')

    const back = await h.contract.methods.read({ id: made.id })
    assert.equal(back.content, '## 1. jelenet\n')
    assert.equal(back.owner, 'ext:video')
  } finally { h.cleanup() }
})

test('the contract cannot write into an agent folder that is not its own', async () => {
  const h = harness()
  try {
    await assert.rejects(
      async () => h.contract.methods.put({ caller: 'video', folder: 'agents/marketing', title: 'X' }),
      (err) => err.code === ERR.forbidden,
    )
  } finally { h.cleanup() }
})

test('the contract declaration satisfies every rule the host enforces', () => {
  const h = harness()
  try {
    // What the host's validator (src/lib/server/extensions/extension-contracts.ts,
    // validateContracts) requires. The missing `summary` was not caught at load
    // time -- it surfaced live, from the log -- which is why it is checked here.
    const NAME_RE = /^[a-z][a-z0-9_]{0,63}$/
    const MAX_TEXT = 200

    assert.ok(NAME_RE.test(DOCS_CONTRACT), 'the contract name does not match the pattern')
    assert.ok(Number.isInteger(h.contract.version) && h.contract.version >= 1)
    assert.equal(typeof h.contract.summary, 'string')
    assert.ok(h.contract.summary.trim().length > 0, 'no summary: the host refuses to load it')
    assert.ok(h.contract.summary.length <= MAX_TEXT, `summary too long: ${h.contract.summary.length}`)

    const names = Object.keys(h.contract.methods)
    assert.ok(names.length > 0, 'the host refuses a contract with no methods')
    for (const name of names) {
      assert.ok(NAME_RE.test(name), `bad method name: ${name}`)
      assert.equal(typeof h.contract.methods[name], 'function')
    }
  } finally { h.cleanup() }
})

test('the contract exposes exactly two methods, at version 1', () => {
  const h = harness()
  try {
    // In this host the declaration itself IS the access: there is no approval
    // and no revocation, so adding a method is irreversible. This test has to
    // be seen failing for it to grow.
    assert.equal(h.contract.version, 1)
    assert.deepEqual(Object.keys(h.contract.methods).sort(), ['put', 'read'])
    assert.equal(DOCS_CONTRACT, 'docs')
  } finally { h.cleanup() }
})
