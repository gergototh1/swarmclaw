import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sha256 } from '../src/db.mjs'
import { idovonal } from '../src/idozites.mjs'
import { readCatalog } from '../src/katalogus.mjs'
import { NINCS_IDOKODOS_SZABALY, hetKulcs, hetiSor, karakterPerMp, sablonStat } from '../src/sablon.mjs'
import { PELDA_JELENETEK, PELDA_NARRACIO, fakeProject, freshRepo } from './helpers.mjs'

const terv = (repo, videoId, jelenetek, narracio = PELDA_NARRACIO) => repo.insertTerv({ videoId, jelenetek, narracio, assetUjjlenyomatok: [], katalogusHash: 'k', szerzoAgentId: 'gyarto', szerzoSessionId: 's', ellenorzes: {} })

/**
 * Two videos. A has a v1 (cimlap, szam, allitas) that was reviewed, rendered
 * and watched, and a v2 (cimlap, lista, allitas) that is its latest plan; B
 * has one plan. The render's scene bounds come from idovonal, so the
 * feedback and retention mapping below is against the numbers the render
 * would really carry.
 */
function seed() {
  const { repo } = freshRepo()
  const katalogus = readCatalog(fakeProject())
  const a = repo.openVideo({ cim: 'A', forrasTipus: 'kezi', forrasId: '', forrasSzoveg: '', nyitottaAgentId: 'x' }).id
  const b = repo.openVideo({ cim: 'B', forrasTipus: 'kezi', forrasId: '', forrasSzoveg: '', nyitottaAgentId: 'x' }).id
  const a1 = terv(repo, a, PELDA_JELENETEK)
  terv(repo, a, [{ tipus: 'cimlap', sorok: ['a'] }, { tipus: 'lista', felsorolas: ['x'] }, { tipus: 'allitas', mondat: 'z' }])
  terv(repo, b, PELDA_JELENETEK)
  repo.insertVerdikt({ tervId: a1.id, tervHash: a1.tervHash, lektorAgentId: 'lektor', lektorSessionId: 's', verdikt: 'elbukik', talalatok: [{ jelenet: 1, kod: 'sablon_rossz_helyen', szoveg: '' }] })
  const hatarok = idovonal([2000, 3000, 2500]).elemek
  const renderId = 'r1'
  repo.claimRender({ id: renderId, videoId: a, tervId: a1.id, tervHash: a1.tervHash, verdiktId: 'v', hostBootAt: 1, jelenetHatarok: hatarok, propsPath: 'p', outPath: 'o', logPath: 'l', platform: 'darwin' })
  repo.finishRender(renderId, { status: 'kesz', fileSha256: sha256('mp4') })
  return { repo, katalogus, a, b, a1, renderId, hatarok }
}

test('sablonStat counts usage from the latest plans only and reviewer findings through the plan they judged', () => {
  const { repo, katalogus } = seed()
  const stat = sablonStat(repo, katalogus)
  assert.equal(stat.cimlap.hasznalat, 2)
  assert.equal(stat.szam.hasznalat, 1)
  assert.equal(stat.lista.hasznalat, 1)
  assert.equal(stat.allitas.hasznalat, 2)
  assert.equal(stat.gorbe.hasznalat, 0)
  assert.deepEqual(stat.szam.lektoriTalalat, { sablon_rossz_helyen: 1 })
  assert.deepEqual(stat.lista.lektoriTalalat, {})
  assert.equal(stat.cimlap.qaBukas, NINCS_IDOKODOS_SZABALY)
  assert.equal(stat.szam.qaBukas, 'nincs_idokodos_szabaly')
  assert.equal(Object.keys(stat).length, katalogus.tipusok.length)
})

test('sablonStat maps feedback to a type by render bounds, by scene index on the render, or by scene index on the latest plan', () => {
  const { repo, katalogus, a, renderId } = seed()
  repo.insertFeedback({ videoId: a, renderId, atMs: 4000, szoveg: 'lassú', forras: 'youtube' })
  repo.insertFeedback({ videoId: a, renderId, jelenet: 0, szoveg: 'jó', forras: 'youtube' })
  repo.insertFeedback({ videoId: a, jelenet: 1, szoveg: 'a lista', forras: 'kezi' })
  repo.insertFeedback({ videoId: a, atMs: 100, szoveg: 'render nélkül, időkóddal', forras: 'kezi' })
  repo.insertFeedback({ videoId: a, atMs: 999_999, szoveg: 'a videó után', forras: 'kezi' })
  repo.insertFeedback({ videoId: a, szoveg: 'semmi', forras: 'kezi' })
  repo.insertFeedback({ videoId: a, jelenet: 9, szoveg: 'nincs ilyen jelenet', forras: 'kezi' })
  const stat = sablonStat(repo, katalogus)
  assert.equal(stat.szam.visszajelzes, 1, 'at_ms 4000 falls in scene 1 of the rendered v1, which is szam')
  assert.equal(stat.cimlap.visszajelzes, 2, 'scene 0 on the render and at_ms 100 through the latest finished render')
  assert.equal(stat.lista.visszajelzes, 1, 'scene 1 with no render is read against the latest plan, v2')
  assert.equal(stat.allitas.visszajelzes, 0)
})

