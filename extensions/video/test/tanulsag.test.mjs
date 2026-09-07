import assert from 'node:assert/strict'
import { test } from 'node:test'
import { JAVASLAT_FUTAS_SAPKA, JAVASLAT_NYITOTT_SAPKA, createTanulsagTools, verdiktekVsQa } from '../src/tanulsag.mjs'
import { PELDA_JELENETEK, PELDA_NARRACIO, fakeProject, freshRepo } from './helpers.mjs'

const quiet = { info() {}, warn() {}, error() {} }

function setup({ remotionDir = fakeProject() } = {}) {
  const { repo } = freshRepo()
  const state = { repo, log: quiet, settings: () => ({ remotionDir }), contracts: { get: () => null, why: () => 'provider_missing' } }
  const tools = Object.fromEntries(createTanulsagTools(state).map((t) => [t.name, t]))
  const run = (name, args, sessionId = 'run-1') => tools[name].execute(args, { session: { id: sessionId, agentId: 'lektor-1' }, message: '' })
  const { id: videoId } = repo.openVideo({ cim: 'c', forrasTipus: 'kezi', forrasId: '', forrasSzoveg: 'f', nyitottaAgentId: '' })
  const f1 = repo.insertFordulo({ sessionId: 's', agentId: 'g', forras: 'chat', uzenet: 'a szám rossz', valasz: 'javítom', toolok: [] })
  const f2 = repo.insertFordulo({ sessionId: 's', agentId: 'g', forras: 'schedule:x', uzenet: 'u', valasz: 'v', toolok: [{ nev: 'videoDraft', hiba: 'tipus_ismeretlen' }] })
  return { repo, run, videoId, f1: f1.id, f2: f2.id }
}

const propose = (run, extra = {}, sessionId) => run('videoPropose', { cel: 'agent:gyarto', fajta: 'tanulsag', cim: 'Rövidebb horog', szoveg: 'A címlap egy mondat.', ...extra }, sessionId)

test('videoReviewMaterial stamps the turns but does not review them; the latest read owns the stamp; videoReviewClose reviews and prunes', async () => {
  const { repo, run, f1, f2 } = setup()
  const m = await run('videoReviewMaterial', {})
  assert.deepEqual(m.fordulok.map((f) => f.id), [f1, f2]); assert.equal(m.forduloHatramaradt, 0)
  assert.deepEqual(m.fordulok[1].toolok, [{ nev: 'videoDraft', hiba: 'tipus_ismeretlen' }])
  assert.equal(m.fordulok[0].forras, 'chat'); assert.equal(m.fordulok[1].forras, 'schedule:x')
  assert.equal(typeof m.atnezesId, 'string'); assert.ok(m.sablonStat); assert.equal(m.sablonStatHiba, null); assert.deepEqual(m.nyitottJavaslatok, [])
  assert.deepEqual(m.sapkak, { nyitott: 0, nyitottSapka: JAVASLAT_NYITOTT_SAPKA, futasSapka: JAVASLAT_FUTAS_SAPKA })
  assert.equal(m.oraVissza, 26)
  const second = await run('videoReviewMaterial', {})
  assert.equal(second.fordulok.length, 2, 'stamped is not reviewed')
  assert.notEqual(second.atnezesId, m.atnezesId)
  assert.equal((await run('videoReviewClose', { atnezesId: m.atnezesId })).lezart, 0, 'a later read superseded the first stamp')
  assert.equal(repo.countUnreviewedFordulok(), 2, 'the superseded close reviewed nothing')
  const c = await run('videoReviewClose', { atnezesId: second.atnezesId })
  assert.equal(c.lezart, 2)
  const again = await run('videoReviewMaterial', {})
  assert.equal(again.fordulok.length, 0)
  assert.equal((await run('videoReviewClose', { atnezesId: second.atnezesId })).lezart, 0, 'a second close of the same run closes nothing')
  assert.equal((await run('videoReviewMaterial', { oraVissza: 0 })).error.code, 'ablak_ervenytelen')
  assert.equal((await run('videoReviewMaterial', { oraVissza: 800 })).error.code, 'ablak_ervenytelen')
  assert.equal((await run('videoReviewMaterial', { oraVissza: 'sok' })).error.code, 'ablak_ervenytelen')
  assert.equal((await run('videoReviewMaterial', { oraVissza: 48 })).oraVissza, 48)
  assert.equal((await run('videoReviewClose', { atnezesId: 'nope' })).lezart, 0)
  assert.equal((await run('videoReviewClose', {})).error.code, 'argumentum_hibas')
  assert.equal(repo.countUnreviewedFordulok(), 0)
})

