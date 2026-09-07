import fs from 'node:fs'
import { Readable } from 'node:stream'

/**
 * The YouTube sender: the one platform this project has real OAuth for
 * (design spec 6). `feltolt` is the whole public surface -- one function,
 * called by `publishDue`'s adapter registry (src/szoveg.mjs) as
 * `state.adapterek.youtube`, wired up in `index.mjs`'s `createYoutubeAdapter`
 * below.
 *
 * FOUR THINGS THIS FILE SAYS OUT LOUD, BECAUSE EVERY ONE OF THEM IS EASY TO
 * FORGET ONCE THE CODE WORKS.
 *
 * THE QUOTA IS FROM DOCUMENTATION, NOT MEASUREMENT. `KVOTA_EGYSEG_FELTOLTES`
 * (1600) and `KVOTA_NAPI_ALAP` (10000) are YouTube Data API v3's own
 * published numbers -- one `videos.insert` call costs 1600 units against a
 * default daily quota of 10000, roughly six uploads a day. Nobody has run an
 * upload from this codebase, so nobody has confirmed these against a real
 * response header. `feltolt` refuses from its OWN counter (`kvota_elfogyott`)
 * BEFORE it ever calls `getToken` or `fetchImpl` -- a refusal that fires
 * after the request went out could lose the video mid-transfer and still
 * report nothing sent, which is worse than refusing a little early on a
 * number that turns out to be conservative. `getToken` is inside the gate and
 * not outside it because it is itself a network round trip to Google's token
 * endpoint: a module that has already decided not to send must not spend one.
 *
 * THE DRY RUN IS NOT A TEST CONVENIENCE. `szarazFutas: true` runs every step
 * up to building the exact two requests YouTube would receive -- the session
 * request's URL, method, HEADERS and JSON body, and the byte request's URL,
 * method and headers -- and returns those instead of sending them. It does
 * NOT call `getToken` and it does NOT touch the disk: a dry run has to work
 * with no connected account and no real video on disk at all, since
 * inspecting the shape of a request is exactly what an operator needs BEFORE
 * there is anything to authenticate with. The five values that genuinely
 * cannot be known without an account, a file and a running attempt (the
 * bearer token, the file's byte length, the session URL YouTube hands back,
 * the bytes themselves, and the abort signal) are the module's own named
 * placeholder constants below, and NOTHING else in the returned request is a
 * placeholder: the two builders below (`munkamenetKeres`, `bajtKeres`) return
 * the WHOLE `fetch` init -- url, method, headers, body framing, `duplex` and
 * `signal` -- and `kuld` sends exactly what they built, so the dry run and
 * the real send cannot differ in anything a builder decides. That is the
 * whole point: Facebook, Instagram and TikTok (design spec 6) cannot be tried
 * against a real account for weeks after their code lands (Meta needs app
 * review, TikTok needs an audit), they will copy this shape, and they will be
 * streaming files too -- so the streaming contract and the attempt bound are
 * as much a part of what has to be inspectable as the headers are.
 *
 * THE UPLOAD IS RESUMABLE, AND THAT IS A MEMORY DECISION BEFORE IT IS A
 * RELIABILITY ONE. The obvious implementation reads the file with
 * `fs.readFileSync` and glues a multipart body together with `Buffer.concat`.
 * This module runs INSIDE the host's single Node process, on a 15-minute
 * schedule: a 600 MB render would stop SwarmClaw's whole event loop -- every
 * other agent turn, connector and HTTP request -- for the length of that
 * synchronous disk read, then hold roughly twice the file in memory because
 * `Buffer.concat` copies. Past Node's buffer ceiling it throws a `RangeError`,
 * which is not a `YoutubeError`, so it escapes `feltolt`'s catch and lands in
 * `publishDue` as the unnamed `kikuldes_hiba` fallback -- the one outcome this
 * module's whole error vocabulary exists to prevent. The sibling module
 * already knows this: `extensions/video/src/qa.mjs`'s `fileSha256` streams the
 * very same files for the very same reason. So: `fs.promises.stat` for the
 * length, `fs.createReadStream` for the bytes, and YouTube's documented
 * resumable protocol (a JSON session request, then a PUT of the bytes to the
 * session URL it answers with) to carry them. It is also the protocol a later
 * task's retry would need anyway.
 *
 * WHAT THE MODULE MAY AND MAY NOT ASSERT ABOUT A VIDEO. `status.privacyStatus`
 * and `status.selfDeclaredMadeForKids` are the two fields on the request that
 * are statements rather than data, and neither is this module's to invent.
 *
 * `privacyStatus` defaults to `private`, and the operator moves it. Publishing
 * publicly is the ONE irreversible step in the whole chain -- the quota gate
 * refuses in advance, the dry run exists so a request can be read before it is
 * sent, and R1 re-reads the video's QA status so an approval cannot go stale,
 * all because this code is untried. `public` on an untried path means the
 * first execution of never-run code is live on a real channel with
 * agent-written copy. `private` is reversible, returns the same real `kulsoId`
 * and watch URL, moves the branch to `kesz` exactly the same way, and the
 * operator flips it in Studio once they have looked at it. The `lathatosag`
 * settings field (index.mjs) is where `public` becomes the operator's explicit
 * choice instead of an unspecified literal in this file.
 *
 * `selfDeclaredMadeForKids` has NO default at all, and `feltolt` refuses by
 * name until the operator has set it. It is a COPPA declaration of fact with
 * real legal weight, made on the operator's behalf, and this module has no
 * input, no field and no content analysis behind it -- `false` is the one
 * value that is simultaneously an assertion and unverifiable. A comment
 * flagging that would not make it true and would never reach the operator.
 * Yes, this means the operator must set a field before the first upload; that
 * is the correct price of a legal declaration.
 */

