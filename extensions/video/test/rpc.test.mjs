import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

import { VideoError } from '../src/args.mjs'
import { VIDEO_STATUSOK } from '../src/db.mjs'
import { HEALTH_CODES, HEALTH_NEM_VALASZOLT, setupChecks } from '../src/health.mjs'
import { SZABALYKESZLET } from '../src/qa.mjs'
import { _resetFutas } from '../src/elonezet.mjs'
import { createRenderOps } from '../src/render.mjs'
import { createRpc } from '../src/rpc.mjs'
import { BACKLOG_SAPKA, JAVASLAT_NYITOTT_SAPKA, TANULSAG_SAPKA } from '../src/tanulsag.mjs'
import { YOUTUBE_OTLET_MAX } from '../src/youtube.mjs'
import { forrasUrl } from '../ui/format.ts'
import { safeHref } from '../ui/safe-href.ts'
import { PELDA_JELENETEK, PELDA_NARRACIO, fakeProject, freshRepo } from './helpers.mjs'

const quiet = { info() {}, warn() {}, error() {} }
const IDEGEN = 'Idegen szöveg a hírlevélből.'

/**
 * The render side, as a double. Every method the rpc reaches on `renderOps`
 * is here and nothing else, so a call that grew a new dependency fails loudly
 * instead of spawning a process on the machine running the suite.
 */
const opsDouble = () => {
  const indult = []
  return {
    indult,
    summary: (r) => ({ renderId: r.id, status: r.status }),
    cancel: (id) => ({ renderId: id, status: 'hiba', hiba: { kod: 'render_megszakitva' } }),
    cleanupAll: () => ({ renderek: 0, narraciok: 0, sorNelkul: 0 }),
    orphanCount: () => 0,
    // `renderel` is `videoRender` by another door: both call this, so a cancel
    // and a start mean one thing in the module (index.mjs).
    start: (tervId) => { indult.push(tervId); return { renderId: 'r-uj', videoId: 'v', tervId, status: 'fut' } },
  }
}

/** Every version probe answers "present" unless a test says otherwise; no binary is ever run. */
const eszkozOk = async () => ({ stdout: '', stderr: '' })

/** No test may reach the network. A suite that grew a request fails here rather than making one. */
const nincsHalo = async (url) => { throw new Error(`a test reached the network: ${url}`) }

function setup({ remotionDir = fakeProject(), settings = {}, ttsWhy = null, signalsWhy = null, execFileImpl = eszkozOk, fetchImpl = nincsHalo, platform = 'darwin', ops = opsDouble(), handles = {}, probeImpl = async () => 4000, log = quiet } = {}) {
  const { storage, repo } = freshRepo()
  const state = {
    storage,
    repo,
    log,
    settings: () => ({ remotionDir, ...settings }),
    contracts: { get: (e, c) => handles[`${e}.${c}`] ?? null, why: (ext) => (ext === 'tts' ? ttsWhy : signalsWhy) },
    execFileImpl,
    fetchImpl,
    probeImpl,
    platform,
  }
  return { repo, state, ops, rpc: createRpc(state, ops), remotionDir }
}

/** A video with a plan, a verdict, a finished render and a QA row. */
function keszVideo(repo, { cim = 'Egy cím', sha = 'sha-1', qaOk = true } = {}) {
  const { id: videoId } = repo.openVideo({ cim, forrasTipus: 'signal', forrasId: 'sig-1', forrasSzoveg: IDEGEN, nyitottaAgentId: 'gyarto-1' })
  const terv = repo.insertTerv({ videoId, jelenetek: PELDA_JELENETEK, narracio: PELDA_NARRACIO, assetUjjlenyomatok: [], katalogusHash: 'kh', szerzoAgentId: 'gyarto-1', szerzoSessionId: 's1', ellenorzes: { figyelmeztetesek: [] } })
  const verdikt = repo.insertVerdikt({ tervId: terv.id, tervHash: terv.tervHash, lektorAgentId: 'lektor-1', lektorSessionId: 's2', verdikt: 'atmegy', talalatok: [{ jelenet: 1, kod: 'L3', szoveg: 'x' }] })
  repo.replaceNarraciok(terv.id, PELDA_NARRACIO.map((n) => ({ tervHash: terv.tervHash, jelenet: n.jelenet, szovegHash: 'h', hang: 'v', modell: 'm', nyelv: 'hu', fajl: `narracio/swarmclaw/${videoId}/${n.jelenet}.mp3`, hosszMs: 1500, ttsKeresId: '' })))
  const renderId = `r-${sha}`
  repo.claimRender({ id: renderId, videoId, tervId: terv.id, tervHash: terv.tervHash, verdiktId: verdikt.id, hostBootAt: 1, jelenetHatarok: [{ jelenet: 0, kezdetMs: 0, vegMs: 1500 }], propsPath: '/p.json', outPath: '/out/v.mp4', logPath: '/l.log', platform: 'darwin' })
  repo.finishRender(renderId, { status: 'kesz', fileSha256: sha })
  repo.insertQa({ renderId, fileSha256: sha, szabalykeszlet: SZABALYKESZLET, ok: qaOk, meresek: { duration_s: 40 }, bukasok: qaOk ? [] : [{ kod: 'Q4', szoveg: 'rövid' }] })
  repo.setVideoStatus(videoId, qaOk ? 'qa_ok' : 'qa_hiba')
  return { videoId, renderId, tervId: terv.id, tervHash: terv.tervHash, verdiktId: verdikt.id }
}

/** Opens a render row that stays `fut`, so the two refusals that name a running render can be exercised. */
function futoRender(repo, videoId, tervId, tervHash, verdiktId, id = 'r-fut') {
  repo.claimRender({ id, videoId, tervId, tervHash, verdiktId, hostBootAt: 1, jelenetHatarok: [], propsPath: '/p', outPath: '/o.mp4', logPath: '/l', platform: 'darwin' })
  return id
}

test('board draws every status column, the caps and the module own turns', async () => {
  const { repo, rpc } = setup()
  const { videoId, renderId } = keszVideo(repo)
  repo.insertFordulo({ sessionId: 's1', agentId: 'gyarto-1', forras: 'schedule:napi', uzenet: 'u', valasz: 'v', toolok: [] })
  repo.insertFordulo({ sessionId: 's2', agentId: 'lektor-1', forras: 'chat', uzenet: 'u', valasz: 'v', toolok: [] })
  const b = await rpc.board()
  assert.deepEqual(Object.keys(b.oszlopok), [...VIDEO_STATUSOK], 'every status is a column, empty ones included')
  assert.deepEqual(b.statusok, [...VIDEO_STATUSOK])
  const kartya = b.oszlopok.qa_ok[0]
  assert.equal(kartya.id, videoId)
  assert.equal(kartya.cim, 'Egy cím')
  assert.equal(kartya.forrasTipus, 'signal')
  assert.equal(kartya.tervVerzio, 1)
  assert.deepEqual(kartya.utolsoVerdikt.verdikt, 'atmegy')
  assert.equal(kartya.utolsoVerdikt.talalatok, 1, 'the count of findings, not the findings')
  assert.deepEqual(kartya.render, { renderId, status: 'kesz' }, 'the render comes through ops.summary')
  assert.deepEqual(kartya.qa, { ok: true, bukasok: [] })
  assert.equal(b.futoRender, null)
  assert.deepEqual(b.sapkak.nyitottJavaslat, { db: 0, sapka: JAVASLAT_NYITOTT_SAPKA })
  assert.deepEqual(b.sapkak.tanulsag['agent:gyarto'], { db: 0, sapka: TANULSAG_SAPKA })
  assert.deepEqual(b.sapkak.backlog, { szabaly: { db: 0, sapka: BACKLOG_SAPKA }, sablon: { db: 0, sapka: BACKLOG_SAPKA } })
  assert.equal(b.counts.videos, 1)
  assert.deepEqual(b.utolsoFordulok.map((f) => [f.agentId, f.forras]), [['lektor-1', 'chat'], ['gyarto-1', 'schedule:napi']])
  assert.equal(typeof b.utolsoFordulokLimit, 'number')
  assert.equal(JSON.stringify(b).includes(IDEGEN), false, 'the board carries no source text')
})

