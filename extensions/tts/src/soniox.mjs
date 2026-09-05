import { Buffer } from 'node:buffer'

/**
 * The one place this extension talks to the provider.
 *
 * WHAT IS KNOWN AND WHAT IS ASSUMED
 * ---------------------------------
 * The endpoint URL is an operator setting; this file hardcodes none, because
 * a wrong one typed here would turn a good key's refusal into a transport
 * failure and the two must not look alike. Everything below about the wire is
 * an assumption the first live call with a funded account will confirm or
 * correct, and it is kept in three small functions so that one file changes
 * when the real shape is seen:
 *
 *   `buildRequest`    the request: a POST with a bearer token and a JSON body
 *                     of `text`, `model`, `voice`, `language`, `audio_format`.
 *                     This is the shape the Soniox text-to-speech
 *                     documentation described when this was written; it has
 *                     not been exercised against the service.
 *   `readAudio`       the answer: either raw `audio/mpeg` bytes, or a JSON
 *                     object carrying base64 under `audio` or `audio_base64`.
 *                     Either way the bytes must start like an mp3 (an ID3 tag
 *                     or an MPEG frame sync), because the caller names the
 *                     file `.mp3` and ffprobe would happily measure a wav
 *                     stored under that name.
 *   `egyenlegKimerultE` which non-2xx answer means "no balance". A guess, and
 *                     named as one where it is written; `classifyRefusal` does
 *                     nothing but turn its answer into an error.
 *
 * THE CONTAINER, IN ONE FILE
 * --------------------------
 * "Soniox returns mp3" is a single assumption with three consequences, and
 * all three are stated here so the first funded call that shows wav or opus
 * is one file's worth of editing:
 *
 *   AUDIO_FORMAT        what `buildRequest` asks the provider for
 *   HANG_KITERJESZTES   the suffix a target path must carry, applied by
 *                       `celFajlEllenorzes` (synthesize.mjs)
 *   `looksLikeMp3`      how the first bytes are recognised, applied to a
 *                       reply here in `readAudio` and to an operator's own
 *                       file by `importCache` (rpc.mjs)
 *
 * Three call sites still read them, in three files, and that is the honest
 * count: what is confined is the assumption, not the number of places that
 * act on it. The one thing not derived from here is `importCache`'s refusal
 * label `fajl_nem_mp3`, which is a stored string the page shows; a container
 * change has to rename that too.
 *
 * THE CODES, A CLOSED SET
 * -----------------------
 * A service that answered with nothing, one that could not be asked, one that
 * did not answer in time, and one that refused are four different facts, and
 * a refusal for lack of balance is a fifth the operator will meet before any
 * other. Each is its own code, so nothing downstream has to read a message:
 *
 *   tts_halozat                     the request could not be made, or the
 *                                   connection broke BEFORE a status line:
 *                                   DNS, TLS, a reset
 *   tts_idotullepes                 the deadline passed before a status line
 *                                   arrived; the request was aborted
 *   tts_egyenleg_kimerult           the provider refused for lack of balance
 *                                   (by the guess in `egyenlegKimerultE`)
 *   tts_szolgaltato_visszautasitott any other non-2xx answer; the HTTP status
 *                                   is in the message and on `httpStatus`
 *   tts_valasz_ertelmezhetetlen     a 2xx that carried no usable audio: empty,
 *                                   not JSON when it said it was, a JSON with
 *                                   no audio field, or bytes that are not mp3
 *   tts_valasz_megszakadt           a 2xx whose body then broke off or ran
 *                                   out of time
 *
 * WHERE THE 2XX LINE FALLS, AND WHY IT DECIDES THE MONEY. The status line is
 * the only evidence this side has about whether the provider did the work. A
 * 2xx means it accepted the request and began sending audio, and on a metered
 * API that is the moment the call becomes billable; what happens to the body
 * afterwards is this side's problem, not evidence that the provider was free.
 * So every failure after a 2xx has its own code and all of them are in
 * `FIZETETT_KODOK`, which is the list the synthesis layer charges for. A
 * broken socket three lines apart from a 2xx used to read as `tts_halozat`
 * and hand back the whole reservation, which meant the same evidence reached
 * opposite conclusions depending on which line of this file saw it.
 *
 * The rest of the set belongs to the synthesis layer and is listed here so
 * the whole vocabulary is in one place:
 *
 *   tts_kulcs_hianyzik              the apiKey setting is empty
 *   tts_vegpont_hianyzik            the endpoint setting is empty
 *   tts_gyoker_hianyzik             the hangGyoker setting is empty, so there
 *                                   is no directory a target path may sit in
 *   tts_beallitas_hibas             a setting, or an argument of this
 *                                   module's own such as `timeoutMs`, is
 *                                   present and cannot be honoured
 *   tts_keret_kimerult              this extension's own daily cap is spent
 *   tts_celfajl_ervenytelen         the target path is refused: not absolute,
 *                                   not .mp3, or outside the configured root
 *   tts_celfajl_foglalt             a file is already there and no request row
 *                                   names it, so it is not this extension's
 *                                   to replace
 *   tts_szoveg_ervenytelen          the text is empty or too long
 *   tts_hossz_meres_sikertelen      the audio arrived and ffprobe could not
 *                                   measure it
 *   tts_fajl_iras_sikertelen        the audio arrived and could not be put
 *                                   where the caller asked for it
 *
 * THE DEADLINE
 * ------------
 * `fetch` has no timeout of its own and nothing in this codebase supplies
 * one, so a request that never answers would hang its caller forever: for the
 * video module that is a scheduled run stuck with no row to say why. Every
 * call here runs under one `AbortController` armed before the request goes
 * out and cleared only after the body has been read, so headers that never
 * come and a body that never ends are cut off alike. The signal is passed to
 * `fetchImpl`, so on the real `fetch` this is a cancellation, not a race: the
 * socket is closed. Whatever the abort surfaces as, the controller's own
 * `aborted` flag is what names it, not the error's class or message.
 *
 * The text is untrusted: strangers wrote it. It goes into the JSON body and
 * nowhere else. No message thrown from here contains it, the endpoint, or the
 * key.
 */

