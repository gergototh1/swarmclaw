import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { DOCS_CONTRACT, createDocsContract } from '../src/contract.mjs'
import { MIGRATIONS, createRepo } from '../src/db.mjs'
import { HIBA } from '../src/errors.mjs'
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

  let watcher = { fut: true, root, indultAt: 1, hiba: null }
  const rpc = createRpc({
    serviceOf: () => build().service,
    vaultOf: () => build().vault,
    writerOf: () => build().writer,
    repoOf: () => repo,
    watcherStatus: () => watcher,
    restartWatcher: () => { watcher = { ...watcher, fut: true, hiba: null }; return watcher },
    sharedFolder: () => 'kozos',
    rootSetting: () => root,
    logOf: () => log,
  })

  const contract = createDocsContract({
    serviceOf: () => build().service,
    extensionNameOf: (args) => args?.hivo ?? 'ext',
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

test('fa answers an empty root without throwing', async () => {
  const h = harness()
  try {
    const res = await h.rpc.fa()
    assert.deepEqual(res.doksik, [])
    assert.ok(res.mappak.includes('kozos'))
    assert.equal(res.kozosMappaNev, 'kozos')
  } finally { h.cleanup() }
})

test('letrehoz then fa shows the document and its folders', async () => {
  const h = harness()
  try {
    await h.rpc.letrehoz({ mappa: 'agents/marketing/mely', cim: 'Ügyfélprofil' })
    const res = await h.rpc.fa()
    assert.equal(res.doksik.length, 1)
    assert.equal(res.doksik[0].utvonal, 'agents/marketing/mely/ugyfelprofil.md')
    assert.ok(res.mappak.includes('agents/marketing/mely'))
    assert.deepEqual(res.cimek, ['Ügyfélprofil'])
  } finally { h.cleanup() }
})

test('ment with a stale baseVersion returns the conflict with the other text', async () => {
  const h = harness()
  try {
    const made = await h.rpc.letrehoz({ cim: 'A', tartalom: 'egy\n' })
    await h.rpc.ment({ id: made.id, tartalom: 'ketto\n', baseVersion: 1 })

    const res = await h.rpc.ment({ id: made.id, tartalom: 'harom\n', baseVersion: 1 })
    assert.equal(res.hiba, HIBA.utkozes)
    assert.equal(res.jelenlegiVerzio, 2)
    assert.equal(res.ovek, 'ketto\n')
    assert.equal((await h.rpc.olvas({ id: made.id })).tartalom, 'ketto\n')
  } finally { h.cleanup() }
})

test('atnevez rewrites the links that pointed at the old title', async () => {
  const h = harness()
  try {
    const target = await h.rpc.letrehoz({ cim: 'Ügyfélprofil', tartalom: 'x\n' })
    const referrer = await h.rpc.letrehoz({ cim: 'Hivatkozó', tartalom: 'Lásd [[Ügyfélprofil]].\n' })

    const res = await h.rpc.atnevez({ id: target.id, ujCim: 'Morvai profil', baseVersion: 1 })
    assert.deepEqual(res.linkek.frissitett, ['kozos/hivatkozo.md'])
    assert.equal((await h.rpc.olvas({ id: referrer.id })).tartalom, 'Lásd [[Morvai profil]].\n')
  } finally { h.cleanup() }
})

test('torol, kuka, visszaallit round-trips a document', async () => {
  const h = harness()
  try {
    const made = await h.rpc.letrehoz({ cim: 'A', tartalom: 'Morvai.\n' })
    await h.rpc.torol({ id: made.id })

    const kuka = await h.rpc.kuka()
    assert.deepEqual(kuka.elemek.map((e) => e.id), [made.id])
    assert.equal((await h.rpc.fa()).doksik.length, 0)

    await h.rpc.visszaallit({ id: made.id })
    assert.equal((await h.rpc.fa()).doksik.length, 1)
    assert.deepEqual((await h.rpc.kuka()).elemek, [])
  } finally { h.cleanup() }
})

test('veglegesTorol removes the row and the trashed file for good', async () => {
  const h = harness()
  try {
    const made = await h.rpc.letrehoz({ cim: 'A' })
    await h.rpc.torol({ id: made.id })
    await h.rpc.veglegesTorol({ id: made.id })
    assert.deepEqual((await h.rpc.kuka()).elemek, [])
    assert.equal(h.repo.listDocs({ includeDeleted: true }).length, 0)
  } finally { h.cleanup() }
})

test('visszaallitVerzio writes the old text forward, keeping the history', async () => {
  const h = harness()
  try {
    const made = await h.rpc.letrehoz({ cim: 'A', tartalom: 'egy\n' })
    await h.rpc.ment({ id: made.id, tartalom: 'ketto\n', baseVersion: 1 })
    await h.rpc.visszaallitVerzio({ id: made.id, verzio: 1, baseVersion: 2 })

    assert.equal((await h.rpc.olvas({ id: made.id })).tartalom, 'egy\n')
    const v = await h.rpc.verziok({ id: made.id })
    assert.deepEqual(v.verziok.map((x) => x.version), [3, 2, 1])
    assert.equal((await h.rpc.verzio({ id: made.id, verzio: 2 })).content, 'ketto\n')
  } finally { h.cleanup() }
})

test('hivatkozok, sablonok and ugynokok answer in the page shapes', async () => {
  const h = harness()
  try {
    const target = await h.rpc.letrehoz({ cim: 'Cél', tartalom: 'x\n' })
    await h.rpc.letrehoz({ cim: 'Forrás', tartalom: 'Lásd [[Cél]].\n' })
    await h.rpc.letrehoz({ mappa: 'agents/marketing', cim: 'Ügynöké' })

    assert.deepEqual((await h.rpc.hivatkozok({ id: target.id })).backlinkek.map((b) => b.title), ['Forrás'])
    assert.deepEqual((await h.rpc.sablonok()).sablonok, [])
    assert.deepEqual((await h.rpc.ugynokok()).ugynokok, [
      { slug: 'marketing', mappa: 'agents/marketing', doksik: 1 },
    ])
  } finally { h.cleanup() }
})

test('mappaLetrehoz makes an empty folder the tree can show', async () => {
  const h = harness()
  try {
    await h.rpc.mappaLetrehoz({ mappa: 'kozos/uj-mappa' })
    assert.equal(h.build().vault.exists('kozos/uj-mappa'), true)
    const bad = await h.rpc.mappaLetrehoz({ mappa: '  ' })
    assert.equal(bad.hiba, HIBA.rossz_parameter)
  } finally { h.cleanup() }
})

test('mappaLetrehoz refuses to leave the root', async () => {
  const h = harness()
  try {
    const res = await h.rpc.mappaLetrehoz({ mappa: '../kifele' })
    assert.equal(res.hiba, HIBA.utvonal_tiltott)
  } finally { h.cleanup() }
})

test('allapot reports a broken root as state, not as a failed call', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-rpc-locked-'))
  fs.chmodSync(parent, 0o500)
  const h = harness({ root: path.join(parent, 'alatta') })
  try {
    const res = await h.rpc.allapot()
    assert.equal(res.hiba, undefined, 'a hívás maga hibázott el')
    assert.equal(res.gyokerRendben, false)
    assert.match(res.gyokerHiba, /nem hozható létre vagy nem írható/)
    assert.equal(res.doksiSzam, 0)
  } finally {
    fs.chmodSync(parent, 0o700)
    fs.rmSync(parent, { recursive: true, force: true })
  }
})

test('allapot carries the watcher state and figyeloUjraindit clears it', async () => {
  const h = harness()
  try {
    h.setWatcher({ fut: false, root: null, indultAt: null, hiba: 'ENOSPC' })
    const down = await h.rpc.allapot()
    assert.equal(down.figyeloFut, false)
    assert.equal(down.figyeloHiba, 'ENOSPC')

    await h.rpc.figyeloUjraindit()
    const up = await h.rpc.allapot()
    assert.equal(up.figyeloFut, true)
    assert.equal(up.figyeloHiba, null)
  } finally { h.cleanup() }
})

test('ujraindex rebuilds the index from the files on disk', async () => {
  const h = harness()
  try {
    await h.rpc.letrehoz({ cim: 'A', tartalom: 'x\n' })
    const res = await h.rpc.ujraindex()
    assert.equal(res.atnezett, 1)
    assert.equal(res.eltavolitott, 0)
  } finally { h.cleanup() }
})

test('every handler answers a broken root with a named error, none of them throws', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-rpc-all-'))
  fs.chmodSync(parent, 0o500)
  const h = harness({ root: path.join(parent, 'alatta') })
  try {
    const calls = {
      fa: {}, olvas: { id: 'doc_x' }, ment: { id: 'doc_x', baseVersion: 1 },
      letrehoz: { cim: 'X' }, keres: { q: 'x' }, mozgat: { id: 'doc_x', ujMappa: 'kozos' },
      atnevez: { id: 'doc_x', ujCim: 'Y', baseVersion: 1 }, torol: { id: 'doc_x' },
      visszaallit: { id: 'doc_x' }, veglegesTorol: { id: 'doc_x' }, kuka: {},
      verziok: { id: 'doc_x' }, verzio: { id: 'doc_x', verzio: 1 },
      visszaallitVerzio: { id: 'doc_x', verzio: 1, baseVersion: 1 },
      hivatkozok: { id: 'doc_x' }, sablonok: {}, ugynokok: {}, allapot: {},
      ujraindex: {}, figyeloUjraindit: {}, mappaLetrehoz: { mappa: 'uj' },
    }
    for (const [name, body] of Object.entries(calls)) {
      const res = await h.rpc[name](body)
      assert.ok(res && typeof res === 'object', `${name} nem adott objektumot`)
    }
    // A tizenkilenc közül a nyilvánvalóan gyökérfüggők meg is nevezik a bajt.
    assert.equal((await h.rpc.letrehoz({ cim: 'X' })).hiba, HIBA.gyoker_nem_irhato)
    assert.equal((await h.rpc.fa()).hiba, HIBA.gyoker_nem_irhato)
  } finally {
    fs.chmodSync(parent, 0o700)
    fs.rmSync(parent, { recursive: true, force: true })
  }
})