test('a status outside the vocabulary gets its own column instead of taking the page down', async () => {
  const { repo, state, rpc } = setup()
  const { videoId } = keszVideo(repo)
  // Nothing enforces the vocabulary at the column: there is no CHECK
  // constraint on ext_video_videos.status, and two writers put a literal in
  // raw SQL without consulting VIDEO_STATUSOK. This is what such a row looks
  // like from here, whatever wrote it.
  state.storage.exec('UPDATE ext_video_videos SET status = ? WHERE id = ?', ['keszul_valami', videoId])

  const b = await rpc.board()
  assert.deepEqual(b.oszlopok.keszul_valami.map((k) => k.id), [videoId], 'the row is in a column of its own')
  assert.deepEqual(b.statusok, [...VIDEO_STATUSOK, 'keszul_valami'], 'the vocabulary first, the stray status after it')
  assert.deepEqual(b.oszlopok.qa_ok, [], 'the known columns are still all there')
  assert.equal(Object.keys(b.oszlopok).length, VIDEO_STATUSOK.length + 1)
  assert.equal(b.counts.videos, 1)

  // Two names that are properties of Object.prototype, which is why the
  // column map has none: on a plain object `??=` would leave the inherited
  // value in place, and `__proto__` would be a write to the prototype.
  for (const status of ['constructor', '__proto__', 'toString']) {
    const { repo: r2, state: s2, rpc: rpc2 } = setup()
    const { videoId: id2 } = keszVideo(r2)
    s2.storage.exec('UPDATE ext_video_videos SET status = ? WHERE id = ?', [status, id2])
    const b2 = await rpc2.board()
    assert.deepEqual(b2.oszlopok[status].map((k) => k.id), [id2], status)
    assert.ok(b2.statusok.includes(status), status)
  }
})

test('board draws without a Remotion project and reports a running render', async () => {
  const { repo, rpc } = setup({ remotionDir: '' })
  const { videoId, tervId, tervHash, verdiktId } = keszVideo(repo)
  const id = futoRender(repo, videoId, tervId, tervHash, verdiktId)
  const b = await rpc.board()
  assert.deepEqual(b.futoRender, { renderId: id, status: 'fut' })
  assert.equal(b.oszlopok.qa_ok.length, 1)
})

test('video returns the source text raw, every plan version, the renders and the notes', async () => {
  const { repo, rpc } = setup()
  const { videoId, renderId, tervId } = keszVideo(repo)
  repo.insertFeedback({ videoId, renderId, atMs: 1200, jelenet: null, szoveg: 'a horog lassú', forras: 'operator' })
  repo.upsertRetention([{ videoId, platform: 'tiktok', tS: 3, arany: 0.8 }])
  const v = await rpc.video({ id: videoId })
  assert.equal(v.forrasSzoveg, IDEGEN, 'the page renders it as a text child under an "idegen szöveg" label')
  assert.equal(v.tervek.length, 1)
  assert.equal(v.tervek[0].jelenetek.length, PELDA_JELENETEK.length)
  assert.equal(v.tervek[0].narracio.length, PELDA_NARRACIO.length)
  assert.equal(v.tervek[0].verdiktek[0].talalatok[0].kod, 'L3', 'the findings themselves, not a count, on this view')
  assert.equal(v.tervek[0].narraciok.length, 3)
  assert.equal(v.tervek[0].narraciok[0].nyelv, 'hu')
  assert.equal(v.renderek[0].renderId, renderId)
  assert.deepEqual(v.renderek[0].jelenetHatarok, [{ jelenet: 0, kezdetMs: 0, vegMs: 1500 }])
  assert.equal(v.renderek[0].tervId, tervId)
  assert.equal(v.visszajelzesek[0].atMs, 1200)
  assert.deepEqual(v.megtartas, [{ platform: 'tiktok', tS: 3, arany: 0.8 }])
  await assert.rejects(rpc.video({ id: 'nincs-ilyen' }), /videó/)
  await assert.rejects(rpc.video({}), /videoId/)
})

test('feedback files a note, deduplicates it, and refuses an argument it cannot honour', async () => {
  const { repo, rpc } = setup()
  const { videoId, renderId } = keszVideo(repo)
  const first = await rpc.feedback({ videoId, atMs: 1200, szoveg: 'x' })
  assert.equal(first.uj, true)
  assert.equal((await rpc.feedback({ videoId, atMs: 1200, szoveg: 'x' })).uj, false, 'the same note twice is one row')
  assert.equal((await rpc.feedback({ videoId, renderId, jelenet: 2, szoveg: 'y' })).uj, true)
  await assert.rejects(rpc.feedback({ videoId, szoveg: '   ' }), /szoveg/)
  await assert.rejects(rpc.feedback({ videoId, szoveg: 'x'.repeat(4001) }), /szoveg/)
  await assert.rejects(rpc.feedback({ videoId, atMs: -1, szoveg: 'x' }), /atMs/)
  await assert.rejects(rpc.feedback({ videoId, jelenet: 'a', szoveg: 'x' }), /jelenet/)
  await assert.rejects(rpc.feedback({ videoId, renderId: 'nincs', szoveg: 'x' }), /renderId/)
  assert.equal(repo.feedbackFor(videoId).length, 2)
})

test('lezar closes a video and refuses one whose render is still running', async () => {
  const { repo, rpc } = setup()
  const { videoId, tervId, tervHash, verdiktId } = keszVideo(repo)
  futoRender(repo, videoId, tervId, tervHash, verdiktId)
  await assert.rejects(rpc.lezar({ videoId }), /render/)
  assert.equal(repo.video(videoId).status, 'qa_ok', 'the refusal changed nothing')
  repo.finishRender('r-fut', { status: 'hiba', hibaKod: 'render_megszakitva' })
  assert.deepEqual(await rpc.lezar({ videoId }), { id: videoId, status: 'lezart' })
  assert.equal(repo.video(videoId).status, 'lezart')
  assert.equal(typeof repo.video(videoId).lezarva_at, 'string')
})

test('cancelRender and cleanup go through the shared renderOps', async () => {
  const { repo, rpc } = setup()
  const { videoId, tervId, tervHash, verdiktId } = keszVideo(repo)
  assert.deepEqual(await rpc.cancelRender({ renderId: 'r-1' }), { renderId: 'r-1', status: 'hiba', hiba: { kod: 'render_megszakitva' } })
  await assert.rejects(rpc.cancelRender({}), /renderId/)
  // The fourth number is the preview cache's, kept apart from the render
  // count: a hash directory is not a render.
  assert.deepEqual(await rpc.cleanup(), { renderek: 0, narraciok: 0, sorNelkul: 0, elonezetek: 0 })
  futoRender(repo, videoId, tervId, tervHash, verdiktId)
  await assert.rejects(rpc.cleanup(), /render/)
})

test('decideProposal accepts a lesson, refuses the thirteenth on a target, and leaves the proposal open', async () => {
  const { repo, rpc } = setup()
  const nyit = (extra = {}) => repo.insertJavaslat({ cel: 'agent:gyarto', fajta: 'tanulsag', cim: 'c', szoveg: 'A címlap egy mondat.', bizonyitek: [], javasoltaAgentId: 'lektor-1', futasSessionId: 's', ...extra }).id
  const first = nyit()
  const done = await rpc.decideProposal({ id: first, dontes: 'elfogad', megjegyzes: 'jó' })
  assert.equal(done.status, 'elfogadva')
  assert.equal(repo.activeTanulsagok('agent:gyarto').length, 1)
  assert.equal(repo.activeTanulsagok('agent:gyarto')[0].id, done.tanulsagId)
  for (let i = 1; i < TANULSAG_SAPKA; i += 1) repo.insertTanulsag({ javaslatId: first, cel: 'agent:gyarto', szoveg: 's' })
  assert.equal(repo.countActiveTanulsagok('agent:gyarto'), TANULSAG_SAPKA)
  const over = nyit()
  await assert.rejects(rpc.decideProposal({ id: over, dontes: 'elfogad' }), /tanulsag_sapka/)
  assert.equal(repo.javaslat(over).status, 'nyitott', 'a refused acceptance leaves it open for the operator')
  assert.equal(repo.countActiveTanulsagok('agent:gyarto'), TANULSAG_SAPKA, 'and writes no lesson')
})

test('decideProposal refuses the eleventh accepted rule and needs a note to reject', async () => {
  const { repo, rpc } = setup()
  const nyit = (fajta) => repo.insertJavaslat({ cel: fajta, fajta, cim: 'c', szoveg: 'szoveg', bizonyitek: [], javasoltaAgentId: 'lektor-1', futasSessionId: 's' }).id
  for (let i = 0; i < BACKLOG_SAPKA; i += 1) repo.decideJavaslat(nyit('szabaly'), 'elfogadva', '')
  const over = nyit('szabaly')
  await assert.rejects(rpc.decideProposal({ id: over, dontes: 'elfogad' }), /backlog_sapka/)
  assert.equal(repo.javaslat(over).status, 'nyitott')
  await assert.rejects(rpc.decideProposal({ id: over, dontes: 'elutasit' }), /megjegyzés/)
  const rejected = await rpc.decideProposal({ id: over, dontes: 'elutasit', megjegyzes: 'nem mérhető' })
  assert.equal(rejected.status, 'elutasitva')
  assert.equal(repo.javaslat(over).dontes_megjegyzes, 'nem mérhető')
  await assert.rejects(rpc.decideProposal({ id: over, dontes: 'elfogad' }), /nem nyitott/)
  await assert.rejects(rpc.decideProposal({ id: over, dontes: 'talan' }), /dontes/)
  await assert.rejects(rpc.decideProposal({ id: 'nincs', dontes: 'elfogad' }), /javaslat/)
  await assert.rejects(rpc.decideProposal({ dontes: 'elfogad' }), /id/)
})

