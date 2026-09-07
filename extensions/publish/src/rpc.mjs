import { KIADAS_ALLAPOTOK, PLATFORMOK } from './db.mjs'
import { PublishError, videoLekerdez } from './video-szerzodes.mjs'
import { SzovegError, kiadastUtemezSavba, olvasSzoveg, olvasTalalatok } from './szoveg.mjs'
import { idozonaOf } from './utemezes.mjs'

/**
 * The calendar page's own rpc surface -- everything `ui/naptar.tsx`,
 * `ui/kiadas.tsx` and `ui/fiokok.tsx` call that is not one of `src/szoveg.mjs`'s
 * five agent tools (those already reach the page over the MCP bridge's
 * reflection, `index.mjs`'s `rpc: { ...createRpc(state), ...createMcpBridge(...) }`,
 * but an operator's own browser tab calls this file's methods directly at
 * `POST /api/extensions/publish.mjs/call/<method>`, never through MCP).
 *
 * TWO THINGS THIS TASK HAS TO GIVE THE PAGE THAT NO EARLIER TASK BUILT A PATH
 * FOR (task-6-brief.md's own two closing sections):
 *
 *   1. `jovahagy` -- the operator's approval click design spec 8 describes
 *      ("A vázlat szövegei a bejegyzésre kattintva olvashatók és
 *      jóváhagyhatók") and design spec 4's diagram draws as
 *      `lektoralt -> jovahagyva -> (a modul a következő szabad sávba teszi)
 *      -> utemezve`. Task 4 built both halves as plain functions
 *      (`repo.kiadastJovahagy`, `kiadastUtemezSavba`) and named this file as
 *      the only thing standing between them and a release that can ever
 *      reach `utemezve` -- without it the 15-minute dispatch schedule wakes
 *      forever and finds nothing due, which is exactly the dead loop the
 *      brief's "AMIT A 6. FELADATNAK LE KELL ZÁRNIA" section describes.
 *   2. `savotFelvesz`, `savotTorol`, `alapSavokatFelvesz` -- THE ENTRANCE TO
 *      THE SLOT TABLE. Added in this task's fix round, and the reason the
 *      approval above was still a dead end without it: `repo.ujSav`
 *      (src/db.mjs) had no caller in production code at all -- no rpc, no
 *      tool, no settings field, no control anywhere created a publishing
 *      slot. So `repo.savok()` was empty on every real install,
 *      `kovetkezoSzabadSav` (src/utemezes.mjs) answered `null`,
 *      `kiadastUtemezSavba` refused every approval with `nincs_szabad_sav`,
 *      and the 15-minute dispatch schedule woke forever with nothing due.
 *      Moving the approval wall one square is not the same as removing it;
 *      these three methods are the doorway, and `ui/naptar.tsx` puts the
 *      controls for them in the seven day columns that used to say "Nincs sáv
 *      ezen a napon" with no button under it.
 *   3. `fiokotOsszekot` -- the write half of connecting a platform account.
 *      `repo.fiokotIr` (src/db.mjs) has existed since Task 1 and nothing in
 *      production code has ever called it; every branch resolves to
 *      `nincs_fiok` on a real install until this method exists. The Google
 *      OAuth half (`/api/oauth/google/start?purpose=publish`) is a SEPARATE
 *      fact this file does not own -- see `ui/fiokok.tsx`'s own docblock,
 *      modelled on `extensions/gmail/ui/status-bar.tsx`, for why a page link
 *      and a database row are two different things a YouTube connection
 *      needs, not one.
 *
 * READS THROW; LEVERS RESOLVE. `naptar`, `kiadas` and `fiokok` are read-only
 * loads the page makes before it can draw anything, so a refusal there is a
 * genuine failure the host's own `rpcFailure` (500, the thrown message as
 * text) is the right shape for -- same discipline `extensions/crm/src/rpc.mjs`
 * and `extensions/video/src/rpc.mjs`'s reads use. `jovahagy`, `atutemez`,
 * `fiokotOsszekot`, `savotFelvesz`, `savotTorol` and `alapSavokatFelvesz` are
 * buttons the operator presses in states this module deliberately refuses (a
 * release not yet lektorált, no configured slot, a malformed platform id, an
 * hour outside 0-23, a starter set on a calendar that already has slots), and
 * refusing THOSE is not a bug -- it is the
 * button's whole job on a bad day. Each therefore never rejects: it resolves
 * with `{ hiba, uzenet, ...}` on a named refusal and with its own success
 * fields otherwise, the exact `nemDob` shape `extensions/video/src/rpc.mjs`
 * documents at length, reused here under the name `lever` because a thrown
 * refusal reaches the browser as a bare 500 whose sentence the page never
 * gets to read.
 */