test('the contract writes into the calling extension folder and reads back', async () => {
  const h = harness()
  try {
    const made = await h.contract.methods.letesz({
      hivo: 'video', cim: 'Forgatókönyv', tartalom: '## 1. jelenet\n',
    })
    assert.equal(made.utvonal, 'agents/video/forgatokonyv.md')

    const back = await h.contract.methods.olvas({ id: made.id })
    assert.equal(back.tartalom, '## 1. jelenet\n')
    assert.equal(back.tulajdonos, 'ext:video')
  } finally { h.cleanup() }
})

test('the contract cannot write into an agent folder that is not its own', async () => {
  const h = harness()
  try {
    await assert.rejects(
      async () => h.contract.methods.letesz({ hivo: 'video', mappa: 'agents/marketing', cim: 'X' }),
      (err) => err.code === HIBA.nincs_jog,
    )
  } finally { h.cleanup() }
})

test('the contract exposes exactly two methods, at version 1', () => {
  const h = harness()
  try {
    // Ebben a hostban a deklaráció maga a hozzáférés: nincs jóváhagyás és nincs
    // visszavonás, tehát egy metódus hozzáadása visszafordíthatatlan. Ezt a
    // tesztet bukni kell látni ahhoz, hogy bővüljön.
    assert.equal(h.contract.version, 1)
    assert.deepEqual(Object.keys(h.contract.methods).sort(), ['letesz', 'olvas'])
    assert.equal(DOCS_CONTRACT, 'docs')
  } finally { h.cleanup() }
})