test('proposals groups by state, counts the caps and marks a template the kit has caught up with', async () => {
  const { repo, rpc } = setup()
  const sablon = repo.insertJavaslat({ cel: 'sablon', fajta: 'sablon', cim: 'Új típus', szoveg: 'szam\nEgy nagy szám és egy felvezető.', bizonyitek: [], javasoltaAgentId: 'lektor-1', futasSessionId: 's' }).id
  const nyitva = repo.insertJavaslat({ cel: 'agent:lektor', fajta: 'tanulsag', cim: 'c', szoveg: 's', bizonyitek: [], javasoltaAgentId: 'lektor-1', futasSessionId: 's' }).id
  const elutasitva = repo.insertJavaslat({ cel: 'szabaly', fajta: 'szabaly', cim: 'c', szoveg: 's', bizonyitek: [], javasoltaAgentId: 'lektor-1', futasSessionId: 's' }).id
  await rpc.decideProposal({ id: elutasitva, dontes: 'elutasit', megjegyzes: 'nem' })
  await rpc.decideProposal({ id: sablon, dontes: 'elfogad', megjegyzes: '' })
  const p = await rpc.proposals()
  assert.deepEqual(p.nyitott.map((j) => j.id), [nyitva])
  assert.deepEqual(p.kodolva.map((j) => j.id), [sablon], 'the catalogue already has the szam type, so the proposal is coded')
  assert.deepEqual(p.backlog, [], 'and it is off the backlog')
  assert.equal(repo.countByStatusFajta('elfogadva', 'sablon'), 0)
  assert.deepEqual(p.elutasitott.map((j) => j.id), [elutasitva])
  assert.deepEqual(p.tanulsagok['agent:lektor'], { db: 0, sapka: TANULSAG_SAPKA, tetelek: [] })
  assert.equal(p.katalogusHiba, null)
  assert.deepEqual(p.nyitott[0].bizonyitek, [])
})

test('proposals answers without a catalogue and names why', async () => {
  const { repo, rpc } = setup({ remotionDir: '' })
  const sablon = repo.insertJavaslat({ cel: 'sablon', fajta: 'sablon', cim: 'c', szoveg: 'szam\nx', bizonyitek: [], javasoltaAgentId: 'l', futasSessionId: 's' }).id
  repo.decideJavaslat(sablon, 'elfogadva', '')
  const p = await rpc.proposals()
  assert.equal(p.katalogusHiba, 'remotion_dir_hianyzik')
  assert.deepEqual(p.backlog.map((j) => j.id), [sablon], 'with no catalogue nothing is marked coded, and the backlog says so')
  assert.deepEqual(p.kodolva, [])
})

test('retireLesson deactivates a lesson and is idempotent', async () => {
  const { repo, rpc } = setup()
  const j = repo.insertJavaslat({ cel: 'agent:gyarto', fajta: 'tanulsag', cim: 'c', szoveg: 's', bizonyitek: [], javasoltaAgentId: 'l', futasSessionId: 's' }).id
  const { tanulsagId } = await rpc.decideProposal({ id: j, dontes: 'elfogad' })
  assert.deepEqual(await rpc.retireLesson({ id: tanulsagId }), { id: tanulsagId, aktiv: 0 })
  assert.equal(repo.countActiveTanulsagok('agent:gyarto'), 0)
  assert.deepEqual(await rpc.retireLesson({ id: tanulsagId }), { id: tanulsagId, aktiv: 0 })
  await assert.rejects(rpc.retireLesson({}), /id/)
})

test('templates gives the per-type stats and the weekly row, and the weekly row survives a missing project', async () => {
  const { repo, rpc } = setup()
  keszVideo(repo)
  const t = await rpc.templates()
  assert.equal(t.hiba, null)
  assert.equal(typeof t.katalogusHash, 'string')
  assert.equal(t.sablonStat.cimlap.hasznalat, 1)
  assert.equal(t.hetiSor.length, 1)
  assert.equal(t.hetiSor[0].renderek, 1)
  const bare = setup({ remotionDir: '' })
  keszVideo(bare.repo)
  const without = await bare.rpc.templates()
  assert.equal(without.hiba, 'remotion_dir_hianyzik')
  assert.equal(without.sablonStat, null, 'null, not an empty table that would read as "no type was ever used"')
  assert.equal(without.hetiSor.length, 1)
})

test('templates hands the page the catalogue itself, not only the numbers', async () => {
  const dir = fakeProject()
  const katFile = path.join(dir, 'src', 'kit', 'katalogus.generated.json')
  const kat = JSON.parse(fs.readFileSync(katFile, 'utf8'))
  kat.mintak = { cimlap: { sorok: ['a'] } }
  fs.writeFileSync(katFile, JSON.stringify(kat))
  const { rpc } = setup({ remotionDir: dir })
  const r = await rpc.templates()
  assert.ok(r.tipusok.includes('cimlap'))
  assert.equal(typeof r.leirasok.cimlap, 'string')
  assert.ok(Array.isArray(r.propok.cimlap))
  assert.ok(Array.isArray(r.kozosPropok))
  assert.ok(r.kuldhetoTipusok.length > 0)
  assert.ok(r.nemKuldhetoTipusok.includes('cta'))
  assert.deepEqual(r.tablaHianyok, [])
  // Which types have no sample is answered by `templatePreviewStatus`, the
  // module that decides it, and by each card's own `templatePreview` round
  // trip. `templates` used to carry a third copy that nothing read.
  assert.equal(r.mintaHianyzik, undefined)
  _resetFutas()
  const a = await rpc.templatePreviewStatus()
  assert.ok(!a.mintaNelkul.includes('cimlap'))
  assert.ok(a.mintaNelkul.includes('szam'))
})

test('the preview status reads an empty sample as no sample, so the card and the gallery cannot disagree', async () => {
  const dir = fakeProject()
  const katFile = path.join(dir, 'src', 'kit', 'katalogus.generated.json')
  const kat = JSON.parse(fs.readFileSync(katFile, 'utf8'))
  kat.mintak = { cimlap: { sorok: ['a'] }, lista: {} }
  fs.writeFileSync(katFile, JSON.stringify(kat))
  const { rpc } = setup({ remotionDir: dir })
  _resetFutas()
  const r = await rpc.templatePreviewStatus()
  assert.ok(!r.mintaNelkul.includes('cimlap'))
  assert.ok(r.mintaNelkul.includes('lista'), 'an empty sample would draw a blank card, which is what "no sample" says')
})

test('the four preview methods answer, and none of them starts a run by itself', async () => {
  const { state, rpc } = setup()
  _resetFutas()
  // A page load calls status and preview; neither may spawn anything, which
  // is why this state carries no spawn seam at all -- a call that reached
  // `spawn` would launch npx on the machine running the suite.
  const a = await rpc.templatePreviewStatus()
  assert.equal(a.hiba, null)
  assert.equal(a.fut, null)
  assert.equal(a.katalogusHash.length, 64)
  assert.equal(a.meglevo.length, 0)
  // The two answers describe one catalogue: every type is drawable or is
  // waiting for a sample, and the type list itself comes from `templates`.
  assert.equal(a.mintaNelkul.length + a.hianyzo.length, (await rpc.templates()).tipusok.length)
  assert.deepEqual(await rpc.templatePreview({ tipus: 'cimlap' }), { dataUrl: null, ok: 'nincs_kep', hiba: null })
  assert.deepEqual(await rpc.templatePreview({ tipus: 'nincs-ilyen' }), { dataUrl: null, ok: 'tipus_ismeretlen', hiba: null })
  await assert.rejects(() => rpc.templatePreview({ tipus: 5 }), /tipus/)
  await assert.rejects(() => rpc.templatePreview({ tipus: 'x'.repeat(65) }), /tipus/)
  assert.deepEqual(await rpc.templatePreviewCancel(), { megszakitva: false })
  // And the injected spawn is what a start uses, so still nothing is run.
  state.spawnImpl = () => { const c = new EventEmitter(); c.kill = () => {}; return c }
  assert.deepEqual(await rpc.templatePreviewStart(), { indult: true, hiba: null })
  // A second press is refused by name and carries the code to the page
  // rather than a 500 over a run that is going fine. It is the method's own
  // vocabulary, so it rides `ok` and not `hiba`: a broken connection and a
  // run that is going fine must never be the same shape.
  assert.deepEqual(await rpc.templatePreviewStart(), { indult: false, ok: 'mar_fut', hiba: null })
  assert.deepEqual(await rpc.templatePreviewCancel(), { megszakitva: true })
  _resetFutas()
})

