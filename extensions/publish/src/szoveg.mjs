import { AG_ALLAPOTOK, KIADAS_ALLAPOTOK, PLATFORMOK } from './db.mjs'
import { kiadasAllapot } from './allapot.mjs'
import { esedekes, idopontNelkuliUtemezettek, idozonaOf, kovetkezoSzabadSav } from './utemezes.mjs'
import { videoLekerdez } from './video-szerzodes.mjs'

/**
 * The writer, the reviewer, and the sender: the three tools design spec 4's
 * process diagram needs an agent-facing surface for --
 * `qa_ok videó -> [publishDraft] -> vazlat -> [publishVerdict] -> lektoralt
 * -> (operator approves) -> jovahagyva -> (scheduled) -> utemezve ->
 * [publishDue] -> kesz | reszben | hiba` -- plus `publishOpen`, the entry
 * point the diagram's first arrow needs and no interface list names (see its
 * own docblock for why it belongs here anyway), and `publishQueue`, the
 * read both agents need to find their own work (modelled on
 * `extensions/video/src/terv.mjs`'s `videoQueue`).
 *
 * WHERE THE APPROVAL STEP IS, AND WHY NOT HERE. Design spec 8: "A vázlat
 * szövegei a bejegyzésre kattintva olvashatók és jóváhagyhatók" -- the
 * OPERATOR approves, by clicking, on the calendar page a later task builds.
 * `lektoralt -> jovahagyva` is therefore not an agent tool in this file; it
 * is `repo.kiadastJovahagy` (src/db.mjs), waiting for that page's rpc. What
 * DOES live here is `kiadastUtemezSavba`, the scheduling half of that same
 * click (`jovahagyva -> utemezve`, design spec 4's "a modul a következő
 * szabad sávba teszi") -- exported, not wired to a tool, for the same
 * reason and the same later caller. It is built now because the two
 * invariants task-4-brief.md names are properties of exactly this
 * computation, and this task is the one the brief holds responsible for
 * them (see its own docblock, and `src/db.mjs`'s "the write path" section).
 *
 * THE SELF-REVIEW GATE `extensions/video/src/terv.mjs` HAS, THIS FILE DOES
 * NOT. Video's `videoVerdict` refuses a plan's own author reviewing it,
 * keyed on `terv.szerzo_agent_id`. This module's schema
 * (`ext_publish_kiadasok`) carries no author column -- Task 1 through 3 never
 * added one, and a release has no version history to hang authorship off
 * (unlike a `terv`, a `kiadás`'s branches are upserted in place). Adding one
 * now would be a schema change with no test in this task's brief asking for
 * it, so it is left out and named here rather than silently absent: a
 * reviewer may currently judge its own draft. Worth a decision from whoever
 * picks up the calendar page (design spec 4 draws the writer and the
 * reviewer as separate roles, and the two managed agents below never share a
 * tool, but nothing today stops one operator-run session from acting as
 * both).
 *
 * WHERE A REJECTED VERDICT'S FINDINGS GO, AND WHY NOWHERE YET. `elbukik`
 * sends the release back to `vazlat` so the writer's queue picks it up
 * again, but the findings themselves are returned to the caller and nowhere
 * else -- there is no findings table in this schema, unlike video's
 * `verdiktek`. A writer agent in a LATER turn has no tool that reads what a
 * PAST verdict found. This is a real gap for a second task to close (a
 * `talalatok` table plus a `publishFixes`-shaped read, mirroring
 * `videoFixes`/`videoRevise`); flagged here rather than solved, because it
 * is a schema decision past what this task's tests ask for.
 */

// --- refusal discipline -----------------------------------------------
//
// A small local copy of `extensions/video/src/args.mjs`'s pattern rather
// than a shared import: this module has no `args.mjs` of its own in its
// file list, and the three tools below need only a slice of what that file
// offers. The vocabulary (named code, message never echoing a caller's
// value or stored text, `guard` turning a refusal into `{ error }`) is the
// same discipline `constraints.md` states for the whole module.

