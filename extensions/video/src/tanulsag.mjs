/**
 * The daily review (spec 6.4) and the turn recorder that feeds it (spec 6.5).
 *
 * Three tools and one hook. `videoReviewMaterial` reads the raw material for
 * one review run and stamps the turns it handed over; `videoReviewClose`
 * turns that stamp into a review and prunes the old turns; `videoPropose`
 * writes one proposal, and is the only tool in the daily run that writes a
 * row an operator will act on. `createAfterChatTurn` records a chat turn
 * into the turn table so the next review can read it.
 *
 * The reviewer proposes; it never rewrites. Nothing in this file touches an
 * agent's soul, a skill or a rule, and nothing here promotes a proposal: the
 * operator decides on the page, and the decision path lives in the page's
 * rpc, not here.
 */

import { VideoError, agentIdOf, guard, readArray, readEnum, readString, readWholeNumber, refuse, sessionIdOf } from './args.mjs'
import { JAVASLAT_CELOK, JAVASLAT_FAJTAK, uid } from './db.mjs'
import { readCatalog, remotionDirOf } from './katalogus.mjs'
import { SZABALYKESZLET } from './qa.mjs'
import { sablonStat } from './sablon.mjs'

/** The window the verdict-vs-QA pairs and the feedback are read from: a day plus the slack a daily schedule drifts by. */
export const DEFAULT_ORA_VISSZA = 26
export const MAX_ORA_VISSZA = 24 * 30
/** Turns handed to one review; the rest are reported as a count so a backlog cannot hide. */
export const FORDULO_LIMIT = 200
/** Turns older than this are deleted when a review closes (spec 6.5). */
export const FORDULO_MEGORZES_NAP = 60
/** A `tanulsag` is one sentence the target agent receives on every run; longer than this it is prose, and prose grows. */
export const JAVASLAT_SZOVEG_MAX = 400
/** Proposals one run may open: the operator's morning five minutes (spec 4.6). */
export const JAVASLAT_FUTAS_SAPKA = 5
/** Open proposals across all runs; above it the reviewer must wait for decisions. */
export const JAVASLAT_NYITOTT_SAPKA = 20
/** A rejected proposal blocks the same claim, for the same target, for this long. */
export const DUPLIKAT_NAP = 30
/**
 * How alike two proposals must READ before the second one is the first one
 * again: the share of words they have in common (twice the shared words over
 * the two word counts), where 1 is the same words and 0 is none of them.
 *
 * 0.8 is "the same sentence, reordered or a word apart", not "about the same
 * subject". On a two-word title one word in common scores 0.5 and passes; on
 * a four-word title three in common scores 0.75 and still passes. What does
 * not pass is a text whose words are the earlier one's words.
 */
export const DUPLIKAT_HASONLOSAG = 0.8
/**
 * The two backlog caps the page enforces when it accepts a proposal (spec
 * 6.4): active lessons per target, and accepted-but-uncoded `szabaly` and
 * `sablon` proposals, counted separately. Exported from here so the page
 * and the review share one number; nothing in this file enforces them,
 * because acceptance is not a reviewer's act.
 */
export const TANULSAG_SAPKA = 12
export const BACKLOG_SAPKA = 10

const isoHoursAgo = (h) => new Date(Date.now() - h * 3_600_000).toISOString()
const isoDaysAgo = (d) => new Date(Date.now() - d * 86_400_000).toISOString()

/**
 * A passing verdict whose render the QA failed: the reviewer's own miss, the
 * strongest signal in the set (spec 4.6). Only renders that finished with a
 * file are considered, because a QA row is keyed on the file's hash and a
 * render without one was never measured. The QA row is read under the
 * current rule set: a failure under an older set is a fact about that set,
 * not about the verdict.
 *
 * THE RENDER'S PLAN MUST BE THE VERDICT'S PLAN, AND THAT IS NO LONGER FREE.
 * The join reads the render row's `verdikt_id`, which used to be the verdict
 * on that render's own plan and nothing else. Since the verdict gate lets a
 * plan inherit its right to proceed from an ancestor (`verdikt-kapu.mjs`), an
 * operator's revision -- which has no verdict of its own by design -- renders
 * under the PARENT's verdict id, because that is the judgement the run rests
 * on. Counting that failure here would file it as a named reviewer's miss,
 * against the parent plan's id, for a sentence the reviewer never saw. It
 * feeds no gate, only the lessons loop, which makes it worse rather than
 * better: it would teach the review from a falsehood about a person's work.
 * So the pair is dropped, and what is dropped is exactly the pair -- the same
 * verdict's own plan still counts, and a revision's QA failure is not lost,
 * it stays on the render and QA rows the page and `videoRenderStatus` read.
 */
