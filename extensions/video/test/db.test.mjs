import assert from 'node:assert/strict'
import fs from 'node:fs'
import { test } from 'node:test'

import { FORDULO_MAX, MIGRATIONS, RENDER_STATUSOK, VIDEO_STATUSOK, canonicalJson, tervHashOf } from '../src/db.mjs'
import { PELDA_JELENETEK, PELDA_NARRACIO, freshRepo } from './helpers.mjs'

const terv = (repo, videoId, extra = {}) => repo.insertTerv({ videoId, jelenetek: PELDA_JELENETEK, narracio: PELDA_NARRACIO, assetUjjlenyomatok: [], katalogusHash: 'k1', szerzoAgentId: 'gyarto', szerzoSessionId: 's1', ellenorzes: { figyelmeztetesek: [] }, ...extra })
const openVideo = (repo) => repo.openVideo({ cim: 'c', forrasTipus: 'kezi', forrasId: '', forrasSzoveg: 'szöveg', nyitottaAgentId: '' }).id

test('every migration table uses the ext_video_ prefix', () => {
  for (const m of MIGRATIONS) for (const t of m.sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)) assert.match(t[1], /^ext_video_/)
})

test('every migration index uses the ext_video_ prefix so uninstall drops it', () => {
  // dropExtensionStorage selects sqlite_master by name prefix. An index whose
  // name misses the prefix survives an uninstall and makes the reinstall's
  // CREATE INDEX fail, so the names matter as much as the table names do.
  for (const m of MIGRATIONS) for (const i of m.sql.matchAll(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS (\w+)/g)) assert.match(i[1], /^ext_video_/)
})

test('the migration creates the eleven tables the spec lists plus the agent table', () => {
  const { storage } = freshRepo()
  const names = storage.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'ext_video_%' ORDER BY name").map((r) => r.name)
  assert.deepEqual(names, [
    'ext_video_fordulok', 'ext_video_javaslatok', 'ext_video_megtartas', 'ext_video_narraciok', 'ext_video_qa',
    'ext_video_renderek', 'ext_video_tanulsagok', 'ext_video_tervek', 'ext_video_ugynokok', 'ext_video_verdiktek',
    'ext_video_videos', 'ext_video_visszajelzesek',
  ])
})

test('v1 is idempotent (a leftover table survives a re-run) and v2 adds the nyelv column once', () => {
  // The host applies a version once per extension id and never re-runs it;
  // v1 is IF NOT EXISTS throughout because it may meet a table an uninstall
  // left behind, while v2 is an ALTER TABLE and relies on that once-only rule.
  const { storage } = freshRepo()
  storage.raw.exec(MIGRATIONS[0].sql)
  assert.equal(storage.get("SELECT COUNT(*) AS c FROM sqlite_master WHERE name = 'ext_video_renderek_fut'").c, 1)
  assert.deepEqual(MIGRATIONS.map((m) => m.version), [1, 2])
  const cols = storage.all('PRAGMA table_info(ext_video_narraciok)').map((c) => c.name)
  assert.ok(cols.includes('nyelv')); assert.equal(cols.filter((c) => c === 'nyelv').length, 1)
})

test('canonicalJson sorts keys at every depth and the terv hash follows content, not key order', () => {
  assert.equal(canonicalJson({ b: [{ y: 1, x: 2 }], a: 'á' }), '{"a":"á","b":[{"x":2,"y":1}]}')
  const h1 = tervHashOf({ jelenetek: [{ tipus: 'cimlap', sorok: ['a'] }], narracio: [{ jelenet: 0, szoveg: 's' }], assetUjjlenyomatok: [] })
  const h2 = tervHashOf({ jelenetek: [{ sorok: ['a'], tipus: 'cimlap' }], narracio: [{ szoveg: 's', jelenet: 0 }], assetUjjlenyomatok: [] })
  const h3 = tervHashOf({ jelenetek: [{ tipus: 'cimlap', sorok: ['a'] }], narracio: [{ jelenet: 0, szoveg: 's' }], assetUjjlenyomatok: [{ utvonal: 'k.png', sha256: 'x' }] })
  assert.equal(h1, h2); assert.notEqual(h1, h3)
})

