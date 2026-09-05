import { ALAP_KARAKTER_PER_MP } from './idozites.mjs'

/**
 * Template effectiveness and the weekly row, computed from the stored rows
 * on every call (spec 6.3). Nothing here is cached and nothing here writes:
 * the numbers come from verdict, QA, feedback and retention rows that any
 * tool call may change, and a stat table would be the cache nobody
 * invalidates (spec 4.1).
 *
 * The rows read here carry text strangers wrote (scene lists, finding
 * texts, feedback). Only structure is read from them -- a scene's `tipus`,
 * a finding's `jelenet` and `kod`, a note's `jelenet` or `at_ms` -- and
 * each is used as a lookup key against the module's own vocabulary or as
 * a number; none is echoed.
 */

/** Rule set 1 has no time-coded rule (spec 5.3), so the QA column is this word, never a zero that would read as "did not fail". */
export const NINCS_IDOKODOS_SZABALY = 'nincs_idokodos_szabaly'
/** Narrated scenes needed before the measured chars/s replaces the estimate (spec 5.1 L7). */
export const MERES_MIN_JELENET = 10

const parse = (text) => JSON.parse(text)

/** Scene types per plan id, for every plan ever stored. */
function tervTipusMap(repo) {
  return new Map(repo.tervekAll().map((t) => [t.id, parse(t.jelenetek).map((j) => j.tipus)]))
}

/** The video's latest finished render, or undefined; rendersForVideo is newest first. */
const keszRender = (repo, videoId) => repo.rendersForVideo(videoId).find((r) => r.status === 'kesz')

/**
 * Per type: usage in the latest plans, reviewer findings by code, QA
 * failures by time code (rule set 1 has none, so the word), feedback mapped
 * to a scene, and retention drop within scene bounds against the video's
 * own average. Retention points from several platforms are averaged
 * together; a per-platform split is a later view, not a different number.
 * `megtartas` is the word `meretlen` for a type no finished render has
 * retention points on, never a zero.
 *
 * A note is mapped to a type through its render's scene bounds when it
 * carries `at_ms`, or through the scene index when it carries `jelenet`; a
 * note with neither, or one whose index is outside its plan, counts for no
 * type. A note with `at_ms` but no render is mapped through the video's
 * latest finished render, because a timestamp is a fact about a file and
 * that is the file the operator watched.
 */
export function sablonStat(repo, katalogus) {
  const stat = Object.fromEntries(katalogus.tipusok.map((t) => [t, { hasznalat: 0, lektoriTalalat: {}, qaBukas: NINCS_IDOKODOS_SZABALY, visszajelzes: 0, megtartas: 'meretlen' }]))
  const statOf = (tipus) => (typeof tipus === 'string' && Object.hasOwn(stat, tipus) ? stat[tipus] : null)
  const tipusok = tervTipusMap(repo)
  const tipusAt = (tervId, i) => (tipusok.get(tervId) || [])[i] ?? null
  for (const t of repo.latestTervek()) for (const tipus of tipusok.get(t.id) || []) { const s = statOf(tipus); if (s) s.hasznalat += 1 }
  for (const v of repo.verdiktekAll()) {
    for (const tal of parse(v.talalatok)) {
      const s = statOf(tipusAt(v.terv_id, tal.jelenet))
      if (s && typeof tal.kod === 'string') s.lektoriTalalat[tal.kod] = (s.lektoriTalalat[tal.kod] || 0) + 1
    }
  }
  const renderek = new Map(repo.rendersAll().map((r) => [r.id, r]))
  for (const f of repo.feedbackAll()) {
    let tipus = null
    const render = (f.render_id ? renderek.get(f.render_id) : undefined) || (Number.isInteger(f.at_ms) ? keszRender(repo, f.video_id) : undefined)
    if (render && Number.isInteger(f.jelenet)) tipus = tipusAt(render.terv_id, f.jelenet)
    else if (render && Number.isInteger(f.at_ms)) {
      const h = parse(render.jelenet_hatarok).find((x) => f.at_ms >= x.kezdetMs && f.at_ms < x.vegMs)
      tipus = h ? tipusAt(render.terv_id, h.jelenet) : null
    } else if (Number.isInteger(f.jelenet)) {
      const terv = repo.latestTerv(f.video_id)
      tipus = terv ? tipusAt(terv.id, f.jelenet) : null
    }
    const s = statOf(tipus)
    if (s) s.visszajelzes += 1
  }
  const eses = {}
  for (const videoId of repo.retentionVideoIds()) {
    const render = keszRender(repo, videoId)
    if (!render) continue
    const pontok = repo.retentionFor(videoId)
    if (pontok.length === 0) continue
    const atlag = pontok.reduce((s, p) => s + p.arany, 0) / pontok.length
    for (const h of parse(render.jelenet_hatarok)) {
      const benne = pontok.filter((p) => p.t_s * 1000 >= h.kezdetMs && p.t_s * 1000 < h.vegMs)
      const tipus = tipusAt(render.terv_id, h.jelenet)
      if (benne.length === 0 || !statOf(tipus)) continue
      const jelenetAtlag = benne.reduce((s, p) => s + p.arany, 0) / benne.length
      eses[tipus] = eses[tipus] || { sum: 0, n: 0 }
      eses[tipus].sum += jelenetAtlag - atlag
      eses[tipus].n += 1
    }
  }
  for (const [tipus, e] of Object.entries(eses)) stat[tipus].megtartas = Number((e.sum / e.n).toFixed(3))
  return stat
}

