import fs from 'node:fs'

/**
 * The YouTube sender: the one platform this project has real OAuth for
 * (design spec 6). `feltolt` is the whole public surface -- one function,
 * called by `publishDue`'s adapter registry (src/szoveg.mjs) as
 * `state.adapterek.youtube`, wired up in `index.mjs`'s `createYoutubeAdapter`
 * below.
 *
 * TWO THINGS THIS FILE SAYS OUT LOUD, BECAUSE BOTH ARE EASY TO FORGET ONCE
 * THE CODE WORKS.
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
 * number that turns out to be conservative.
 *
 * THE DRY RUN IS NOT A TEST CONVENIENCE. `szarazFutas: true` runs every step
 * up to building the exact request YouTube would receive -- the metadata
 * object, the upload URL -- and returns that instead of sending it. It does
 * NOT call `getToken` or read the file: a dry run has to work with no
 * connected account and no real video on disk at all, since inspecting the
 * shape of a request is exactly what an operator needs BEFORE there is
 * anything to authenticate with. Facebook, Instagram and TikTok (design
 * spec 6) cannot be tried against a real account for weeks after their code
 * lands -- Meta needs app review, TikTok needs an audit -- and this module's
 * whole defence against shipping untried code is that the request can be
 * inspected without ever leaving the machine.
 *
 * A THIRD THING, NARROWER BUT STILL A REAL DECISION: `feltoltBelso` sends
 * every video as `status.privacyStatus: 'public'` with
 * `selfDeclaredMadeForKids: false`. The brief and the design doc are silent
 * on both. `public` matches the whole point of this pipeline -- a `kiadás`
 * exists to go out, not to sit unlisted -- but `selfDeclaredMadeForKids` is
 * a COPPA declaration with real legal weight for a real channel, and `false`
 * is a guess this module has no way to verify against the actual content.
 * Flagged here and in task-5-report.md rather than silently shipped: the
 * first operator connecting a real channel should confirm both defaults are
 * what they want before the first non-dry-run send.
 */

/** YouTube Data API v3's published cost of one `videos.insert` call, in quota units. Documentation, not measurement -- see the file docblock. */
export const KVOTA_EGYSEG_FELTOLTES = 1600

/** YouTube Data API v3's published default daily quota, in units. Documentation, not measurement -- see the file docblock. */
export const KVOTA_NAPI_ALAP = 10000

const FELTOLTES_URL = 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=multipart&part=snippet,status'
const HATAR = 'swarmclaw_publish_youtube_boundary'