class SzovegError extends Error {
  constructor(code, message, extra = {}) {
    super(message || code)
    this.name = 'SzovegError'
    this.code = code
    this.extra = extra
  }
}

function refuse(code, message, extra = {}) {
  throw new SzovegError(code, message, extra)
}

/** Runs a tool body; a `SzovegError` becomes `{ error: { code, message, ...extra } }`, anything else propagates as the bug it is. */
async function guard(fn) {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof SzovegError) return { error: { code: err.code, message: err.message, ...err.extra } }
    throw err
  }
}

const absent = (raw) => raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')

function readString(what, raw, { required = false, max = 4000 } = {}) {
  if (raw === undefined || raw === null) {
    if (required) refuse('argumentum_hibas', `${what} kötelező`)
    return undefined
  }
  if (typeof raw !== 'string') refuse('argumentum_hibas', `${what}: szöveg kell`)
  if (required && raw.trim() === '') refuse('argumentum_hibas', `${what} nem lehet üres`)
  if (raw.length > max) refuse('argumentum_hibas', `${what}: legfeljebb ${max} karakter`)
  return raw
}

function readEnum(what, raw, allowed, { required = false, fallback, code = 'argumentum_hibas' } = {}) {
  if (absent(raw)) {
    if (required) refuse(code, `${what} kötelező: ${allowed.join(', ')}`)
    return fallback
  }
  if (typeof raw !== 'string' || !allowed.includes(raw)) refuse(code, `${what}: ${allowed.join(', ')} egyike kell`)
  return raw
}

function readArray(what, raw, { required = false, max = 1000 } = {}) {
  if (absent(raw)) {
    if (required) refuse('argumentum_hibas', `${what} kötelező`)
    return undefined
  }
  if (!Array.isArray(raw)) refuse('argumentum_hibas', `${what}: lista kell`)
  if (raw.length > max) refuse('argumentum_hibas', `${what}: legfeljebb ${max} elem`)
  return raw
}

/** The calling agent, from the session the host hands the tool; '' when there is none. Never from an argument -- same reasoning as `extensions/video/src/args.mjs`'s `agentIdOf`. */
function agentIdOf(ctx) {
  const id = ctx && ctx.session ? ctx.session.agentId : null
  return typeof id === 'string' && id !== '' ? id : ''
}

// --- the two closed vocabularies this module produces ------------------

/**
 * The reviewer's finding codes, THIS MODULE'S OWN closed list -- design
 * spec 4: "A lektornak saját, zárt kódlistája van ebben a modulban... a
 * videó modul LEKTOR_KODOK-ja annak a modulnak a belső ügye, és bővítmény
 * nem importál egy másikból." No import from `extensions/video`.
 *
 * `allitas_forras_nelkul` is the one word shared with video's own list --
 * spec 4 names it explicitly, and constraints.md's rule is why: "ahol a
 * jelentés ugyanaz, ott ugyanaz a szó áll... hogy az operátor ne tanuljon
 * két nevet egy tényre." Here the "forrás" is the video's narration/claims,
 * not raw source text, but the underlying fact is identical -- a claim in
 * the platform text with nothing behind it.
 *
 * The other three are design spec 4's remaining named categories, one code
 * each: "hiányzó vagy kitalált hashtag" splits into two facts
 * (`hashtag_hianyzik`, `hashtag_kitalalt` -- a missing hashtag and an
 * invented one are different repairs), and "a platform hosszkorlátját
 * túllépő szöveg" is `szoveg_tul_hosszu` -- the SAME word `publishDraft`
 * uses for its own hard refusal below, on purpose (constraints.md's rule
 * again): a reviewer can only ever observe this on a platform whose limit
 * was `null` in `PLATFORM_KORLATOK` at draft time and has since been
 * surveyed, since `publishDraft` refuses an over-limit text outright before
 * it is ever stored -- rare, but the same fact either way.
 */
export const LEKTOR_KODOK = Object.freeze(['allitas_forras_nelkul', 'hashtag_kitalalt', 'hashtag_hianyzik', 'szoveg_tul_hosszu'])

