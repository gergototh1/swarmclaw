import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createAgentContext } from '../src/agent-context.mjs'
import { MIGRATIONS, createRepo } from '../src/db.mjs'
import { HIBA } from '../src/errors.mjs'
import { createIndexWriter } from '../src/index-writer.mjs'
import { createService } from '../src/service.mjs'
import { actorOf, createTools } from '../src/tools.mjs'
import { createVault } from '../src/vault.mjs'
import { memStorage } from './helpers.mjs'

/** A session as the host attaches it to a tool call. */
function agentCtx(agentId, agentName) {
  return { session: { agentId, agentName }, message: '' }
}
const operatorCtx = { session: {}, message: '' }

/**
 * A `ctx.contracts` double. `videos` is the handle `get` answers for the
 * video.videos pair (null when absent), `why` the host's reason for the null.
 */
function contractsDouble({ videos = null, why = null } = {}) {
  return {
    get: (ext, contract) => (ext === 'video' && contract === 'videos' ? videos : null),
    why: () => why,
  }
}

/** One video as the eleven-column projection promises it. */
function videoRow(over = {}) {
  return {
    id: 'vid_1',
    cim: 'Miért drágul a kávé',
    status: 'kesz',
    forras_tipus: 'signal',
    forras_id: 'sig_9',
    out_path: 'out/vid_1.mp4',
    file_sha256: 'aabb',
    hossz_ms: 42300,
    narracio_szoveg: 'Első mondat. Második mondat.',
    created_at: '2026-09-01T10:00:00.000Z',
    qa_ok_at: '2026-09-01T11:00:00.000Z',
    ...over,
  }
}

function harness({ root: rootOverride, contracts = null } = {}) {
  const root = rootOverride ?? fs.mkdtempSync(path.join(os.tmpdir(), 'docs-tools-'))
  const s = memStorage()
  for (const m of MIGRATIONS) s.raw.exec(m.sql)
  const repo = createRepo(s)
  const warnings = []
  const log = { info() {}, warn: (m, meta) => warnings.push({ m, meta }), error() {} }

  let service = null
  const serviceOf = () => {
    if (!service) {
      const vault = createVault({ root })
      const writer = createIndexWriter({ vault, repo })
      service = createService({
        vault, writer, repo, sharedFolder: () => 'kozos', versionsKept: () => 50,
      })
    }
    return service
  }
  const tools = createTools({ contracts }, { serviceOf, logOf: () => log })
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]))
  const ctxHooks = createAgentContext({}, { serviceOf, sharedFolder: () => 'kozos', logOf: () => log })

  return {
    repo,
    tools,
    byName,
    ctxHooks,
    warnings,
    serviceOf,
    cleanup: () => { if (!rootOverride) fs.rmSync(root, { recursive: true, force: true }) },
  }
}

test('the module exposes exactly the seven declared tools', () => {
  const h = harness()
  try {
    assert.deepEqual(h.tools.map((t) => t.name), [
      'doksi_lista', 'doksi_olvas', 'doksi_keres', 'doksi_ir', 'doksi_mozgat', 'doksi_torol',
      'doksi_video_forgatokonyv',
    ])
    for (const t of h.tools) {
      assert.ok(t.description.length > 20, `túl rövid leírás: ${t.name}`)
      assert.equal(t.parameters.type, 'object')
      assert.equal(typeof t.execute, 'function')
    }
  } finally { h.cleanup() }
})

test('actorOf reads the agent record the host actually passes', () => {
  // A host a tool ctx-ét `{ ...ctx, ...buildContext }`-ként állítja össze
  // (src/lib/server/session-tools/index.ts): az agentId a külső contextből jön,
  // a teljes Agent pedig agentRecord néven. Élesben ez utóbbi hiányzott a
  // felismerésből, és a mappa `agents/c3377d/` lett volna `agents/gtassistant/`
  // helyett.
  assert.deepEqual(
    actorOf({ session: { agentId: 'c3377d2c', agentRecord: { id: 'c3377d2c', name: 'GTassistant' } } }),
    { kind: 'agent', slug: 'gtassistant' },
  )
  // Név nélkül az id az egyetlen kapaszkodó -- csúnya, de működik.
  assert.deepEqual(actorOf({ session: { agentId: 'c3377d2c' } }), { kind: 'agent', slug: 'c3377d' })
})