/**
 * How long one upload attempt may run before this module gives up on it.
 * Ten minutes: long enough for a real video file over a slow connection, and
 * short enough that a wedged connection does not hold the 15-minute dispatch
 * tick (`index.mjs`'s `SCHEDULES`) open past its own next run.
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
 * Uploads one video to the connected YouTube channel, or refuses by name.
 *
 * `getToken()` and `fetchImpl(url, init)` are both injected -- no test in
 * this module's suite reaches the network, and this is also what lets the
 * dry run above skip the token and the send in the same shape a test would.
 * `fetchImpl` defaults to the global `fetch`; `getToken` has no default,
 * because a caller that forgot to build one belongs in the loud crash a
 * missing function produces, not in a silent no-op.
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

async function feltoltBelso({ fajl, cim, leiras, cimkek = [], getToken, fetchImpl = fetch, szarazFutas = false, maiEgysegek, most = new Date() }) {
  if (typeof fajl !== 'string' || fajl === '') refuse('argumentum_hibas', 'fajl kötelező')
  if (typeof cim !== 'string' || cim === '') refuse('argumentum_hibas', 'cim kötelező')
  if (typeof leiras !== 'string') refuse('argumentum_hibas', 'leiras kötelező')
  if (!Array.isArray(cimkek)) refuse('argumentum_hibas', 'cimkek: lista kell')
  if (!szarazFutas && typeof getToken !== 'function') refuse('argumentum_hibas', 'getToken kötelező, ha a hívás nem száraz futás')

  // THE QUOTA GATE, BEFORE ANYTHING ELSE TOUCHES A TOKEN OR THE NETWORK. See
  // the file docblock for why this is the module's own counter and why the
  // number is documentation, not measurement.
  const eddig = typeof maiEgysegek === 'number' ? maiEgysegek : aktualisEgysegek(most)
  if (eddig + KVOTA_EGYSEG_FELTOLTES > KVOTA_NAPI_ALAP) {
    refuse(
      'kvota_elfogyott',
      `a napi YouTube feltöltési kvóta elfogyott: ez a feltöltés ${KVOTA_EGYSEG_FELTOLTES} egységbe kerülne, a napi keret ${KVOTA_NAPI_ALAP} egység, és ma már ${eddig} egység el van könyvelve -- próbáld holnap újra`,
    )
  }

  const metaadat = { snippet: { title: cim, description: leiras, tags: cimkek }, status: { privacyStatus: 'public', selfDeclaredMadeForKids: false } }
  const kerés = { url: FELTOLTES_URL, metaadat, fajl }

  // A DRY RUN NEVER TOUCHES getToken OR fetchImpl. See the file docblock:
  // inspecting the request is the one thing an operator needs before there
  // is an account to authenticate with at all.
  if (szarazFutas) return { szaraz: true, kerés }

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

  let tartalom
  try {
    tartalom = fs.readFileSync(fajl)
  } catch {
    refuse('video_fajl_olvashatatlan', 'a feltöltendő videófájl nem olvasható a lemezről')
  }

  const test = Buffer.concat([
    Buffer.from(`--${HATAR}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metaadat)}\r\n--${HATAR}\r\nContent-Type: video/*\r\n\r\n`, 'utf8'),
    tartalom,
    Buffer.from(`\r\n--${HATAR}--`, 'utf8'),
  ])

  const lejarat = new AbortController()
  const oraJel = setTimeout(() => lejarat.abort(), FELTOLTES_IDOTULLEPES_MS)
  let res
  try {
    res = await fetchImpl(FELTOLTES_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/related; boundary=${HATAR}` },
      body: test,
      signal: lejarat.signal,
    })
  } catch {
    if (lejarat.signal.aborted) refuse('feltoltes_idotullepes', 'a YouTube-feltöltés nem fejeződött be a megengedett időn belül')
    refuse('feltoltes_atviteli_hiba', 'a YouTube-feltöltés a hálózaton hiúsult meg, mielőtt válasz érkezett volna')
  } finally {
    clearTimeout(oraJel)
  }

  if (!res.ok) {
    refuse('feltoltes_elutasitva', `a YouTube elutasította a feltöltést (státusz ${res.status})`, { httpStatus: res.status })
  }

  let json
  try {
    json = await res.json()
  } catch {
    refuse('feltoltes_valasz_ertelmezhetetlen', 'a YouTube válasza nem érvényes JSON')
  }
  const kulsoId = json && typeof json.id === 'string' && json.id !== '' ? json.id : null
  if (kulsoId === null) refuse('feltoltes_valasz_ertelmezhetetlen', 'a YouTube válasza nem tartalmaz videó-azonosítót')

  egysegetKonyvel(KVOTA_EGYSEG_FELTOLTES, most)
  return { url: `https://youtu.be/${kulsoId}`, kulsoId }
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
 * (src/szoveg.mjs's `olvasSzoveg`); a value that does not parse back is this
 * function's own named refusal (`ag_szoveg_olvashatatlan`) rather than a
 * `SyntaxError` escaping into `publishDue`'s catch, where it would land as
 * the unnamed `kikuldes_hiba` fallback.
 *
 * No `cimkek`: the schema `publishDraft` writes to has no tag field (design
 * spec 3 never added one), so every upload from this pipeline goes out
 * untagged until a later task adds one.
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
    let szoveg
    try {
      szoveg = JSON.parse(ag.szoveg)
    } catch {
      const err = new Error('a mentett YouTube szöveg nem olvasható vissza')
      err.code = 'ag_szoveg_olvashatatlan'
      throw err
    }
    if (!video || typeof video.out_path !== 'string' || video.out_path === '') {
      const err = new Error('a videónak nincs feltölthető fájlja')
      err.code = 'video_fajl_hianyzik'
      throw err
    }
    const eredmeny = await feltolt({ fajl: video.out_path, cim: szoveg.cim, leiras: szoveg.leiras, getToken, fetchImpl, szarazFutas })
    if (eredmeny.error) {
      const err = new Error(eredmeny.error.message)
      err.code = eredmeny.error.code
      throw err
    }
    return eredmeny
  }
}
