import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { createRenderOps, createRenderTools } from '../src/render.mjs'
import { PELDA_JELENETEK, fakeProject, freshRepo } from './helpers.mjs'

const quiet = { info() {}, warn() {}, error() {} }
const GOOD_PROBE = { format: { duration: '40.0' }, streams: [{ codec_type: 'video', codec_name: 'h264', width: 1080, height: 1920, avg_frame_rate: '30/1' }, { codec_type: 'audio', codec_name: 'aac', duration: '40.0' }] }

/** A fake child: a pid, the two events, unref. Nothing is spawned. */
function fakeChild(pid = 4242) { const c = new EventEmitter(); c.pid = pid; c.unref = () => {}; return c }

function setup({ platform = 'darwin', bootAt = 1000, tools = true, chrome = true, hang = 'Kenji' } = {}) {
  const { repo } = freshRepo()
  const dir = fakeProject()
  const spawned = []
  const kills = []
  let child = fakeChild()
  // The repo stamps `started_at` from the real wall clock (db.mjs's `now()`
  // seam is the watchdog's alone, per index.mjs's seam comment), so the fake
  // clock has to start at the real "now" too: a fixed past ISO string would
  // make the overrun test's elapsed time negative whenever the suite runs
  // later than that moment, which is every run but the one it was written at.
  const clock = { now: Date.now() }
  const state = {
    repo, log: quiet, settings: () => ({ remotionDir: dir, renderMaxPerc: 40, megtartottRenderek: 2 }),
    contracts: { get: () => ({ status: async () => ({ hang, modell: 'tts-rt-v1', nyelv: 'hu' }) }), why: () => null },
    spawnImpl: (cmd, args, opts) => { spawned.push({ cmd, args, opts }); return child },
    execFileImpl: async (cmd, args) => {
      if (!tools && cmd === 'ffmpeg' && args[0] === '-version') throw new Error('not found')
      if (!chrome && cmd === 'npx' && args[1] === 'browser') throw new Error('exit 1')
      if (cmd === 'ffprobe' && args.includes('-show_streams')) return { stdout: JSON.stringify(GOOD_PROBE), stderr: '' }
      if (cmd === 'ffmpeg' && args.includes('volumedetect')) return { stdout: '', stderr: 'mean_volume: -20.0 dB\n' }
      return { stdout: 'ok', stderr: '' }
    },
    killImpl: (pid, signal) => { kills.push({ pid, signal }); if (state.deadGroups.has(pid)) { const e = new Error('ESRCH'); e.code = 'ESRCH'; throw e } },
    deadGroups: new Set(),
    platform, bootAt: () => bootAt, now: () => clock.now,
  }
  const ops = createRenderOps(state)
  const toolsByName = Object.fromEntries(createRenderTools(state, ops).map((t) => [t.name, t]))
  const run = (name, args) => toolsByName[name].execute(args, { session: { id: 's', agentId: 'g' }, message: '' })
  // a plan, a passing verdict and a narration set with the files present
  const { id: videoId } = repo.openVideo({ cim: 'c', forrasTipus: 'kezi', forrasId: '', forrasSzoveg: 'f', nyitottaAgentId: '' })
  const jelenetek = [{ ...PELDA_JELENETEK[0] }, { tipus: 'lista', felsorolas: ['a'], kep: 'usecase/kep.png' }, ...Array.from({ length: 6 }, () => PELDA_JELENETEK[1]), PELDA_JELENETEK[2]]
  const narracio = jelenetek.map((_, i) => ({ jelenet: i, szoveg: `M${i}.` }))
  const kep = fs.readFileSync(path.join(dir, 'public', 'usecase', 'kep.png'))
  const terv = repo.insertTerv({ videoId, jelenetek, narracio, assetUjjlenyomatok: [{ utvonal: 'usecase/kep.png', sha256: createHash('sha256').update(kep).digest('hex') }], katalogusHash: 'k', szerzoAgentId: 'g', szerzoSessionId: 's', ellenorzes: {} })
  const verdikt = repo.insertVerdikt({ tervId: terv.id, tervHash: terv.tervHash, lektorAgentId: 'l', lektorSessionId: 's', verdikt: 'atmegy', talalatok: [] })
  const narrate = () => {
    const rows = narracio.map((n) => {
      const fajl = `narracio/swarmclaw/${videoId}/${terv.tervHash}/${n.jelenet}.mp3`
      fs.mkdirSync(path.dirname(path.join(dir, 'public', fajl)), { recursive: true }); fs.writeFileSync(path.join(dir, 'public', fajl), 'mp3')
      return { tervHash: terv.tervHash, jelenet: n.jelenet, szovegHash: createHash('sha256').update(n.szoveg).digest('hex'), hang: 'Kenji', modell: 'tts-rt-v1', nyelv: 'hu', fajl, hosszMs: 4000, ttsKeresId: '' }
    })
    repo.replaceNarraciok(terv.id, rows)
  }
  const setChild = (c) => { child = c }
  return { state, repo, dir, videoId, terv, verdikt, narrate, spawned, kills, clock, ops, run, setChild }
}