/** A finding code's shape, for the same reason `extensions/video/src/terv.mjs`'s `KOD_ALAK` exists: lower snake case, so an unrecognised code is still safe to name back in a warning. */
const KOD_ALAK = /^[a-z][a-z0-9_]{0,63}$/
const MAX_TALALAT_SZOVEG = 2000

/**
 * Per-platform length limits, ONE PLACE (design spec: "PLATFORM_KORLATOK egy
 * helyen álljon"). YouTube's are from the platform's own documented limits
 * (title, description) -- the same source design spec 6 cites for the
 * upload quota. The other three are `null`, ON PURPOSE, and stay `null`
 * until somebody has actually surveyed them: Meta's Graph API needs app
 * review before publishing works at all, and TikTok's Content Posting API
 * needs an audit (design spec 6) -- nobody has run either, so no number
 * exists to put here. A plausible-looking number would be indistinguishable
 * from a verified one at the call site and would silently truncate or
 * reject a real post months from now; `null` is the honest answer, and
 * `publishDraft` below refuses a platform whose limit is `null` BY NAME
 * rather than falling through to no check at all.
 */
export const PLATFORM_KORLATOK = Object.freeze({
  youtube: Object.freeze({ cim: 100, leiras: 5000 }),
  facebook: null,
  instagram: null,
  tiktok: null,
})

export const VERDIKTEK = Object.freeze(['atmegy', 'elbukik'])

/** A sanity bound on a text field BEFORE it is compared to a platform's real limit -- well above every real limit in `PLATFORM_KORLATOK`, so it never fires on an honest post and exists only so a caller cannot hand this module a multi-megabyte string to compare. */
const MAX_SZOVEG_MEZO = 20000

// --- the scheduling write path (see the file docblock's "WHERE THE
// APPROVAL STEP IS" note) -----------------------------------------------

/**
 * Assigns an already-approved (`jovahagyva`) release to its next free slot
 * occurrence, and writes it -- the `jovahagyva -> utemezve` arrow of design
 * spec 4, and the one place `kovetkezoSzabadSav` (src/utemezes.mjs) and the
 * repository's scheduling writes (src/db.mjs) meet. See `db.mjs`'s "the
 * write path" section docblock for why that pairing lives here and not
 * there.
 *
 * Both invariants task-4-brief.md names hold by construction here:
 * `foglaltak` is `repo.foglaltSavIdopontok()` -- the `idopont` column alone,
 * never `sav_id` or `felulirt_idopont` (invariant 2) -- and the result is
 * written through `repo.kiadastUtemez` in one atomic UPDATE that sets
 * `sav_id`, `idopont` and `allapot` together, so no caller of `esedekes`
 * can ever observe a release claiming `utemezve` with no `idopont`, or an
 * `idopont` that does not match the slot it was just given.
 *
 * Refuses named `nincs_szabad_sav` when the operator has declared no slots
 * at all -- the one case `kovetkezoSzabadSav` answers `null` for -- leaving
 * the release at `jovahagyva` rather than half-written.
 */
export function kiadastUtemezSavba(state, { kiadasId, most }) {
  const repo = state.repo
  const zona = idozonaOf(state.settings())
  const jelolt = kovetkezoSzabadSav(repo.savok(), repo.foglaltSavIdopontok(), most, zona)
  if (jelolt === null) {
    refuse('nincs_szabad_sav', 'nincs egyetlen publikálási sáv sem beállítva; a kiadás jóváhagyva marad, amíg nincs sáv')
  }
  return repo.kiadastUtemez({ kiadasId, savId: jelolt.savId, idopont: jelolt.idopont })
}

// --- the tools -----------------------------------------------------------

