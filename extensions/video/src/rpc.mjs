import { VideoError } from './args.mjs'
import { VIDEO_STATUSOK } from './db.mjs'
import { allapot, futasNezet, indit, kep, megszakit, vanMinta } from './elonezet.mjs'
import { runHealth } from './health.mjs'
import { readCatalog, remotionDirOf } from './katalogus.mjs'
import { KULDHETO_TIPUSOK, NEM_KULDHETO_TIPUSOK, tablaHianyai } from './kit-tabla.mjs'
import { KODOLT_JAVASLAT_IDK, SZABALYKESZLET } from './qa.mjs'
import { hetiSor, sablonStat } from './sablon.mjs'
import { BACKLOG_SAPKA, DUPLIKAT_NAP, JAVASLAT_NYITOTT_SAPKA, TANULSAG_SAPKA } from './tanulsag.mjs'

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
        visszajelzesek: repo().feedbackFor(v.id).map((f) => ({ id: f.id, renderId: f.render_id, atMs: f.at_ms, jelenet: f.jelenet, szoveg: f.szoveg, forras: f.forras, at: f.created_at })),
        megtartas: repo().retentionFor(v.id).map((p) => ({ platform: p.platform, tS: p.t_s, arany: p.arany })),
      }
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
     * `mintaHianyzik` is answered here rather than inferred from a picture
     * that failed to appear: the two repositories move independently, so a
     * type the catalogue carries without a sample is an ordinary state the
     * card says out loud.
     */
    async templates() {
      const { katalogus, hiba } = catalogOrCode(state)
      if (!katalogus) {
        return {
          hiba, katalogusHash: null, sablonStat: null, hetiSor: hetiSor(repo()),
          tipusok: null, leirasok: null, propok: null, kozosPropok: null,
          kuldhetoTipusok: null, nemKuldhetoTipusok: null, mintaHianyzik: null, tablaHianyok: null,
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
        // `vanMinta` and not `Object.hasOwn`, so this list and the gallery's
        // own bookkeeping cannot disagree: an empty sample is no sample
        // (src/elonezet.mjs says why at length), and a card that said "has a
        // sample" beside a picture that will never be generated would be the
        // page contradicting itself.
        mintaHianyzik: katalogus.tipusok.filter((t) => !vanMinta(katalogus, t)),
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
        return { hiba, katalogusHash: null, katalogusTipusok: null, meglevo: null, hianyzo: null, mintaNelkul: null, fut: futasNezet() }
      }
      return { hiba: null, ...allapot(state) }
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
     * The page's Tisztítás: every row-bound file in both namespaces. Refused
     * while a render is running, because the files it is writing are named
     * by a `fut` row and deleting them would be the module sabotaging its
     * own child process. The refusal names the render so the page can offer
     * `cancelRender`.
     */
    async cleanup() {
      const futo = repo().runningRender()
      need(!futo, `fut egy render (${futo ? futo.id : ''}); előbb állítsd le (cancelRender)`)
      return ops.cleanupAll()
    },
  }
}