/** Polls until `fn()` is true: the close path awaits stream and probe I/O, which no fixed number of ticks covers. */
async function settle(fn) {
  for (let i = 0; i < 300; i += 1) {
    if (fn()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('a várt állapot nem állt be 3 s alatt')
}
const pause = () => new Promise((r) => setTimeout(r, 30))

test('start refuses in the spec order, each with its code', async () => {
  const s = setup()
  assert.equal((await s.run('videoRender', { tervId: 'nope' })).error.code, 'terv_ismeretlen')
  const t2 = s.repo.insertTerv({ videoId: s.videoId, jelenetek: PELDA_JELENETEK, narracio: [], assetUjjlenyomatok: [], katalogusHash: 'k', szerzoAgentId: 'g', szerzoSessionId: 's', ellenorzes: {} })
  assert.equal((await s.run('videoRender', { tervId: s.terv.id })).error.code, 'terv_elavult')
  assert.equal((await s.run('videoRender', { tervId: t2.id })).error.code, 'verdikt_hianyzik')
  const s2 = setup()
  assert.equal((await s2.run('videoRender', { tervId: s2.terv.id })).error.code, 'narracio_hianyos')
  s2.narrate()
  fs.appendFileSync(path.join(s2.dir, 'public', 'usecase', 'kep.png'), 'changed')
  const r = await s2.run('videoRender', { tervId: s2.terv.id })
  assert.equal(r.error.code, 'asset_valtozott'); assert.deepEqual(r.error.valtozott, ['usecase/kep.png'])
  const s3 = setup({ hang: 'Mira' }); s3.narrate()
  assert.equal((await s3.run('videoRender', { tervId: s3.terv.id })).error.code, 'narracio_hang_valtozott')
  const s4 = setup({ platform: 'linux' }); s4.narrate()
  assert.equal((await s4.run('videoRender', { tervId: s4.terv.id })).error.code, 'render_host_platform')
  const s5 = setup({ tools: false }); s5.narrate()
  const r5 = await s5.run('videoRender', { tervId: s5.terv.id })
  assert.equal(r5.error.code, 'render_eszkoz_hianyzik'); assert.equal(r5.error.eszkoz, 'ffmpeg')
  const s6 = setup({ chrome: false }); s6.narrate()
  assert.equal((await s6.run('videoRender', { tervId: s6.terv.id })).error.code, 'chrome_hianyzik')
  const s7 = setup(); s7.narrate(); fs.unlinkSync(path.join(s7.dir, 'src', 'FosVideo.tsx'))
  assert.equal((await s7.run('videoRender', { tervId: s7.terv.id })).error.code, 'remotion_dir_hianyzik')
})

test('start writes the props with hang and lathatoHossz, spawns detached with a log fd, and a second start is render_folyamatban', async () => {
  const s = setup(); s.narrate()
  const r = await s.run('videoRender', { tervId: s.terv.id })
  assert.equal(r.status, 'fut'); assert.equal(typeof r.renderId, 'string')
  const row = s.repo.render(r.renderId)
  assert.equal(row.pid, 4242); assert.equal(row.host_boot_at, 1000); assert.equal(row.platform, 'darwin')
  assert.equal(s.repo.video(s.videoId).status, 'renderel')
  const props = JSON.parse(fs.readFileSync(row.props_path, 'utf8'))
  assert.equal(props.hatter, true); assert.equal(props.lista.length, 9)
  assert.equal(props.lista[1].hang, `narracio/swarmclaw/${s.videoId}/${s.terv.tervHash}/1.mp3`)
  assert.equal(props.lista[0].lathatoHossz, 10 + 120 + 8); assert.equal(props.lista[8].lathatoHossz, 10 + 120 + 45)
  assert.equal(JSON.parse(row.jelenet_hatarok).length, 9)
  assert.equal(s.spawned.length, 1)
  assert.equal(s.spawned[0].cmd, 'npx')
  assert.deepEqual(s.spawned[0].args, ['remotion', 'render', 'src/index.ts', 'fos-video', row.out_path, '--props', row.props_path])
  assert.equal(s.spawned[0].opts.detached, true); assert.equal(s.spawned[0].opts.shell, false); assert.equal(s.spawned[0].opts.cwd, s.dir)
  assert.equal(s.spawned[0].opts.stdio[0], 'ignore'); assert.equal(typeof s.spawned[0].opts.stdio[1], 'number')
  assert.ok(row.out_path.startsWith(path.join(s.dir, 'out', 'swarmclaw', s.videoId, r.renderId)))
  const again = await s.run('videoRender', { tervId: s.terv.id })
  assert.equal(again.error.code, 'render_folyamatban'); assert.equal(again.error.renderId, r.renderId)
})

test('exit 0 with a file closes as kesz, runs the QA, binds the pass to the sha, and a second exit changes nothing', async () => {
  const s = setup(); s.narrate()
  const child = fakeChild(); s.setChild(child)
  const r = await s.run('videoRender', { tervId: s.terv.id })
  const row = s.repo.render(r.renderId)
  fs.writeFileSync(row.out_path, 'x'.repeat(200_000))
  child.emit('exit', 0, null); await settle(() => s.repo.video(s.videoId).status === 'qa_ok')
  const after = s.repo.render(r.renderId)
  assert.equal(after.status, 'kesz'); assert.equal(after.file_sha256.length, 64)
  const qa = s.repo.qaFor(r.renderId, after.file_sha256, 1)
  assert.equal(qa.ok, 1); assert.equal(s.repo.video(s.videoId).status, 'qa_ok')
  child.emit('exit', 1, null); await pause()
  assert.equal(s.repo.render(r.renderId).status, 'kesz')
  const st = await s.run('videoRenderStatus', { renderId: r.renderId })
  assert.equal(st.status, 'kesz'); assert.equal(st.qa.ok, true); assert.equal(st.fileSha256, after.file_sha256)
  assert.equal((await s.run('videoRenderStatus', { renderId: 'nope' })).error.code, 'render_ismeretlen')
})

test('exit 1 is render_kilepesi_kod; a signal is render_megszakadt; a failed QA measurement is qa_meretlen, not qa_hiba', async () => {
  const s = setup(); s.narrate()
  const child = fakeChild(); s.setChild(child)
  const r = await s.run('videoRender', { tervId: s.terv.id })
  child.emit('exit', 1, null); await settle(() => s.repo.render(r.renderId).status !== 'fut')
  assert.equal(s.repo.render(r.renderId).hiba_kod, 'render_kilepesi_kod'); assert.equal(s.repo.video(s.videoId).status, 'render_hiba')
  const s2 = setup(); s2.narrate()
  const c2 = fakeChild(); s2.setChild(c2)
  const r2 = await s2.run('videoRender', { tervId: s2.terv.id })
  c2.emit('exit', null, 'SIGKILL'); await settle(() => s2.repo.render(r2.renderId).status !== 'fut')
  assert.equal(s2.repo.render(r2.renderId).hiba_kod, 'render_megszakadt')
  const s3 = setup(); s3.narrate()
  const c3 = fakeChild(); s3.setChild(c3)
  const r3 = await s3.run('videoRender', { tervId: s3.terv.id })
  const row3 = s3.repo.render(r3.renderId); fs.writeFileSync(row3.out_path, 'x'.repeat(200_000))
  s3.state.execFileImpl = async () => { throw new Error('ffprobe died') }
  c3.emit('exit', 0, null); await settle(() => s3.repo.video(s3.videoId).status === 'qa_meretlen')
  assert.equal(s3.repo.render(r3.renderId).status, 'kesz'); assert.equal(s3.repo.render(r3.renderId).hiba_kod, 'qa_meres_sikertelen')
  assert.equal(s3.repo.video(s3.videoId).status, 'qa_meretlen'); assert.equal(s3.repo.qaFor(r3.renderId, s3.repo.render(r3.renderId).file_sha256, 1), null)
})

test('a file rewritten under the running gate is qa_meretlen: no pass is bound to a sha the row does not name', async () => {
  const s = setup(); s.narrate()
  const child = fakeChild(); s.setChild(child)
  const r = await s.run('videoRender', { tervId: s.terv.id })
  const row = s.repo.render(r.renderId)
  fs.writeFileSync(row.out_path, 'x'.repeat(200_000))
  // The row's sha and the gate's sha are two reads of one unlocked path. This
  // rewrites the file between them, which is the only way the two can differ.
  const eredeti = s.state.execFileImpl
  s.state.execFileImpl = async (cmd, args) => {
    if (cmd === 'ffprobe') fs.writeFileSync(row.out_path, 'y'.repeat(200_000))
    return eredeti(cmd, args)
  }
  child.emit('exit', 0, null); await settle(() => s.repo.video(s.videoId).status === 'qa_meretlen')
  const after = s.repo.render(r.renderId)
  assert.equal(after.status, 'kesz'); assert.equal(after.hiba_kod, 'qa_meres_sikertelen')
  assert.equal(s.repo.qaAll().length, 0, 'a measurement of other bytes is not written as this render\'s QA')
  assert.equal(s.repo.qaFor(r.renderId, after.file_sha256, 1), null)
  assert.equal((await s.run('videoRenderStatus', { renderId: r.renderId })).qa, null)
})

test('a fut row with no pid is dead: the status closes it from the disk and signals nothing', async () => {
  const s = setup(); s.narrate()
  // spawn answered with a child that never carried a pid, and no `error`
  // event followed it, so nothing is left that would report this render's
  // end. The row must not keep saying `fut` on the strength of that.
  const child = fakeChild(); delete child.pid; s.setChild(child)
  const r = await s.run('videoRender', { tervId: s.terv.id })
  assert.equal(s.repo.render(r.renderId).pid, null)
  const st = await s.run('videoRenderStatus', { renderId: r.renderId })
  assert.equal(st.status, 'hiba'); assert.equal(st.hiba.kod, 'render_megszakadt')
  assert.deepEqual(s.kills, [], 'a null pid is dead by definition, and no signal goes out on it')
})

test('status on a running row: dead group with dir is render_megszakadt, without dir render_kimenet_hianyzik, dead group with file closes by file', async () => {
  const s = setup(); s.narrate()
  const r = await s.run('videoRender', { tervId: s.terv.id })
  s.state.deadGroups.add(-4242)
  const st = await s.run('videoRenderStatus', { renderId: r.renderId })
  assert.equal(st.status, 'hiba'); assert.equal(st.hiba.kod, 'render_megszakadt')
  assert.deepEqual(s.kills, [{ pid: -4242, signal: 0 }])
  const s2 = setup(); s2.narrate()
  const r2 = await s2.run('videoRender', { tervId: s2.terv.id })
  fs.rmSync(path.dirname(s2.repo.render(r2.renderId).out_path), { recursive: true, force: true })
  s2.state.deadGroups.add(-4242)
  assert.equal((await s2.run('videoRenderStatus', { renderId: r2.renderId })).hiba.kod, 'render_kimenet_hianyzik')
  const s3 = setup(); s3.narrate()
  const r3 = await s3.run('videoRender', { tervId: s3.terv.id })
  fs.writeFileSync(s3.repo.render(r3.renderId).out_path, 'x'.repeat(200_000))
  s3.state.deadGroups.add(-4242)
  assert.equal((await s3.run('videoRenderStatus', { renderId: r3.renderId })).status, 'kesz')
})

test('an overrun kills the group; a row from before a reboot gets no signal and closes from the disk', async () => {
  const s = setup(); s.narrate()
  const r = await s.run('videoRender', { tervId: s.terv.id })
  s.clock.now += 41 * 60_000
  const st = await s.run('videoRenderStatus', { renderId: r.renderId })
  assert.equal(st.hiba.kod, 'render_idotullepes')
  assert.deepEqual(s.kills.map((k) => k.signal), [0, 'SIGTERM'])
  const s2 = setup(); s2.narrate()
  const r2 = await s2.run('videoRender', { tervId: s2.terv.id })
  s2.state.bootAt = () => 9999
  const st2 = await s2.run('videoRenderStatus', { renderId: r2.renderId })
  assert.equal(st2.hiba.kod, 'render_megszakadt'); assert.deepEqual(s2.kills, [])
})

test('cancel closes first and kills second, so the later exit is a no-op; a finished render is not cancelled', async () => {
  const s = setup(); s.narrate()
  const child = fakeChild(); s.setChild(child)
  const r = await s.run('videoRender', { tervId: s.terv.id })
  const c = s.ops.cancel(r.renderId)
  assert.equal(c.hiba.kod, 'render_megszakitva'); assert.equal(s.kills.at(-1).signal, 'SIGTERM')
  child.emit('exit', null, 'SIGTERM'); await pause()
  assert.equal(s.repo.render(r.renderId).hiba_kod, 'render_megszakitva')
  assert.throws(() => s.ops.cancel(r.renderId), (e) => e.code === 'render_nem_fut')
})

test('a render whose plan is no longer the latest does not write the video status', async () => {
  const s = setup(); s.narrate()
  const child = fakeChild(); s.setChild(child)
  const r = await s.run('videoRender', { tervId: s.terv.id })
  s.repo.insertTerv({ videoId: s.videoId, jelenetek: PELDA_JELENETEK, narracio: [], assetUjjlenyomatok: [], katalogusHash: 'k', szerzoAgentId: 'g', szerzoSessionId: 's', ellenorzes: {} })
  s.repo.setVideoStatus(s.videoId, 'terv')
  child.emit('exit', 1, null); await settle(() => s.repo.render(r.renderId).status !== 'fut')
  assert.equal(s.repo.render(r.renderId).status, 'hiba'); assert.equal(s.repo.video(s.videoId).status, 'terv')
})

test('takarit keeps the newest N rows per video, deletes only row-bound files under the namespace, and counts orphans', async () => {
  const s = setup(); s.narrate()
  const ids = []
  const outPaths = []
  for (let i = 0; i < 4; i += 1) {
    const child = fakeChild(); s.setChild(child)
    const r = await s.run('videoRender', { tervId: s.terv.id })
    ids.push(r.renderId); outPaths.push(s.repo.render(r.renderId).out_path)
    fs.writeFileSync(outPaths[i], 'x')
    child.emit('exit', 0, null); await settle(() => s.repo.video(s.videoId).status === 'qa_hiba')
    s.clock.now += 60_000
  }
  // megtartottRenderek is 2: the fourth start already pruned the first render's files before it claimed its row.
  assert.equal(fs.existsSync(outPaths[0]), false); assert.equal(s.repo.render(ids[0]).out_path, null); assert.notEqual(s.repo.render(ids[0]).torolve_at, null)
  assert.equal(fs.existsSync(outPaths[1]), true)
  const stray = path.join(s.dir, 'out', 'swarmclaw', 'idegen.mp4'); fs.writeFileSync(stray, 'x')
  assert.equal(s.ops.orphanCount(), 1)
  const r = s.ops.takarit(s.videoId)
  assert.equal(r.torolt, 1)
  assert.equal(fs.existsSync(outPaths[1]), false); assert.equal(s.repo.render(ids[1]).out_path, null)
  assert.equal(fs.existsSync(outPaths[2]), true); assert.equal(fs.existsSync(outPaths[3]), true)
  assert.equal(fs.existsSync(stray), true)
  const all = s.ops.cleanupAll()
  assert.equal(all.renderek, 2); assert.equal(all.narraciok, 9); assert.equal(all.sorNelkul, 1)
  assert.equal(fs.existsSync(stray), true)
})

test('a kesz render whose file later vanished is named render_kimenet_hianyzik, and the module\'s own deletion is not', async () => {
  const s = setup(); s.narrate()
  const child = fakeChild(); s.setChild(child)
  const r = await s.run('videoRender', { tervId: s.terv.id })
  const row = s.repo.render(r.renderId)
  fs.writeFileSync(row.out_path, 'x'.repeat(200_000))
  child.emit('exit', 0, null); await settle(() => s.repo.video(s.videoId).status === 'qa_ok')
  const elotte = await s.run('videoRenderStatus', { renderId: r.renderId })
  assert.equal(elotte.hiba, null); assert.equal(elotte.qa.ok, true)
  // Spec 11.2: a kesz row whose file disappeared afterwards. Without this the
  // producer hands the operator a path and a QA pass for a file that is gone.
  fs.unlinkSync(row.out_path)
  const st = await s.run('videoRenderStatus', { renderId: r.renderId })
  assert.equal(st.status, 'kesz')
  assert.equal(st.hiba.kod, 'render_kimenet_hianyzik')
  assert.ok(st.hiba.szoveg.includes(row.out_path))
  assert.equal(s.repo.render(r.renderId).hiba_kod, 'render_kimenet_hianyzik')
  assert.equal(st.qa.ok, true, 'the measurement stands: it is a true fact about bytes that existed')
  assert.equal(s.repo.qaAll().length, 1, 'no QA is run on a file that is not there')
  // The module's own sweep nulls the paths, so a row it emptied names no file and is not reported as a vanished one.
  const s2 = setup(); s2.narrate()
  const c2 = fakeChild(); s2.setChild(c2)
  const r2 = await s2.run('videoRender', { tervId: s2.terv.id })
  fs.writeFileSync(s2.repo.render(r2.renderId).out_path, 'x'.repeat(200_000))
  c2.emit('exit', 0, null); await settle(() => s2.repo.video(s2.videoId).status === 'qa_ok')
  s2.ops.cleanupAll()
  const st2 = await s2.run('videoRenderStatus', { renderId: r2.renderId })
  assert.equal(st2.outPath, null); assert.equal(st2.hiba, null)
  // An earlier code is kept in the text: "the gate never ran" and "the file is gone" are two facts.
  const s3 = setup(); s3.narrate()
  const c3 = fakeChild(); s3.setChild(c3)
  const r3 = await s3.run('videoRender', { tervId: s3.terv.id })
  const row3 = s3.repo.render(r3.renderId); fs.writeFileSync(row3.out_path, 'x'.repeat(200_000))
  s3.state.execFileImpl = async () => { throw new Error('ffprobe died') }
  c3.emit('exit', 0, null); await settle(() => s3.repo.video(s3.videoId).status === 'qa_meretlen')
  fs.unlinkSync(row3.out_path)
  const st3 = await s3.run('videoRenderStatus', { renderId: r3.renderId })
  assert.equal(st3.hiba.kod, 'render_kimenet_hianyzik')
  assert.match(st3.hiba.szoveg, /qa_meres_sikertelen/)
})

test('the overrun row says what the signals returned: a refused SIGTERM is not reported as a kill and no SIGKILL follows it', async (t) => {
  const s = setup(); s.narrate()
  const r = await s.run('videoRender', { tervId: s.terv.id })
  // Every signal to this group is refused. groupAlive reads EPERM as a live
  // group, so the watchdog reaches the kill; the kill itself never lands.
  s.state.killImpl = (pid, signal) => { s.kills.push({ pid, signal }); const e = new Error('EPERM'); e.code = 'EPERM'; throw e }
  s.clock.now += 41 * 60_000
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const st = await s.run('videoRenderStatus', { renderId: r.renderId })
  t.mock.timers.tick(30_000)
  t.mock.timers.reset()
  assert.equal(st.hiba.kod, 'render_idotullepes')
  assert.match(st.hiba.szoveg, /EPERM/)
  assert.doesNotMatch(st.hiba.szoveg, /SIGTERM-et kapott/)
  assert.deepEqual(s.kills.map((k) => k.signal), [0, 'SIGTERM'], 'no SIGKILL is scheduled behind a SIGTERM that never went out')
})

test('a SIGTERM that went out does schedule the SIGKILL, and the row promises it only while the host runs', async (t) => {
  const s = setup(); s.narrate()
  const r = await s.run('videoRender', { tervId: s.terv.id })
  s.clock.now += 41 * 60_000
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const st = await s.run('videoRenderStatus', { renderId: r.renderId })
  assert.deepEqual(s.kills.map((k) => k.signal), [0, 'SIGTERM'])
  t.mock.timers.tick(10_000)
  t.mock.timers.reset()
  assert.deepEqual(s.kills.map((k) => k.signal), [0, 'SIGTERM', 'SIGKILL'])
  assert.match(st.hiba.szoveg, /SIGTERM-et kapott/)
  assert.match(st.hiba.szoveg, /ha a host addig még fut/, 'an unref\'d timer cannot promise a signal a departing host will send')
})

test('cancel records that no signal went out when the group had already gone', async () => {
  const s = setup(); s.narrate()
  const child = fakeChild(); s.setChild(child)
  const r = await s.run('videoRender', { tervId: s.terv.id })
  s.state.deadGroups.add(-4242)
  const c = s.ops.cancel(r.renderId)
  assert.equal(c.hiba.kod, 'render_megszakitva')
  assert.match(c.hiba.szoveg, /nem élt, jel nem ment ki/)
  assert.deepEqual(s.kills.map((k) => k.signal), [0], 'a dead group is probed and then left alone')
})

test('a render closed from the disk keeps why it was closed, so a kesz row does not read as a clean render', async () => {
  const s = setup(); s.narrate()
  const r = await s.run('videoRender', { tervId: s.terv.id })
  fs.writeFileSync(s.repo.render(r.renderId).out_path, 'x'.repeat(200_000))
  s.state.deadGroups.add(-4242)
  const st = await s.run('videoRenderStatus', { renderId: r.renderId })
  assert.equal(st.status, 'kesz'); assert.equal(st.qa.ok, true)
  assert.equal(st.hiba.kod, 'render_folyamat_eltunt')
  assert.match(st.hiba.szoveg, /a folyamatcsoport nem él/)
  // The same fact survives a QA that could not measure the file.
  const s2 = setup(); s2.narrate()
  const r2 = await s2.run('videoRender', { tervId: s2.terv.id })
  fs.writeFileSync(s2.repo.render(r2.renderId).out_path, 'x'.repeat(200_000))
  s2.state.execFileImpl = async () => { throw new Error('ffprobe died') }
  s2.state.deadGroups.add(-4242)
  const st2 = await s2.run('videoRenderStatus', { renderId: r2.renderId })
  assert.equal(st2.hiba.kod, 'qa_meres_sikertelen')
  assert.match(st2.hiba.szoveg, /^a folyamatcsoport nem él; .*ffprobe died/)
})

test('the video follows the QA row that stands for the fingerprint, not the measurement the write did not keep', async () => {
  const s = setup(); s.narrate()
  const child = fakeChild(); s.setChild(child)
  const r = await s.run('videoRender', { tervId: s.terv.id })
  const row = s.repo.render(r.renderId)
  const bajtok = 'x'.repeat(200_000)
  fs.writeFileSync(row.out_path, bajtok)
  // A failing measurement of exactly these bytes under this rule set is
  // already on file. insertQa's ON CONFLICT leaves it alone, so the fresh
  // pass is never written; a video set from the fresh boolean would say
  // qa_ok while every qaFor reads ok = 0.
  const sha = createHash('sha256').update(bajtok).digest('hex')
  s.repo.insertQa({ renderId: r.renderId, fileSha256: sha, szabalykeszlet: 1, ok: false, meresek: {}, bukasok: ['korabbi'] })
  child.emit('exit', 0, null); await settle(() => s.repo.video(s.videoId).status !== 'renderel')
  assert.equal(s.repo.render(r.renderId).status, 'kesz')
  assert.equal(s.repo.qaAll().length, 1)
  assert.equal(s.repo.qaFor(r.renderId, sha, 1).ok, 0)
  assert.equal(s.repo.video(s.videoId).status, 'qa_hiba')
})

test('videoRender refuses a closed video, so no render close can write qa_ok over lezart', async () => {
  const s = setup(); s.narrate()
  s.repo.lezarVideo(s.videoId)
  assert.equal((await s.run('videoRender', { tervId: s.terv.id })).error.code, 'video_lezart')
  assert.equal(s.spawned.length, 0)
})

test('the preview cache is the module\'s own, so it is not counted as the operator\'s stray files', () => {
  const s = setup()
  // What `elonezet.mjs` writes: one directory per catalogue hash, under the
  // render namespace, with one still per scene type in it. No render row can
  // ever name these -- there is no render -- so a walk of the namespace that
  // does not know about them reports every one as a file the operator left.
  const hash = 'a'.repeat(64)
  const cacheDir = path.join(s.dir, 'out', 'swarmclaw', 'sablon-elonezet', hash)
  fs.mkdirSync(cacheDir, { recursive: true })
  for (const tipus of ['cimlap', 'lista', 'allitas']) fs.writeFileSync(path.join(cacheDir, `${tipus}.png`), 'png')
  assert.equal(s.ops.orphanCount(), 0, 'the cache is this module\'s, and the count is of the operator\'s files')

  // And a real stray beside it is still counted: the exclusion is the one
  // namespace, not the whole walk.
  fs.writeFileSync(path.join(s.dir, 'out', 'swarmclaw', 'idegen.mp4'), 'x')
  assert.equal(s.ops.orphanCount(), 1)
})