/** YouTube Data API v3's published cost of one `videos.insert` call, in quota units. Documentation, not measurement -- see the file docblock. */
export const KVOTA_EGYSEG_FELTOLTES = 1600

/** YouTube Data API v3's published default daily quota, in units. Documentation, not measurement -- see the file docblock. */
export const KVOTA_NAPI_ALAP = 10000

/** The resumable session request: `uploadType=resumable` is what makes YouTube answer a session URL instead of expecting the bytes inline -- see the file docblock's third note for why this module never sends them inline. */
const FELTOLTES_URL = 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status'

/** What the bytes are declared as, in both the session request's `x-upload-content-type` and the byte request's own `content-type`. `video/*` rather than a guessed container: this module never inspects the file, and a wrong exact type is worse than an honest wildcard. */
const TARTALOM_TIPUS = 'video/*'

/**
 * THE ONE LINE THAT MAKES A STREAMED BODY POSSIBLE AT ALL. Node's `fetch`
 * refuses a request whose body is a stream unless the init says `duplex:
 * 'half'` -- it throws a `TypeError` from inside the call, which `kuld`'s
 * catch would then report as `feltoltes_atviteli_hiba`: "look at the
 * network", forever, on every single upload, for a fault that is entirely
 * this module's. Declared on BOTH requests rather than only on the byte one,
 * so the two inits have the same shape and the next three platforms copy a
 * complete one; it is inert on a string body.
 */
const DUPLEX = 'half'

/**
 * The four values a dry run genuinely cannot know, spelled as sentences
 * rather than as empty strings or zeroes.
 *
 * An operator reading a dry run has to be able to tell "this module built the
 * header wrong" from "this value only exists once there is an account and a
 * file", and a `0` byte length or an empty bearer token reads as the first.
 * They are Hungarian because the operator reads them; they are constants
 * because `test/youtube.test.mjs` asserts the dry run's headers against the
 * real send's headers key by key, and a literal typed twice drifts.
 */
export const SZARAZ_TOKEN = '<hozzáférési token: száraz futásban nem kérünk le>'
export const SZARAZ_HOSSZ = '<a fájl mérete bájtban: száraz futásban nem olvassuk a lemezt>'
export const SZARAZ_MUNKAMENET_URL = '<a feltöltési munkamenet URL-je: ezt a YouTube adja a munkamenet-válasz Location fejlécében>'
export const SZARAZ_BAJTOK = '<a videó bájtjai: száraz futásban nem olvassuk a lemezt>'
export const SZARAZ_JEL = '<megszakítás-jel: száraz futásban nincs futó kísérlet, amit meg lehetne szakítani>'

/**
 * The three values YouTube's `status.privacyStatus` accepts, and the one this
 * module defaults to.
 *
 * `unlisted` is here because it is a real YouTube state an operator may
 * genuinely want (a link-only preview for a client), not because anything in
 * this module needs it. `private` is the default for the reason the file
 * docblock gives at length: the first run of untried code must not be public.
 */