export function verdiktekVsQa(repo, sinceIso) {
  const renderek = repo.rendersAll()
  const out = []
  for (const v of repo.verdiktekSince(sinceIso)) {
    if (v.verdikt !== 'atmegy') continue
    for (const r of renderek) {
      if (r.verdikt_id !== v.id || r.terv_id !== v.terv_id || !r.file_sha256) continue
      const qa = repo.qaFor(r.id, r.file_sha256, SZABALYKESZLET)
      if (qa && qa.ok === 0) out.push({ verdiktId: v.id, tervId: v.terv_id, renderId: r.id, qaId: qa.id, bukasok: JSON.parse(qa.bukasok) })
    }
  }
  return out
}

/**
 * The words of a text, for comparing how two proposals read: lowercased,
 * accents dropped, and every character that is not a letter or a digit taken
 * as a separator. The accents go because a sentence retyped without them is
 * the same sentence, and Hungarian is a language where that happens; the
 * punctuation goes because a full stop is not a difference of claim.
 */
const szavak = (s) => new Set(s.toLowerCase().normalize('NFD').replace(/\p{M}+/gu, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter((w) => w !== ''))

/** Twice the words two texts share over the two word counts; 0 when either has no words. */
function hasonlosag(a, b) {
  const egyik = szavak(a)
  const masik = szavak(b)
  if (egyik.size === 0 || masik.size === 0) return 0
  let kozos = 0
  for (const szo of egyik) if (masik.has(szo)) kozos += 1
  return (2 * kozos) / (egyik.size + masik.size)
}

const javaslatView = (j) => ({ id: j.id, cel: j.cel, fajta: j.fajta, cim: j.cim, szoveg: j.szoveg, bizonyitek: JSON.parse(j.bizonyitek), status: j.status, dontesMegjegyzes: j.dontes_megjegyzes, createdAt: j.created_at, decidedAt: j.decided_at })

/**
 * The catalogue for the template stats, or null with the refusal code when
 * the project is not there. The review must not fail on it: the turns, the
 * verdicts and the proposals are readable without a Remotion project, and a
 * missing project is reported beside the stats as `sablonStatHiba` rather
 * than in place of everything else. Any other throw is a bug and propagates.
 */
function catalogOrNull(state) {
  try {
    return { katalogus: readCatalog(remotionDirOf(state)), hiba: null }
  } catch (err) {
    if (err instanceof VideoError) return { katalogus: null, hiba: err.code }
    throw err
  }
}

export function createTanulsagTools(state) {
  const repo = () => state.repo
  return [
    {
      name: 'videoReviewMaterial',
      description: 'A napi átnézés nyersanyaga egyben: az átnézetlen fordulók (bélyegezve, de nem átnézve; a videoReviewClose zárja), az atmegy verdiktek, amelyeket a QA elbuktatott, az ablak visszajelzései, a nyitott és a 30 napon belül elutasított javaslatok, a sablon-számok.',
      parameters: { type: 'object', properties: { oraVissza: { type: 'integer', description: 'alap 26' } } },
      /**
       * Reads, and stamps the turns it read with this call's `atnezesId`. A
       * stamp is not a review: the rows stay unreviewed until
       * `videoReviewClose` is called with the same id, so a run that dies
       * between the two hands them to the next run. The stamp is
       * overwritten by every read, so the latest reader owns the rows and
       * an earlier id closes nothing once a later read has happened; that
       * is what lets a dead run be superseded instead of holding its rows.
       *
       * `oraVissza` bounds the verdict pairs and the feedback only. The turns
       * are not windowed: an unreviewed turn is unreviewed however old it
       * is, up to `FORDULO_LIMIT` per read, and `forduloHatramaradt` says
       * how many were left behind.
       */
      execute(args) {
        return guard(() => {
          const oraVissza = readWholeNumber('oraVissza', args.oraVissza, { min: 1, max: MAX_ORA_VISSZA, fallback: DEFAULT_ORA_VISSZA, code: 'ablak_ervenytelen' })
          const since = isoHoursAgo(oraVissza)
          const atnezesId = uid()
          const fordulok = repo().unreviewedFordulok(FORDULO_LIMIT)
          repo().stampAtnezes(fordulok.map((f) => f.id), atnezesId)
          const { katalogus, hiba } = catalogOrNull(state)
          return {
            atnezesId,
            oraVissza,
            fordulok: fordulok.map((f) => ({ id: f.id, sessionId: f.session_id, agentId: f.agent_id, forras: f.forras, uzenet: f.uzenet, valasz: f.valasz, toolok: JSON.parse(f.toolok), at: f.at })),
            forduloLimit: FORDULO_LIMIT,
            forduloHatramaradt: repo().countUnreviewedFordulok() - fordulok.length,
            verdiktekVsQa: verdiktekVsQa(repo(), since),
            visszajelzesek: repo().feedbackSince(since).map((f) => ({ id: f.id, videoId: f.video_id, renderId: f.render_id, atMs: f.at_ms, jelenet: f.jelenet, szoveg: f.szoveg, forras: f.forras, at: f.created_at })),
            nyitottJavaslatok: repo().openJavaslatok().map(javaslatView),
            elutasitottJavaslatok: repo().rejectedSince(isoDaysAgo(DUPLIKAT_NAP)).map(javaslatView),
            sablonStat: katalogus ? sablonStat(repo(), katalogus) : null,
            sablonStatHiba: hiba,
            sapkak: { nyitott: repo().countOpen(), nyitottSapka: JAVASLAT_NYITOTT_SAPKA, futasSapka: JAVASLAT_FUTAS_SAPKA },
          }
        })
      },
    },
    {
      name: 'videoReviewClose',
      description: 'Lezárja egy videoReviewMaterial átnézését: a bélyegzett fordulók átnézetté válnak, a 60 napnál régebbiek törlődnek. Más sort nem ír.',
      parameters: { type: 'object', required: ['atnezesId'], properties: { atnezesId: { type: 'string' } } },
      /**
       * The bookkeeping half of the review. `lezart` is how many turns this
       * call closed: 0 for an id nobody stamped, for one already closed, and
       * for one a later read has superseded. The prune runs on every call
       * regardless, because it deletes by age alone and an id that closed
       * nothing is not a reason to keep 61-day-old turns.
       */
      execute(args) {
        return guard(() => {
          const atnezesId = readString('atnezesId', args.atnezesId, { required: true, max: 64 })
          const lezart = repo().closeAtnezes(atnezesId)
          repo().pruneFordulok(FORDULO_MEGORZES_NAP)
          return { lezart }
        })
      },
    },
    {
      name: 'videoPropose',
      description: 'Egy javaslat a javaslat-táblába (tanulsag: ≤ 400 karakter; szabaly: mérhető feltétel; sablon: hiányzó képesség, a szoveg első sora a javasolt típusnév), létező sorok id-jével bizonyítékként. Futásonként legfeljebb 5; 20 nyitott fölött nem nyit újat; ugyanarra a célra a gyakorlatilag azonos cím, vagy ugyanabban a fajtában a gyakorlatilag azonos szöveg 30 napig duplikát -- ugyanaz a bizonyíték több különböző javaslat alatt nem az.',
      parameters: { type: 'object', required: ['cel', 'fajta', 'cim', 'szoveg', 'bizonyitek'], properties: { cel: { type: 'string', enum: [...JAVASLAT_CELOK] }, fajta: { type: 'string', enum: [...JAVASLAT_FAJTAK] }, cim: { type: 'string' }, szoveg: { type: 'string' }, bizonyitek: { type: 'array', items: { type: 'string' } } } },
      /**
       * Every refusal is by name, in this order: the arguments themselves,
       * the evidence (present, and every id a row in a table a proposal may
       * cite), the per-run cap, the open cap, then the duplicate check. The
       * per-run count is keyed on the host's session id, which the agent
       * cannot choose; the run's own rejected proposals count toward it too,
       * because the cap is on what one run may ask, not on what it got.
       *
       * A duplicate is an open or 30-day-rejected proposal for the SAME
       * target that makes the same CLAIM: a title that reads the same, or --
       * in the same `fajta` -- a text that reads the same, "the same" being
       * `DUPLIKAT_HASONLOSAG` of the words in common. The refusal carries the
       * existing id, so the reviewer can read the earlier decision instead of
       * retrying.
       *
       * WHAT THIS RULE USED TO BE, AND WHY IT IS NOT THAT ANY MORE.
       *
       * Until the first live run of this module the test also refused a
       * proposal that shared at least half of its evidence with an earlier
       * one, for the same target, regardless of what the two proposals said.
       * That run is what showed the rule was wrong. The reviewer failed one
       * plan with three separate findings -- a template in the wrong place, a
       * claim with no source, and the same template fault in another scene --
       * and tried to turn each into its own lesson. All three cited the same
       * two rows, the plan and the verdict, because that is honestly where
       * all three findings live. The first proposal went in; the second and
       * the third were refused as duplicates on evidence that overlapped two
       * of two. The reviewer got the rest of its work through by citing an
       * older plan and an older verdict instead -- weaker evidence for the
       * same true claim. A guard that pushes an agent toward worse citations
       * is doing the opposite of its job, and in the ordinary case -- one
       * review, several findings -- it silences this module's own learning
       * loop entirely: before that run both `ext_video_javaslatok` and
       * `ext_video_tanulsagok` had never held a row.
       *
       * The mistake was treating "cites the same rows" as "says the same
       * thing". Evidence answers where the reviewer saw it; the title and the
       * text are what it is asking the operator to decide. One verdict can
       * ground any number of different claims, so an overlap between two
       * evidence lists carries no information at all about whether the two
       * claims are the same one twice. It is not kept as a weaker signal
       * either: a signal that means nothing on its own means nothing in
       * combination, and a second threshold nobody could tune would be a knob
       * with no run behind it.
       *
       * What the guard still has to do, it still does. A reviewer that
       * re-proposes its idea every morning writes the same title or the same
       * sentence, and is refused; a proposal the operator turned down cannot
       * come back inside `DUPLIKAT_NAP` under its own wording. The title test
       * is the old exact-title test widened, not replaced: an identical title
       * scores 1 and is still refused, and now so is the same title with a
       * word moved or a comma dropped, which the old `===` let through.
       *
       * The title test ignores `fajta` and the text test does not, because a
       * title is the claim's name: two proposals for one target under one
       * name are one claim however they were filed. A body of text only means
       * the same thing when it is the same kind of thing -- a `szabaly` and a
       * `tanulsag` worded alike are a measurable condition and a sentence for
       * an agent's prompt, and the operator has to decide those separately.
       */
      execute(args, ctx) {
        return guard(() => {
          const cel = readEnum('cel', args.cel, JAVASLAT_CELOK, { required: true, code: 'cel_ismeretlen' })
          const fajta = readEnum('fajta', args.fajta, JAVASLAT_FAJTAK, { required: true, code: 'fajta_ismeretlen' })
          const cim = readString('cim', args.cim, { required: true, max: 120 })
          const szoveg = readString('szoveg', args.szoveg, { required: true, max: 4000 })
          if (fajta === 'tanulsag' && szoveg.length > JAVASLAT_SZOVEG_MAX) refuse('szoveg_tul_hosszu', `tanulsag: legfeljebb ${JAVASLAT_SZOVEG_MAX} karakter, ez ${szoveg.length}`)
          const bizonyitek = readArray('bizonyitek', args.bizonyitek, { required: true, max: 50 })
          if (bizonyitek.length === 0) refuse('bizonyitek_hianyzik', 'legalább egy létező sor id-je kell; bizonyíték nélkül a javaslat vélemény')
          for (const id of bizonyitek) if (typeof id !== 'string' || !repo().bizonyitekLetezik(id)) refuse('bizonyitek_ismeretlen', 'a bizonyíték egyik id-je nem létező sor')
          const sessionId = sessionIdOf(ctx)
          if (repo().countInSession(sessionId) >= JAVASLAT_FUTAS_SAPKA) refuse('javaslat_sapka', `ebben a futásban már ${JAVASLAT_FUTAS_SAPKA} javaslat született`)
          if (repo().countOpen() >= JAVASLAT_NYITOTT_SAPKA) refuse('javaslat_nyitott_sapka', `${JAVASLAT_NYITOTT_SAPKA} nyitott javaslat vár döntésre; előbb dönteni kell`)
          const uj = new Set(bizonyitek)
          const jeloltek = [...repo().openJavaslatok(), ...repo().rejectedSince(isoDaysAgo(DUPLIKAT_NAP))].filter((j) => j.cel === cel)
          for (const j of jeloltek) {
            const cimAzonos = hasonlosag(j.cim, cim) >= DUPLIKAT_HASONLOSAG
            const szovegAzonos = j.fajta === fajta && hasonlosag(j.szoveg, szoveg) >= DUPLIKAT_HASONLOSAG
            if (cimAzonos || szovegAzonos) {
              refuse('javaslat_duplikat', `${j.status === 'nyitott' ? 'nyitott' : 'elutasított'} javaslat ugyanerre a célra, ${cimAzonos ? 'gyakorlatilag ugyanazzal a címmel' : 'ugyanabban a fajtában gyakorlatilag ugyanazzal a szöveggel'}: ${j.id}`, { javaslatId: j.id })
            }
          }
          const { id } = repo().insertJavaslat({ cel, fajta, cim, szoveg, bizonyitek: [...uj], javasoltaAgentId: agentIdOf(ctx), futasSessionId: sessionId })
          return { javaslatId: id }
        })
      },
    },
  ]
}

/**
 * The refusal code a tool answered with, read from its JSON output; 'hiba'
 * for a host-marked error whose output carried no code; null otherwise. Only
 * the code is kept, never the message: the output is a tool's answer to an
 * agent, and the review reads tool names and codes, not prose.
 */
function toolHiba(event) {
  if (typeof event.output === 'string' && event.output.startsWith('{')) {
    try {
      const parsed = JSON.parse(event.output)
      if (parsed && parsed.error && typeof parsed.error.code === 'string') return parsed.error.code
    } catch {
      // Not JSON: nothing to read.
    }
  }
  return event.error === true ? 'hiba' : null
}

/**
 * Records one chat turn for the daily review (spec 6.5). Never throws: a
 * hook failure counts toward the host's three-strike disable, and a turn not
 * written is cheaper than a disabled module. Which turns it writes is the
 * operator's `forduloRogzites` setting, not a side effect of the run's
 * extension list: `sajat` keeps the module's own agents -- the ids that have
 * drafted or judged through it, as `ext_video_ugynokok` remembers them --
 * and `mind` keeps every agent this hook fires for. A turn with no agent on
 * its session is never recorded in either mode.
 *
 * The `String(...)` wrapping below is not argument coercion: the host
 * documents these fields as strings, and the wrap is the guard that keeps a
 * hook that must not throw from throwing on a field the host left out.
 * `insertFordulo` cuts the message and the response to `FORDULO_MAX`.
 */
export function createAfterChatTurn(state) {
  return async function afterChatTurn(ctx) {
    try {
      const repo = state.repo
      if (!repo) return
      const agentId = ctx && ctx.session ? ctx.session.agentId : null
      if (typeof agentId !== 'string' || agentId === '') return
      const mode = (state.settings() || {}).forduloRogzites === 'mind' ? 'mind' : 'sajat'
      if (mode === 'sajat' && !repo.knownAgentIds().has(agentId)) return
      const toolok = (Array.isArray(ctx.toolEvents) ? ctx.toolEvents : []).map((e) => ({ nev: String(e.name), hiba: toolHiba(e) }))
      repo.insertFordulo({ sessionId: String(ctx.session.id || ''), agentId, forras: String(ctx.source || ''), uzenet: String(ctx.message || ''), valasz: String(ctx.response || ''), toolok })
    } catch (err) {
      state.log.warn('video: afterChatTurn nem tudott fordulót rögzíteni', { message: err instanceof Error ? err.message : String(err) })
    }
  }
}