test('actorOf reads the session, and no tool argument can override it', () => {
  assert.deepEqual(actorOf(agentCtx('abc123def', 'Marketing Ügynök')), { kind: 'agent', slug: 'marketing-ugynok' })
  assert.deepEqual(actorOf(operatorCtx), { kind: 'user' })
  assert.deepEqual(actorOf(undefined), { kind: 'user' })
  // A hamis "actor" mező a hívásban nem jut el sehova: actorOf a session-t nézi.
  assert.deepEqual(actorOf({ session: {}, actor: { kind: 'agent', slug: 'hamis' } }), { kind: 'user' })
})

test('doksi_ir without a folder puts the doc in the calling agent home', async () => {
  const h = harness()
  try {
    const res = await h.byName.doksi_ir.execute(
      { cim: 'Ügyfélprofil', tartalom: 'Morvai.\n' },
      agentCtx('abc123', 'Marketing'),
    )
    assert.equal(res.utvonal, 'agents/marketing/ugyfelprofil.md')
    assert.equal(res.verzio, 1)
  } finally { h.cleanup() }
})

test('doksi_ir refuses another agent folder and returns a message, not a throw', async () => {
  const h = harness()
  try {
    const res = await h.byName.doksi_ir.execute(
      { mappa: 'agents/kutato', cim: 'Belenyúlás' },
      agentCtx('abc123', 'Marketing'),
    )
    assert.equal(res.hiba, HIBA.nincs_jog)
    assert.match(res.uzenet, /agents\/marketing/)
  } finally { h.cleanup() }
})

test('doksi_ir on an existing doc without baseVersion is refused', async () => {
  const h = harness()
  try {
    const ctx = agentCtx('abc123', 'Marketing')
    const made = await h.byName.doksi_ir.execute({ cim: 'A', tartalom: 'egy\n' }, ctx)
    const res = await h.byName.doksi_ir.execute({ id: made.id, tartalom: 'ketto\n' }, ctx)
    assert.equal(res.hiba, HIBA.rossz_parameter)
    assert.match(res.uzenet, /baseVersion/)
    assert.equal((await h.byName.doksi_olvas.execute({ id: made.id }, ctx)).tartalom, 'egy\n')
  } finally { h.cleanup() }
})

test('a conflict comes back with the other side content attached', async () => {
  const h = harness()
  try {
    const ctx = agentCtx('abc123', 'Marketing')
    const made = await h.byName.doksi_ir.execute({ cim: 'A', tartalom: 'egy\n' }, ctx)
    await h.byName.doksi_ir.execute({ id: made.id, tartalom: 'operatore\n', baseVersion: 1 }, operatorCtx)

    const res = await h.byName.doksi_ir.execute({ id: made.id, tartalom: 'ugynoke\n', baseVersion: 1 }, ctx)
    assert.equal(res.hiba, HIBA.utkozes)
    assert.equal(res.jelenlegiVerzio, 2)
    assert.equal(res.ovek, 'operatore\n')
    assert.match(res.uzenet, /Olvasd újra/)
  } finally { h.cleanup() }
})