export const LATHATOSAGOK = Object.freeze(['private', 'unlisted', 'public'])

/** The `lathatosag` settings field's default, and this module's fallback for a cleared field. See the file docblock. */
export const ALAP_LATHATOSAG = 'private'

/**
 * How long one upload attempt may run before this module gives up on it.
 * Ten minutes: long enough for a real video file over a slow connection, and
 * short enough that a wedged connection does not hold the 15-minute dispatch
 * tick (`index.mjs`'s `SCHEDULES`) open past its own next run. It covers BOTH
 * phases of the resumable upload together, because what it bounds is the
 * attempt, not a single socket.
 */
export const FELTOLTES_IDOTULLEPES_MS = 10 * 60 * 1000

/**
 * A named refusal from this adapter -- same shape and same discipline as
 * `SzovegError` (src/szoveg.mjs): a code, a sentence, never the caller's
 * `cim`/`leiras`/`fajl` value or a platform response body echoed back.
 */
export class YoutubeError extends Error {
  constructor(code, message, extra = {}) {
    super(message || code)
    this.name = 'YoutubeError'
    this.code = code
    this.extra = extra
  }
}

function refuse(code, message, extra = {}) {
  throw new YoutubeError(code, message, extra)
}

/**
 * The in-process daily counter `feltolt` charges before every real send, and
 * the ONE thing about it worth naming: it lives in this module's memory, not
 * in storage, so a host restart resets it to zero mid-day. A caller that
 * knows the real total (a persisted counter a later task adds) passes it
 * through `maiEgysegek` and this default is never consulted; `feltolt` is
 * only ever this permissive on a fresh process, and a fresh process has sent
 * nothing yet either.
 */
let szamlalo = { nap: '', ossz: 0 }

function napKulcs(now) {
  return now.toISOString().slice(0, 10)
}

function aktualisEgysegek(now) {
  const nap = napKulcs(now)
  if (szamlalo.nap !== nap) szamlalo = { nap, ossz: 0 }
  return szamlalo.ossz
}

function egysegetKonyvel(mennyiseg, now) {
  const nap = napKulcs(now)
  if (szamlalo.nap !== nap) szamlalo = { nap, ossz: 0 }
  szamlalo = { nap, ossz: szamlalo.ossz + mennyiseg }
}

/** Test-only reset, so one test's counted upload cannot leak into the next test's quota gate. Not exported for production use -- nothing in this module ever needs to zero a real day's spend. */
export function _szamlalotNullaz() {
  szamlalo = { nap: '', ossz: 0 }
}

/**
 * The visibility the operator chose, from the module's own settings object.
 *
 * The fallback fires twice and the second time is the one that matters, the
 * same way `idozonaOf` (src/utemezes.mjs) describes for its own field: a
 * never-configured install has no `lathatosag` key, and an operator who
 * CLEARS the field stores `''`, at which point the host's `defaultValue`
 * never fires again. Falling back to `private` rather than to the last known
 * value keeps a blanked field on the safe side of the one irreversible step.
 *
 * A value outside `LATHATOSAGOK` is NOT silently corrected here -- it is
 * passed through, and `feltolt` refuses it by name. Quietly turning an
 * unrecognised setting into `private` would hide a typo that the operator
 * believes means `public`.
 *
 * @param {undefined | null | { lathatosag?: unknown }} beallitasok
 * @returns {string}
 */
export function lathatosagOf(beallitasok) {
  const ertek = beallitasok && typeof beallitasok === 'object' ? beallitasok.lathatosag : undefined
  if (typeof ertek !== 'string' || ertek.trim() === '') return ALAP_LATHATOSAG
  return ertek.trim()
}

/**
 * The operator's COPPA declaration, from the module's own settings object --
 * `true`, `false`, or `null` for "the operator has not said".
 *
 * `null` and NOT `false` is the entire point (see the file docblock): a
 * missing declaration is a different fact from a declaration of "no", and
 * this module may only forward the second. The stored value is the settings
 * select's own word, so a value this function does not recognise -- an old
 * setting, a hand-edited store -- answers `null` too: an unreadable
 * declaration has not been made either.
 *
 * @param {undefined | null | { gyerekeknek?: unknown }} beallitasok
 * @returns {boolean | null}
 */
export function gyerekeknekOf(beallitasok) {
  const ertek = beallitasok && typeof beallitasok === 'object' ? beallitasok.gyerekeknek : undefined
  if (ertek === 'igen') return true
  if (ertek === 'nem') return false
  return null
}