test('sablonStat measures retention drop per type against the video average, and says meretlen elsewhere', () => {
  const { repo, katalogus, a, hatarok } = seed()
  assert.equal(hatarok[1].kezdetMs, 2600); assert.equal(hatarok[2].kezdetMs, 6200)
  const rows = [[0, 1], [1, 1], [2, 1], [3, 0.5], [4, 0.5], [5, 0.5], [7, 0.2], [8, 0.2], [9, 0.2]].map(([tS, arany]) => ({ videoId: a, platform: 'youtube', tS, arany }))
  repo.upsertRetention(rows)
  const stat = sablonStat(repo, katalogus)
  const atlag = (3 * 1 + 3 * 0.5 + 3 * 0.2) / 9
  assert.equal(stat.cimlap.megtartas, Number((1 - atlag).toFixed(3)))
  assert.equal(stat.szam.megtartas, Number((0.5 - atlag).toFixed(3)))
  assert.equal(stat.allitas.megtartas, Number((0.2 - atlag).toFixed(3)))
  assert.equal(stat.lista.megtartas, 'meretlen')
  // Retention on a video with no finished render measures nothing rather than something.
  const { repo: r2, katalogus: k2 } = seed()
  const b2 = r2.videos().find((v) => v.cim === 'B').id
  r2.upsertRetention([{ videoId: b2, platform: 'youtube', tS: 0, arany: 1 }])
  assert.equal(sablonStat(r2, k2).cimlap.megtartas, 'meretlen')
})

test('hetKulcs is the ISO week, and hetiSor counts renders, failed QA rows and findings per week', () => {
  assert.equal(hetKulcs('2026-09-05T07:15:00.000Z'), '2026-W36')
  assert.equal(hetKulcs('2026-01-01T00:00:00.000Z'), '2026-W01')
  assert.equal(hetKulcs('2025-12-29T00:00:00.000Z'), '2026-W01')
  assert.equal(hetKulcs('2024-12-30T12:00:00.000Z'), '2025-W01')
  assert.equal(hetKulcs('2021-01-03T12:00:00.000Z'), '2020-W53')
  const { repo, renderId } = seed()
  assert.deepEqual(hetiSor(freshRepo().repo), [])
  repo.insertQa({ renderId, fileSha256: sha256('mp4'), szabalykeszlet: 1, ok: false, meresek: {}, bukasok: ['Q1'] })
  repo.insertQa({ renderId, fileSha256: sha256('other'), szabalykeszlet: 1, ok: true, meresek: {}, bukasok: [] })
  const sor = hetiSor(repo)
  assert.equal(sor.length, 1)
  assert.deepEqual(sor[0], { het: hetKulcs(new Date().toISOString()), renderek: 1, qaBukas: 1, lektoriTalalat: { sablon_rossz_helyen: 1 } })
})

test('karakterPerMp is the estimate below ten narrated scenes and the measured ratio from ten', () => {
  const { repo } = freshRepo()
  const videoId = repo.openVideo({ cim: 'C', forrasTipus: 'kezi', forrasId: '', forrasSzoveg: '', nyitottaAgentId: 'x' }).id
  const jelenetek = Array.from({ length: 11 }, () => ({ tipus: 'szam', szam: 1 }))
  const narracio = jelenetek.map((_, i) => ({ jelenet: i, szoveg: 'x'.repeat(30) }))
  const t = terv(repo, videoId, jelenetek, narracio)
  const row = (jelenet, hosszMs = 2000) => ({ tervHash: t.tervHash, jelenet, szovegHash: sha256('x'.repeat(30)), hang: 'h', modell: 'm', fajl: 'f', hosszMs, ttsKeresId: '' })
  assert.equal(karakterPerMp(repo), 14)
  repo.replaceNarraciok(t.id, Array.from({ length: 9 }, (_, i) => row(i)))
  assert.equal(karakterPerMp(repo), 14)
  repo.replaceNarraciok(t.id, Array.from({ length: 10 }, (_, i) => row(i)))
  assert.equal(karakterPerMp(repo), 15)
  // A row with no measured length, and a row whose scene the plan does not narrate, count for nothing.
  repo.replaceNarraciok(t.id, [...Array.from({ length: 9 }, (_, i) => row(i)), row(9, 0), row(10, 1000)])
  assert.equal(karakterPerMp(repo), Number((300 / 19).toFixed(2)))
  repo.replaceNarraciok(t.id, [...Array.from({ length: 9 }, (_, i) => row(i)), row(9, 0), row(99, 1000)])
  assert.equal(karakterPerMp(repo), 14)
})