test('canonicalJson keeps JSON.stringify value semantics, so an in-memory object and its stored JSON hash the same', () => {
  const inMemory = { b: undefined, a: [undefined, () => 1, NaN, new Date(0)], c: { z: null } }
  const stored = JSON.parse(JSON.stringify(inMemory))
  assert.equal(canonicalJson(inMemory), canonicalJson(stored))
  assert.equal(canonicalJson(inMemory), '{"a":[null,null,null,"1970-01-01T00:00:00.000Z"],"c":{"z":null}}')
  assert.equal(canonicalJson(undefined), undefined)
  assert.equal(canonicalJson('x"y'), '"x\\"y"')
})

test('terv versions count per video and latestTerv is the highest', () => {
  const { repo } = freshRepo()
  const v = openVideo(repo)
  const t1 = terv(repo, v); const t2 = terv(repo, v)
  assert.equal(t1.verzio, 1); assert.equal(t2.verzio, 2); assert.equal(t1.tervHash, t2.tervHash)
  assert.equal(repo.latestTerv(v).id, t2.id)
  assert.equal(repo.latestTervek().length, 1)
  assert.equal(repo.terv(t1.id).terv_hash, t1.tervHash, 'the stored hash is the one insertTerv computed')
  assert.deepEqual(repo.tervekForVideo(v).map((t) => t.verzio), [1, 2])
  const w = openVideo(repo)
  assert.equal(terv(repo, w).verzio, 1, 'versions are per video')
  assert.equal(repo.latestTervek().length, 2)
})

test('a passing verdict is found only for the exact terv id and hash pair', () => {
  const { repo } = freshRepo()
  const v = openVideo(repo)
  const t1 = terv(repo, v)
  repo.insertVerdikt({ tervId: t1.id, tervHash: t1.tervHash, lektorAgentId: 'lektor', lektorSessionId: 's', verdikt: 'atmegy', talalatok: [] })
  assert.ok(repo.passingVerdikt(t1.id, t1.tervHash))
  assert.equal(repo.passingVerdikt(t1.id, 'other-hash'), null)
  const t2 = terv(repo, v)
  assert.equal(repo.passingVerdikt(t2.id, t2.tervHash), null, 'a v1 verdict does not carry over to an identical v2')
  repo.insertVerdikt({ tervId: t2.id, tervHash: t2.tervHash, lektorAgentId: 'lektor', lektorSessionId: 's', verdikt: 'elbukik', talalatok: [{ jelenet: 0, kod: 'L1', szoveg: 'x' }] })
  assert.equal(repo.passingVerdikt(t2.id, t2.tervHash), null, 'a failing verdict is not a pass')
  assert.equal(repo.verdiktek(t2.id).length, 1); assert.equal(repo.verdiktekAll().length, 2)
})

test('passingVerdikt: a later verdict on the same id and hash withdraws an earlier pass', () => {
  // Verdicts are append-only. A reviewer who first passes a plan and later,
  // on a second look at the SAME submission (same terv id, same terv hash),
  // fails it, leaves both rows in the table; the earlier `atmegy` must not
  // still be findable, or a render gate reading it would start from an
  // approval the reviewer has since withdrawn.
  const { repo } = freshRepo()
  const v = openVideo(repo)
  const t = terv(repo, v)
  repo.insertVerdikt({ tervId: t.id, tervHash: t.tervHash, lektorAgentId: 'lektor', lektorSessionId: 's', verdikt: 'atmegy', talalatok: [] })
  assert.ok(repo.passingVerdikt(t.id, t.tervHash), 'the first pass stands on its own')
  repo.insertVerdikt({ tervId: t.id, tervHash: t.tervHash, lektorAgentId: 'lektor', lektorSessionId: 's', verdikt: 'elbukik', talalatok: [{ jelenet: 0, kod: 'horog_gyenge', szoveg: 'x' }] })
  assert.equal(repo.passingVerdikt(t.id, t.tervHash), null, 'the later fail withdraws the earlier pass')
  repo.insertVerdikt({ tervId: t.id, tervHash: t.tervHash, lektorAgentId: 'lektor', lektorSessionId: 's', verdikt: 'atmegy', talalatok: [] })
  assert.ok(repo.passingVerdikt(t.id, t.tervHash), 'a later pass reinstates it')
  assert.equal(repo.verdiktek(t.id).length, 3)
})