/**
 * The resumable session request: everything except the bytes.
 *
 * Built by ONE function so the dry run and the real send cannot drift -- see
 * the file docblock's second note. `hossz` and `token` are the only two
 * values that differ between the two callers, and both arrive as the module's
 * own placeholder constants on the dry path.
 */
function munkamenetKeres({ metaadat, token, hossz, jel }) {
  return {
    url: FELTOLTES_URL,
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json; charset=UTF-8',
      'x-upload-content-type': TARTALOM_TIPUS,
      'x-upload-content-length': String(hossz),
    },
    body: JSON.stringify(metaadat),
    duplex: DUPLEX,
    signal: jel,
  }
}

/** The byte request: the PUT to whatever session URL the request above was answered with. Same one-builder discipline as `munkamenetKeres`; the body is the caller's, because on the real path it is a stream and on the dry path it is a sentence. */
function bajtKeres({ url, hossz, jel }) {
  return {
    url,
    method: 'PUT',
    headers: {
      'content-type': TARTALOM_TIPUS,
      'content-length': String(hossz),
    },
    duplex: DUPLEX,
    signal: jel,
  }
}

/**
 * One `fetchImpl` call, with this module's two transport refusals kept apart.
 *
 * A timeout and a broken connection are two different facts with two
 * different remedies -- wait and let the next tick retry a big file, versus
 * look at the network -- so they are two codes, not one. Both phases of the
 * resumable upload go through here, so the distinction holds wherever the
 * attempt died.
 */
async function kuld(fetchImpl, kerés, body, lejarat) {
  // EVERYTHING EXCEPT THE BODY COMES FROM THE BUILDER, UNREAD. Picking fields
  // off `kerés` by name here is what let `duplex` and `signal` live only on
  // the real path and be invisible to a dry run; spreading whatever the
  // builder decided makes the dry/real parity structural rather than a
  // convention two functions have to keep agreeing on.
  const { url, ...init } = kerés
  try {
    return await fetchImpl(url, { ...init, body })
  } catch {
    if (lejarat.signal.aborted) refuse('feltoltes_idotullepes', 'a YouTube-feltöltés nem fejeződött be a megengedett időn belül')
    refuse('feltoltes_atviteli_hiba', 'a YouTube-feltöltés a hálózaton hiúsult meg, mielőtt válasz érkezett volna')
  }
}

/** One response header, on a real `Response` or on a test's stand-in, or null. The session URL arrives this way and nowhere else. */
function fejlec(res, nev) {
  const h = res && res.headers
  if (!h || typeof h.get !== 'function') return null
  const ertek = h.get(nev)
  return typeof ertek === 'string' && ertek !== '' ? ertek : null
}

/**
 * Uploads one video to the connected YouTube channel, or refuses by name.
 *
 * `getToken()` and `fetchImpl(url, init)` are both injected -- no test in
 * this module's suite reaches the network, and this is also what lets the
 * dry run above skip the token and the send in the same shape a test would.
 * `fetchImpl` defaults to the global `fetch`; `getToken` has no default,
 * because a caller that forgot to build one belongs in the loud crash a
 * missing function produces, not in a silent no-op. `most` and
 * `idotullepesMs` are the same kind of seam: the clock the daily counter is
 * keyed on, and the bound on one attempt, both defaulted to the real thing.
 *
 * `lathatosag` and `gyerekeknekKeszult` are the two operator decisions this
 * module refuses to make for itself -- see the file docblock's last note.
 * `lathatosag` defaults to `private`; `gyerekeknekKeszult` has NO default and
 * anything other than a boolean is a named refusal.
 *
 * `maiEgysegek`, when given, overrides this module's own in-process counter
 * -- see that counter's own docblock for why a caller would.
 *
 * Returns `{ url, kulsoId }` on a real send, `{ szaraz: true, kerés }` on a
 * dry run, or `{ error: { code, message, ...extra } }` on a named refusal.
 * A bug (anything that is not a `YoutubeError`) propagates as the bug it is,
 * the same discipline `guard` documents in src/szoveg.mjs.
 */
export async function feltolt(args = {}) {
  try {
    return await feltoltBelso(args)
  } catch (err) {
    if (err instanceof YoutubeError) return { error: { code: err.code, message: err.message, ...err.extra } }
    throw err
  }
}

