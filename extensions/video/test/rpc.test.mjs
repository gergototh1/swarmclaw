import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

import { VIDEO_STATUSOK } from '../src/db.mjs'
import { HEALTH_CODES, HEALTH_NEM_VALASZOLT, setupChecks } from '../src/health.mjs'
import { SZABALYKESZLET } from '../src/qa.mjs'
import { createRpc } from '../src/rpc.mjs'
import { BACKLOG_SAPKA, JAVASLAT_NYITOTT_SAPKA, TANULSAG_SAPKA } from '../src/tanulsag.mjs'
import { PELDA_JELENETEK, PELDA_NARRACIO, fakeProject, freshRepo } from './helpers.mjs'

const quiet = { info() {}, warn() {}, error() {} }
const IDEGEN = 'Idegen szöveg a hírlevélből.'

/**
 * The render side, as a double. Every method the rpc reaches on `renderOps`
 * is here and nothing else, so a call that grew a new dependency fails loudly
 * instead of spawning a process on the machine running the suite.
 */
const opsDouble = () => ({
  summary: (r) => ({ renderId: r.id, status: r.status }),
  cancel: (id) => ({ renderId: id, status: 'hiba', hiba: { kod: 'render_megszakitva' } }),
  cleanupAll: () => ({ renderek: 0, narraciok: 0, sorNelkul: 0 }),
  orphanCount: () => 0,
})

/** Every version probe answers "present" unless a test says otherwise; no binary is ever run. */
const eszkozOk = async () => ({ stdout: '', stderr: '' })

function setup({ remotionDir = fakeProject(), settings = {}, ttsWhy = null, signalsWhy = null, execFileImpl = eszkozOk, platform = 'darwin', ops = opsDouble() } = {}) {
  const { storage, repo } = freshRepo()
  const state = {
    storage,
    repo,
    log: quiet,
    settings: () => ({ remotionDir, ...settings }),
    contracts: { get: () => null, why: (ext) => (ext === 'tts' ? ttsWhy : signalsWhy) },
    execFileImpl,
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
  assert.deepEqual(await rpc.cleanup(), { renderek: 0, narraciok: 0, sorNelkul: 0 })
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
})