test('all four preview methods answer an unreadable project, and none of them throws over it', async () => {
  // An unreadable project is an ordinary operator state -- the setting is
  // empty on a fresh install -- and the gallery has to draw something either
  // way. So these answer with a code in `hiba`, the same field and the same
  // codes `templates` uses, rather than making the page handle a second,
  // harder shape for the same state.
  const { rpc } = setup({ remotionDir: '' })
  _resetFutas()
  const a = await rpc.templatePreviewStatus()
  assert.equal(a.hiba, 'remotion_dir_hianyzik')
  assert.equal(a.fut, null)
  // Every catalogue-derived field is null, never an empty list: `hianyzo: []`
  // would draw as "the gallery is complete".
  for (const mezo of ['katalogusHash', 'meglevo', 'hianyzo', 'mintaNelkul']) {
    assert.equal(a[mezo], null, mezo)
  }
  assert.deepEqual(await rpc.templatePreview({ tipus: 'cimlap' }), { dataUrl: null, hiba: 'remotion_dir_hianyzik' })
  assert.deepEqual(await rpc.templatePreviewStart(), { indult: false, hiba: 'remotion_dir_hianyzik' })
  // Cancel reads nothing but this module's own run state, so it has no
  // project to fail on and carries no `hiba` it could never fill.
  assert.deepEqual(await rpc.templatePreviewCancel(), { megszakitva: false })
})

test('a catalogue the other repository left unreadable is the same answer, by its own code', async () => {
  const dir = fakeProject()
  fs.writeFileSync(path.join(dir, 'src', 'kit', 'katalogus.generated.json'), 'nem json')
  const { rpc } = setup({ remotionDir: dir })
  _resetFutas()
  assert.equal((await rpc.templatePreviewStatus()).hiba, 'katalogus_ervenytelen')
  assert.deepEqual(await rpc.templatePreview({ tipus: 'cimlap' }), { dataUrl: null, hiba: 'katalogus_ervenytelen' })
  assert.deepEqual(await rpc.templatePreviewStart(), { indult: false, hiba: 'katalogus_ervenytelen' })
})

test('a run in flight is still reported when the project stops being readable under it', async () => {
  // The run lives in this extension and not in the operator's project, so a
  // setting changed mid-run does not make the run disappear -- and that is
  // exactly the moment the cancel button matters.
  let olvashato = true
  const dir = fakeProject()
  const { rpc, state } = setup({ remotionDir: dir })
  state.settings = () => ({ remotionDir: olvashato ? dir : '' })
  _resetFutas()
  state.spawnImpl = () => { const c = new EventEmitter(); c.kill = () => {}; return c }
  assert.deepEqual(await rpc.templatePreviewStart(), { indult: true, hiba: null })
  olvashato = false
  const a = await rpc.templatePreviewStatus()
  assert.equal(a.hiba, 'remotion_dir_hianyzik')
  assert.equal(a.katalogusHash, null)
  assert.equal(a.fut.osszes, 24, 'the run is answered beside the refusal, not hidden behind it')
  assert.deepEqual(await rpc.templatePreviewCancel(), { megszakitva: true })
  _resetFutas()
})

test('a start answers "already running" and nothing else: an error it has no answer for is not dressed up as one', async () => {
  // The project is read here first, deliberately, and only the run-already-on
  // refusal is converted into an answer afterwards. Everything else `indit`
  // can throw is something this method does not understand, and
  // `{ indult: false, ok }` over it would tell the page a run did not start
  // for a reason the page can draw -- when in truth nobody here knows what
  // happened. The seam is the settings read: the guard sees the project, and
  // `indit` reads it again a moment later.
  const dir = fakeProject()
  const { rpc, state } = setup({ remotionDir: dir })
  _resetFutas()
  let olvasas = 0
  state.settings = () => { olvasas += 1; return { remotionDir: olvasas === 1 ? dir : '' } }
  await assert.rejects(() => rpc.templatePreviewStart(), (err) => err.code === 'remotion_dir_hianyzik')
  assert.equal((await rpc.templatePreviewStatus()).fut, null, 'and no lock is left behind')
  _resetFutas()
})

test('templates without a readable project still answers the weekly row and says the code', async () => {
  const { repo, rpc } = setup({ remotionDir: '' })
  keszVideo(repo)
  const r = await rpc.templates()
  assert.equal(r.hiba, 'remotion_dir_hianyzik')
  // Every catalogue-derived field is null, never an empty list: an empty
  // `tipusok` would draw as "this kit has no templates", which is a false
  // statement about the kit rather than a true one about the connection.
  for (const mezo of ['tipusok', 'leirasok', 'propok', 'kozosPropok', 'kuldhetoTipusok', 'nemKuldhetoTipusok', 'tablaHianyok']) {
    assert.equal(r[mezo], null, mezo)
  }
  assert.ok(Array.isArray(r.hetiSor))
})

test('importFeedback refuses each bad row by index and is idempotent', async () => {
  const { repo, rpc } = setup()
  const { videoId } = keszVideo(repo)
  const sorok = [
    { videoId, atMs: 1000, jelenet: 1, szoveg: 'jó sor' },
    { videoId: 'nincs-ilyen', atMs: 0, szoveg: 'x' },
    { videoId, atMs: 0, szoveg: '  ' },
    { videoId, atMs: -5, szoveg: 'x' },
    null,
  ]
  const first = await rpc.importFeedback({ sorok })
  assert.equal(first.imported, 1)
  assert.equal(first.skipped, 0)
  assert.deepEqual(first.refused, [
    { index: 1, ok: 'video_ismeretlen' },
    { index: 2, ok: 'szoveg_ervenytelen' },
    { index: 3, ok: 'idopont_ervenytelen' },
    { index: 4, ok: 'video_ismeretlen' },
  ])
  const second = await rpc.importFeedback({ sorok })
  assert.equal(second.imported, 0)
  assert.equal(second.skipped, 1, 'the same row a second time is a skip, not a duplicate')
  assert.equal(repo.feedbackFor(videoId).length, 1)
  await assert.rejects(rpc.importFeedback({}), /sorok/)
  await assert.rejects(rpc.importFeedback({ sorok: new Array(5001).fill({}) }), /sorok/)
})

test('importRetention refuses out-of-range ratios and is idempotent by the primary key', async () => {
  const { repo, rpc } = setup()
  const { videoId } = keszVideo(repo)
  const sorok = [
    { videoId, platform: 'tiktok', tS: 0, arany: 0.9 },
    { videoId, platform: 'tiktok', tS: 1, arany: 1.5 },
    { videoId, platform: 'tiktok', tS: -1, arany: 0.5 },
    { videoId, platform: '', tS: 2, arany: 0.5 },
    { videoId: 'nincs-ilyen', platform: 'tiktok', tS: 2, arany: 0.5 },
  ]
  const first = await rpc.importRetention({ sorok })
  assert.equal(first.imported, 1)
  assert.deepEqual(first.refused, [
    { index: 1, ok: 'arany_ervenytelen' },
    { index: 2, ok: 'tS_ervenytelen' },
    { index: 3, ok: 'platform_ervenytelen' },
    { index: 4, ok: 'video_ismeretlen' },
  ])
  await rpc.importRetention({ sorok: [{ videoId, platform: 'tiktok', tS: 0, arany: 0.4 }] })
  const pontok = repo.retentionFor(videoId)
  assert.equal(pontok.length, 1, 'the same second twice is one point, updated')
  assert.equal(pontok[0].arany, 0.4)
  await assert.rejects(rpc.importRetention({ sorok: 'nem lista' }), /sorok/)
})

test('health separates what is blocked from what is only limited, and calls itself ok when nothing is blocked', async () => {
  const remotionDir = fakeProject()
  fs.mkdirSync(path.join(remotionDir, 'node_modules', '.remotion'), { recursive: true })
  const { rpc } = setup({ remotionDir })
  const h = await rpc.health()
  assert.equal(h.ok, true)
  assert.deepEqual(h.hibak, [])
  assert.deepEqual(h.figyelmeztetesek, [])
  assert.deepEqual(h.blokkolt, [])
  assert.deepEqual(h.remotion, { beallitva: true, letezik: true, hianyzoFajlok: [] })
  assert.deepEqual(h.eszkozok, { ffmpeg: true, ffprobe: true, npx: true })
  assert.equal(h.chrome.konyvtar, true)
  assert.deepEqual(h.szerzodesek, { tts: null, signals: null })
  assert.equal(h.futoRender, null, 'nothing running is idle, not a failure')
  assert.equal(h.sorNelkul, 0, 'a readable project with no stray file really is zero')
  assert.equal(h.counts.videos, 0)
  assert.equal(h.forduloRogzites, 'sajat')
  assert.deepEqual(h.sapkak, { nyitottJavaslat: JAVASLAT_NYITOTT_SAPKA, tanulsagCelonkent: TANULSAG_SAPKA, backlog: BACKLOG_SAPKA })
})