async function feltoltBelso({
  fajl,
  cim,
  leiras,
  cimkek = [],
  getToken,
  fetchImpl = fetch,
  szarazFutas = false,
  maiEgysegek,
  most = new Date(),
  lathatosag = ALAP_LATHATOSAG,
  gyerekeknekKeszult,
  idotullepesMs = FELTOLTES_IDOTULLEPES_MS,
}) {
  if (typeof fajl !== 'string' || fajl === '') refuse('argumentum_hibas', 'fajl kötelező')
  if (typeof cim !== 'string' || cim === '') refuse('argumentum_hibas', 'cim kötelező')
  if (typeof leiras !== 'string') refuse('argumentum_hibas', 'leiras kötelező')
  if (!Array.isArray(cimkek)) refuse('argumentum_hibas', 'cimkek: lista kell')
  if (!szarazFutas && typeof getToken !== 'function') refuse('argumentum_hibas', 'getToken kötelező, ha a hívás nem száraz futás')

  // THE TWO OPERATOR DECISIONS, REFUSED BY NAME BEFORE ANYTHING ELSE -- and
  // on the dry path too, because a dry run whose `status` block could not be
  // built is not a request an operator can inspect.
  if (!LATHATOSAGOK.includes(lathatosag)) {
    refuse(
      'lathatosag_ervenytelen',
      `a YouTube láthatóság beállítása nem az engedett három érték egyike (${LATHATOSAGOK.join(', ')}); állítsd be a Publikálás bővítmény beállításai közt a "YouTube láthatóság" mezőt`,
    )
  }
  if (typeof gyerekeknekKeszult !== 'boolean') {
    refuse(
      'gyerekeknek_nincs_beallitva',
      'a YouTube minden feltöltésnél megköveteli a nyilatkozatot arról, hogy a videó gyerekeknek készült-e (COPPA), és ezt a modul nem döntheti el helyetted: állítsd be a Publikálás bővítmény beállításai közt a "Gyerekeknek készült tartalom" mezőt, aztán próbáld újra',
    )
  }

  // THE QUOTA GATE, BEFORE ANYTHING ELSE TOUCHES A TOKEN OR THE NETWORK. See
  // the file docblock for why this is the module's own counter, why the
  // number is documentation rather than measurement, and why `getToken` is
  // on the far side of this gate rather than above it.
  const eddig = typeof maiEgysegek === 'number' ? maiEgysegek : aktualisEgysegek(most)
  if (eddig + KVOTA_EGYSEG_FELTOLTES > KVOTA_NAPI_ALAP) {
    refuse(
      'kvota_elfogyott',
      `a napi YouTube feltöltési kvóta elfogyott: ez a feltöltés ${KVOTA_EGYSEG_FELTOLTES} egységbe kerülne, a napi keret ${KVOTA_NAPI_ALAP} egység, és ma már ${eddig} egység el van könyvelve -- próbáld holnap újra`,
    )
  }

  const metaadat = {
    snippet: { title: cim, description: leiras, tags: cimkek },
    status: { privacyStatus: lathatosag, selfDeclaredMadeForKids: gyerekeknekKeszult },
  }

  // A DRY RUN NEVER TOUCHES getToken, fetchImpl OR THE DISK. See the file
  // docblock: the headers and the body framing are built HERE, by the same
  // two builders the real send uses, because they are the two parts the next
  // three platforms are most likely to get wrong and the dry run is the only
  // way they will be looked at for weeks.
  if (szarazFutas) {
    return {
      szaraz: true,
      kerés: {
        url: FELTOLTES_URL,
        metaadat,
        fajl,
        munkamenet: munkamenetKeres({ metaadat, token: SZARAZ_TOKEN, hossz: SZARAZ_HOSSZ, jel: SZARAZ_JEL }),
        bajtok: { ...bajtKeres({ url: SZARAZ_MUNKAMENET_URL, hossz: SZARAZ_HOSSZ, jel: SZARAZ_JEL }), body: SZARAZ_BAJTOK },
      },
    }
  }

  let token
  try {
    token = await getToken()
  } catch (err) {
    // 'no_credential' NAMES the fact this module can act on: connect the
    // account. Anything else from the token stage -- a revoked grant, a
    // failed refresh, a host with no OAuth client configured -- is a
    // different fact with a different remedy (reconnect, or fix the host),
    // but it is still the TOKEN stage that failed, never the network: see
    // the next test below for why that distinction is named rather than
    // folded into one generic failure.
    if (err && err.code === 'no_credential') refuse('fiok_nincs_osszekotve', 'nincs összekötött YouTube-fiók; kösd össze a Bővítmények lapon a publish OAuth-beleegyezéssel')
    refuse('fiok_hitelesites_hiba', 'a YouTube-fiók hitelesítése nem sikerült; kösd össze újra a fiókot a Bővítmények lapon')
  }

  // `stat`, not a read: the length is all the session request needs, and
  // asking for it asynchronously is what keeps the host's event loop free.
  let hossz
  try {
    hossz = (await fs.promises.stat(fajl)).size
  } catch {
    refuse('video_fajl_olvashatatlan', 'a feltöltendő videófájl nem olvasható a lemezről')
  }

  const lejarat = new AbortController()
  const oraJel = setTimeout(() => lejarat.abort(), idotullepesMs)
  /** @type {import('node:fs').ReadStream | null} */
  let folyam = null
  try {
    const mk = munkamenetKeres({ metaadat, token, hossz, jel: lejarat.signal })
    const munkamenetValasz = await kuld(fetchImpl, mk, mk.body, lejarat)

    // BOOKED HERE, NOT ON SUCCESS. YouTube charges the 1600 units for the
    // `videos.insert` call itself, including the ones it REJECTS: a run of
    // 4xx answers that never moved the counter would let this module hammer
    // well past the real daily limit while its own gate still says there is
    // room. Booked once the request has actually been answered -- a
    // transport failure before any response is the one case where nobody
    // knows whether Google counted it, and guessing there would be a
    // measurement this module has not made.
    egysegetKonyvel(KVOTA_EGYSEG_FELTOLTES, most)

    if (!munkamenetValasz.ok) {
      refuse('feltoltes_elutasitva', `a YouTube elutasította a feltöltést (státusz ${munkamenetValasz.status})`, { httpStatus: munkamenetValasz.status })
    }
    const munkamenetUrl = fejlec(munkamenetValasz, 'location')
    if (munkamenetUrl === null) {
      refuse('feltoltes_valasz_ertelmezhetetlen', 'a YouTube nem adott vissza feltöltési munkamenet-URL-t, így a videó bájtjainak nincs hova menniük')
    }

    const bk = bajtKeres({ url: munkamenetUrl, hossz, jel: lejarat.signal })
    folyam = fs.createReadStream(fajl)
    const bajtValasz = await kuld(fetchImpl, bk, Readable.toWeb(folyam), lejarat)

    // `308 Resume Incomplete` is the resumable protocol's "send me the rest",
    // not a rejection -- and it cannot arise here, because this is a single
    // PUT of the WHOLE body rather than a chunked upload. A later task that
    // splits the body into chunks has to handle it before it splits anything.
    if (!bajtValasz.ok) {
      refuse('feltoltes_elutasitva', `a YouTube elutasította a feltöltést (státusz ${bajtValasz.status})`, { httpStatus: bajtValasz.status })
    }

    let json
    try {
      json = await bajtValasz.json()
    } catch {
      refuse('feltoltes_valasz_ertelmezhetetlen', 'a YouTube válasza nem érvényes JSON')
    }
    const kulsoId = json && typeof json.id === 'string' && json.id !== '' ? json.id : null
    if (kulsoId === null) refuse('feltoltes_valasz_ertelmezhetetlen', 'a YouTube válasza nem tartalmaz videó-azonosítót')

    return { url: `https://youtu.be/${kulsoId}`, kulsoId }
  } catch (err) {
    // ONLY ON THE FAILURE PATH. A `fetch` that resolved has already consumed
    // the request body, and the stream belongs to it from that moment; an
    // abort or a broken connection is the case where nobody drained it and
    // the descriptor would otherwise stay open for the life of the process.
    if (folyam !== null) folyam.destroy()
    throw err
  } finally {
    clearTimeout(oraJel)
  }
}