/**
 * How long one synthesis may take, headers and body together. A sentence of
 * mp3 is a few hundred kilobytes and the provider answers in seconds; a
 * minute is far above that and far below anything a caller would wait for
 * without a row to show for it.
 */
export const REQUEST_TIMEOUT_MS = 60_000

/**
 * The largest body this will read into memory. A sentence of narration is
 * well under a megabyte; a reply larger than this is not the audio that was
 * asked for, whatever its status line says.
 */
export const MAX_AUDIO_BYTES = 32 * 1024 * 1024

export class TtsError extends Error {
  /**
   * @param {string} code one of TTS_KODOK
   * @param {string} message for a person; never carries the text, the key or the endpoint
   * @param {{ httpStatus?: number, maiMasodperc?: number, napiKeret?: number, alap?: string }} [extra]
   */
  constructor(code, message, extra = {}) {
    super(message || code)
    this.name = 'TtsError'
    this.code = code
    if (extra.httpStatus !== undefined) this.httpStatus = extra.httpStatus
    if (extra.maiMasodperc !== undefined) this.maiMasodperc = extra.maiMasodperc
    if (extra.napiKeret !== undefined) this.napiKeret = extra.napiKeret
    if (extra.alap !== undefined) this.alap = extra.alap
  }
}

export const TTS_KODOK = Object.freeze([
  'tts_kulcs_hianyzik',
  'tts_vegpont_hianyzik',
  'tts_gyoker_hianyzik',
  'tts_beallitas_hibas',
  'tts_keret_kimerult',
  'tts_egyenleg_kimerult',
  'tts_szolgaltato_visszautasitott',
  'tts_valasz_ertelmezhetetlen',
  'tts_valasz_megszakadt',
  'tts_halozat',
  'tts_idotullepes',
  'tts_celfajl_ervenytelen',
  'tts_celfajl_foglalt',
  'tts_szoveg_ervenytelen',
  'tts_hossz_meres_sikertelen',
  'tts_fajl_iras_sikertelen',
])

