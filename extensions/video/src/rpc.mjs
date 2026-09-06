import { VideoError, guard, readString, readWholeNumber } from './args.mjs'
import { VIDEO_STATUSOK, head } from './db.mjs'
import { allapot, futasNezet, indit, kep, megszakit, torolElonezetCache } from './elonezet.mjs'
import { runHealth } from './health.mjs'
import { readCatalog, remotionDirOf } from './katalogus.mjs'
import { KULDHETO_TIPUSOK, NEM_KULDHETO_TIPUSOK, tablaHianyai } from './kit-tabla.mjs'
import { narralTerv } from './narracio.mjs'
import { KODOLT_JAVASLAT_IDK, SZABALYKESZLET } from './qa.mjs'
import { hetiSor, sablonStat } from './sablon.mjs'
import { BACKLOG_SAPKA, DUPLIKAT_NAP, JAVASLAT_NYITOTT_SAPKA, TANULSAG_SAPKA } from './tanulsag.mjs'
import { MAX_CIM, MAX_FORRAS_SZOVEG, nyissVideot } from './terv.mjs'
import { YOUTUBE_OTLET_MAX, csatornakOf, fetchYoutube, ytDlpUtvonalOf } from './youtube.mjs'

/**
 * The methods this module's own page calls, over
 * `POST /api/extensions/video/call/<method>`, and nothing else.
 *
 * THIS IS NOT THE CONTRACT, AND CANNOT BECOME IT. `contract.mjs` declares
 * two reads over an explicit column allowlist and imports nothing from this
 * file; this file imports nothing from that one. Adding a method here, or a
 * field to what `board` or `video` returns, adds nothing to what a consumer
 * extension can read -- there is no shared builder for a field to arrive
 * through, and the contract's projection drops any key its list does not
 * name. That separation is the whole reason the two are different files with
 * different shapes rather than one map the contract re-exports a slice of.
 *
 * WHO CAN CALL THIS. The route is guarded by the app's access-key check, and
 * on the far side of it is a browser origin shared by every extension bundle
 * on the page: the `:id` in the URL says which extension to run, not who is
 * calling, and the route's own header says so. So nothing here may act on
 * "the video page asked", and nothing does.
 *
 * REFUSALS. A plain `Error`, which the route answers as a 500 carrying the
 * message, and which the page shows as text. The route also writes that
 * message to the host log with `log.warn`, which is why no message below
 * repeats a value the caller passed and none repeats stored text: the rule
 * args.mjs states for the tools holds here for the same reason. What a
 * message may name is this module's own vocabulary and ids this module
 * generated -- a running render's id, so the page can offer `cancelRender`.
 *
 * WHAT THIS FILE DOES TO THE STORED TEXT: NOTHING. Titles, source text,
 * narration sentences, findings, feedback and proposal text are handed on as
 * the repository read them, for the page to render as React text children.
 * The one place a stored string is read rather than carried is
 * `markKodolva`, which uses a proposal's first line as a lookup key against
 * the catalogue's own type list -- an array membership test, never a query,
 * a path, a log line or a branch on its content.
 */

const CELOK_TANULSAG = Object.freeze(['agent:gyarto', 'agent:lektor', 'skill:video-jelenetlista', 'skill:video-lektoralas'])
const DONTESEK = Object.freeze(['elfogad', 'elutasit'])
/** Turns shown in the status bar's "the module's own turns" line. Not a page of history; the review tools read the table properly. */
const UTOLSO_FORDULO_LIMIT = 20
/** Caps on what one import call will look at. A larger batch is refused by name, never truncated. */
const IMPORT_FEEDBACK_MAX = 5000
const IMPORT_RETENTION_MAX = 50_000
const SZOVEG_MAX = 4000
const MEGJEGYZES_MAX = 2000
/**
 * The window one press of the YouTube button looks back over when the page
 * names none.
 *
 * IT IS A REAL BOUND. Each channel's Atom feed dates every entry it carries,
 * and `fetchYoutube` filters on that date (src/youtube.mjs), so this number
 * decides what comes back. Two weeks because the feed only holds about
 * fifteen entries anyway: a wider window mostly reaches past the end of what
 * YouTube will hand over, and a narrower one would hide a channel that
 * publishes fortnightly.
 *
 * WHAT USED TO BE HERE AND WHY IT IS NOT. This said the window was measured
 * against yt-dlp's `upload_date`, "which the listing does not in practice
 * carry", and called itself the bound that would apply the day it did. That
 * was true of the first version, which listed with `--flat-playlist` and got
 * `NA` for every date; it stopped being true when the source moved to the
 * feed, and a comment asserting that this default is inert would send its
 * next reader looking for a filter that has been working all along.
 */
const YOUTUBE_NAPOK_ALAP = 14
const YOUTUBE_NAPOK_MAX = 365
const AT_MS_MAX = 24 * 3_600_000
const JELENET_MAX = 200

const isoDaysAgo = (d) => new Date(Date.now() - d * 86_400_000).toISOString()

/** The rpc side of the refusal discipline: a plain Error, which the host answers as 500 with the message. */
function need(cond, message) {
  if (!cond) throw new Error(message)
}

const isId = (v) => typeof v === 'string' && v !== '' && v.length <= 64

/**
 * A whole number in range, or null when the caller named none. Absent, null
 * and '' are no opinion; anything else present that cannot be honoured is
 * refused by name rather than coerced to a default. The message names the
 * field and the range, never the value.
 */