export function createSzovegTools(state) {
  const repo = () => state.repo

  return [
    /**
     * The entry point design spec 4's diagram needs and no interface list
     * names: a `qa_ok` video has to become a `kiadás` somehow before
     * `publishDraft` has a `kiadasId` to write to. Idempotent on the video:
     * a second call for the same `videoId` returns the release that already
     * exists rather than opening a duplicate (design spec 9 does not forbid
     * a second release on one video, but an agent calling this twice by
     * accident should not be the way to get one).
     */
    {
      name: 'publishOpen',
      description: 'Megnyit egy kiadást egy kész (qa_ok) videóból, a video.videos szerződésen át. Ha ehhez a videoId-hez már van kiadás, azt adja vissza új nyitás helyett.',
      parameters: { type: 'object', required: ['videoId'], properties: { videoId: { type: 'string' } } },
      execute(args) {
        return guard(async () => {
          const videoId = readString('videoId', args.videoId, { required: true, max: 64 })
          const letezo = repo().kiadasVideohoz(videoId)
          if (letezo) return { kiadasId: letezo.id, allapot: letezo.allapot, uj: false }
          const video = await videoLekerdez(state, videoId)
          if (!video) refuse('video_ismeretlen', 'nincs videó a megadott videoId-vel')
          if (video.status !== 'qa_ok') refuse('video_nem_qa_ok', 'csak a QA-t átment (qa_ok) videóból nyitható kiadás', { status: video.status })
          const k = repo().ujKiadas({ videoId })
          return { kiadasId: k.id, allapot: k.allapot, cim: video.cim, narracioSzoveg: video.narracio_szoveg, uj: true }
        })
      },
    },
    /** The work queue both agents read: which releases still need text (`vazlat`) or await approval (`lektoralt`), and which platforms already have a draft. Modelled on `videoQueue` (extensions/video/src/terv.mjs). */
    {
      name: 'publishQueue',
      description: 'A publikálási munkasor, csak olvasva: mely kiadások vazlat (szövegírásra/lektorálásra vár) vagy lektoralt (jóváhagyásra vár) állapotban, ágankénti platformmal és azzal, hogy van-e már megírt szöveg.',
      parameters: { type: 'object', properties: {} },
      execute() {
        return guard(() => ({
          kiadasok: repo().kiadasok()
            .filter((k) => k.allapot === KIADAS_ALLAPOTOK.VAZLAT || k.allapot === KIADAS_ALLAPOTOK.LEKTORALT)
            .map((k) => ({
              kiadasId: k.id,
              videoId: k.video_id,
              allapot: k.allapot,
              agak: repo().agak(k.id).map((a) => ({ platform: a.platform, vanSzoveg: a.szoveg !== null })),
            })),
        }))
      },
    },
    /**
     * Writes (or rewrites) a release's platform texts. Only on `vazlat` or
     * `lektoralt` -- design spec 9's "nincs újraírás publikálás után"
     * extends backward to "no rewrite once approved either": a release past
     * `jovahagyva` refuses by name. A platform whose `PLATFORM_KORLATOK` is
     * `null` refuses by name too, naming the platform -- see the constant's
     * own docblock for why a guessed number is worse than a named refusal.
     * The over-limit refusal (`szoveg_tul_hosszu`) never echoes the text
     * that was too long, only the platform and which field.
     */
    {
      name: 'publishDraft',
      description: 'Beírja vagy frissíti egy kiadás platformszövegeit (cím és leírás, platformonként). Csak vazlat vagy lektoralt állapotú kiadásra. Fel nem mért platformra (PLATFORM_KORLATOK szerint null) és a platform hosszkorlátját túllépő szövegre megnevezve, a platform nevével utasít el.',
      parameters: {
        type: 'object',
        required: ['kiadasId', 'szovegek'],
        properties: {
          kiadasId: { type: 'string' },
          szovegek: {
            type: 'array',
            items: {
              type: 'object',
              required: ['platform', 'cim', 'leiras'],
              properties: {
                platform: { type: 'string', enum: PLATFORMOK },
                cim: { type: 'string' },
                leiras: { type: 'string' },
              },
            },
          },
        },
      },
      execute(args) {
        return guard(() => {
          const kiadasId = readString('kiadasId', args.kiadasId, { required: true, max: 64 })
          const kiadas = repo().kiadas(kiadasId)
          if (!kiadas) refuse('kiadas_ismeretlen', 'nincs kiadás a megadott kiadasId-vel')
          if (kiadas.allapot !== KIADAS_ALLAPOTOK.VAZLAT && kiadas.allapot !== KIADAS_ALLAPOTOK.LEKTORALT) {
            refuse('kiadas_lezart_szovegre', 'ez a kiadás túl van a szövegírás fázisán -- jóváhagyva vagy azon túl a szöveg nem írható át', { allapot: kiadas.allapot })
          }
          const szovegek = readArray('szovegek', args.szovegek, { required: true, max: PLATFORMOK.length })
          const irando = szovegek.map((item, i) => {
            if (item === null || typeof item !== 'object' || Array.isArray(item)) refuse('argumentum_hibas', `szovegek[${i}]: objektum kell`)
            const platform = readEnum(`szovegek[${i}].platform`, item.platform, PLATFORMOK, { required: true, code: 'platform_ismeretlen' })
            const cim = readString(`szovegek[${i}].cim`, item.cim, { required: true, max: MAX_SZOVEG_MEZO })
            const leiras = readString(`szovegek[${i}].leiras`, item.leiras, { required: true, max: MAX_SZOVEG_MEZO })
            const korlat = PLATFORM_KORLATOK[platform]
            if (korlat === null) {
              refuse('platform_felmeretlen', `a(z) ${platform} platform hosszkorlátja még nincs felmérve -- ezen a platformon egyelőre nem publikálható szöveg`, { platform })
            }
            if (cim.length > korlat.cim) refuse('szoveg_tul_hosszu', `a cím túllépi a platform hosszkorlátját (legfeljebb ${korlat.cim} karakter)`, { platform, mezo: 'cim' })
            if (leiras.length > korlat.leiras) refuse('szoveg_tul_hosszu', `a leírás túllépi a platform hosszkorlátját (legfeljebb ${korlat.leiras} karakter)`, { platform, mezo: 'leiras' })
            return { platform, szoveg: JSON.stringify({ cim, leiras }) }
          })
          const platformok = irando.map((x) => x.platform)
          if (new Set(platformok).size !== platformok.length) refuse('platform_ismetlodik', 'egy platform legfeljebb egyszer szerepelhet egy híváson belül')
          for (const { platform, szoveg } of irando) repo().szovegetIr({ kiadasId, platform, szoveg })
          return { kiadasId, agak: repo().agak(kiadasId).map((a) => ({ platform: a.platform, allapot: a.allapot })) }
        })
      },
    },
    /**
     * The reviewer's ruling on a release's CURRENT texts as a whole -- there
     * is no per-draft version to target (see the file docblock's note on
     * why there is no self-review gate either). `atmegy` moves the release
     * to `lektoralt`; `elbukik` leaves it at `vazlat` for the writer to
     * redraft (design spec 4's "vissza"). An unrecognised finding code is a
     * warning, not a refusal -- `LEKTOR_KODOK` may grow, and refusing a
     * verdict for a word the tool has not learnt yet would stall the
     * release on a vocabulary mismatch, the same reasoning as
     * `extensions/video/src/terv.mjs`'s `videoVerdict`.
     */
    {
      name: 'publishVerdict',
      description: 'A lektor ítélete egy kiadás megírt szövegeiről: atmegy vagy elbukik, találatokkal ({ platform, kod, szoveg }). Csak megírt szövegű, vazlat állapotú kiadásra. Ismeretlen kod figyelmeztetés, nem visszautasítás.',
      parameters: {
        type: 'object',
        required: ['kiadasId', 'verdikt'],
        properties: {
          kiadasId: { type: 'string' },
          verdikt: { type: 'string', enum: VERDIKTEK },
          talalatok: { type: 'array', items: { type: 'object', properties: { platform: { type: 'string', enum: PLATFORMOK }, kod: { type: 'string' }, szoveg: { type: 'string' } } } },
        },
      },
      execute(args, ctx) {
        return guard(() => {
          const agentId = agentIdOf(ctx)
          if (agentId === '') refuse('agent_hianyzik', 'a session ügynök nélkül fut; a lektorálásra ügynök kell')
          const kiadasId = readString('kiadasId', args.kiadasId, { required: true, max: 64 })
          const kiadas = repo().kiadas(kiadasId)
          if (!kiadas) refuse('kiadas_ismeretlen', 'nincs kiadás a megadott kiadasId-vel')
          if (kiadas.allapot !== KIADAS_ALLAPOTOK.VAZLAT) refuse('kiadas_nincs_vazlatban', 'csak vazlat állapotú kiadás lektorálható', { allapot: kiadas.allapot })
          const agak = repo().agak(kiadasId)
          if (agak.length === 0 || agak.every((a) => a.szoveg === null)) refuse('szoveg_hianyzik', 'ehhez a kiadáshoz még nincs megírt szöveg')
          const verdikt = readEnum('verdikt', args.verdikt, VERDIKTEK, { required: true, code: 'verdikt_ismeretlen' })
          const raw = readArray('talalatok', args.talalatok, { max: 100 }) ?? []
          const figyelmeztetesek = []
          const talalatok = raw.map((t, i) => {
            const ok = t !== null && typeof t === 'object' && !Array.isArray(t)
              && PLATFORMOK.includes(t.platform)
              && typeof t.kod === 'string' && KOD_ALAK.test(t.kod)
              && typeof t.szoveg === 'string' && t.szoveg.length <= MAX_TALALAT_SZOVEG
            if (!ok) refuse('argumentum_hibas', `talalatok[${i}]: { platform: ${PLATFORMOK.join('|')}, kod: kisbetűs_kód, szoveg: legfeljebb ${MAX_TALALAT_SZOVEG} karakter } kell`)
            if (!LEKTOR_KODOK.includes(t.kod)) figyelmeztetesek.push(`kod_ismeretlen:${t.kod}`)
            return { platform: t.platform, kod: t.kod, szoveg: t.szoveg }
          })
          if (verdikt === 'elbukik' && talalatok.length === 0) refuse('talalat_hianyzik', 'egy elbukik verdikthez legalább egy találat kell, különben nem javítható')
          const uj = repo().kiadasAllapototIr(kiadasId, verdikt === VERDIKTEK[0] ? KIADAS_ALLAPOTOK.LEKTORALT : KIADAS_ALLAPOTOK.VAZLAT)
          return { kiadasId, allapot: uj.allapot, figyelmeztetesek, talalatok }
        })
      },
    },
    /**
     * "Tedd ki, aminek eljött az ideje" -- the tool the dispatch schedule
     * (`index.mjs`'s `SCHEDULES`, `KIKULDES_PROMPT`) calls. Three phases,
     * matching the prompt's own three-fact report:
     *
     *   1. Every `var` branch of every DUE release (`esedekes`,
     *      src/utemezes.mjs, filtered on the STORED `allapot` column -- see
     *      that file's own docblock for why never `kiadasAllapot`'s
     *      computed answer) is dispatched: no connected account is
     *      `nincs_fiok`, a connected account with no registered adapter (or
     *      an adapter that throws) is `hiba` with a named `hibaKod`, and a
     *      successful send is `kesz` with the adapter's `url`.
     *   2. Once every branch of a release has an answer, the release's own
     *      aggregate (`kiadasAllapot`, src/allapot.mjs) is computed and
     *      written back -- `kesz`, `reszben`, `hiba` or `nincs_hova`, never
     *      `utemezve` or `ismeretlen` (a bug, thrown loudly rather than
     *      written).
     *   3. `idopontNelkuliUtemezettek` (src/utemezes.mjs) -- the third fact,
     *      untouched by phases 1-2 -- is reported separately.
     *
     * SCHEDULING (`jovahagyva -> utemezve`) IS NOT PHASE 0 HERE: see the
     * file docblock's "WHERE THE APPROVAL STEP IS" note for why that stays
     * a separate, operator-triggered write (`kiadastUtemezSavba` above).
     *
     * `state.adapterek` is the platform-sender registry a later task
     * populates (design spec 6's four adapters; Task 5 registers `youtube`
     * in `index.mjs`). Absent or missing an entry is not a silent no-op: a
     * connected account with no adapter is a real `hiba`
     * (`hibaKod: 'adapter_nincs'`), reported the same way a network failure
     * would be -- the operator sees a named reason rather than a release
     * that never moves.
     */
    {
      name: 'publishDue',
      description: 'Kiteszi mindazt, aminek eljött az ideje: minden utemezve állapotú, esedékes kiadás minden var ágát megpróbálja kiküldeni a kapcsolt fiókok szerint, írja az ág és a kiadás végeredményét, és jelenti az időpont nélküli ütemezett kiadásokat is. Argumentum nélkül hívható.',
      parameters: { type: 'object', properties: {} },
      execute() {
        return guard(async () => {
          const most = new Date()
          const kiadasok = repo().kiadasok()
          const esedekesek = esedekes(kiadasok, most)
          const idopontNelkul = idopontNelkuliUtemezettek(kiadasok)
          const adapterek = state.adapterek && typeof state.adapterek === 'object' ? state.adapterek : {}
          const fiokByPlatform = new Map(repo().fiokok().map((f) => [f.platform, f]))
          const hibak = []
          let kikuldve = 0

          for (const kiadas of esedekesek) {
            for (const ag of repo().agak(kiadas.id)) {
              if (ag.allapot !== AG_ALLAPOTOK.VAR) continue
              const fiok = fiokByPlatform.get(ag.platform)
              if (!fiok) {
                repo().agEredmenyetIr({ agId: ag.id, allapot: AG_ALLAPOTOK.NINCS_FIOK })
                continue
              }
              const adapter = adapterek[ag.platform]
              if (typeof adapter !== 'function') {
                repo().agEredmenyetIr({ agId: ag.id, allapot: AG_ALLAPOTOK.HIBA, hibaKod: 'adapter_nincs' })
                hibak.push({ kiadasId: kiadas.id, platform: ag.platform, hibaKod: 'adapter_nincs' })
                continue
              }
              try {
                const eredmeny = await adapter({ ag, kiadas, fiok })
                const url = eredmeny && typeof eredmeny.url === 'string' ? eredmeny.url : null
                repo().agEredmenyetIr({ agId: ag.id, allapot: AG_ALLAPOTOK.KESZ, url })
              } catch (err) {
                const hibaKod = err && typeof err.code === 'string' && err.code !== '' ? err.code : 'kikuldes_hiba'
                repo().agEredmenyetIr({ agId: ag.id, allapot: AG_ALLAPOTOK.HIBA, hibaKod })
                hibak.push({ kiadasId: kiadas.id, platform: ag.platform, hibaKod })
              }
            }
            const vegso = kiadasAllapot(repo().agak(kiadas.id))
            if (![KIADAS_ALLAPOTOK.KESZ, KIADAS_ALLAPOTOK.RESZBEN, KIADAS_ALLAPOTOK.HIBA, KIADAS_ALLAPOTOK.NINCS_HOVA].includes(vegso)) {
              // A bug, not a caller mistake: every VAR branch of this release
              // was just resolved above, so kiadasAllapot has no relevans
              // branch left to answer `utemezve` for, and every branch it saw
              // is one this module itself just wrote -- `ismeretlen` would mean
              // agEredmenyetIr wrote a word AG_ALLAPOTOK does not have. Thrown,
              // not refused: an agent cannot fix this by calling differently.
              throw new Error(`publishDue: a(z) ${kiadas.id} kiadás ágai után kiadasAllapot ${vegso}-t adott, ami dispatch után nem várt válasz -- ez a modul hibája`)
            }
            repo().kiadasAllapototIr(kiadas.id, vegso)
            if (vegso === KIADAS_ALLAPOTOK.KESZ) kikuldve += 1
          }

          return {
            kikuldve,
            hibak,
            idopontNelkuliUtemezettek: idopontNelkul.map((k) => ({ kiadasId: k.id })),
          }
        })
      },
    },
  ]
}