/**
 * The codes whose call the provider was paid for. The synthesis layer charges
 * exactly these to the day's counter when no measurement exists, and releases
 * the reservation for everything else.
 *
 * Membership is decided by one fact and nothing else: did a 2xx status line
 * arrive? On a metered API the safe default is to charge what cannot be
 * proven free, and a 2xx is the provider saying it took the work. Both codes
 * here are raised only after `res.ok` was true.
 */
export const FIZETETT_KODOK = Object.freeze(['tts_valasz_ertelmezhetetlen', 'tts_valasz_megszakadt'])

/**
 * The container this extension asks for and accepts. See THE CONTAINER, IN
 * ONE FILE above: these two and `looksLikeMp3` are the whole of the mp3
 * assumption, and the three call sites read them from here.
 */
export const AUDIO_FORMAT = 'mp3'
export const HANG_KITERJESZTES = '.mp3'

/**
 * The request as the Soniox documentation described it when this was
 * written. One function, so the day the real shape differs it changes here.
 */
function buildRequest({ apiKey, modell, hang, nyelv, szoveg, signal }) {
  return {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      accept: 'audio/mpeg, application/json',
    },
    body: JSON.stringify({ text: szoveg, model: modell, voice: hang, language: nyelv, audio_format: AUDIO_FORMAT }),
    signal,
  }
}

/**
 * Whether these bytes start the way an mp3 file does: an ID3v2 tag, or an
 * MPEG audio frame sync (eleven set bits). This is a check on the first bytes
 * only; it says the answer is an mp3, not that the mp3 is whole.
 */
export function looksLikeMp3(bytes) {
  if (bytes.length < 3) return false
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return true
  return bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0
}

/** Every string inside a parsed JSON value, to a small depth, for the guess below to read. */
function collectStrings(value, depth, out) {
  if (depth < 0 || out.length >= 32) return
  if (typeof value === 'string') { out.push(value); return }
  if (Array.isArray(value)) { for (const v of value) collectStrings(v, depth - 1, out); return }
  if (value && typeof value === 'object') for (const v of Object.values(value)) collectStrings(v, depth - 1, out)
}

/**
 * THIS FUNCTION IS A GUESS. It is the whole of the guess, and it is here alone
 * so that a real observation replaces it in one place.
 *
 * The brief said every non-2xx is `tts_szolgaltato_visszautasitott`, and that
 * a separate code for an exhausted account is added once that status has
 * actually been seen (spec 13.). It has not been seen: this account has never
 * made a funded call. The code exists ahead of that observation because the
 * operator's balance is spent and the refusal is the first thing they will
 * meet, and this rule is what stands in until the real answer is recorded.
 *
 * Because it is a guess, it is written to be wrong in the safe direction: an
 * answer this does not recognise degrades to `tts_szolgaltato_visszautasitott`
 * with its HTTP status, which is always a true statement, whereas an answer
 * this recognises wrongly tells the operator to go and top up an account that
 * is fine. So:
 *
 *   - HTTP 402 alone (`http-402`). That status *is* "payment required"; no
 *     body is read for it.
 *   - a 4xx whose JSON error text *asserts* that this account is out of money
 *     (`hibaszoveg`). Only phrases that pair a money noun with an exhaustion
 *     word count. A body that merely mentions money -- "billing", "top up", a
 *     link to a pricing or billing page -- is not an assertion about this
 *     account, so URLs are removed before matching and the bare words are not
 *     patterns at all.
 *
 * "quota" is never enough on its own: it is a rate limit as often as a
 * balance. Nor is "insufficient": it is a permission as often as a credit.
 * A 5xx body is never read for phrases -- a server fault is not a statement
 * about an account.
 *
 * Returns the value for `alap` when the answer reads as exhaustion, and null
 * otherwise. Nothing from the body is ever quoted back out.
 */