function optionalWhole(what, raw, { min, max }) {
  if (raw === undefined || raw === null || raw === '') return null
  const n = Number(raw)
  need((typeof raw === 'number' || typeof raw === 'string') && Number.isSafeInteger(n) && n >= min && n <= max, `${what}: egész szám kell ${min} és ${max} között`)
  return n
}

/**
 * A catalogue when the project is configured and readable, a refusal code
 * otherwise, never a throw: the page has to draw for an operator who has not
 * set `remotionDir` yet, and that operator's board is the thing that tells
 * them so. Anything that is not one of this module's own refusals is a bug
 * and propagates.
 */
function catalogOrCode(state) {
  try {
    return { katalogus: readCatalog(remotionDirOf(state)), hiba: null }
  } catch (err) {
    if (err instanceof VideoError) return { katalogus: null, hiba: err.code }
    throw err
  }
}

const javaslatView = (j) => ({
  id: j.id, cel: j.cel, fajta: j.fajta, cim: j.cim, szoveg: j.szoveg, bizonyitek: JSON.parse(j.bizonyitek),
  status: j.status, dontesMegjegyzes: j.dontes_megjegyzes, createdAt: j.created_at, decidedAt: j.decided_at,
})

/**
 * Marks accepted proposals that reality has caught up with: a `sablon` whose
 * named type is now in the catalogue, a `szabaly` the released rule set
 * cites (`KODOLT_JAVASLAT_IDK`). The reviewer's skill writes the proposed
 * type name as the first line of `szoveg`, which is why that line is read.
 *
 * THIS IS A WRITE INSIDE A READ, and the spec's 8.1 table calls `board` and
 * `proposals` non-writing. What it writes is one idempotent status
 * transition, `elfogadva` -> `kodolva`, on a proposal whose stated condition
 * has already come true; it changes no operator decision and creates no row.
 * It runs here because the backlog cap in `decideProposal` counts
 * `elfogadva` rows: without this, a template that is in the kit would keep
 * occupying a slot until somebody decided something else, and the page would
 * show a backlog the kit has already cleared.
 */
function markKodolva(repo, katalogus) {
  for (const j of repo.javaslatokByStatus('elfogadva')) {
    if (j.fajta === 'szabaly' && KODOLT_JAVASLAT_IDK.includes(j.id)) repo.markKodolva(j.id)
    if (j.fajta === 'sablon' && katalogus && katalogus.tipusok.includes(j.szoveg.split('\n')[0].trim())) repo.markKodolva(j.id)
  }
}

/** The 6.4 caps, counted now. The page shows "9/12"; `decideProposal` enforces the same three numbers. */
function sapkak(repo) {
  const tanulsag = Object.fromEntries(CELOK_TANULSAG.map((cel) => [cel, { db: repo.countActiveTanulsagok(cel), sapka: TANULSAG_SAPKA }]))
  return {
    nyitottJavaslat: { db: repo.countOpen(), sapka: JAVASLAT_NYITOTT_SAPKA },
    tanulsag,
    backlog: {
      szabaly: { db: repo.countByStatusFajta('elfogadva', 'szabaly'), sapka: BACKLOG_SAPKA },
      sablon: { db: repo.countByStatusFajta('elfogadva', 'sablon'), sapka: BACKLOG_SAPKA },
    },
  }
}

/**
 * The answer shape of the three mechanical levers, and the one place in this
 * file that does not refuse by throwing.
 *
 * EVERY OTHER METHOD HERE THROWS ITS REFUSALS and that is right for them:
 * they are reads and small writes the page only offers next to a row it has
 * already loaded, so a refusal there means the page asked for something that
 * is not on screen. `nyit`, `narral` and `renderel` are the opposite. They
 * are buttons an operator presses in exactly the states this module refuses
 * -- the day's cap is spent, the plan has no passing verdict, the tts has no
 * balance left, a render is already running -- and each of those refusals is
 * a sentence the operator has to read to know what to do next. A thrown one
 * reaches the browser as a 500 whose body the page shows as "500", and the
 * sentence is lost.
 *
 * So the refusal comes back as data: `{ hiba, uzenet }` plus whatever fields
 * the refusal itself carried (`sapka`, `maNyilt`, `ttsKod`, `renderId`), the
 * same fields the agent gets from the tool. `guard` decides what counts as a
 * refusal, so the tool and the page agree on that too -- a VideoError, and a
 * contract failure named after the extension that failed.
 *
 * WHAT IS LEFT IS A BUG IN THIS MODULE, and it is answered rather than
 * thrown, under a code of its own. `ismeretlen_hiba` is not one of this
 * module's refusals and must not be read as one; it means the lever broke.
 * The message is the throw's own -- the operator needs something to report,
 * and a bug's message carries this module's own text and paths, never a
 * stored source text -- and the host log still gets it, so the failure is not
 * quieter than it was.
 */
async function nemDob(state, fn) {
  try {
    const r = await guard(fn)
    if (r !== null && typeof r === 'object' && r.error) {
      const { code, message, ...extra } = r.error
      return { hiba: code, uzenet: message, ...extra }
    }
    return r
  } catch (err) {
    const uzenet = err instanceof Error ? err.message : String(err)
    state.log.error('video rpc lever threw', { error: uzenet })
    return { hiba: 'ismeretlen_hiba', uzenet }
  }
}