test('one running render at a time: the partial unique index is the barrier and claimRender names the running id', () => {
  const { repo } = freshRepo()
  const v = openVideo(repo); const t = terv(repo, v)
  const base = { videoId: v, tervId: t.id, tervHash: t.tervHash, verdiktId: 'vd', hostBootAt: 1, jelenetHatarok: [], propsPath: '/p', outPath: '/o', logPath: '/l', platform: 'darwin' }
  const first = repo.claimRender({ id: 'r1', ...base })
  assert.deepEqual(first, { id: 'r1' })
  const second = repo.claimRender({ id: 'r2', ...base })
  assert.deepEqual(second, { error: 'render_folyamatban', renderId: 'r1' })
  assert.equal(repo.runningRender().id, 'r1')
  repo.setRenderPid('r1', 4242)
  assert.equal(repo.render('r1').pid, 4242)
  assert.equal(repo.finishRender('r1', { status: 'kesz', fileSha256: 'abc' }), true)
  assert.equal(repo.finishRender('r1', { status: 'hiba', hibaKod: 'x' }), false, 'a closed render is not reopened or rewritten')
  assert.equal(repo.render('r1').status, 'kesz'); assert.equal(repo.render('r1').file_sha256, 'abc')
  assert.ok(repo.render('r1').finished_at)
  repo.setRenderPid('r1', 1)
  assert.equal(repo.render('r1').pid, 4242, 'a pid is written only on a running row')
  assert.equal(repo.runningRender(), null)
  assert.deepEqual(repo.claimRender({ id: 'r3', ...base }), { id: 'r3' })
})

test('claimRender propagates a failure that is not the one-render barrier', () => {
  const { repo } = freshRepo()
  // A NOT NULL violation with no render running is a bug in the caller, not
  // a `render_folyamatban`; reporting the latter would tell the agent to wait
  // for a render that does not exist.
  assert.throws(() => repo.claimRender({ id: 'r1', videoId: 'v', tervId: 't', tervHash: 'h', verdiktId: 'vd', hostBootAt: 1, jelenetHatarok: [], propsPath: '/p', outPath: '/o', logPath: '/l', platform: null }), /NOT NULL/)
  assert.equal(repo.runningRender(), null)
})

test('finishRender writes only the two closing statuses, each with what it needs', () => {
  const { repo } = freshRepo()
  const v = openVideo(repo); const t = terv(repo, v)
  repo.claimRender({ id: 'r1', videoId: v, tervId: t.id, tervHash: t.tervHash, verdiktId: 'vd', hostBootAt: 1, jelenetHatarok: [], propsPath: '/p', outPath: '/o', logPath: '/l', platform: 'darwin' })
  assert.throws(() => repo.finishRender('r1', { status: 'fut' }), /kesz or hiba/)
  assert.throws(() => repo.finishRender('r1', { status: 'elveszett' }), /kesz or hiba/, 'elveszett is in the vocabulary and written by nothing')
  assert.throws(() => repo.finishRender('r1', { status: 'kesz' }), /sha256/)
  assert.throws(() => repo.finishRender('r1', { status: 'hiba' }), /code/)
  assert.equal(repo.render('r1').status, 'fut', 'a refused close leaves the row running')
  assert.equal(repo.finishRender('r1', { status: 'hiba', hibaKod: 'render_megszakadt', hibaSzoveg: 'exit 1' }), true)
  assert.equal(repo.render('r1').hiba_kod, 'render_megszakadt')
  assert.ok(RENDER_STATUSOK.includes('elveszett'))
  repo.markRenderDeleted('r1')
  const r = repo.render('r1')
  assert.equal(r.out_path, null); assert.equal(r.props_path, null); assert.equal(r.log_path, null); assert.ok(r.torolve_at)
  assert.equal(repo.rendersForVideo(v).length, 1); assert.equal(repo.rendersAll().length, 1)
})