test('an absent narration provider blocks narration; an absent signals provider blocks nothing', async () => {
  const remotionDir = fakeProject()
  fs.mkdirSync(path.join(remotionDir, 'node_modules', '.remotion'), { recursive: true })
  const { rpc } = setup({ remotionDir, ttsWhy: 'provider_missing', signalsWhy: 'provider_disabled' })
  const h = await rpc.health()
  assert.equal(h.ok, false)
  assert.deepEqual(h.hibak, ['tts_szerzodes_hianyzik'])
  assert.deepEqual(h.figyelmeztetesek, ['signals_szerzodes_hianyzik'], 'videoOpen still works from a kezi source')
  assert.deepEqual(h.blokkolt, ['narracio'], 'the render engine is fine; only narration is stopped')
  assert.deepEqual(h.szerzodesek, { tts: 'provider_missing', signals: 'provider_disabled' }, 'the host reason, verbatim')
})

test('an unreachable render engine is reported as such, and no number is invented for it', async () => {
  const { rpc } = setup({ remotionDir: '' })
  const h = await rpc.health()
  assert.equal(h.ok, false)
  assert.equal(h.hibak.includes('remotion_dir_hianyzik'), true)
  assert.equal(h.hibak.includes('chrome_hianyzik'), true)
  assert.deepEqual(h.remotion, { beallitva: false, letezik: false, hianyzoFajlok: [] })
  assert.deepEqual(h.blokkolt, ['render', 'terv'])
  assert.equal(h.sorNelkul, null, 'not counted is null, never a zero that would read as "nothing left behind"')
  assert.deepEqual(h.eszkozok, { ffmpeg: true, ffprobe: true, npx: true }, 'the tools are a separate fact from the project')
})

test('a project missing one of the required files is reported by file name', async () => {
  const remotionDir = fakeProject()
  fs.rmSync(path.join(remotionDir, 'src', 'FosVideo.tsx'))
  const { rpc } = setup({ remotionDir })
  const h = await rpc.health()
  assert.equal(h.remotion.letezik, true)
  assert.deepEqual(h.remotion.hianyzoFajlok, ['src/FosVideo.tsx'])
  assert.equal(h.hibak.includes('remotion_dir_hianyzik'), true)
  assert.equal(h.sorNelkul, null, 'an incomplete project is not counted')
})

test('a missing binary blocks what it is used for, and the platform rule follows the setting', async () => {
  const remotionDir = fakeProject()
  fs.mkdirSync(path.join(remotionDir, 'node_modules', '.remotion'), { recursive: true })
  const execFileImpl = async (name) => {
    if (name === 'ffprobe') throw new Error('not found')
    return { stdout: '', stderr: '' }
  }
  const { rpc } = setup({ remotionDir, execFileImpl })
  const h = await rpc.health()
  assert.deepEqual(h.eszkozok, { ffmpeg: true, ffprobe: false, npx: true })
  assert.deepEqual(h.hibak, ['ffprobe_hianyzik'])
  assert.deepEqual(h.blokkolt, ['narracio', 'render'])

  const linux = setup({ remotionDir, platform: 'linux' })
  const lh = await linux.rpc.health()
  assert.equal(lh.hibak.includes('platform_nem_mac'), true)
  assert.deepEqual(lh.blokkolt, ['render'])
  assert.equal(lh.platform, 'linux')

  const allowed = setup({ remotionDir, platform: 'linux', settings: { linuxRenderEngedely: true } })
  const ah = await allowed.rpc.health()
  assert.equal(ah.hibak.includes('platform_nem_mac'), false)
  assert.equal(ah.linuxRenderEngedely, true)
})

test('health reports a running render without adjudicating it', async () => {
  const remotionDir = fakeProject()
  fs.mkdirSync(path.join(remotionDir, 'node_modules', '.remotion'), { recursive: true })
  const { repo, rpc } = setup({ remotionDir })
  const { videoId, tervId, tervHash, verdiktId } = keszVideo(repo)
  const id = futoRender(repo, videoId, tervId, tervHash, verdiktId)
  const h = await rpc.health()
  assert.deepEqual(h.futoRender, { renderId: id, status: 'fut' })
  assert.equal(repo.render(id).status, 'fut', 'reading health never closes a render')
  assert.equal(h.counts.renderek, 2)
})

test('health names the check it cannot answer instead of leaving it out', async () => {
  const { rpc } = setup()
  const h = await rpc.health()
  assert.deepEqual(h.nemValaszolt, ['reconcile_hianyzik'])
  assert.equal(h.hibak.includes('reconcile_hianyzik'), false, 'absence from hibak must not read as "this one is fine"')
  assert.equal(h.figyelmeztetesek.includes('reconcile_hianyzik'), false)
  assert.deepEqual([...HEALTH_NEM_VALASZOLT], ['reconcile_hianyzik'])
})

test('every code health can emit is declared in HEALTH_CODES', async () => {
  const kulcsok = new Set(HEALTH_CODES.map((c) => c.checkKey))
  const { rpc } = setup({ remotionDir: '', ttsWhy: 'provider_missing', signalsWhy: 'not_declared', platform: 'linux', execFileImpl: async () => { throw new Error('missing') } })
  const h = await rpc.health()
  for (const kod of [...h.hibak, ...h.figyelmeztetesek, ...h.nemValaszolt]) assert.equal(kulcsok.has(kod), true, `${kod} is not declared in HEALTH_CODES`)
  assert.deepEqual(h.hibak.slice().sort(), ['chrome_hianyzik', 'ffmpeg_hianyzik', 'ffprobe_hianyzik', 'npx_hianyzik', 'platform_nem_mac', 'remotion_dir_hianyzik', 'tts_szerzodes_hianyzik'])
  assert.deepEqual(h.figyelmeztetesek, ['signals_szerzodes_hianyzik'])
})

test('health carries no setting the answer does not name', async () => {
  const { rpc } = setup({ settings: { apiKey: 'sk-titkos-kulcs', token: 'tok-titkos', napiSapka: 3 } })
  const body = JSON.stringify(await rpc.health())
  for (const tiltott of ['sk-titkos-kulcs', 'tok-titkos', 'apiKey', 'token', 'napiSapka']) {
    assert.equal(body.includes(tiltott), false, `${tiltott} must not reach the page`)
  }
})

test('setupChecks hands the host its own declaration shape and keeps the module own field back', () => {
  const checks = setupChecks()
  assert.equal(checks.length, HEALTH_CODES.length)
  const mezok = new Set(['checkKey', 'displayName', 'description', 'kind', 'target', 'required'])
  for (const c of checks) {
    for (const k of Object.keys(c)) assert.equal(mezok.has(k), true, `${k} is not a field of ExtensionSetupCheckDeclaration`)
    assert.equal(Object.hasOwn(c, 'blokkol'), false)
    assert.equal(typeof c.checkKey, 'string')
    assert.equal(['env', 'command', 'url', 'manual'].includes(c.kind), true)
  }
  checks[0].displayName = 'átírva'
  assert.notEqual(setupChecks()[0].displayName, 'átírva', 'the host gets fresh objects, not the module own list')
  assert.equal(HEALTH_CODES[0].displayName !== 'átírva', true)
})

test('an rpc refusal never repeats the value it refused', async () => {
  const { rpc } = setup()
  const gonosz = '<script>alert(1)</script>'
  for (const call of [rpc.video({ id: gonosz }), rpc.feedback({ videoId: gonosz, szoveg: 'x' }), rpc.decideProposal({ id: gonosz, dontes: 'elfogad' })]) {
    const err = await call.then(() => null, (e) => e)
    assert.ok(err instanceof Error)
    assert.equal(err.message.includes('script'), false, 'the refused value stays out of the message the route logs')
  }
  // The same discipline on the lever that ANSWERS its refusal instead of
  // throwing it, against the REAL render ops rather than the double: the
  // first live run pressed Render with a made-up id and the page showed
  // `nincs terv ezzel az id-vel: nincs-ilyen`, which the route also wrote to
  // the host log. `renderel` is a new door onto `renderOps.start`, so start's
  // wording is what the operator reads.
  const { state } = setup()
  const igazi = createRpc(state, createRenderOps(state))
  const valasz = await igazi.renderel({ tervId: gonosz })
  assert.equal(valasz.hiba, 'terv_ismeretlen')
  assert.equal(valasz.uzenet, 'nincs terv a megadott tervId-vel')
  assert.equal(valasz.uzenet.includes('script'), false, 'the refused value stays out of the sentence the page shows and the route logs')
  const megszakit = await igazi.cancelRender({ renderId: gonosz }).then(() => null, (e) => e)
  assert.equal(megszakit.code, 'render_ismeretlen')
  assert.equal(megszakit.message.includes('script'), false)
})