/**
 * A YouTube idea's stored source text: three paragraphs, and the url is the
 * last one.
 *
 * THE ORDER IS NOT COSMETIC. `forrasUrl` (ui/format.ts) is the one thing on
 * the page that may turn part of a stranger's text into a link target, and it
 * reads THE LAST PARAGRAPH and nothing else -- deliberately, because offering
 * a link out of the middle of prose would mean the page deciding where inside
 * a stranger's text a url starts. `videoOpen` has always put the card's url
 * last (`forrasSzovegOf`, src/terv.mjs, joins headline, summary, url), and
 * this door first did not: it wrote title, url, date, so `forrasUrl` read the
 * date paragraph, refused it, and the Video view printed "a forrás utolsó
 * bekezdése nem http(s) url" on a video whose entire point is "go and watch
 * this one". The url is last here for that reason and must stay last.
 *
 * THE MIDDLE PARAGRAPH IS DISPLAY MATERIAL and nothing else: no column, key
 * or gate reads it. The upload day rather than the instant, because "how old
 * is this" is the question the card answers and a timestamp to the second is
 * noise in a box the Video view labels as a stranger's text. The view count
 * stands beside it because it is the other half of the same question -- how
 * old, and how watched -- and it is what tells the operator whether an idea is
 * worth taking before they open anything.
 *
 * AN ABSENT VIEW COUNT SAYS SO IN WORDS. `nezettsegOf` answers null rather
 * than 0 for an entry that does not carry `<media:statistics>`
 * (src/youtube.mjs), because a video nobody has watched and a feed that did
 * not say are two different facts. Printing nothing would fold them into a
 * third -- "there is no such thing as a view count here" -- and printing `0`
 * would state the false one out loud, on a card the operator is deciding
 * against.
 */
function youtubeForrasSzoveg(j) {
  const nezettseg = typeof j.nezettseg === 'number' ? `${j.nezettseg} megtekintés` : 'a csatorna feedje nem közölt nézettséget'
  return `${j.cim}\n\nFeltöltve: ${j.feltoltve.slice(0, 10)} · ${nezettseg}\n\n${j.url}`
}