test('a QA pass is bound to the file fingerprint and the rule set', () => {
  const { repo } = freshRepo()
  const row = repo.insertQa({ renderId: 'r1', fileSha256: 'sha-a', szabalykeszlet: 1, ok: true, meresek: { duration_s: 30 }, bukasok: [] })
  const again = repo.insertQa({ renderId: 'r1', fileSha256: 'sha-a', szabalykeszlet: 1, ok: false, meresek: {}, bukasok: [{ kod: 'Q7' }] })
  assert.equal(again.id, row.id); assert.equal(again.ok, 1, 'the first verdict for that fingerprint stands')
  assert.equal(repo.qaFor('r1', 'sha-b', 1), null, 'a new fingerprint has no pass')
  assert.equal(repo.qaFor('r1', 'sha-a', 2), null, 'a new rule set has no pass')
  assert.equal(repo.qaFor('r2', 'sha-a', 1), null, 'another render of the same bytes has no pass of its own')
  assert.equal(repo.qaAll().length, 1)
})

test('feedback is deduplicated on (video, at_ms, jelenet, szoveg) and retention upserts on its key', () => {
  const { repo } = freshRepo()
  const v = openVideo(repo)
  const a = repo.insertFeedback({ videoId: v, atMs: 1200, jelenet: null, szoveg: 'rossz szám', forras: 'import' })
  const b = repo.insertFeedback({ videoId: v, atMs: 1200, jelenet: null, szoveg: 'rossz szám', forras: 'operator' })
  assert.equal(a.uj, true); assert.equal(b.uj, false); assert.equal(a.id, b.id)
  assert.equal(repo.insertFeedback({ videoId: v, atMs: null, jelenet: 2, szoveg: 'rossz szám', forras: 'operator' }).uj, true)
  assert.equal(repo.insertFeedback({ videoId: v, atMs: null, jelenet: null, szoveg: 'rossz szám', forras: 'operator' }).uj, true, 'two NULL halves are one key, not two distinct ones')
  assert.equal(repo.insertFeedback({ videoId: v, atMs: null, jelenet: null, szoveg: 'rossz szám', forras: 'import' }).uj, false)
  assert.equal(repo.insertFeedback({ videoId: openVideo(repo), atMs: 1200, jelenet: null, szoveg: 'rossz szám', forras: 'import' }).uj, true, 'the same note on another video is another note')
  assert.equal(repo.feedbackFor(v).length, 3)
  repo.upsertRetention([{ videoId: v, platform: 'yt', tS: 0, arany: 1 }, { videoId: v, platform: 'yt', tS: 5, arany: 0.7 }])
  repo.upsertRetention([{ videoId: v, platform: 'yt', tS: 5, arany: 0.6 }])
  assert.deepEqual(repo.retentionFor(v).map((p) => p.arany), [1, 0.6])
  assert.deepEqual(repo.retentionVideoIds(), [v])
})