test('videoReviewMaterial reports the turns left behind the limit and survives a missing Remotion project', async () => {
  const { repo, run } = setup({ remotionDir: '' })
  for (let i = 0; i < 205; i += 1) repo.insertFordulo({ sessionId: 's', agentId: 'g', forras: 'chat', uzenet: `m${i}`, valasz: '', toolok: [] })
  const m = await run('videoReviewMaterial', {})
  assert.equal(m.fordulok.length, 200); assert.equal(m.forduloLimit, 200); assert.equal(m.forduloHatramaradt, 7)
  assert.equal(m.sablonStat, null); assert.equal(m.sablonStatHiba, 'remotion_dir_hianyzik')
  assert.equal((await run('videoReviewClose', { atnezesId: m.atnezesId })).lezart, 200)
  assert.equal(repo.countUnreviewedFordulok(), 7)
})

test('verdiktekVsQa pairs a passing verdict with a failed QA on its render', async () => {
  const { repo, run, videoId } = setup()
  const terv = repo.insertTerv({ videoId, jelenetek: PELDA_JELENETEK, narracio: PELDA_NARRACIO, assetUjjlenyomatok: [], katalogusHash: 'k', szerzoAgentId: 'g', szerzoSessionId: 's', ellenorzes: {} })
  const v = repo.insertVerdikt({ tervId: terv.id, tervHash: terv.tervHash, lektorAgentId: 'l', lektorSessionId: 's', verdikt: 'atmegy', talalatok: [] })
  repo.claimRender({ id: 'r1', videoId, tervId: terv.id, tervHash: terv.tervHash, verdiktId: v.id, hostBootAt: 1, jelenetHatarok: [], propsPath: '/p', outPath: '/o', logPath: '/l', platform: 'darwin' })
  repo.finishRender('r1', { status: 'kesz', fileSha256: 'sha' })
  repo.insertQa({ renderId: 'r1', fileSha256: 'sha', szabalykeszlet: 1, ok: false, meresek: {}, bukasok: [{ kod: 'Q5', nev: 'audio_stream' }] })
  const m = await run('videoReviewMaterial', {})
  assert.equal(m.verdiktekVsQa.length, 1); assert.equal(m.verdiktekVsQa[0].verdiktId, v.id); assert.deepEqual(m.verdiktekVsQa[0].bukasok.map((b) => b.kod), ['Q5'])
  assert.equal(m.verdiktekVsQa[0].renderId, 'r1'); assert.equal(m.verdiktekVsQa[0].tervId, terv.id)
  assert.equal(verdiktekVsQa(repo, new Date(Date.now() + 60_000).toISOString()).length, 0, 'a verdict before the window is not paired')
  const failing = repo.insertVerdikt({ tervId: terv.id, tervHash: terv.tervHash, lektorAgentId: 'l', lektorSessionId: 's', verdikt: 'elbukik', talalatok: [] })
  repo.claimRender({ id: 'r2', videoId, tervId: terv.id, tervHash: terv.tervHash, verdiktId: failing.id, hostBootAt: 1, jelenetHatarok: [], propsPath: '/p', outPath: '/o', logPath: '/l', platform: 'darwin' })
  repo.finishRender('r2', { status: 'kesz', fileSha256: 'sha2' })
  repo.insertQa({ renderId: 'r2', fileSha256: 'sha2', szabalykeszlet: 1, ok: false, meresek: {}, bukasok: [{ kod: 'Q1', nev: 'x' }] })
  assert.equal(verdiktekVsQa(repo, new Date(0).toISOString()).length, 1, 'a failing verdict is not a miss')
})