/** A local named refusal, thrown inside `lever` and turned into `{ hiba, uzenet, ...extra }` -- never thrown across an rpc boundary the host would turn into an unnamed 500. */
class RpcError extends Error {
  constructor(code, message, extra = {}) {
    super(message || code)
    this.name = 'RpcError'
    this.code = code
    this.extra = extra
  }
}

function refuse(code, message, extra = {}) {
  throw new RpcError(code, message, extra)
}

/**
 * Runs a lever's body; a named refusal (this file's own `RpcError`, or
 * `src/szoveg.mjs`'s `SzovegError` -- `kiadastUtemezSavba`'s `nincs_szabad_sav`
 * is the one refusal this file did not itself write) resolves as
 * `{ hiba, uzenet, ...extra }` rather than throwing. Anything else is a bug in
 * this module and is answered the same way rather than left to reach the
 * browser as an opaque 500 -- `extensions/video/src/rpc.mjs`'s `nemDob` gives
 * the full reasoning this copies.
 */
async function lever(state, fn) {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof RpcError) return { hiba: err.code, uzenet: err.message, ...err.extra }
    if (err instanceof SzovegError) return { hiba: err.code, uzenet: err.message, ...err.extra }
    if (err instanceof PublishError) return { hiba: err.code, uzenet: err.message }
    const uzenet = err instanceof Error ? err.message : String(err)
    if (state.log && typeof state.log.error === 'function') state.log.error('publish rpc lever threw', { error: uzenet })
    return { hiba: 'ismeretlen_hiba', uzenet }
  }
}

const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== ''

function requireString(what, raw, { max = 4000 } = {}) {
  if (!isNonEmptyString(raw)) refuse('argumentum_hibas', `${what} kötelező, nem lehet üres`)
  if (raw.length > max) refuse('argumentum_hibas', `${what}: legfeljebb ${max} karakter`)
  return raw
}

function requireEnum(what, raw, allowed) {
  if (typeof raw !== 'string' || !allowed.includes(raw)) refuse('argumentum_hibas', `${what}: ${allowed.join(', ')} egyike kell`)
  return raw
}

/** A whole number inside a closed range, refused by NAME and by the module's own bounds -- never echoing what the caller sent, same discipline as `repo.ujSav`'s own refusals (src/db.mjs). */
function requireInt(what, raw, min, max) {
  if (!Number.isInteger(raw) || raw < min || raw > max) refuse('argumentum_hibas', `${what}: ${min} és ${max} közötti egész szám kell`)
  return raw
}

const savSor = (s) => ({ id: s.id, nap: s.nap, ora: s.ora, perc: s.perc })