test('turns are stamped on read and closed on close, so an interrupted review returns them', () => {
  const { repo } = freshRepo()
  const f1 = repo.insertFordulo({ sessionId: 's', agentId: 'a', forras: 'chat', uzenet: 'x'.repeat(5000), valasz: 'y', toolok: [] })
  repo.insertFordulo({ sessionId: 's', agentId: 'a', forras: 'schedule', uzenet: 'u', valasz: 'v', toolok: [{ nev: 'videoDraft', hiba: 'tipus_ismeretlen' }] })
  const open = repo.unreviewedFordulok(200)
  assert.equal(open.length, 2); assert.equal(open[0].uzenet.length, FORDULO_MAX)
  assert.equal(repo.countUnreviewedFordulok(), 2)
  repo.stampAtnezes([f1.id], 'at-1')
  assert.equal(repo.unreviewedFordulok(200).length, 2, 'a stamp is not a review')
  assert.equal(repo.fordulo(f1.id).atnezes_id, 'at-1')
  assert.equal(repo.closeAtnezes('at-1'), 1)
  assert.equal(repo.unreviewedFordulok(200).length, 1)
  assert.equal(repo.closeAtnezes('at-1'), 0)
  assert.equal(repo.latestFordulok(1)[0].forras, 'schedule')
})

test('a turn is cut at FORDULO_MAX characters without splitting a surrogate pair', () => {
  const { repo } = freshRepo()
  const emoji = '😀'
  const uzenet = 'x'.repeat(FORDULO_MAX - 1) + emoji
  const { id } = repo.insertFordulo({ sessionId: 's', agentId: 'a', forras: 'chat', uzenet, valasz: emoji.repeat(3000), toolok: [] })
  const row = repo.fordulo(id)
  assert.equal(row.uzenet.length, FORDULO_MAX - 1, 'the pair that would straddle the cut is dropped whole')
  assert.ok(row.uzenet.isWellFormed())
  assert.equal(row.valasz.length, FORDULO_MAX); assert.ok(row.valasz.isWellFormed())
})

test('proposals: open, decide once, counts by status and kind, rejected within a window; lessons activate and retire', () => {
  const { repo } = freshRepo()
  const { id } = repo.insertJavaslat({ cel: 'agent:gyarto', fajta: 'tanulsag', cim: 'Rövidebb horog', szoveg: 'A címlap egy mondat.', bizonyitek: ['f1'], javasoltaAgentId: 'lektor', futasSessionId: 'run-1' })
  assert.equal(repo.countOpen(), 1); assert.equal(repo.countInSession('run-1'), 1)
  assert.equal(repo.openJavaslatok().length, 1)
  assert.throws(() => repo.decideJavaslat(id, 'kodolva', 'x'), /elfogadva or elutasitva/)
  assert.throws(() => repo.decideJavaslat(id, 'nyitott', 'x'), /elfogadva or elutasitva/)
  assert.equal(repo.decideJavaslat(id, 'elfogadva', 'ok'), true)
  assert.equal(repo.decideJavaslat(id, 'elutasitva', 'later'), false, 'a decided proposal is not decided again')
  assert.equal(repo.javaslat(id).dontes_megjegyzes, 'ok')
  assert.equal(repo.countOpen(), 0); assert.equal(repo.countByStatusFajta('elfogadva', 'tanulsag'), 1)
  const rej = repo.insertJavaslat({ cel: 'sablon', fajta: 'sablon', cim: 'ikon', szoveg: 'x', bizonyitek: ['f1'], javasoltaAgentId: 'l', futasSessionId: 'run-1' })
  repo.markKodolva(rej.id)
  assert.equal(repo.javaslat(rej.id).status, 'nyitott', 'only an accepted proposal becomes kodolva')
  repo.decideJavaslat(rej.id, 'elutasitva', 'nem')
  assert.equal(repo.rejectedSince(new Date(Date.now() - 1000).toISOString()).length, 1)
  repo.markKodolva(id)
  assert.equal(repo.javaslat(id).status, 'kodolva')
  const t = repo.insertTanulsag({ javaslatId: id, cel: 'agent:gyarto', szoveg: 'A címlap egy mondat.' })
  assert.equal(repo.activeTanulsagok('agent:gyarto').length, 1); assert.equal(repo.countActiveTanulsagok('agent:gyarto'), 1)
  assert.equal(repo.tanulsagokAll().length, 1)
  repo.retireTanulsag(t.id)
  assert.equal(repo.activeTanulsagok('agent:gyarto').length, 0)
  assert.ok(repo.tanulsagokAll()[0].visszavonva_at)
})