test('Tisztítás takes the preview cache too: it is the module\'s own and no row can bind its deletion', async () => {
  const dir = fakeProject()
  const { rpc } = setup({ remotionDir: dir })
  const root = path.join(dir, 'out', 'swarmclaw', 'sablon-elonezet')
  const hashek = ['a'.repeat(64), 'b'.repeat(64)]
  for (const h of hashek) {
    fs.mkdirSync(path.join(root, h), { recursive: true })
    fs.writeFileSync(path.join(root, h, 'cimlap.png'), 'png')
    fs.writeFileSync(path.join(root, h, 'cimlap.props.json'), '{}')
  }
  // Not a hash directory: this is not the module's, so the sweep leaves it,
  // the same three conditions the run's own sweep applies.
  fs.mkdirSync(path.join(root, 'operatore'), { recursive: true })
  fs.writeFileSync(path.join(root, 'operatore', 'sajat.png'), 'png')

  const r = await rpc.cleanup()
  assert.equal(r.elonezetek, 2, 'both hash directories go, and the answer says how many')
  for (const h of hashek) assert.equal(fs.existsSync(path.join(root, h)), false)
  assert.equal(fs.existsSync(path.join(root, 'operatore', 'sajat.png')), true)
})

/**
 * The three mechanical levers the page pulls without ordering a chat turn:
 * `nyit`, `narral` and `renderel`. Each is the tool's own service function by
 * another door, and NONE OF THE THREE THROWS -- a thrown rpc handler reaches
 * the browser as a bare 500 whose message the operator never sees, and these
 * three are the ones an operator presses in a state the module refuses.
 */

/** A tts double over the `narration` contract's shape; writes the mp3 the module then probes. */
function ttsDouble({ fail = null } = {}) {
  const calls = []
  return {
    calls,
    handle: {
      synthesize: async ({ szoveg, celFajl }) => {
        calls.push({ szoveg, celFajl })
        if (fail) {
          const cause = Object.assign(new Error('a szolgáltató egyenlege kimerült'), { code: fail })
          throw Object.assign(new Error(`contract tts.mjs.narration.synthesize threw: ${cause.message}`), { code: 'provider_threw', extensionId: 'tts.mjs', consumerId: 'video.mjs', cause })
        }
        fs.mkdirSync(path.dirname(celFajl), { recursive: true })
        fs.writeFileSync(celFajl, 'mp3')
        return { kerelemId: 'k', fajl: celFajl, hosszMs: 1, cache: false, hang: 'Kenji', modell: 'tts-rt-v1', nyelv: 'hu' }
      },
      status: async () => ({ hang: 'Kenji', modell: 'tts-rt-v1', nyelv: 'hu' }),
    },
  }
}

/** A video with a plan and a passing verdict, and nothing after it: what `narral` is pressed on. */
function lektoraltVideo(repo, { scenes = 8 } = {}) {
  const jelenetek = Array.from({ length: scenes }, (_, i) => (i === 0 ? PELDA_JELENETEK[0] : i === scenes - 1 ? PELDA_JELENETEK[2] : PELDA_JELENETEK[1]))
  const narracio = jelenetek.map((_, i) => ({ jelenet: i, szoveg: `Mondat ${i}.` }))
  const { id: videoId } = repo.openVideo({ cim: 'c', forrasTipus: 'kezi', forrasId: '', forrasSzoveg: IDEGEN, nyitottaAgentId: '' })
  const terv = repo.insertTerv({ videoId, jelenetek, narracio, assetUjjlenyomatok: [], katalogusHash: 'k', szerzoAgentId: 'g', szerzoSessionId: 's', ellenorzes: {} })
  repo.insertVerdikt({ tervId: terv.id, tervHash: terv.tervHash, lektorAgentId: 'l', lektorSessionId: 's', verdikt: 'atmegy', talalatok: [] })
  return { videoId, tervId: terv.id }
}

test('nyit opens a manual video through the same service videoOpen calls, and the row says the operator opened it', async () => {
  const { repo, rpc } = setup()
  const r = await rpc.nyit({ forras: 'kezi', forrasSzoveg: IDEGEN, cim: 'Kézi cím' })
  assert.equal(r.hiba, undefined, 'a successful open carries no refusal')
  assert.equal(r.cim, 'Kézi cím')
  assert.equal(r.forrasFigyelmeztetes.length > 0, true, 'the page gets the same stranger-text warning the agent gets')
  const v = repo.video(r.videoId)
  assert.equal(v.forras_tipus, 'kezi')
  assert.equal(v.forras_szoveg, IDEGEN, 'the source text is stored byte for byte')
  assert.equal(v.nyitotta_agent_id, '', 'the page is not an agent and does not name one')
  assert.equal(v.status, 'nyitott')
})

test('nyit takes the title from the source text when the operator gave none', async () => {
  const { rpc } = setup()
  const r = await rpc.nyit({ forras: 'kezi', forrasSzoveg: 'Első sor.\n\nMásodik.' })
  assert.equal(r.cim, 'Első sor.')
})

test('nyit refuses by name instead of throwing: a missing text, an unknown source, and the daily cap', async () => {
  const { repo, rpc } = setup()
  const ures = await rpc.nyit({ forras: 'kezi' })
  assert.equal(ures.hiba, 'argumentum_hibas')
  assert.equal(typeof ures.uzenet, 'string')
  assert.ok(ures.uzenet.includes('szoveg'), 'the message names the argument')

  const ismeretlen = await rpc.nyit({ forras: 'nincsilyen', forrasSzoveg: 'x' })
  assert.equal(ismeretlen.hiba, 'argumentum_hibas')

  assert.equal((await rpc.nyit({ forras: 'kezi', forrasSzoveg: 'Egy.' })).hiba, undefined)
  const sapka = await rpc.nyit({ forras: 'kezi', forrasSzoveg: 'Kettő.' })
  assert.equal(sapka.hiba, 'napi_sapka', 'the default cap is one a day and the page is told which cap it hit')
  assert.equal(sapka.sapka, 1, 'the refusal carries its numbers, so the page can say 1/1')
  assert.equal(sapka.maNyilt, 1)
  assert.equal(repo.videos().length, 1)
})

test('nyit passes the source through to the signals branch, and its refusal arrives named', async () => {
  const { rpc } = setup({ signalsWhy: 'provider_missing' })
  const r = await rpc.nyit({ forras: 'signal' })
  assert.equal(r.hiba, 'signals_szerzodes_hianyzik')
  assert.equal(r.why, 'provider_missing', 'the host\'s own reason travels, so the operator knows which fix')
})

test('narral runs the tts contract for every scene and writes the set the render gate reads', async () => {
  const tts = ttsDouble()
  const { repo, rpc } = setup({ handles: { 'tts.narration': tts.handle } })
  const { videoId, tervId } = lektoraltVideo(repo)
  const r = await rpc.narral({ tervId })
  assert.equal(r.hiba, undefined)
  assert.equal(r.valtozatlan, false)
  assert.equal(tts.calls.length, 8, 'one synthesize per scene, through the contract')
  assert.equal(repo.narraciok(tervId).length, 8)
  assert.equal(repo.video(videoId).status, 'narralt')
})

test('narral refuses by name instead of throwing: an unknown plan, a plan with no passing verdict, and a tts that is not there', async () => {
  const tts = ttsDouble()
  const { repo, rpc } = setup({ handles: { 'tts.narration': tts.handle } })
  const ismeretlen = await rpc.narral({ tervId: 'nincs-ilyen' })
  assert.equal(ismeretlen.hiba, 'terv_ismeretlen')
  assert.equal(typeof ismeretlen.uzenet, 'string')

  const { videoId } = keszVideo(repo, { cim: 'másik', sha: 'sha-2' })
  const uj = repo.insertTerv({ videoId, jelenetek: PELDA_JELENETEK, narracio: PELDA_NARRACIO, assetUjjlenyomatok: [], katalogusHash: 'k', szerzoAgentId: 'g', szerzoSessionId: 's', ellenorzes: {} })
  const nincsVerdikt = await rpc.narral({ tervId: uj.id })
  assert.equal(nincsVerdikt.hiba, 'verdikt_hianyzik')

  const nincsTts = setup({ ttsWhy: 'provider_disabled' })
  const { tervId } = lektoraltVideo(nincsTts.repo)
  const r = await nincsTts.rpc.narral({ tervId })
  assert.equal(r.hiba, 'tts_szerzodes_hianyzik')
  assert.equal(r.why, 'provider_disabled')
})