test('doksi_lista defaults to the own folder plus the shared one', async () => {
  const h = harness()
  try {
    const marketing = agentCtx('abc123', 'Marketing')
    await h.byName.doksi_ir.execute({ cim: 'Sajat' }, marketing)
    await h.byName.doksi_ir.execute({ mappa: 'kozos', cim: 'Kozos' }, operatorCtx)
    await h.byName.doksi_ir.execute({ cim: 'Masike' }, agentCtx('def456', 'Kutato'))

    const res = await h.byName.doksi_lista.execute({}, marketing)
    assert.deepEqual(res.doksik.map((d) => d.cim).sort(), ['Kozos', 'Sajat'])

    const scoped = await h.byName.doksi_lista.execute({ mappa: 'agents/kutato' }, marketing)
    assert.equal(scoped.doksik.length, 1, 'olvasni más mappájából is lehet')
  } finally { h.cleanup() }
})

test('doksi_keres folds diacritics and reports a snippet', async () => {
  const h = harness()
  try {
    const ctx = agentCtx('abc123', 'Marketing')
    await h.byName.doksi_ir.execute({ cim: 'A', tartalom: 'Kőműves Morvai jegyzet.\n' }, ctx)
    const res = await h.byName.doksi_keres.execute({ q: 'komuves' }, ctx)
    assert.equal(res.talalatok.length, 1)
    assert.ok(res.talalatok[0].reszlet.includes('Kőműves'))
  } finally { h.cleanup() }
})

test('doksi_mozgat and doksi_torol answer through the same shape', async () => {
  const h = harness()
  try {
    const ctx = agentCtx('abc123', 'Marketing')
    const made = await h.byName.doksi_ir.execute({ cim: 'A' }, ctx)
    const moved = await h.byName.doksi_mozgat.execute({ id: made.id, ujMappa: 'kozos' }, ctx)
    assert.equal(moved.utvonal, 'kozos/a.md')

    const removed = await h.byName.doksi_torol.execute({ id: made.id }, ctx)
    assert.equal(removed.id, made.id)
    assert.equal((await h.byName.doksi_lista.execute({}, ctx)).doksik.length, 0)
  } finally { h.cleanup() }
})

test('every tool answers an unwritable root with a message rather than throwing', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-locked-'))
  fs.chmodSync(parent, 0o500)
  const h = harness({
    root: path.join(parent, 'alatta'),
    // A hetedik tool a szerződésen át jut el a gyökérig; szolgáltató nélkül
    // előbb utasítana el, és ez a teszt nem a gyökeret mérné rajta.
    contracts: contractsDouble({ videos: { get: async () => videoRow() } }),
  })
  try {
    const ctx = agentCtx('abc123', 'Marketing')
    const calls = [
      [h.byName.doksi_lista, {}],
      [h.byName.doksi_olvas, { id: 'doc_x' }],
      [h.byName.doksi_keres, { q: 'x' }],
      [h.byName.doksi_ir, { cim: 'X' }],
      [h.byName.doksi_mozgat, { id: 'doc_x', ujMappa: 'kozos' }],
      [h.byName.doksi_torol, { id: 'doc_x' }],
      [h.byName.doksi_video_forgatokonyv, { videoId: 'vid_1' }],
    ]
    for (const [tool, args] of calls) {
      const res = await tool.execute(args, ctx)
      assert.ok(res.hiba, `${tool.name} nem adott hibakódot`)
      assert.ok(res.uzenet.length > 0, `${tool.name} nem adott üzenetet`)
    }
  } finally {
    fs.chmodSync(parent, 0o700)
    fs.rmSync(parent, { recursive: true, force: true })
  }
})

test('the agent context adds nothing when there is nothing to list', () => {
  const h = harness()
  try {
    assert.equal(h.ctxHooks.getAgentContext(agentCtx('abc123', 'Marketing')), null)
  } finally { h.cleanup() }
})

test('the agent context lists own documents first, then the shared ones', async () => {
  const h = harness()
  try {
    const ctx = agentCtx('abc123', 'Marketing')
    await h.byName.doksi_ir.execute({ cim: 'Sajat jegyzet' }, ctx)
    await h.byName.doksi_ir.execute({ mappa: 'kozos', cim: 'Kozos jegyzet' }, operatorCtx)

    const block = h.ctxHooks.getAgentContext(ctx)
    assert.match(block, /A te doksijaid \(agents\/marketing\)/)
    assert.ok(block.indexOf('Sajat jegyzet') < block.indexOf('Kozos jegyzet'))
    assert.match(block, /- Sajat jegyzet — agents\/marketing\/sajat-jegyzet\.md/)
  } finally { h.cleanup() }
})