/**
 * A REVISION'S FAILED RENDER IS NOT THE REVIEWER'S MISS.
 *
 * `verdiktekVsQa` joins renders to verdicts on the render row's `verdikt_id`,
 * and that id stopped meaning "the verdict on this render's plan" the moment
 * the verdict gate started letting a plan inherit its right from an ancestor
 * (`src/verdikt-kapu.mjs`): a revision's render row carries the PARENT's
 * verdict id, because that is the judgement the run rests on. Left alone, the
 * first QA failure on an operator's fix would be filed as a named reviewer's
 * miss, against a plan id they did judge, for a sentence they never saw -- a
 * false report about a person's work, fed into the one mechanism this module
 * learns from.
 */
test('egy javítás elbukott rendere nem a lektor hibája, mert az örökölt verdikt nem erről a tervről szól', async () => {
  const { repo, videoId } = setup()
  const szulo = repo.insertTerv({ videoId, jelenetek: PELDA_JELENETEK, narracio: PELDA_NARRACIO, assetUjjlenyomatok: [], katalogusHash: 'k', szerzoAgentId: 'g', szerzoSessionId: 's', ellenorzes: {} })
  const v = repo.insertVerdikt({ tervId: szulo.id, tervHash: szulo.tervHash, lektorAgentId: 'l', lektorSessionId: 's', verdikt: 'atmegy', talalatok: [] })
  // Az operátor egy mondatot kért másképp; a javításnak nincs és nem is lesz
  // saját verdiktje, tehát a render sorára a szülő ítéletének id-je kerül.
  const javitas = repo.insertTerv({
    videoId, jelenetek: PELDA_JELENETEK, narracio: PELDA_NARRACIO.map((n) => (n.jelenet === 1 ? { ...n, szoveg: 'Az operátor által kért mondat.' } : n)),
    assetUjjlenyomatok: [], katalogusHash: 'k', szerzoAgentId: 'g', szerzoSessionId: 's', ellenorzes: {},
    szarmazas: 'operator_javitas', javitasIdk: [], szuloTervId: szulo.id,
  })
  repo.claimRender({ id: 'r1', videoId, tervId: javitas.id, tervHash: javitas.tervHash, verdiktId: v.id, hostBootAt: 1, jelenetHatarok: [], propsPath: '/p', outPath: '/o', logPath: '/l', platform: 'darwin' })
  repo.finishRender('r1', { status: 'kesz', fileSha256: 'sha' })
  repo.insertQa({ renderId: 'r1', fileSha256: 'sha', szabalykeszlet: 1, ok: false, meresek: {}, bukasok: [{ kod: 'Q5', nev: 'audio_stream' }] })
  assert.deepEqual(verdiktekVsQa(repo, new Date(0).toISOString()), [], 'a lektor nem látta ezt a mondatot')

  // ...és ugyanannak a verdiktnek a SAJÁT terve továbbra is beleszámít: a
  // szűrés a terv-egyezésről szól, nem arról, hogy a videón volt javítás.
  repo.claimRender({ id: 'r2', videoId, tervId: szulo.id, tervHash: szulo.tervHash, verdiktId: v.id, hostBootAt: 1, jelenetHatarok: [], propsPath: '/p', outPath: '/o', logPath: '/l', platform: 'darwin' })
  repo.finishRender('r2', { status: 'kesz', fileSha256: 'sha2' })
  repo.insertQa({ renderId: 'r2', fileSha256: 'sha2', szabalykeszlet: 1, ok: false, meresek: {}, bukasok: [{ kod: 'Q1', nev: 'x' }] })
  const out = verdiktekVsQa(repo, new Date(0).toISOString())
  assert.deepEqual(out.map((x) => x.renderId), ['r2'])
  assert.equal(out[0].tervId, szulo.id)
})