test('narral reports the tts own code word for word, so a spent balance does not read as "the tts failed"', async () => {
  const tts = ttsDouble({ fail: 'tts_egyenleg_kimerult' })
  const { repo, rpc } = setup({ handles: { 'tts.narration': tts.handle } })
  const { tervId } = lektoraltVideo(repo)
  const r = await rpc.narral({ tervId })
  assert.equal(r.hiba, 'tts_visszautasitva')
  assert.equal(r.ttsKod, 'tts_egyenleg_kimerult')
  assert.equal(r.jelenet, 0)
  assert.equal(repo.narraciok(tervId).length, 0, 'a refused set writes no row')
})

test('renderel starts the render through the same renderOps videoRender uses', async () => {
  const { repo, rpc, ops } = setup()
  const { tervId } = lektoraltVideo(repo)
  const r = await rpc.renderel({ tervId })
  assert.deepEqual(ops.indult, [tervId], 'the page and the tool share one start')
  assert.equal(r.renderId, 'r-uj')
  assert.equal(r.hiba, undefined)
})

test('renderel refuses by name instead of throwing when the render side refuses', async () => {
  const ops = opsDouble()
  ops.start = () => { throw new VideoError('narracio_hianyos', 'ehhez a tervhez nincs teljes narráció', { hianyzo: [3] }) }
  const { repo, rpc } = setup({ ops })
  const { tervId } = lektoraltVideo(repo)
  const r = await rpc.renderel({ tervId })
  assert.equal(r.hiba, 'narracio_hianyos')
  assert.deepEqual(r.hianyzo, [3], 'the refusal\'s own fields travel, so the page can say which scene')
})

test('renderel refuses a missing tervId by name rather than handing the render side an empty string', async () => {
  const { rpc, ops } = setup()
  const r = await rpc.renderel({})
  assert.equal(r.hiba, 'argumentum_hibas')
  assert.deepEqual(ops.indult, [], 'nothing was started')
})

test('a bug in one of the three levers arrives as ismeretlen_hiba and is logged, never as a silent 500', async () => {
  const ops = opsDouble()
  ops.start = () => { throw new TypeError('cannot read properties of undefined') }
  const hibak = []
  const { repo, rpc } = setup({ ops, log: { info() {}, warn() {}, error: (...a) => hibak.push(a) } })
  const { tervId } = lektoraltVideo(repo)
  const r = await rpc.renderel({ tervId })
  assert.equal(r.hiba, 'ismeretlen_hiba')
  assert.ok(r.uzenet.includes('cannot read properties'), 'the operator gets something to report')
  assert.equal(hibak.length, 1, 'and the host log still sees the bug')
})

// --- the YouTube ideas button, end to end through the rpc ---

/**
 * The two seams `youtubeOtletek` reaches, as doubles: yt-dlp resolving a
 * channel handle to a channel id, and the GET of that channel's Atom feed.
 * No test below starts a process or makes a request.
 */
function ytSeamek(csatornaIdk, feedek) {
  const execFileImpl = async (command, args) => {
    const cel = args[0]
    const valasz = csatornaIdk[cel]
    assert.ok(valasz !== undefined, `the module resolved a channel this test did not stub: ${cel}`)
    if (typeof valasz === 'function') throw valasz()
    return { stdout: valasz, stderr: '' }
  }
  const fetchImpl = async (url) => {
    const valasz = feedek[url]
    assert.ok(valasz !== undefined, `the module fetched a feed this test did not stub: ${url}`)
    return { status: 200, ok: true, text: async () => valasz }
  }
  return { execFileImpl, fetchImpl }
}

const YT_FEED = (id) => `https://www.youtube.com/feeds/videos.xml?channel_id=${id}`

/** One Atom entry, dated inside the default window unless a test moves it. */
const ytEntry = (id, cim, kiadva = new Date(Date.now() - 86_400_000).toISOString()) =>
  `<entry><yt:videoId>${id}</yt:videoId><title>${cim}</title><published>${kiadva}</published><media:group><media:community><media:statistics views="12"/></media:community></media:group></entry>`

/** The same entry without `<media:statistics>`: a feed that did not say how many watched it. */
const ytEntryNezettsegNelkul = (id, cim, kiadva = new Date(Date.now() - 86_400_000).toISOString()) =>
  `<entry><yt:videoId>${id}</yt:videoId><title>${cim}</title><published>${kiadva}</published></entry>`

const ytFeed = (entries) => `<?xml version="1.0"?><feed><title>A csatorna</title><published>2006-09-20T05:17:16+00:00</published>${entries.join('')}</feed>`

/** A module whose channels all resolve and whose feeds all answer, keyed by the handle letter. */
function ytSetup(handles) {
  const csatornaIdk = {}
  const feedek = {}
  for (const [betu, entries] of Object.entries(handles)) {
    const id = `UC${betu.repeat(22)}`
    csatornaIdk[`https://www.youtube.com/@${betu}/videos`] = id
    feedek[YT_FEED(id)] = ytFeed(entries)
  }
  const { execFileImpl, fetchImpl } = ytSeamek(csatornaIdk, feedek)
  return setup({
    settings: { youtubeCsatornak: Object.keys(handles).map((b) => `@${b}`).join(', '), ytDlpUtvonal: '/nem/futtatjuk/yt-dlp' },
    execFileImpl,
    fetchImpl,
  })
}

test('youtubeOtletek opens a card per fresh upload and puts it in the nyitott column', async () => {
  const { repo, rpc } = ytSetup({
    a: [ytEntry('NYFGCESmikA', 'Egy cím'), ytEntry('l6USUAIKJls', 'Másik &amp; cím')],
    b: [ytEntry('XyXBwO5jYpw', 'Harmadik')],
  })
  const r = await rpc.youtubeOtletek({})
  assert.equal(r.hiba, undefined)
  assert.equal(r.jelolt, 3)
  assert.equal(r.marVolt, 0)
  assert.equal(r.maradek, 0)
  assert.deepEqual(r.csatornaHibak, [])
  assert.deepEqual(r.nyitott.map((n) => n.cim), ['Egy cím', 'Másik & cím', 'Harmadik'])

  const b = await rpc.board()
  assert.deepEqual(b.oszlopok.nyitott.map((k) => k.cim).sort(), ['Egy cím', 'Harmadik', 'Másik & cím'])
  for (const k of b.oszlopok.nyitott) assert.equal(k.forrasTipus, 'youtube')
  // The stored source is the module's own three paragraphs: the title as the
  // feed wrote it, then the upload day and the view count so the operator can
  // see how fresh and how watched the idea is, and LAST the url this module
  // built from an id it checked.
  const reszlet = await rpc.video({ id: r.nyitott[0].videoId })
  const sorok = reszlet.forrasSzoveg.split('\n\n')
  assert.equal(sorok[0], 'Egy cím')
  assert.match(sorok[1], /^Feltöltve: \d{4}-\d{2}-\d{2} · 12 megtekintés$/, 'the card can say how old the idea is and how watched')
  assert.equal(sorok[2], 'https://www.youtube.com/watch?v=NYFGCESmikA')
  assert.equal(reszlet.forrasId, 'NYFGCESmikA')
  assert.equal(reszlet.nyitottaAgentId, '', 'an operator is not an agent')
  assert.equal(repo.videoForYoutube('NYFGCESmikA').id, r.nyitott[0].videoId)
})

test('the stored YouTube source yields a clickable link through the page own reader', async () => {
  // THE ASSERTION WHOSE ABSENCE LET THE BUG SHIP. The paragraph order was
  // pinned above, and separately `forrasUrl` was pinned in the ui suite, and
  // nothing ever put one through the other -- so the door composed title, url,
  // date while the reader took the LAST paragraph, and every YouTube card drew
  // "a forrás utolsó bekezdése nem http(s) url" over a video whose whole point
  // is to be watched. This runs the real reader, with the real `safeHref`, over
  // the text the real door stored.
  const { rpc } = ytSetup({ a: [ytEntry('NYFGCESmikA', 'Egy cím')] })
  const r = await rpc.youtubeOtletek({})
  const reszlet = await rpc.video({ id: r.nyitott[0].videoId })
  assert.equal(forrasUrl(reszlet.forrasSzoveg, safeHref), 'https://www.youtube.com/watch?v=NYFGCESmikA')
})