test('the agent context stays inside its budget and drops whole lines', async () => {
  const h = harness()
  try {
    const ctx = agentCtx('abc123', 'Marketing')
    for (let i = 0; i < 40; i += 1) {
      await h.byName.doksi_ir.execute({ cim: `Doksi ${i} ${'x'.repeat(120)}` }, ctx)
    }
    const block = h.ctxHooks.getAgentContext(ctx)
    assert.ok(block.length <= 6000, `túl hosszú: ${block.length}`)
    for (const l of block.split('\n')) {
      assert.ok(l.startsWith('##') || l.startsWith('- '), `csonka sor: ${l}`)
    }
  } finally { h.cleanup() }
})

test('a deleted document leaves the agent context', async () => {
  const h = harness()
  try {
    const ctx = agentCtx('abc123', 'Marketing')
    const made = await h.byName.doksi_ir.execute({ cim: 'Eltunik' }, ctx)
    assert.match(h.ctxHooks.getAgentContext(ctx), /Eltunik/)
    await h.byName.doksi_torol.execute({ id: made.id }, ctx)
    assert.equal(h.ctxHooks.getAgentContext(ctx), null)
  } finally { h.cleanup() }
})

test('an unreadable root logs a warning and yields no context instead of throwing', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-ctx-locked-'))
  fs.chmodSync(parent, 0o500)
  const h = harness({ root: path.join(parent, 'alatta') })
  try {
    assert.equal(h.ctxHooks.getAgentContext(agentCtx('abc123', 'Marketing')), null)
    assert.equal(h.warnings.length, 1)
  } finally {
    fs.chmodSync(parent, 0o700)
    fs.rmSync(parent, { recursive: true, force: true })
  }
})

test('the guidance tells the agent about baseVersion and about conflicts', () => {
  const h = harness()
  try {
    const guidance = h.ctxHooks.getOperatingGuidance().join('\n')
    assert.match(guidance, /baseVersion/)
    assert.match(guidance, /ütközés/i)
    assert.ok(h.ctxHooks.getCapabilityDescription().length > 20)
  } finally { h.cleanup() }
})

test('doksi_video_forgatokonyv lays the script down in the calling agent own folder', async () => {
  const h = harness({ contracts: contractsDouble({ videos: { get: async () => videoRow() } }) })
  try {
    const ctx = agentCtx('abc123', 'Videó Gyártó')
    const res = await h.byName.doksi_video_forgatokonyv.execute({ videoId: 'vid_1' }, ctx)
    // Nem `agents/video/`: a canWrite szerint egy ügynök a SAJÁT mappájába ír,
    // és a hívó slugja a neve, nem a szolgáltató bővítmény neve.
    assert.equal(res.utvonal, 'agents/video-gyarto/miert-dragul-a-kave.md')
    assert.equal(res.verzio, 1)

    const doc = await h.byName.doksi_olvas.execute({ id: res.id }, ctx)
    assert.equal(doc.cim, 'Miért drágul a kávé')
    assert.ok(doc.tartalom.includes('Első mondat. Második mondat.'))
    assert.ok(doc.tartalom.startsWith('>'), 'nincs a tetején a forrás-figyelmeztetés')
  } finally { h.cleanup() }
})

test('doksi_video_forgatokonyv passes the video id the caller asked for', async () => {
  const asked = []
  const h = harness({ contracts: contractsDouble({ videos: { get: async (args) => { asked.push(args); return videoRow() } } }) })
  try {
    await h.byName.doksi_video_forgatokonyv.execute({ videoId: '  vid_1  ' }, agentCtx('abc123', 'Videó'))
    assert.deepEqual(asked, [{ id: 'vid_1' }])
  } finally { h.cleanup() }
})