export function egyenlegKimerultE(status, json) {
  if (status === 402) return 'http-402'
  if (status < 400 || status >= 500 || json === undefined) return null
  const strings = []
  collectStrings(json, 3, strings)
  // A documentation or billing-portal link is where these words most often
  // appear in a body that has nothing to do with the balance.
  const text = strings.join('\n').replace(/\bhttps?:\/\/\S+/gi, ' ')
  const minta = [
    /insufficient (balance|credits?|funds)/i,
    /(balance|credits?|funds)\b[^.]{0,40}\b(exhausted|depleted|insufficient|empty|zero|too low)/i,
    /\b(no|out of|not enough) (balance|credits?|funds)\b/i,
  ]
  return minta.some((re) => re.test(text)) ? 'hibaszoveg' : null
}

/**
 * The error for a non-2xx answer. Everything this decides comes from
 * `egyenlegKimerultE` above; `alap` records which of its two rules fired, so a
 * reader of the row can tell a status code's definition from a phrase match.
 * Anything it does not claim is `tts_szolgaltato_visszautasitott` with the
 * status in the message. The body is classified, never quoted.
 */
export function classifyRefusal(status, json) {
  const alap = egyenlegKimerultE(status, json)
  if (alap === 'http-402') {
    return new TtsError('tts_egyenleg_kimerult', 'a szolgáltató HTTP 402-vel utasított el: nincs egyenleg', { httpStatus: status, alap })
  }
  if (alap === 'hibaszoveg') {
    return new TtsError('tts_egyenleg_kimerult', `a szolgáltató HTTP ${status}-tal utasított el, és a hibaszövege az egyenleget nevezi meg`, { httpStatus: status, alap })
  }
  return new TtsError('tts_szolgaltato_visszautasitott', `a szolgáltató HTTP ${status}-t adott`, { httpStatus: status })
}

/** Release an unread body. A double without a stream has nothing to release. */
async function cancelBody(res) {
  try {
    if (res.body && typeof res.body.cancel === 'function') await res.body.cancel()
  } catch {
    // Already closed or already read: nothing is held either way.
  }
}

/** A parsed JSON body when the reply says it is JSON and parses; otherwise undefined. */
async function readJsonIfDeclared(res) {
  const type = (res.headers.get('content-type') || '').toLowerCase()
  if (!type.startsWith('application/json')) {
    // The body is still consumed: an unread body keeps its connection open on
    // the real fetch until the response is collected.
    await res.arrayBuffer()
    return undefined
  }
  try {
    return await res.json()
  } catch {
    return undefined
  }
}

/**
 * The audio out of a 2xx reply, or a `tts_valasz_ertelmezhetetlen` error.
 * Raw bytes under an audio content type, or base64 under `audio` /
 * `audio_base64` in a JSON object; either way the result must start like an
 * mp3.
 */
async function readAudio(res) {
  const type = (res.headers.get('content-type') || '').toLowerCase()
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_AUDIO_BYTES) {
    // The one exit that never reads the body: release it, or on the real
    // fetch the connection stays open until the response is collected.
    await cancelBody(res)
    throw new TtsError('tts_valasz_ertelmezhetetlen', `a válasz ${declared} bájt, a felső határ ${MAX_AUDIO_BYTES}`, { httpStatus: res.status })
  }
  let bytes
  if (type.startsWith('application/json')) {
    let json
    try {
      json = await res.json()
    } catch {
      throw new TtsError('tts_valasz_ertelmezhetetlen', 'a válasz JSON-nak mondta magát, de nem az', { httpStatus: res.status })
    }
    const b64 = json && typeof json === 'object' && !Array.isArray(json)
      ? (typeof json.audio === 'string' ? json.audio : (typeof json.audio_base64 === 'string' ? json.audio_base64 : ''))
      : ''
    if (b64 === '') throw new TtsError('tts_valasz_ertelmezhetetlen', 'a JSON-válaszban nincs audio mező', { httpStatus: res.status })
    bytes = Buffer.from(b64, 'base64')
  } else {
    bytes = Buffer.from(await res.arrayBuffer())
  }
  if (bytes.length === 0) throw new TtsError('tts_valasz_ertelmezhetetlen', 'üres válasz', { httpStatus: res.status })
  if (bytes.length > MAX_AUDIO_BYTES) {
    throw new TtsError('tts_valasz_ertelmezhetetlen', `a válasz ${bytes.length} bájt, a felső határ ${MAX_AUDIO_BYTES}`, { httpStatus: res.status })
  }
  if (!looksLikeMp3(bytes)) throw new TtsError('tts_valasz_ertelmezhetetlen', 'a válasz nem mp3-ként kezdődik', { httpStatus: res.status })
  return bytes
}