/**
 * The `state.adapterek.youtube` sender `publishDue` (src/szoveg.mjs) calls as
 * `adapter({ ag, kiadas, fiok, video })` -- `video` is R1's addition (see
 * that task's own note in `task-5-brief.md`): the fresh video row, read
 * again at dispatch time rather than trusted from whenever the release was
 * approved, so this adapter is never handed a `video` that failed QA after
 * approval. `publishDue` refuses BEFORE calling any adapter when that is not
 * true, so this function does not re-check `video.status` itself -- it
 * trusts its one caller the way `feltolt` trusts `getToken`.
 *
 * `ag.szoveg` is the JSON `{ cim, leiras }` `publishDraft` wrote
 * (src/szoveg.mjs's `olvasSzoveg`); a value that does not READ BACK as that
 * object is this function's own named refusal (`ag_szoveg_olvashatatlan`).
 * "Does not read back" is deliberately wider than "does not parse":
 * `JSON.parse` only throws on syntactic rubbish, while the column is nullable
 * and `publishOpen` already models a branch with no text at all
 * (`vanSzoveg: false`), so `null`, `123`, `"x"` and `[]` all parse perfectly
 * and then throw a bare `TypeError` on `.cim` -- an error with no `.code`,
 * which is exactly the unnamed `kikuldes_hiba` fallback this guard exists to
 * prevent.
 *
 * No `cimkek`: the schema `publishDraft` writes to has no tag field (design
 * spec 3 never added one), so every upload from this pipeline goes out
 * untagged until a later task adds one.
 *
 * `lathatosag` and `gyerekeknekKeszult` are read from `state.settings()` at
 * CALL time, not at build time -- an operator who sets the COPPA field
 * between two dispatch ticks must not have to reload the extension for it to
 * take effect.
 *
 * `getToken` reads `state.oauth`, the seam `index.mjs`'s `setup()` fills from
 * `ctx.oauth` the same way `extensions/gmail/index.mjs` does. `purpose` is
 * `'publish'` -- the one entry `src/app/api/oauth/google/start/route.ts`'s
 * `SCOPES` table grants `youtube.upload` for (Task 5's host change).
 * `hasGoogleCredential` is checked FIRST and cheaply, so a host with no
 * account connected answers `fiok_nincs_osszekotve` without a wasted refresh
 * round trip -- the same reasoning `getGoogleAccessToken`'s own docblock
 * gives for checking a missing OAuth client before a missing credential.
 *
 * `fetchImpl` and `szarazFutas` are the second argument, both forwarded
 * straight to `feltolt` -- the seam a test builds this adapter with to keep
 * it off the network, and the switch an operator could wire to a settings
 * field later to dry-run every dispatch tick. `index.mjs` calls this with
 * neither, so production sends for real once an account is connected.
 */