test('rememberAgent records a role once and bizonyitekLetezik checks every evidence table', () => {
  const { repo } = freshRepo()
  repo.rememberAgent('a1', 'gyarto'); repo.rememberAgent('a1', 'lektor')
  assert.deepEqual([...repo.knownAgentIds()], ['a1'])
  const v = openVideo(repo)
  const f = repo.insertFordulo({ sessionId: 's', agentId: 'a1', forras: 'chat', uzenet: 'u', valasz: 'v', toolok: [] })
  assert.equal(repo.bizonyitekLetezik(v), true); assert.equal(repo.bizonyitekLetezik(f.id), true); assert.equal(repo.bizonyitekLetezik('nope'), false)
  const t = terv(repo, v)
  const vd = repo.insertVerdikt({ tervId: t.id, tervHash: t.tervHash, lektorAgentId: 'l', lektorSessionId: 's', verdikt: 'atmegy', talalatok: [] })
  repo.claimRender({ id: 'r1', videoId: v, tervId: t.id, tervHash: t.tervHash, verdiktId: vd.id, hostBootAt: 1, jelenetHatarok: [], propsPath: '/p', outPath: '/o', logPath: '/l', platform: 'darwin' })
  const qa = repo.insertQa({ renderId: 'r1', fileSha256: 's', szabalykeszlet: 1, ok: true, meresek: {}, bukasok: [] })
  const fb = repo.insertFeedback({ videoId: v, szoveg: 'x', forras: 'operator' })
  for (const id of [t.id, vd.id, 'r1', qa.id, fb.id]) assert.equal(repo.bizonyitekLetezik(id), true)
  assert.equal(repo.bizonyitekLetezik("' OR 1=1 --"), false, 'the id is bound, not spliced')
})

test('video status moves only through the vocabulary, and lezart only through lezarVideo', () => {
  const { repo } = freshRepo()
  const v = openVideo(repo)
  assert.equal(repo.video(v).status, 'nyitott')
  assert.throws(() => repo.setVideoStatus(v, 'done'), /VIDEO_STATUSOK/)
  assert.throws(() => repo.setVideoStatus(v, 'lezart'), /lezarVideo/)
  assert.equal(repo.video(v).status, 'nyitott')
  for (const s of VIDEO_STATUSOK.filter((x) => x !== 'lezart')) { repo.setVideoStatus(v, s); assert.equal(repo.video(v).status, s) }
  assert.equal(repo.video(v).lezarva_at, null)
  repo.lezarVideo(v)
  assert.equal(repo.video(v).status, 'lezart'); assert.ok(repo.video(v).lezarva_at)
  assert.equal(repo.videosByStatus('lezart').length, 1); assert.equal(repo.videos().length, 1)
  assert.equal(repo.video('nope'), null)
})

test('videoForSignal finds the video opened from a card and counts opened-since by the clock', () => {
  const { repo } = freshRepo()
  const { id } = repo.openVideo({ cim: 'c', forrasTipus: 'signal', forrasId: 'card-1', forrasSzoveg: 'x', nyitottaAgentId: 'g' })
  assert.equal(repo.videoForSignal('card-1').id, id)
  assert.equal(repo.videoForSignal('card-2'), null)
  assert.equal(repo.videosOpenedSince('2000-01-01T00:00:00.000Z'), 1)
  assert.equal(repo.videosOpenedSince('2999-01-01T00:00:00.000Z'), 0)
})