export function createRpc(state, ops) {
  const repo = () => state.repo
  const requireVideo = (id) => {
    need(isId(id), 'videoId: nem üres szöveg kell')
    const v = repo().video(id)
    need(v, 'nincs videó ezzel az id-vel')
    return v
  }
  const kartya = (v) => {
    const terv = repo().latestTerv(v.id)
    const verdikt = terv ? repo().verdiktek(terv.id).at(-1) || null : null
    const render = repo().rendersForVideo(v.id)[0] || null
    const qa = render && render.file_sha256 ? repo().qaFor(render.id, render.file_sha256, SZABALYKESZLET) : null
    return {
      id: v.id, cim: v.cim, status: v.status, forrasTipus: v.forras_tipus, forrasId: v.forras_id, createdAt: v.created_at,
      tervVerzio: terv ? terv.verzio : null, tervId: terv ? terv.id : null,
      utolsoVerdikt: verdikt ? { id: verdikt.id, verdikt: verdikt.verdikt, talalatok: JSON.parse(verdikt.talalatok).length, at: verdikt.created_at } : null,
      render: render ? ops.summary(render) : null,
      qa: qa ? { ok: qa.ok === 1, bukasok: JSON.parse(qa.bukasok).map((b) => b.kod) } : null,
    }
  }
  return {
    /**
     * The Sor view and the status bar in one load.
     *
     * `oszlopok` is keyed by every status in the module's vocabulary, empty
     * columns included, so the board draws the same shape on an empty
     * install. It is NOT assumed to be total over what is in the table.
     * Nothing enforces the vocabulary at the column: `ext_video_videos` has
     * no CHECK constraint on `status` (db.mjs), `setVideoStatus` is one
     * writer of several, and `openVideo` and `lezarVideo` write their status
     * as a literal in raw SQL without consulting `VIDEO_STATUSOK` at all. A
     * row with a status outside the list -- a literal that drifts, a
     * hand-edited row, a half-applied migration -- is therefore possible, and
     * an unknown key here used to throw. The throw is server-side, so the
     * whole page went with it: the status bar, the health lines, the tabs and
     * every view are behind this one response, and the operator got one line
     * saying a property of undefined could not be read.
     *
     * So an unknown status makes its own column and is named in `statusok`
     * after the known ones. The page already draws it that way: `statusLabel`
     * (ui/format.ts) answers `{ label: <raw>, known: false }` for anything
     * outside its map and `sor.tsx` renders it under `vid-badge-bad`, which
     * was unreachable while this method died first.
     *
     * `utolsoFordulok` is NOT the host's schedule history: "the last three
     * runs per schedule" lives in the host's own store, which extension code
     * cannot read. These are this module's `ext_video_fordulok` rows -- the
     * turns it recorded itself -- and the page says so in those words, "a
     * modul fordulói szerint", rather than presenting them as run history.
     */
    async board() {
      const { katalogus } = catalogOrCode(state)
      markKodolva(repo(), katalogus)
      // A null prototype, because the key comes from the table: on a plain
      // object `oszlopok['constructor']` is inherited and truthy, so `??=`
      // would not replace it and `.push` would be called on a function, and
      // `__proto__` would be an assignment to the prototype rather than a
      // column. With no prototype both are ordinary keys.
      const oszlopok = Object.create(null)
      for (const s of VIDEO_STATUSOK) oszlopok[s] = []
      for (const v of repo().videos()) (oszlopok[v.status] ??= []).push(kartya(v))
      // The vocabulary first, in its own order, then whatever else the table
      // held, so the board's usual shape is unchanged and a stray status is
      // drawn rather than dropped or fatal.
      const ismeretlen = Object.keys(oszlopok).filter((s) => !VIDEO_STATUSOK.includes(s))
      const futo = repo().runningRender()
      const fordulok = repo().latestFordulok(UTOLSO_FORDULO_LIMIT)
      return {
        oszlopok,
        statusok: [...VIDEO_STATUSOK, ...ismeretlen],
        futoRender: futo ? ops.summary(futo) : null,
        sapkak: sapkak(repo()),
        counts: repo().counts(),
        utolsoFordulok: fordulok.map((f) => ({ agentId: f.agent_id, forras: f.forras, at: f.at })),
        utolsoFordulokLimit: UTOLSO_FORDULO_LIMIT,
      }
    },
    /**
     * Everything the Video view draws for one video: the source text raw,
     * every plan version with its verdicts and narrations, every render with
     * its scene bounds and QA, the notes and the retention points.
     *
     * `forrasSzoveg` is here and is deliberately absent from the `videos`
     * contract: the page renders it as a text child inside a box the spec
     * labels "idegen szöveg", which is a guard a contract consumer would not
     * carry with it.
     */
    async video(body = {}) {
      const v = requireVideo(body.id)
      const tervek = repo().tervekForVideo(v.id).map((t) => ({
        id: t.id, verzio: t.verzio, jelenetek: JSON.parse(t.jelenetek), narracio: JSON.parse(t.narracio),
        assetUjjlenyomatok: JSON.parse(t.asset_ujjlenyomatok), tervHash: t.terv_hash, katalogusHash: t.katalogus_hash,
        szerzoAgentId: t.szerzo_agent_id, ellenorzes: JSON.parse(t.ellenorzes), createdAt: t.created_at,
        verdiktek: repo().verdiktek(t.id).map((vd) => ({ id: vd.id, verdikt: vd.verdikt, tervHash: vd.terv_hash, lektorAgentId: vd.lektor_agent_id, talalatok: JSON.parse(vd.talalatok), at: vd.created_at })),
        narraciok: repo().narraciok(t.id).map((n) => ({ jelenet: n.jelenet, fajl: n.fajl, hosszMs: n.hossz_ms, hang: n.hang, modell: n.modell, nyelv: n.nyelv, tervHash: n.terv_hash, szovegHash: n.szoveg_hash })),
      }))
      const renderek = repo().rendersForVideo(v.id).map((r) => ({ ...ops.summary(r), tervId: r.terv_id, jelenetHatarok: JSON.parse(r.jelenet_hatarok), propsPath: r.props_path, torolveAt: r.torolve_at }))
      return {
        id: v.id, cim: v.cim, status: v.status, forrasTipus: v.forras_tipus, forrasId: v.forras_id, forrasSzoveg: v.forras_szoveg,
        nyitottaAgentId: v.nyitotta_agent_id, createdAt: v.created_at, lezarvaAt: v.lezarva_at,
        tervek, renderek,
        // `kezelteRenderId` és `kezeltAt` NEM ugyanaz, mint a `renderId`: az
        // utóbbi az a render, amit az operátor NÉZETT, amikor a kérést írta,
        // az előbbi kettő pedig az a render, ami a kérést LEZÁRTA, és mikor.
        // A lap ezen a különbségen áll: a nyitott kérés az, amire még nem
        // született fájl, és a lezárt mellett a lezáró render a bizonyíték.
        visszajelzesek: repo().feedbackFor(v.id).map((f) => ({ id: f.id, renderId: f.render_id, atMs: f.at_ms, jelenet: f.jelenet, szoveg: f.szoveg, forras: f.forras, at: f.created_at, kezelteRenderId: f.kezelte_render_id, kezeltAt: f.kezelt_at })),
        megtartas: repo().retentionFor(v.id).map((p) => ({ platform: p.platform, tS: p.t_s, arany: p.arany })),
      }
    },
    /**
     * The Sor view's Uj video: one row from text the operator pasted.
     *
     * `videoOpen` by another door -- the same service function, the same
     * daily cap, the same refusals (src/terv.mjs, `nyissVideot`) -- and the
     * opener is '' rather than an agent id, because an operator is not an
     * agent and nothing gates on the opener (spec 3.3).
     *
     * The page's field is `forrasSzoveg`, which is what the `video` response
     * calls the same text; the service's argument is `szoveg`, which is what
     * the tool's schema calls it. One rename here rather than two vocabularies
     * on the page.
     */
    async nyit(body = {}) {
      return nemDob(state, () => nyissVideot(state, { forras: body.forras, szoveg: body.forrasSzoveg, cim: body.cim, signalId: body.signalId }, ''))
    },
    /**
     * The Sor view's "Ötletek a YouTube-ról": one row per fresh upload of the
     * channels the operator configured, minus the ones this module already
     * has a video for.
     *
     * A LEVER, so it goes through `nemDob` like the other three: every state
     * it refuses -- no channel configured, no binary at the configured path,
     * a channel that did not answer -- is a sentence the operator has to read
     * to know what to do next, and a thrown one reaches the browser as a 500
     * whose body the page shows as "500".
     *
     * IT DOES NOT GO THROUGH `nyissVideot` AND DOES NOT APPLY THE DAILY CAP,
     * and that is a decision rather than an oversight. `napiSapka` bounds what
     * the SCHEDULED producing agent opens BY ITSELF -- it is the answer to
     * "how much may this module do while nobody is watching" -- and its
     * default is 1. A press of this button is the operator deciding, in front
     * of the board, that they want today's ideas; a cap that stopped at the
     * second one would make the button useless for the thing it exists for.
     * So the bound here is the method's own (`YOUTUBE_OTLET_MAX`), it is per
     * press rather than per day, and the answer says how many candidates were
     * left over so a second press is an informed one.
     *
     * THE CONSEQUENCE, STATED. The rows this opens are ordinary videos and
     * `videosOpenedSince` counts them, so after a press the scheduled producer
     * will hit its own cap for the rest of the UTC day and open nothing. That
     * is the right outcome and not a bug to work around: the day's ideas have
     * already been delivered, by the operator, from a source the agent cannot
     * reach.
     *
     * WHAT IT WRITES. `openVideo` directly, with `forrasTipus: 'youtube'`,
     * `forrasId` the checked video id, and the three-paragraph source text
     * `youtubeForrasSzoveg` builds: the title, the upload day and the view
     * count, and last the url this module built from that id -- never a url
     * that came back over the network. The opener is '' rather than an agent
     * id, for the same reason `nyit`'s is: an operator is not an agent, and
     * nothing gates on the opener. `forras_tipus` has no CHECK constraint
     * (db.mjs), so the third value needed no migration; the tool's own source
     * list (`FORRASOK` in src/terv.mjs) is deliberately NOT widened, because
     * no agent may start this.
     *
     * BOTH STORED FIELDS ARE BOUNDED, because both are a stranger's text and
     * this is a door. The title arrives already cut to `MAX_CIM` -- the feed
     * reader cuts it where it reads it (src/youtube.mjs) -- and `head` here is
     * the door saying so rather than assuming it: the two other doors bound
     * what they store at the door (`nyissVideot`, src/terv.mjs), and a door
     * that trusted its supplier would be the one place the rule is a
     * convention instead of code. `MAX_FORRAS_SZOVEG` over the composed text
     * cannot fire while the title is capped -- a title, a date, a number and a
     * watch url are a few hundred characters -- and it is written because the
     * paragraphs are, and the invariant that keeps it inert belongs beside it.
     */
    async youtubeOtletek(body = {}) {
      return nemDob(state, async () => {
        const napok = readWholeNumber('napok', body.napok, { min: 1, max: YOUTUBE_NAPOK_MAX, fallback: YOUTUBE_NAPOK_ALAP })
        const csatornak = csatornakOf(state)
        const { jeloltek, csatornaHibak, eldobott } = await fetchYoutube({
          csatornak,
          napok,
          ytDlp: ytDlpUtvonalOf(state),
          execFileImpl: state.execFileImpl || undefined,
          fetchImpl: state.fetchImpl || undefined,
        })
        // One card per video id, whatever brought it: the same channel listed
        // twice in the setting is a typo, not two ideas.
        const latott = new Set()
        const ujak = []
        for (const j of jeloltek) {
          if (latott.has(j.id)) continue
          latott.add(j.id)
          if (repo().videoForYoutube(j.id) !== null) continue
          ujak.push(j)
        }
        const nyitando = ujak.slice(0, YOUTUBE_OTLET_MAX)
        const nyitott = nyitando.map((j) => {
          const { id } = repo().openVideo({ cim: head(j.cim, MAX_CIM), forrasTipus: 'youtube', forrasId: j.id, forrasSzoveg: head(youtubeForrasSzoveg(j), MAX_FORRAS_SZOVEG), nyitottaAgentId: '' })
          return { videoId: id, cim: j.cim }
        })
        return { nyitott, marVolt: latott.size - ujak.length, jelolt: latott.size, maradek: ujak.length - nyitott.length, csatornaHibak, eldobott }
      })
    },
    /**
     * The Terv section's Narracio kerese. `videoNarrate` by another door
     * (src/narracio.mjs, `narralTerv`): the tts contract per scene, ffprobe on
     * every file that comes back, the N-rules, and the set written whole or
     * not at all.
     *
     * Nothing about it needs an agent -- the sentences were written and passed
     * review before this button appeared -- so the page runs it directly
     * rather than paying for a chat turn to press it.
     */
    async narral(body = {}) {
      return nemDob(state, () => narralTerv(state, body.tervId))
    },
    /**
     * The Renderek section's Render inditasa. `videoRender` by another door:
     * the same `renderOps` instance the two render tools use (index.mjs), so
     * a start means one thing in this module.
     *
     * `tervId` is read here rather than inside `ops.start`, because the render
     * side takes an id it can look up and an empty string is not one; the tool
     * reads it the same way before calling the same method.
     */
    async renderel(body = {}) {
      return nemDob(state, () => ops.start(readString('tervId', body.tervId, { required: true, max: 64 })))
    },
    /**
     * One note from the operator. `atMs` and `jelenet` are optional and
     * independent -- the page prefills them from the clicked timeline point
     * -- and the row is deduplicated on (video, atMs, jelenet, szoveg), so a
     * double click adds nothing and `uj` says which happened.
     */
    async feedback(body = {}) {
      const v = requireVideo(body.videoId)
      const renderId = body.renderId === undefined || body.renderId === null || body.renderId === '' ? null : body.renderId
      if (renderId !== null) need(isId(renderId) && repo().render(renderId), 'renderId: létező render id-je kell')
      const atMs = optionalWhole('atMs', body.atMs, { min: 0, max: AT_MS_MAX })
      const jelenet = optionalWhole('jelenet', body.jelenet, { min: 0, max: JELENET_MAX })
      need(typeof body.szoveg === 'string' && body.szoveg.trim() !== '' && body.szoveg.length <= SZOVEG_MAX, `szoveg: nem üres, legfeljebb ${SZOVEG_MAX} karakteres szöveg kell`)
      return repo().insertFeedback({ videoId: v.id, renderId, atMs, jelenet, szoveg: body.szoveg, forras: 'operator' })
    },
    /** `lezart` is the end of the line, not a delete: the rows and the file stay. A video with a render in flight is refused, naming the render so the page can offer to stop it. */
    async lezar(body = {}) {
      const v = requireVideo(body.videoId)
      const futo = repo().runningRender()
      need(!futo || futo.video_id !== v.id, `fut egy render ehhez a videóhoz (${futo ? futo.id : ''}); előbb állítsd le`)
      repo().lezarVideo(v.id)
      return { id: v.id, status: 'lezart' }
    },
    /** The page's Stop. The same `renderOps` instance the two render tools use, so a cancel means one thing in this module (index.mjs). */
    async cancelRender(body = {}) {
      need(isId(body.renderId), 'renderId: nem üres szöveg kell')
      return ops.cancel(body.renderId)
    },
    /** The Javaslatok view: open proposals by kind, the backlog, the active lessons per target with their counters, and what was rejected inside the duplicate window. */
    async proposals() {
      const { katalogus, hiba } = catalogOrCode(state)
      markKodolva(repo(), katalogus)
      const tanulsagok = Object.fromEntries(CELOK_TANULSAG.map((cel) => [cel, {
        db: repo().countActiveTanulsagok(cel),
        sapka: TANULSAG_SAPKA,
        tetelek: repo().activeTanulsagok(cel).map((t) => ({ id: t.id, javaslatId: t.javaslat_id, szoveg: t.szoveg, createdAt: t.created_at })),
      }]))
      return {
        nyitott: repo().openJavaslatok().map(javaslatView),
        backlog: repo().javaslatokByStatus('elfogadva').map(javaslatView).filter((j) => j.fajta !== 'tanulsag'),
        tanulsagok,
        elutasitott: repo().rejectedSince(isoDaysAgo(DUPLIKAT_NAP)).map(javaslatView),
        kodolva: repo().javaslatokByStatus('kodolva').map(javaslatView),
        sapkak: sapkak(repo()),
        katalogusHiba: hiba,
      }
    },
    /**
     * The 6.4 table. The caps are checked before the decision is written, so
     * a refused acceptance leaves the proposal open: a 13th lesson for a
     * target, an 11th rule or template on the backlog. Rejection needs no
     * cap; its note is the next review's raw material, which is why an empty
     * one is refused.
     *
     * An accepted `tanulsag` writes two rows and they go in one transaction:
     * a decided proposal with no lesson behind it would be a cap slot spent
     * on nothing, and no operator action could get it back.
     */
    async decideProposal(body = {}) {
      need(isId(body.id), 'id: nem üres szöveg kell')
      need(DONTESEK.includes(body.dontes), `dontes: ${DONTESEK.join(' vagy ')} kell`)
      const megjegyzes = body.megjegyzes === undefined || body.megjegyzes === null ? '' : body.megjegyzes
      need(typeof megjegyzes === 'string' && megjegyzes.length <= MEGJEGYZES_MAX, `megjegyzes: legfeljebb ${MEGJEGYZES_MAX} karakteres szöveg kell`)
      const j = repo().javaslat(body.id)
      need(j, 'nincs javaslat ezzel az id-vel')
      need(j.status === 'nyitott', `a javaslat nem nyitott (${j.status})`)
      if (body.dontes === 'elutasit') {
        need(megjegyzes.trim() !== '', 'az elutasításhoz megjegyzés kell: ez a következő átnézés nyersanyaga')
        repo().decideJavaslat(j.id, 'elutasitva', megjegyzes)
        return { id: j.id, status: 'elutasitva' }
      }
      if (j.fajta === 'tanulsag') {
        need(repo().countActiveTanulsagok(j.cel) < TANULSAG_SAPKA, `tanulsag_sapka: ezen a célon már ${TANULSAG_SAPKA} aktív tanulság van; vonj vissza egyet, vagy építsd be a soulba/skillbe commitként`)
        return repo().storage.transaction(() => {
          repo().decideJavaslat(j.id, 'elfogadva', megjegyzes)
          const t = repo().insertTanulsag({ javaslatId: j.id, cel: j.cel, szoveg: j.szoveg })
          return { id: j.id, status: 'elfogadva', tanulsagId: t.id }
        })
      }
      need(repo().countByStatusFajta('elfogadva', j.fajta) < BACKLOG_SAPKA, `backlog_sapka: már ${BACKLOG_SAPKA} elfogadott, nem kódolt ${j.fajta} javaslat van; kódolj vagy vonj vissza egyet`)
      repo().decideJavaslat(j.id, 'elfogadva', megjegyzes)
      return { id: j.id, status: 'elfogadva', varakozik: j.fajta === 'szabaly' ? 'kodolasra' : 'a kitre' }
    },
    /**
     * Retires an active lesson. Idempotent by the repository's own WHERE, and
     * the answer is what holds afterwards either way: the row is inactive.
     * An id that names nothing is not a refusal here -- the page's button
     * exists only next to a lesson it just read.
     */
    async retireLesson(body = {}) {
      need(isId(body.id), 'id: nem üres szöveg kell')
      repo().retireTanulsag(body.id)
      return { id: body.id, aktiv: 0 }
    },
    /**
     * The Sablonok view: the numbers of spec 6.3, and the vocabulary those
     * numbers are about.
     *
     * Until now this answered only the statistics, which left the operator
     * knowing LESS about the templates than the agent does -- `videoCatalog`
     * hands the agent every type, its prose and its props. The gallery is
     * that same answer, drawn.
     *
     * `hetiSor` is computed either way -- renders, QA failures and findings
     * by week are stored rows and do not need the project -- while every
     * catalogue-derived field is `null` when the catalogue could not be
     * read, never an empty list. `sablonStat: {}` would read as "no type was
     * ever used" and `tipusok: []` as "this kit has no templates"; both are
     * false statements about the kit, where the refusal code beside them is
     * a true one about the connection.
     *
     * `tablaHianyok` IS DRAWN, and that is why it is still here. It names the
     * types and props the catalogue declares and `kit-tabla.mjs` does not,
     * which is the same `katalogus_valtozott` the agent gets on every plan
     * while the gap is open; the gallery prints it above the grid, because
     * the operator is the one who closes it and until now only the agent was
     * told. A field nothing draws is a field nobody notices going wrong --
     * this one carried the answer to a real skew for a whole feature without
     * ever reaching the page.
     *
     * WHAT USED TO BE HERE AND IS NOT: `mintaHianyzik`. It listed the types
     * the catalogue carries without a sample, and its docblock claimed the
     * card said so out loud. The card does say so -- from `nincs_minta` on
     * the per-card `templatePreview` round trip, and from
     * `templatePreviewStatus`'s `mintaNelkul`, which is the same list from
     * the module that actually decides it. Two transports for one fact, one
     * of them read by nobody and described by a docblock promising UI that
     * did not exist. The one the gallery draws is the one that stayed.
     */
    async templates() {
      const { katalogus, hiba } = catalogOrCode(state)
      if (!katalogus) {
        return {
          hiba, katalogusHash: null, sablonStat: null, hetiSor: hetiSor(repo()),
          tipusok: null, leirasok: null, propok: null, kozosPropok: null,
          kuldhetoTipusok: null, nemKuldhetoTipusok: null, tablaHianyok: null,
        }
      }
      return {
        hiba: null,
        katalogusHash: katalogus.katalogusHash,
        sablonStat: sablonStat(repo(), katalogus),
        hetiSor: hetiSor(repo()),
        tipusok: katalogus.tipusok,
        leirasok: katalogus.leirasok,
        propok: katalogus.propok,
        kozosPropok: katalogus.kozosPropok,
        kuldhetoTipusok: KULDHETO_TIPUSOK,
        nemKuldhetoTipusok: NEM_KULDHETO_TIPUSOK,
        tablaHianyok: tablaHianyai(katalogus),
      }
    },
    /**
     * The gallery's four controls, and what an unreadable project does to
     * them.
     *
     * ALL FOUR ANSWER, exactly the way `templates` does, and none of them
     * throws over a project the operator has not connected. An unreadable
     * project is an ordinary operator state -- the setting is empty on a
     * fresh install, and the other repository can be moved or half-written
     * at any moment -- and the view has to draw something either way. The
     * page already handles `templates`' `hiba` plus its null branch, so a
     * throw here would only mean the gallery had a second, harder shape to
     * handle for the same state: a poll that turns red over a page that is
     * otherwise fine.
     *
     * TWO FIELDS, NEVER ONE. `hiba` is "the other repository could not be
     * read", by the same code and the same field name `templates` uses;
     * `ok` is the method's own vocabulary -- `mar_fut`, `nincs_kep`,
     * `nincs_minta`, `tipus_ismeretlen`. Folding a project refusal into
     * `ok` would give a broken connection the same shape as a run that is
     * going fine, which is the one thing the page must not confuse.
     *
     * `templatePreviewCancel` carries no `hiba`: it reads nothing but this
     * module's own run state, so there is no project for it to fail on, and
     * a field that could never be anything but null would be a promise it
     * does not make.
     */
    async templatePreview(body = {}) {
      need(typeof body.tipus === 'string' && body.tipus.length <= 64, 'tipus: szöveg kell')
      const { hiba } = catalogOrCode(state)
      if (hiba) return { dataUrl: null, hiba }
      // The grid asks per card, as cards become visible, so nothing loads
      // twenty-four images to draw the six the operator can see.
      return { ...kep(state, body.tipus), hiba: null }
    },
    /**
     * Starts the generation of every missing picture and returns at once.
     *
     * Refuses a second run BY NAME and does not queue it: the answer carries
     * `ok: 'mar_fut'` rather than a 500, so the page can say "it is already
     * running" instead of showing an error over a run that is going fine.
     *
     * THE CATCH IS THAT ONE REFUSAL AND NOTHING ELSE. The project is read
     * here, deliberately, before the run is asked for; what `indit` can
     * still throw afterwards is not something this method has an answer
     * for, and `{ indult: false, ok }` over it would tell the page a run
     * did not start for a reason it can draw, when in truth nobody here
     * knows what happened.
     */
    async templatePreviewStart() {
      const { hiba } = catalogOrCode(state)
      if (hiba) return { indult: false, hiba }
      try {
        return { ...(await indit(state)), hiba: null }
      } catch (err) {
        if (err instanceof VideoError && err.code === 'mar_fut') return { indult: false, ok: err.code, hiba: null }
        throw err
      }
    },
    /**
     * Where a run is, or null. The page polls this while a run is on.
     *
     * Every catalogue-derived field is `null` beside the code when the
     * project cannot be read, never an empty list, for the reason
     * `templates` gives at length: `hianyzo: []` would draw as "the gallery
     * is complete". `fut` is answered either way, because the run lives in
     * this module and not in the project: a run started before the operator
     * changed the setting is still on, and that is the moment the cancel
     * button matters most.
     */
    async templatePreviewStatus() {
      const { hiba } = catalogOrCode(state)
      if (hiba) {
        return { hiba, katalogusHash: null, meglevo: null, hianyzo: null, mintaNelkul: null, fut: futasNezet() }
      }
      // Named one by one rather than spread, so what crosses to the page is a
      // decision and not whatever `allapot` happens to return. `allapot`'s
      // own `katalogusTipusok` is the catalogue's type order, which the page
      // already has from `templates` and never asked for twice; it stopped
      // here rather than becoming a second copy of the type list for the grid
      // to disagree with.
      const { katalogusHash, meglevo, hianyzo, mintaNelkul, fut } = allapot(state)
      return { hiba: null, katalogusHash, meglevo, hianyzo, mintaNelkul, fut }
    },
    /** Stops the run before the next type. What is already generated stays. */
    async templatePreviewCancel() {
      return megszakit()
    },
    /**
     * Notes exported from the operator's own analytics, as rows they mapped
     * to this module's video ids on the Video view.
     *
     * Every row is imported, skipped as a duplicate, or refused BY INDEX
     * with a reason: nothing is dropped silently, and one bad row does not
     * stop the ones after it. A refusal names the index and a code from this
     * module's own vocabulary, never the row's text.
     */
    async importFeedback(body = {}) {
      need(Array.isArray(body.sorok) && body.sorok.length <= IMPORT_FEEDBACK_MAX, `sorok: legfeljebb ${IMPORT_FEEDBACK_MAX} elemű lista kell`)
      const refused = []
      let imported = 0
      let skipped = 0
      for (let i = 0; i < body.sorok.length; i += 1) {
        const s = body.sorok[i]
        if (!s || typeof s !== 'object' || !isId(s.videoId) || !repo().video(s.videoId)) { refused.push({ index: i, ok: 'video_ismeretlen' }); continue }
        let atMs
        let jelenet
        try {
          atMs = optionalWhole('atMs', s.atMs, { min: 0, max: AT_MS_MAX })
          jelenet = optionalWhole('jelenet', s.jelenet, { min: 0, max: JELENET_MAX })
        } catch {
          refused.push({ index: i, ok: 'idopont_ervenytelen' })
          continue
        }
        if (typeof s.szoveg !== 'string' || s.szoveg.trim() === '' || s.szoveg.length > SZOVEG_MAX) { refused.push({ index: i, ok: 'szoveg_ervenytelen' }); continue }
        const r = repo().insertFeedback({ videoId: s.videoId, renderId: null, atMs, jelenet, szoveg: s.szoveg, forras: 'import' })
        if (r.uj) imported += 1
        else skipped += 1
      }
      return { imported, skipped, refused }
    },
    /**
     * Retention points, idempotent by the table's primary key: a re-import
     * of the same (video, platform, second) updates the ratio rather than
     * adding a second point. Rows are validated first and written in one
     * transaction, so a batch is all there or not there.
     */
    async importRetention(body = {}) {
      need(Array.isArray(body.sorok) && body.sorok.length <= IMPORT_RETENTION_MAX, `sorok: legfeljebb ${IMPORT_RETENTION_MAX} elemű lista kell`)
      const refused = []
      const rows = []
      for (let i = 0; i < body.sorok.length; i += 1) {
        const s = body.sorok[i]
        if (!s || typeof s !== 'object' || !isId(s.videoId) || !repo().video(s.videoId)) { refused.push({ index: i, ok: 'video_ismeretlen' }); continue }
        if (typeof s.platform !== 'string' || s.platform === '' || s.platform.length > 40) { refused.push({ index: i, ok: 'platform_ervenytelen' }); continue }
        if (!Number.isSafeInteger(s.tS) || s.tS < 0) { refused.push({ index: i, ok: 'tS_ervenytelen' }); continue }
        if (typeof s.arany !== 'number' || !(s.arany >= 0 && s.arany <= 1)) { refused.push({ index: i, ok: 'arany_ervenytelen' }); continue }
        rows.push({ videoId: s.videoId, platform: s.platform, tS: s.tS, arany: s.arany })
      }
      const imported = repo().upsertRetention(rows)
      return { imported, refused }
    },
    /** The status bar's facts (health.mjs). Reads only; never runs the render watchdog and never carries a setting the answer does not name. */
    async health() {
      return runHealth(state, ops)
    },
    /**
     * The page's Tisztítás: every row-bound file in both namespaces, AND the
     * template-preview cache. Refused while a render is running, because the
     * files it is writing are named by a `fut` row and deleting them would be
     * the module sabotaging its own child process. The refusal names the
     * render so the page can offer `cancelRender`.
     *
     * WHY THE CACHE IS SWEPT HERE AND NOT IN `cleanupAll`. `renderOps` deletes
     * what a ROW names -- that is the whole shape of it, and `orphanCount`
     * beside it counts what no row names precisely so the module can promise
     * never to delete those. The preview cache is neither: it is the module's
     * own, keyed by a catalogue hash, and no row will ever name it. So it
     * would survive an uninstall that had already dropped the tables, leaving
     * files nothing could be asked about. This method is the operator's one
     * "leave nothing of yours behind" lever, so it is the place the cache goes
     * -- and `elonezetek` is reported separately rather than folded into
     * `renderek`, because a hash directory is not a render.
     *
     * The cost is stated out loud: pressing Tisztítás throws away pictures
     * that took a minute of the operator's machine. That is the same bargain
     * the button already makes with finished renders, which cost far more, and
     * the cache regenerates from a button two views away.
     */
    async cleanup() {
      const futo = repo().runningRender()
      need(!futo, `fut egy render (${futo ? futo.id : ''}); előbb állítsd le (cancelRender)`)
      const remotionDir = remotionDirOf(state)
      return { ...ops.cleanupAll(), elonezetek: torolElonezetCache(remotionDir).torolt }
    },
  }
}