/**
 * The slot set a zero-slot install can take in ONE click, and then edit.
 *
 * CLAUDE.md's UX rule ("okos alapértékek -- sose hagyj üresen") against the
 * one screen in this module that cannot have a `defaultValue`: a slot is a
 * ROW, not a settings field, and there is nowhere for the host to put a
 * default for it. A fresh install therefore opens on seven empty days and an
 * operator who has to guess that "Monday 18:00" is even a thing this module
 * wants. This constant is that guess made for them, offered as a button and
 * not as a fact: three evenings a week is a publishing rhythm a person would
 * actually pick, every one of them is deletable, and any other slot can be
 * added beside them.
 *
 * NOT IN THE MIGRATION, deliberately. A migration writes SCHEMA; seeding it
 * with rows would make these three slots arrive on every install whether or
 * not anyone asked, would re-arrive on nobody's schedule after an operator
 * deleted them, and would make "the operator declared this slot" and "the
 * module guessed it" the same row with no way to tell them apart.
 * `alapSavokatFelvesz` below is the operator's own act, and it refuses when
 * any slot already exists so a second press cannot quietly double the week.
 */
export const ALAP_SAVOK = Object.freeze([
  Object.freeze({ nap: 1, ora: 18, perc: 0 }),
  Object.freeze({ nap: 3, ora: 18, perc: 0 }),
  Object.freeze({ nap: 5, ora: 18, perc: 0 }),
])

/**
 * A branch row, for the page: the four platform flags design spec 8 draws
 * (`var`/`kesz`/`hiba`/`nincs_fiok`), never the release's own computed
 * outcome -- see the file docblock's "READS THROW" note for where that
 * distinction is actually decided (it is not decided here at all: this
 * function reads exactly the columns `repo.agak` returns and reshapes
 * nothing).
 */
function agSorNaptarhoz(a) {
  return { platform: a.platform, allapot: a.allapot, url: a.url }
}

/** The fuller per-branch shape the detail view needs: the naptár's three fields plus the failure code, the dispatch timestamp, and the branch's own stored text -- read through `olvasSzoveg` (src/szoveg.mjs), the same parse `publishOpen` uses on this column, so a malformed value is refused once, not reinterpreted a second way here. */
function agSorReszlethez(a) {
  const szoveg = olvasSzoveg(a.platform, a.szoveg)
  return { platform: a.platform, allapot: a.allapot, hibaKod: a.hiba_kod, url: a.url, kikuldveAt: a.kikuldve_at, szoveg }
}