/**
 * One synthesis: the text in, mp3 bytes out, or a `TtsError` from the closed
 * set above. `fetchImpl` defaults to the global `fetch`; a test passes a
 * double and no request leaves the machine. `timeoutMs` absent means the
 * default; present and not a positive finite number is refused, not coerced.
 *
 * The deadline covers the whole exchange. The timer is cleared in `finally`,
 * which runs only after the body has been read or the call has thrown, so a
 * call that finished leaves nothing armed. On the abort path the rejection
 * from `fetchImpl` or from the body read is the one caught below and named
 * by the `aborted` flag; no other promise is left dangling.
 */
export async function synthesizeRemote({ endpoint, apiKey, modell, hang, nyelv, szoveg, fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS }) {
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TtsError('tts_beallitas_hibas', 'timeoutMs: pozitív véges szám kell')
  }
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(), timeoutMs)
  const timedOut = () => new TtsError('tts_idotullepes', `a szolgáltató nem válaszolt ${timeoutMs} ms alatt`)
  try {
    let res
    try {
      res = await fetchImpl(endpoint, buildRequest({ apiKey, modell, hang, nyelv, szoveg, signal: deadline.signal }))
    } catch (err) {
      if (deadline.signal.aborted) throw timedOut()
      throw new TtsError('tts_halozat', `a kérés nem ment ki: ${transportReason(err)}`)
    }
    if (!res.ok) {
      let json
      try {
        json = await readJsonIfDeclared(res)
      } catch {
        if (deadline.signal.aborted) throw timedOut()
        json = undefined
      }
      throw classifyRefusal(res.status, json)
    }
    try {
      return await readAudio(res)
    } catch (err) {
      // Past the 2xx. The provider accepted the work and started sending
      // audio, so a body that then breaks off or runs out of time is not a
      // call that cost nothing: it gets its own code and is charged (see
      // FIZETETT_KODOK). `tts_halozat` and `tts_idotullepes` stay what they
      // say they are -- a call that never got a status line.
      if (deadline.signal.aborted) {
        throw new TtsError('tts_valasz_megszakadt', `a szolgáltató elkezdett válaszolni, de a test nem ért ide ${timeoutMs} ms alatt`, { httpStatus: res.status })
      }
      if (err instanceof TtsError) throw err
      throw new TtsError('tts_valasz_megszakadt', `a válasz teste megszakadt: ${transportReason(err)}`, { httpStatus: res.status })
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * A short reason for a transport failure: the error code, never the message.
 * Node's fetch throws `TypeError: fetch failed` with the real reason on
 * `cause`, so the cause's code (ECONNREFUSED, ENOTFOUND, a TLS code) is the
 * useful part. When there is no code the error's class name is all that is
 * repeated, because a runtime's message may spell out the URL it was given
 * and the endpoint is not this module's to quote.
 */
function transportReason(err) {
  const cause = err && typeof err === 'object' ? err.cause : undefined
  if (cause && typeof cause === 'object' && typeof cause.code === 'string') return cause.code
  if (err && typeof err === 'object' && typeof err.code === 'string') return err.code
  return err instanceof Error && err.name ? err.name : 'ismeretlen ok'
}