/**
 * ISO week key, e.g. 2026-W36, of an ISO timestamp, in UTC. The date is
 * moved to the Thursday of its week (ISO weeks belong to the year of their
 * Thursday), and the week number is the whole number of weeks from the
 * Monday of that year's first week, which is the week of 4 January.
 */
export function hetKulcs(iso) {
  const d = new Date(iso)
  const day = (d.getUTCDay() + 6) % 7
  d.setUTCDate(d.getUTCDate() - day + 3)
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4))
  const week = 1 + Math.round(((d - firstThursday) / 86_400_000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7)
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

/** Per ISO week: renders started, QA rows that failed, reviewer findings by code. Sorted by week, oldest first. */
export function hetiSor(repo) {
  const hetek = {}
  const het = (iso) => { const k = hetKulcs(iso); hetek[k] = hetek[k] || { het: k, renderek: 0, qaBukas: 0, lektoriTalalat: {} }; return hetek[k] }
  for (const r of repo.rendersAll()) het(r.started_at).renderek += 1
  for (const q of repo.qaAll()) if (q.ok === 0) het(q.checked_at).qaBukas += 1
  for (const v of repo.verdiktekAll()) {
    const h = het(v.created_at)
    for (const tal of parse(v.talalatok)) if (typeof tal.kod === 'string') h.lektoriTalalat[tal.kod] = (h.lektoriTalalat[tal.kod] || 0) + 1
  }
  return Object.values(hetek).sort((a, b) => (a.het < b.het ? -1 : 1))
}

/**
 * Measured characters per second from the stored narrations once there are
 * MERES_MIN_JELENET of them; the spec's estimate before that. A narration
 * row is counted only with the sentence its plan still carries for that
 * scene and a positive measured length, so a row whose sentence was reworded
 * after synthesis does not pair a new text with an old duration.
 */
export function karakterPerMp(repo) {
  let karakter = 0
  let hosszMs = 0
  let jelenetek = 0
  const tervek = new Map()
  for (const n of repo.narraciokAll()) {
    if (!tervek.has(n.terv_id)) {
      const t = repo.terv(n.terv_id)
      tervek.set(n.terv_id, t ? parse(t.narracio) : [])
    }
    const mondat = tervek.get(n.terv_id).find((x) => x.jelenet === n.jelenet)
    if (!mondat || typeof mondat.szoveg !== 'string' || !(n.hossz_ms > 0)) continue
    karakter += mondat.szoveg.length
    hosszMs += n.hossz_ms
    jelenetek += 1
  }
  if (jelenetek < MERES_MIN_JELENET || hosszMs === 0) return ALAP_KARAKTER_PER_MP
  return Number((karakter / (hosszMs / 1000)).toFixed(2))
}