test('a feed that did not say how many watched it says so, rather than printing nothing or zero', async () => {
  // `nezettsegOf` answers null rather than 0 for exactly this entry, and the
  // card has to carry that distinction rather than quietly dropping the line:
  // an absent view count and zero views are two facts, and a missing line is a
  // third.
  const { rpc } = ytSetup({ a: [ytEntryNezettsegNelkul('NYFGCESmikA', 'Egy cím')] })
  const r = await rpc.youtubeOtletek({})
  const reszlet = await rpc.video({ id: r.nyitott[0].videoId })
  const sorok = reszlet.forrasSzoveg.split('\n\n')
  assert.match(sorok[1], /^Feltöltve: \d{4}-\d{2}-\d{2} · a csatorna feedje nem közölt nézettséget$/)
  assert.equal(sorok[1].includes('0 megtekintés'), false, 'a feed that did not say must never read as zero views')
  assert.equal(forrasUrl(reszlet.forrasSzoveg, safeHref), 'https://www.youtube.com/watch?v=NYFGCESmikA', 'and the link survives the other branch')
})

test('a title longer than the module stores is cut before it is written, not after', async () => {
  // The door bounds what it stores because a feed's <title> is bounded by
  // nothing but the 4 MB body cap: an uncut one would sit in
  // `ext_video_videos`, on every board response, and -- through the `videos`
  // contract -- in the title of the document the docs extension writes.
  const { repo, rpc } = ytSetup({ a: [ytEntry('NYFGCESmikA', 'á'.repeat(5000))] })
  const r = await rpc.youtubeOtletek({})
  assert.equal(r.nyitott.length, 1, 'an oversized title is cut, never a reason to drop the idea')
  const sor = repo.videos()[0]
  assert.equal(sor.cim.length, 200)
  assert.equal(sor.forras_szoveg.split('\n\n')[0].length, 200, 'and the source text carries the cut title, not the raw one')
})

test('a video already opened from a YouTube id does not open a second time', async () => {
  const { repo, rpc } = ytSetup({ a: [ytEntry('NYFGCESmikA', 'Egy cím'), ytEntry('l6USUAIKJls', 'Másik')] })
  await rpc.youtubeOtletek({})
  const ujra = await rpc.youtubeOtletek({})
  assert.equal(ujra.jelolt, 2)
  assert.equal(ujra.marVolt, 2, 'both are known, so nothing new opened')
  assert.deepEqual(ujra.nyitott, [])
  assert.equal(repo.videos().length, 2, 'and no second row for either id')
})

test('the same channel listed twice in the setting is one card, not two', async () => {
  const id = 'UCaaaaaaaaaaaaaaaaaaaaa'
  const { execFileImpl, fetchImpl } = ytSeamek(
    { 'https://www.youtube.com/@a/videos': id },
    { [YT_FEED(id)]: ytFeed([ytEntry('pv1TUJSEM2k', 'Egy')]) },
  )
  const { rpc } = setup({ settings: { youtubeCsatornak: '@a, @a' }, execFileImpl, fetchImpl })
  const r = await rpc.youtubeOtletek({})
  assert.equal(r.jelolt, 1)
  assert.equal(r.nyitott.length, 1)
})

test('one press opens at most YOUTUBE_OTLET_MAX, and says how many are left over', async () => {
  const entries = []
  for (let n = 0; n < YOUTUBE_OTLET_MAX + 4; n += 1) entries.push(ytEntry(`videoid${String(n).padStart(3, '0')}`, `Cím ${n}`))
  const { repo, rpc } = ytSetup({ a: entries })
  const r = await rpc.youtubeOtletek({})
  assert.equal(r.nyitott.length, YOUTUBE_OTLET_MAX)
  assert.equal(r.maradek, 4, 'the answer says what a second press would still find')
  assert.equal(repo.videos().length, YOUTUBE_OTLET_MAX)
  // The daily cap is deliberately not in this path: `napiSapka` is 1 by
  // default and would have stopped this press at the second idea.
  const masodik = await rpc.youtubeOtletek({})
  assert.equal(masodik.nyitott.length, 4)
  assert.equal(masodik.marVolt, YOUTUBE_OTLET_MAX)
  assert.equal(masodik.maradek, 0)
})

test('napok filters on the feed own published date, and the window is the caller opinion', async () => {
  const regen = (n) => new Date(Date.now() - n * 86_400_000).toISOString()
  const { rpc } = ytSetup({ a: [ytEntry('friss000001', 'Friss', regen(2)), ytEntry('regi0000001', 'Régi', regen(20))] })
  const szuk = await rpc.youtubeOtletek({ napok: 7 })
  assert.deepEqual(szuk.nyitott.map((n) => n.cim), ['Friss'])
  assert.equal(szuk.eldobott, 1, 'the one outside the window is dropped and counted, not silently absent')

  const tag = await ytSetup({ a: [ytEntry('friss000001', 'Friss', regen(2)), ytEntry('regi0000001', 'Régi', regen(20))] }).rpc.youtubeOtletek({ napok: 30 })
  assert.deepEqual(tag.nyitott.map((n) => n.cim), ['Friss', 'Régi'], 'a wider window really does reach further back')
  assert.equal(tag.eldobott, 0)
})

test('youtubeOtletek answers its refusals as data, so the button can print the sentence', async () => {
  const nincsCsatorna = await setup().rpc.youtubeOtletek({})
  assert.equal(nincsCsatorna.hiba, 'youtube_nincs_csatorna')
  assert.ok(nincsCsatorna.uzenet.includes('youtubeCsatornak'))

  const { execFileImpl, fetchImpl } = ytSeamek(
    { 'https://www.youtube.com/@a/videos': () => Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) },
    {},
  )
  const nincsBinaris = await setup({
    settings: { youtubeCsatornak: '@a', ytDlpUtvonal: '/nem/futtatjuk/yt-dlp' }, execFileImpl, fetchImpl,
  }).rpc.youtubeOtletek({})
  assert.equal(nincsBinaris.hiba, 'ytdlp_hianyzik')
  assert.equal(nincsBinaris.uzenet.includes('/nem/futtatjuk/yt-dlp'), false, 'a refusal never repeats a stored setting')

  // Read before anything is resolved or fetched, so a bad window is a named
  // refusal rather than a run that half happened.
  const rosszNapok = await setup({ settings: { youtubeCsatornak: '@a' } }).rpc.youtubeOtletek({ napok: 0 })
  assert.equal(rosszNapok.hiba, 'argumentum_hibas')
})

test('a channel that did not answer is named beside the ideas the others gave', async () => {
  const idB = 'UCbbbbbbbbbbbbbbbbbbbbb'
  const { execFileImpl, fetchImpl } = ytSeamek(
    {
      'https://www.youtube.com/@a/videos': () => Object.assign(new Error('Command failed'), { code: 1 }),
      'https://www.youtube.com/@b/videos': idB,
    },
    { [YT_FEED(idB)]: ytFeed([ytEntry('NYFGCESmikA', 'Egy cím')]) },
  )
  const { rpc } = setup({ settings: { youtubeCsatornak: '@a, @b' }, execFileImpl, fetchImpl })
  const r = await rpc.youtubeOtletek({})
  assert.deepEqual(r.csatornaHibak, [{ csatorna: 'https://www.youtube.com/@a', ok: 'csatorna_nem_valaszolt' }])
  assert.equal(r.nyitott.length, 1, 'the channel that answered still produced a card')
})

test('youtubeOtletek never throws: a bug in it arrives as ismeretlen_hiba and is logged', async () => {
  // The button is pressed in exactly the states this module refuses, so it
  // goes through `nemDob` like the other three levers: a thrown bug would
  // reach the browser as a 500 whose body the page prints as "500".
  const hibak = []
  const id = 'UCaaaaaaaaaaaaaaaaaaaaa'
  const { execFileImpl, fetchImpl } = ytSeamek(
    { 'https://www.youtube.com/@a/videos': id },
    { [YT_FEED(id)]: ytFeed([ytEntry('NYFGCESmikA', 'Egy cím')]) },
  )
  const { repo, rpc } = setup({
    settings: { youtubeCsatornak: '@a' },
    execFileImpl,
    fetchImpl,
    log: { info() {}, warn() {}, error: (...a) => hibak.push(a) },
  })
  repo.openVideo = () => { throw new TypeError('cannot read properties of undefined') }
  const r = await rpc.youtubeOtletek({})
  assert.equal(r.hiba, 'ismeretlen_hiba')
  assert.ok(r.uzenet.includes('cannot read properties'), 'the operator gets something to report')
  assert.equal(hibak.length, 1, 'and the host log still sees the bug')
})