test('a missing provider is a named refusal and writes nothing', async () => {
  // 5.2: a néma kihagyás azt hazudná az ügynöknek, hogy nincs mit letenni.
  const h = harness({ contracts: contractsDouble({ videos: null, why: 'provider_missing' }) })
  try {
    const ctx = agentCtx('abc123', 'Videó Gyártó')
    const res = await h.byName.doksi_video_forgatokonyv.execute({ videoId: 'vid_1' }, ctx)
    assert.equal(res.hiba, HIBA.szerzodes_hianyzik)
    assert.match(res.uzenet, /provider_missing/)
    assert.equal((await h.byName.doksi_lista.execute({}, ctx)).doksik.length, 0, 'félkész doksit hagyott maga után')
  } finally { h.cleanup() }
})

test('a video id that names nothing is refused by name, and no empty doc is left behind', async () => {
  const h = harness({ contracts: contractsDouble({ videos: { get: async () => null } }) })
  try {
    const ctx = agentCtx('abc123', 'Videó Gyártó')
    const res = await h.byName.doksi_video_forgatokonyv.execute({ videoId: 'vid_nincs' }, ctx)
    assert.equal(res.hiba, HIBA.rossz_parameter)
    assert.match(res.uzenet, /vid_nincs/)
    assert.equal((await h.byName.doksi_lista.execute({}, ctx)).doksik.length, 0)
  } finally { h.cleanup() }
})

test('a missing videoId is refused before the contract is touched', async () => {
  let hivas = 0
  const h = harness({ contracts: contractsDouble({ videos: { get: async () => { hivas += 1; return videoRow() } } }) })
  try {
    const res = await h.byName.doksi_video_forgatokonyv.execute({}, agentCtx('abc123', 'Videó'))
    assert.equal(res.hiba, HIBA.rossz_parameter)
    assert.match(res.uzenet, /videoId/)
    assert.equal(hivas, 0)
  } finally { h.cleanup() }
})

test('a stranger title with a newline in it survives the front matter round trip', async () => {
  // A cím idegen szövegből származik; a vault fejléce soralapú, tehát egy
  // beágyazott újsor a fejlécet vágná ketté, és a doksi címtelenül jönne vissza.
  const h = harness({ contracts: contractsDouble({ videos: { get: async () => videoRow({ cim: 'Kávé\nár: fel' }) } }) })
  try {
    const ctx = agentCtx('abc123', 'Videó')
    const res = await h.byName.doksi_video_forgatokonyv.execute({ videoId: 'vid_1' }, ctx)
    assert.equal((await h.byName.doksi_olvas.execute({ id: res.id }, ctx)).cim, 'Kávé ár: fel')
  } finally { h.cleanup() }
})

test('doksi_video_forgatokonyv takes no folder and no identity from its arguments', async () => {
  const h = harness({ contracts: contractsDouble({ videos: { get: async () => videoRow() } }) })
  try {
    const res = await h.byName.doksi_video_forgatokonyv.execute(
      { videoId: 'vid_1', mappa: 'agents/kutato', actor: { kind: 'agent', slug: 'kutato' } },
      agentCtx('abc123', 'Videó Gyártó'),
    )
    assert.equal(res.utvonal, 'agents/video-gyarto/miert-dragul-a-kave.md')
  } finally { h.cleanup() }
})

test('the operator calling the tool lands in the shared folder, not in an agent one', async () => {
  // A `create` az operátornak nem ad home mappát, hanem a közöset adja.
  const h = harness({ contracts: contractsDouble({ videos: { get: async () => videoRow() } }) })
  try {
    const res = await h.byName.doksi_video_forgatokonyv.execute({ videoId: 'vid_1' }, operatorCtx)
    assert.equal(res.utvonal, 'kozos/miert-dragul-a-kave.md')
  } finally { h.cleanup() }
})