test('replaceNarraciok swaps the whole set and counts reflect the tables', () => {
  const { repo } = freshRepo()
  const v = openVideo(repo); const t = terv(repo, v)
  const row = (jelenet, extra = {}) => ({ tervHash: t.tervHash, jelenet, szovegHash: `h${jelenet}`, hang: 'alloy', modell: 'tts-1', nyelv: 'hu', fajl: `narracio/swarmclaw/${jelenet}.mp3`, hosszMs: 1000, ttsKeresId: 'q', ...extra })
  assert.equal(repo.replaceNarraciok(t.id, [row(0), row(1), row(2)]), 3)
  assert.equal(repo.replaceNarraciok(t.id, [row(1)]), 1)
  assert.deepEqual(repo.narraciok(t.id).map((n) => n.jelenet), [1])
  assert.equal(repo.narraciok(t.id)[0].nyelv, 'hu')
  assert.equal(repo.narraciokAll().length, 1)
  // A row missing any of the voice triple is a call-site bug, thrown before the DELETE so the old set stays.
  for (const mezo of ['hang', 'modell', 'nyelv']) {
    assert.throws(() => repo.replaceNarraciok(t.id, [row(0), row(2, { [mezo]: '' })]), new RegExp(`jelenet 2 row needs a non-empty ${mezo}`))
    assert.throws(() => repo.replaceNarraciok(t.id, [row(2, { [mezo]: undefined })]), /non-empty/)
  }
  assert.deepEqual(repo.narraciok(t.id).map((n) => n.jelenet), [1])
  assert.deepEqual(repo.counts(), { videos: 1, tervek: 1, renderek: 0, qaOk: 0, nyitottJavaslatok: 0, fordulok: 0 })
})

test('the key list in db.mjs names every primary key and every unique index the schema actually has', () => {
  // The header calls itself "the whole key set: every primary key, every
  // unique index, and every lookup that acts as one". That claim is what a
  // later reader trusts instead of reading the DDL, and on the other module
  // the entry that had gone stale was twice the one that mattered, so it is
  // pinned rather than believed: a key with no entry, or an entry whose
  // columns have drifted from the schema, fails here.
  const forras = fs.readFileSync(new URL('../src/db.mjs', import.meta.url), 'utf8')
  const kezdet = forras.indexOf('EVERY KEY IN THIS SCHEMA')
  const veg = forras.indexOf('export const MIGRATIONS')
  assert.ok(kezdet > 0 && veg > kezdet)
  const lista = forras.slice(kezdet, veg)
  const { storage } = freshRepo()
  const tablak = storage.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'ext_video_%' ORDER BY name").map((r) => r.name)
  assert.equal(tablak.length, 12)
  for (const tabla of tablak) {
    const pk = storage.all(`PRAGMA table_info(${tabla})`).filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name)
    assert.ok(pk.length > 0, `${tabla} has no primary key`)
    assert.ok(lista.includes(`${tabla} -- PRIMARY KEY (${pk.join(', ')})`), `${tabla}: PRIMARY KEY (${pk.join(', ')}) is missing from the key list`)
    for (const idx of storage.all(`PRAGMA index_list(${tabla})`).filter((i) => i.unique === 1)) {
      // A table-level UNIQUE gets an auto-index and is listed under its
      // table's name; a named index is listed under its own name. SQLite also
      // backs a non-integer PRIMARY KEY with an auto-index, and that one is
      // the primary key already checked above, not a second key.
      const oszlopok = storage.all(`PRAGMA index_info(${idx.name})`).map((c) => c.name)
      const autoindex = idx.name.startsWith('sqlite_autoindex_')
      if (autoindex && oszlopok.join(', ') === pk.join(', ')) continue
      const vart = autoindex ? `${tabla} -- UNIQUE (${oszlopok.join(', ')})` : idx.name
      assert.ok(lista.includes(vart), `${tabla}: ${vart} is missing from the key list`)
    }
  }
})