export function createRpc(state) {
  const repo = () => {
    if (!state.repo) throw new Error('publish: a modul még nem kapott storage-hozzáférést a hosttól (setup() nem futott le)')
    return state.repo
  }

  return {
    /**
     * The weekly calendar's one load: every release with its workflow/outcome
     * word (`kiadas.allapot`, the STORED column -- never `kiadasAllapot`'s
     * computed answer, per the module-wide rule constraints.md states and
     * `src/allapot.mjs`'s own docblock repeats), its computed dispatch instant
     * and the operator's override kept as two separate fields, and its
     * branches' own flags. Plus every declared slot, so the page can draw
     * where there is still room (design spec 8: "a szabad sávok láthatók").
     *
     * `idozona` travels with the answer rather than being a page-side
     * constant, for the same reason `kovetkezoSzabadSav`'s own docblock gives
     * for requiring it as an argument: the module's setting and its own
     * compiled-in default stop being the same string the moment an operator
     * edits the field, and a page that assumed Budapest while the setting
     * said something else would draw every slot on the wrong day.
     */
    async naptar() {
      return {
        idozona: idozonaOf(state.settings()),
        savok: repo().savok().map((s) => ({ id: s.id, nap: s.nap, ora: s.ora, perc: s.perc })),
        kiadasok: repo().kiadasok().map((k) => ({
          kiadasId: k.id,
          videoId: k.video_id,
          allapot: k.allapot,
          idopont: k.idopont,
          felulirtIdopont: k.felulirt_idopont,
          savId: k.sav_id,
          agak: repo().agak(k.id).map(agSorNaptarhoz),
        })),
      }
    },

    /**
     * One release's detail view: the four platform texts, the operator's
     * jóváhagyás gate, per-branch state and url, and the video's own title
     * and narration -- design spec 8's "A vázlat szövegei a bejegyzésre
     * kattintva olvashatók". The video read (`videoLekerdez`) is best-effort:
     * a release the operator already opened has every fact this route needs
     * except the video's, and a video the module can no longer reach (the
     * video extension reloading, or the file since deleted) must not hide
     * the release's own texts and branch state behind that unrelated
     * failure -- `videoHiba` carries the sentence instead, and `cim`/
     * `narracioSzoveg` fall back to `null`, which the page already has a
     * sentence for.
     */
    async kiadas(body = {}) {
      const kiadasId = requireString('kiadasId', body.kiadasId, { max: 64 })
      const k = repo().kiadas(kiadasId)
      if (!k) throw new Error(`publish: nincs kiadás a megadott kiadasId-vel`)
      let cim = null
      let narracioSzoveg = null
      let videoHiba = null
      try {
        const video = await videoLekerdez(state, k.video_id)
        cim = video ? video.cim : null
        narracioSzoveg = video ? video.narracio_szoveg : null
      } catch (err) {
        if (!(err instanceof PublishError)) throw err
        videoHiba = err.message
      }
      return {
        kiadasId: k.id,
        videoId: k.video_id,
        allapot: k.allapot,
        idopont: k.idopont,
        felulirtIdopont: k.felulirt_idopont,
        savId: k.sav_id,
        cim,
        narracioSzoveg,
        videoHiba,
        agak: repo().agak(k.id).map(agSorReszlethez),
        talalatok: olvasTalalatok(k.talalatok),
      }
    },

    /**
     * Every connected account, plus the closed platform list (so the page
     * can draw a row for a platform with NO account, per design spec 8's
     * "fiókok (összekötés, és megnevezve az, ami hiányzik)"), plus whether
     * this host even has a Google OAuth client configured -- read the same
     * way `extensions/gmail/ui/status-bar.tsx` reads it, so the connect
     * button can be disabled with a sentence instead of sending the operator
     * into a 409.
     */
    async fiokok() {
      const oauth = state.oauth
      const googleKliensVan = oauth && typeof oauth.googleClientConfigured === 'function' ? oauth.googleClientConfigured() : false
      return {
        platformok: PLATFORMOK,
        googleKliensVan,
        fiokok: repo().fiokok().map((f) => ({ id: f.id, platform: f.platform, kulsoId: f.kulso_id, nev: f.nev, csatlakoztatvaAt: f.csatlakoztatva_at })),
      }
    },

    /**
     * The operator's approval click, and -- in the SAME call -- the
     * scheduling step design spec 4 draws as the module's own next move
     * ("a modul a következő szabad sávba teszi"), not a second click. Two
     * separate database writes (`repo.kiadastJovahagy`, then
     * `kiadastUtemezSavba`, src/szoveg.mjs), reported as two separate facts:
     * `jovahagyva: true` once the first succeeds, and `utemezve`/
     * `utemezesHiba` for the second, which can legitimately fail on its own
     * (`nincs_szabad_sav` -- no slot is configured yet) WITHOUT undoing the
     * approval. A release left at `jovahagyva` with no slot is not a bug:
     * `kiadastUtemezSavba`'s own docblock says as much, and this is where
     * that becomes visible to the operator instead of silently trying again
     * on every future page load.
     *
     * WHICH IS WHY THIS METHOD ALSO TAKES AN ALREADY-`jovahagyva` RELEASE.
     * The two halves fail independently, so the state between them is
     * reachable and common: on a fresh install the operator approves, gets
     * `nincs_szabad_sav`, and only then declares a slot. Without a second
     * press that does the scheduling half alone, that release would be
     * STRANDED -- `jovahagy` would refuse it as "not lektoralt" and
     * `atutemez` (below) refuses anything that is not already `utemezve`, so
     * the very first release on every new install would be unschedulable
     * forever. The approval is not repeated (`repo.kiadastJovahagy` only runs
     * on the `lektoralt` arrow, and refuses anything else by name anyway);
     * `jovahagyva: true` in the answer is a statement about the release, not
     * a claim that this call is what approved it.
     *
     * Never writes `kiadasAllapot`'s computed answer onto anything -- this
     * method's two writes are the workflow arrow `jovahagyva -> utemezve`
     * alone, both HUMAN/MODULE-DECIDED transitions the stored column exists
     * for; the outcome words (`kesz`/`reszben`/`hiba`/`nincs_hova`) are
     * `publishDue`'s to write, after a real dispatch, never this button's.
     */
    async jovahagy(body = {}) {
      return lever(state, async () => {
        const kiadasId = requireString('kiadasId', body.kiadasId, { max: 64 })
        const k = repo().kiadas(kiadasId)
        if (!k) refuse('kiadas_ismeretlen', 'nincs kiadás a megadott kiadasId-vel')
        if (k.allapot !== KIADAS_ALLAPOTOK.LEKTORALT && k.allapot !== KIADAS_ALLAPOTOK.JOVAHAGYVA) {
          refuse('kiadas_nincs_lektoralva', `csak lektorált vagy már jóváhagyott, sávra még nem tett kiadás hagyható jóvá (jelenlegi állapot: ${k.allapot})`, { allapot: k.allapot })
        }
        if (k.allapot === KIADAS_ALLAPOTOK.LEKTORALT) repo().kiadastJovahagy(kiadasId)
        let utemezve = false
        let utemezesHiba = null
        try {
          kiadastUtemezSavba(state, { kiadasId, most: new Date() })
          utemezve = true
        } catch (err) {
          if (!(err instanceof SzovegError)) throw err
          utemezesHiba = { kod: err.code, uzenet: err.message }
        }
        const vegso = repo().kiadas(kiadasId)
        return { kiadasId, jovahagyva: true, utemezve, utemezesHiba, allapot: vegso.allapot }
      })
    },

    /**
     * The operator's manual reschedule of an already-scheduled release, onto
     * a time they typed rather than the next free slot -- design spec 3's
     * `felulirt_idopont`, and design spec 8's "a bejegyzés áthúzható másik
     * sávba". Implemented as a typed instant rather than an actual
     * drag-and-drop target: this harness (and `test/ui.test.mjs`'s own,
     * copied from `extensions/video/test/ui.test.mjs`) has no DOM and cannot
     * drive a native drag gesture, and a control this project cannot test is
     * a control this project cannot trust it still works after the next
     * change. The functional requirement -- move a release to a different
     * instant while it has not gone out -- is the same either way; only the
     * gesture differs. `ui/naptar.tsx`'s own docblock names this the same
     * deliberate deviation.
     */
    async atutemez(body = {}) {
      return lever(state, () => {
        const kiadasId = requireString('kiadasId', body.kiadasId, { max: 64 })
        const felulirtIdopont = requireString('felulirtIdopont', body.felulirtIdopont, { max: 64 })
        if (Number.isNaN(Date.parse(felulirtIdopont))) refuse('idopont_ervenytelen', 'felulirtIdopont csak érvényes ISO időpont lehet')
        const k = repo().kiadas(kiadasId)
        if (!k) refuse('kiadas_ismeretlen', 'nincs kiadás a megadott kiadasId-vel')
        if (k.allapot !== KIADAS_ALLAPOTOK.UTEMEZVE) {
          refuse('kiadas_nincs_utemezve', `csak ütemezett kiadás időpontja írható felül (jelenlegi állapot: ${k.allapot})`, { allapot: k.allapot })
        }
        const uj = repo().idopontFeluliras({ kiadasId, felulirtIdopont })
        return { kiadasId, idopont: uj.idopont, felulirtIdopont: uj.felulirt_idopont }
      })
    },

    /**
     * Connects or renames one platform's account -- the write half design
     * spec 6 and the brief's own closing section both say is missing: without
     * it `repo.fiokotIr` (src/db.mjs) has no caller in production code at
     * all, and `publishDue`'s account gate (src/szoveg.mjs) resolves every
     * branch to `nincs_fiok` forever. This is the SAME write for all four
     * platforms -- a platform, an external id, a display name -- because
     * that is the whole of what `ext_publish_fiokok` stores; it is not an
     * OAuth flow, and for YouTube it is deliberately the SECOND of the two
     * things a working connection needs. See this file's own docblock and
     * `ui/fiokok.tsx`'s for the first: `/api/oauth/google/start?purpose=publish`.
     */
    async fiokotOsszekot(body = {}) {
      return lever(state, () => {
        const platform = requireEnum('platform', body.platform, PLATFORMOK)
        const kulsoId = requireString('kulsoId', body.kulsoId, { max: 200 })
        const nev = requireString('nev', body.nev, { max: 200 })
        const fiok = repo().fiokotIr({ platform, kulsoId, nev })
        return { fiok: { id: fiok.id, platform: fiok.platform, kulsoId: fiok.kulso_id, nev: fiok.nev, csatlakoztatvaAt: fiok.csatlakoztatva_at } }
      })
    },

    /**
     * Declares one weekly publishing slot: every `nap` at `ora:perc` ON THE
     * WALL CLOCK of the module's configured zone (`idozona`, the setting
     * `naptar` above sends to the page beside the slots for exactly this
     * reason), never UTC.
     *
     * The three numbers are checked HERE as well as in `repo.ujSav`
     * (src/db.mjs) rather than only there, because the two refusals are
     * different acts: the repository's throw is a programmer error crossing a
     * layer, and this one is a button an operator pressed with `25` in the
     * hour box. A `lever` refusal reaches the page as a sentence it can
     * print; the repository's would reach it as an opaque 500.
     */
    async savotFelvesz(body = {}) {
      return lever(state, () => {
        const nap = requireInt('nap', body.nap, 0, 6)
        const ora = requireInt('ora', body.ora, 0, 23)
        const perc = requireInt('perc', body.perc, 0, 59)
        return { sav: savSor(repo().ujSav({ nap, ora, perc })) }
      })
    },

    /**
     * Removes one slot. Refused by name when the id names none -- an operator
     * clicking a stale row from a page loaded before someone else deleted it
     * is a real state, and answering it with a sentence is the difference
     * between that and a delete that silently did nothing.
     *
     * Already-scheduled releases keep their `idopont` and go out as planned:
     * `repo.savotTorol`'s own docblock (src/db.mjs) has the whole argument,
     * and `ui/naptar.tsx` puts that sentence next to the button so the
     * operator is not left guessing what a delete costs.
     */
    async savotTorol(body = {}) {
      return lever(state, () => {
        const savId = requireString('savId', body.savId, { max: 64 })
        const torolt = repo().savotTorol(savId)
        if (torolt === null) refuse('sav_ismeretlen', 'nincs sáv a megadott savId-vel')
        return { savId: torolt.id }
      })
    },

    /**
     * The zero-slot install's one click: `ALAP_SAVOK` above, written in one
     * transaction so a fresh calendar either gains the whole starter week or
     * none of it.
     *
     * Refused by name (`van_mar_sav`) the moment ANY slot exists. This is not
     * an idempotency nicety -- it is what keeps the button honest about being
     * an empty-state offer. Without it a second press (a double click, a
     * stale tab, a page reloaded after someone else pressed it) would add
     * three more slots on top of the operator's own edits, and the module
     * would look like it was inventing publishing times of its own.
     */
    async alapSavokatFelvesz() {
      return lever(state, () => {
        if (repo().savok().length > 0) {
          refuse('van_mar_sav', 'ezen a telepítésen már van legalább egy sáv; az alapkészletet csak üres naptárra lehet felvenni')
        }
        const savok = repo().storage.transaction(() => ALAP_SAVOK.map((s) => savSor(repo().ujSav(s))))
        return { savok }
      })
    },
  }
}