export function createYoutubeAdapter(state, { fetchImpl, szarazFutas = false } = {}) {
  const PURPOSE = 'publish'
  const getToken = async () => {
    const oauth = state.oauth
    if (!oauth || typeof oauth.getGoogleAccessToken !== 'function' || typeof oauth.hasGoogleCredential !== 'function') {
      const err = new Error('nincs oauth réteg a hoston')
      err.code = 'no_credential'
      throw err
    }
    if (!oauth.hasGoogleCredential(PURPOSE)) {
      const err = new Error('nincs összekötött YouTube-fiók')
      err.code = 'no_credential'
      throw err
    }
    return oauth.getGoogleAccessToken(PURPOSE)
  }

  return async function youtubeAdapter({ ag, video }) {
    const olvashatatlan = () => {
      const err = new Error('a mentett YouTube szöveg nem olvasható vissza')
      err.code = 'ag_szoveg_olvashatatlan'
      return err
    }
    let szoveg
    try {
      szoveg = JSON.parse(ag.szoveg)
    } catch {
      throw olvashatatlan()
    }
    if (szoveg === null || typeof szoveg !== 'object' || Array.isArray(szoveg)) throw olvashatatlan()
    if (!video || typeof video.out_path !== 'string' || video.out_path === '') {
      const err = new Error('a videónak nincs feltölthető fájlja')
      err.code = 'video_fajl_hianyzik'
      throw err
    }
    const beallitasok = typeof state.settings === 'function' ? state.settings() : null
    const eredmeny = await feltolt({
      fajl: video.out_path,
      cim: szoveg.cim,
      leiras: szoveg.leiras,
      getToken,
      fetchImpl,
      szarazFutas,
      lathatosag: lathatosagOf(beallitasok),
      gyerekeknekKeszult: gyerekeknekOf(beallitasok),
    })
    if (eredmeny.error) {
      const err = new Error(eredmeny.error.message)
      err.code = eredmeny.error.code
      throw err
    }
    return eredmeny
  }
}