test('videoPropose refuses by name: no evidence, unknown evidence, unknown target or kind, long lesson, duplicates by title and by text, the sixth per run, the 21st open', async () => {
  const { repo, run, f1, f2, videoId } = setup()
  assert.equal((await propose(run, { bizonyitek: [] })).error.code, 'bizonyitek_hianyzik')
  assert.equal((await propose(run, {})).error.code, 'argumentum_hibas')
  const unknown = await propose(run, { bizonyitek: ['nope'] })
  assert.equal(unknown.error.code, 'bizonyitek_ismeretlen'); assert.doesNotMatch(unknown.error.message, /nope/, 'the refusal does not echo the value')
  assert.equal((await propose(run, { bizonyitek: [f1], cel: 'agent:ceo' })).error.code, 'cel_ismeretlen')
  assert.equal((await propose(run, { bizonyitek: [f1], fajta: 'otlet' })).error.code, 'fajta_ismeretlen')
  assert.equal((await propose(run, { bizonyitek: [f1], szoveg: 'x'.repeat(401) })).error.code, 'szoveg_tul_hosszu')
  assert.equal(repo.countOpen(), 0, 'a refusal writes nothing')
  const ok = await propose(run, { bizonyitek: [f1, f2] })
  assert.equal(typeof ok.javaslatId, 'string')
  const row = repo.javaslat(ok.javaslatId)
  assert.equal(row.javasolta_agent_id, 'lektor-1'); assert.equal(row.futas_session_id, 'run-1'); assert.deepEqual(JSON.parse(row.bizonyitek), [f1, f2])
  const dupTitle = await propose(run, { szoveg: 'Teljesen más állítás.', bizonyitek: [videoId] })
  assert.equal(dupTitle.error.code, 'javaslat_duplikat'); assert.equal(dupTitle.error.javaslatId, ok.javaslatId)
  assert.match(dupTitle.error.message, /címmel/, 'the refusal says what matched, in the module\'s own words')
  const dupSzoveg = await propose(run, { cim: 'Egészen más cím', bizonyitek: [f1, videoId] })
  assert.equal(dupSzoveg.error.code, 'javaslat_duplikat'); assert.match(dupSzoveg.error.message, /szöveggel/)
  assert.equal(typeof (await propose(run, { cel: 'agent:lektor', bizonyitek: [f1, f2] })).javaslatId, 'string', 'the same claim for another target is a different proposal')
  repo.decideJavaslat(ok.javaslatId, 'elutasitva', 'nem')
  assert.equal((await propose(run, { bizonyitek: [f1, f2] })).error.code, 'javaslat_duplikat', 'a rejection within 30 days still blocks')
  const extra = Array.from({ length: JAVASLAT_FUTAS_SAPKA }, (_, i) => repo.insertFordulo({ sessionId: 's', agentId: 'g', forras: 'chat', uzenet: `e${i}`, valasz: '', toolok: [] }).id)
  const kulon = ['A horog rövid.', 'A zárlat állítás.', 'A zene halkabb.']
  for (let i = 0; i < JAVASLAT_FUTAS_SAPKA - 2; i += 1) assert.equal(typeof (await propose(run, { cim: `Cím ${i}`, szoveg: kulon[i], bizonyitek: [extra[i]] })).javaslatId, 'string')
  assert.equal((await propose(run, { cim: 'Hatodik', bizonyitek: [videoId] })).error.code, 'javaslat_sapka')
  let open = repo.countOpen()
  let n = 0
  while (open < JAVASLAT_NYITOTT_SAPKA) { repo.insertJavaslat({ cel: 'szabaly', fajta: 'szabaly', cim: `Sz ${n}`, szoveg: 'x', bizonyitek: [videoId], javasoltaAgentId: 'l', futasSessionId: `other-${n}` }); n += 1; open += 1 }
  assert.equal((await propose(run, { cim: 'Huszonegyedik', bizonyitek: [videoId] }, 'run-2')).error.code, 'javaslat_nyitott_sapka')
})

/**
 * The live run this rule was rewritten for: one plan failed with three
 * separate findings, each of which honestly rests on the same two rows. The
 * old evidence-overlap test refused the second and the third, and the
 * reviewer only got them through by citing an older plan instead -- weaker
 * evidence for a true claim.
 */
test('three different lessons out of one verdict, on the same two evidence rows, all go through', async () => {
  const { repo, run, f1, f2 } = setup()
  const talalatok = [
    { cim: 'Sablon rossz helyen', szoveg: 'A címlap-sablon nem mehet a videó közepére.' },
    { cim: 'Állítás forrás nélkül', szoveg: 'Számot csak a forrásával együtt mondj ki.' },
    { cim: 'Zárlat típusa hiányzik', szoveg: 'A lezáró jelenetnek külön neve legyen.' },
  ]
  for (const t of talalatok) assert.equal(typeof (await propose(run, { ...t, bizonyitek: [f1, f2] })).javaslatId, 'string', t.cim)
  assert.equal(repo.countOpen(), 3, 'one verdict grounds several findings; the same citation is not the same claim')
  // Same target, the same words, another kind: a measurable rule and a
  // sentence for a prompt are two different asks, so `fajta` guards the text
  // test and not the title test.
  assert.equal(typeof (await propose(run, { fajta: 'szabaly', cim: 'Sablonhely, mérhetően', szoveg: talalatok[0].szoveg, bizonyitek: [f1] })).javaslatId, 'string')
  assert.equal(repo.countOpen(), 4)
})

test('the same claim again is refused by name, and a rejected one says it was rejected rather than reading as open', async () => {
  const { repo, run, f1, f2 } = setup()
  const elso = await propose(run, { bizonyitek: [f1] })
  const szoSzerint = await propose(run, { bizonyitek: [f1] })
  assert.equal(szoSzerint.error.code, 'javaslat_duplikat'); assert.equal(szoSzerint.error.javaslatId, elso.javaslatId)
  assert.match(szoSzerint.error.message, /nyitott/); assert.doesNotMatch(szoSzerint.error.message, /elutasított/)
  // The words moved around: the same claim, which the old `===` on the title
  // let through.
  assert.equal((await propose(run, { cim: 'Horog, rövidebb', szoveg: 'Egy mondat a címlap.', bizonyitek: [f2] })).error.code, 'javaslat_duplikat')
  repo.decideJavaslat(elso.javaslatId, 'elutasitva', 'nem visszatérő')
  const ujra = await propose(run, { bizonyitek: [f1] })
  assert.equal(ujra.error.code, 'javaslat_duplikat'); assert.equal(ujra.error.javaslatId, elso.javaslatId)
  assert.match(ujra.error.message, /elutasított/); assert.doesNotMatch(ujra.error.message, /nyitott/)
  assert.doesNotMatch(ujra.error.message, /Rövidebb|horog/, 'the refusal does not quote stored text back')
  assert.equal(repo.countOpen(), 0, 'a refusal writes nothing')
})

test('videoPropose accepts a szabaly longer than the tanulsag limit and stores each evidence id once', async () => {
  const { repo, run, f1 } = setup()
  const r = await propose(run, { fajta: 'szabaly', cel: 'szabaly', cim: 'Mérhető', szoveg: 'y'.repeat(1000), bizonyitek: [f1, f1] })
  assert.equal(typeof r.javaslatId, 'string')
  assert.deepEqual(JSON.parse(repo.javaslat(r.javaslatId).bizonyitek), [f1])
})
