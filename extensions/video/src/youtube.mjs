import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { refuse } from './args.mjs'
import { head } from './db.mjs'
import { MAX_CIM } from './terv.mjs'

/**
 * The one source this module can reach on its own: the recent uploads of the
 * channels the operator listed.
 *
 * WHAT THIS IS FOR. The board's two other sources both need somebody to act
 * first -- a saved AI Signal card, or text the operator pasted -- and neither
 * answers the question "what is worth making a video about today". This file
 * answers it from one press of one button: read the channels' newest uploads,
 * drop the ones this module already opened a video from, and let the rest
 * become cards.
 *
 * IT IS NOT REACHABLE FROM A TOOL, ON PURPOSE. `videoOpen`'s `forras` list is
 * `signal` and `kezi` (src/terv.mjs, FORRASOK) and stays that way: this source
 * spawns a process and makes a request to a third party, and an agent that
 * could start it on its own would be a scheduled run reaching the network on
 * every turn. One operator button is the whole surface.
 *
 * TWO STEPS PER CHANNEL, AND WHY IT IS NOT ONE.
 *
 *   1. RESOLVE the channel to its `UC...` id. yt-dlp does this, because
 *      turning `@lexfridman` (or a `/c/`, `/user/` url) into a channel id
 *      means reading YouTube's own page, and this module does not scrape
 *      pages. When the operator already wrote a `/channel/UC...` url, or a
 *      bare `UC...` id, THE ID IS TAKEN FROM THAT STRING AND NO PROCESS IS
 *      STARTED AT ALL -- there is nothing to resolve, and spawning yt-dlp to
 *      be told what the operator already typed would be seconds spent per
 *      press for nothing.
 *   2. READ THE CHANNEL'S ATOM FEED,
 *      `https://www.youtube.com/feeds/videos.xml?channel_id=<id>`, one GET.
 *      It carries the ~15 newest uploads, newest first, each with a real ISO
 *      `published` and a view count.
 *
 * WHY NOT yt-dlp FOR THE LISTING TOO. Measured by hand against a real channel
 * with the binary this module ships a path to (2025.08.20):
 *
 *   - `--flat-playlist` gives id and title and NOTHING ELSE: `upload_date`,
 *     `timestamp` and `view_count` all come back as `NA`, with or without
 *     `youtubetab:approximate_date`. The entries are `_type: url` stubs.
 *   - Dropping `--flat-playlist` is not the answer either: full extraction
 *     fails outright on this version with "The page needs to be reloaded"
 *     (the SABR block, yt-dlp issue #12482).
 *   - `--extractor-args "youtube:player_client=android"` changes the flat
 *     listing not at all -- byte-for-byte identical output -- so it is not
 *     passed. A flag that changes nothing today is a flag that changes
 *     something nobody asked for later.
 *
 * An earlier version of this file listed with `--flat-playlist` and kept
 * candidates whose date was unknown, because every date was unknown. That
 * left the `napok` window unable to ever fire and left the operator unable to
 * see how fresh an idea was -- on a button whose whole point is "friss
 * feltöltések". The feed carries the dates, so the window is real now and an
 * entry with no readable date is DROPPED and counted: that direction is the
 * honest one and can no longer empty the board, because the feed dates every
 * entry it carries.
 *
 * WHAT IT DOES WITH WHAT COMES BACK: as little as possible. Titles are
 * strangers' text and are carried through untouched (unescaped from XML, and
 * nothing else) for the page to render as React text children. The video id
 * is CHECKED against a shape (`ID_ALAK`) and the watch url is then built here
 * from the checked id and this module's own constant; the same holds for the
 * channel id and the feed url. A url is never taken from, or assembled out
 * of, text that arrived over the network -- not from yt-dlp's stdout and not
 * from the feed's own `<link href=...>`, which is exactly the field it would
 * be easiest to trust.
 *
 * THE PROCESS IS AN ARGUMENT VECTOR, NEVER A SHELL, with a per-channel
 * timeout and a `maxBuffer` (the pattern `probeDurationMs` uses in
 * src/narracio.mjs). The request is under a deadline of its own, the pattern
 * `getJson` uses in extensions/aisignal/src/research.mjs -- read for its
 * shape, imported from never: an extension may not depend on another
 * extension's internals.
 */

/**
 * What the module runs when the operator has not named a path.
 *
 * THE BARE NAME, AND A MAINTAINER'S HOME DIRECTORY IS NOT A DEFAULT. This was
 * an absolute path under one developer's `~`, duplicated as the manifest's
 * `defaultValue`, so on every other machine -- and this repo ships inside the
 * Electron desktop app -- the button failed `ytdlp_hianyzik` on the first
 * press, over a setting that looked filled in.
 *
 * A bare name does depend on the PATH the host process inherited, which is the
 * reason the full path was written in the first place, and that reason is
 * weaker than it looks: a miss is already a NAMED refusal that says which
 * setting to fill in, so the cost of guessing wrong is one sentence, while the
 * cost of guessing another machine's filesystem is a button that cannot work
 * anywhere. `ytDlpUtvonal` stays the answer for a host with a narrow PATH, and
 * its help text says so.
 */
export const YT_DLP_ALAP = 'yt-dlp'

/**
 * Candidates one channel may contribute. The feed carries about fifteen
 * entries, so this does not bind today; it is here so a feed that answers
 * with thousands -- a shape this module did not expect -- cannot fill the
 * answer on its own.
 */
export const PER_CSATORNA_LIMIT = 50

/**
 * What one press of the button may open, and the reason it is not the daily
 * cap. See the `youtubeOtletek` docblock in src/rpc.mjs, which is where the
 * decision belongs; the number lives here with the module's other bounds so
 * the page and the tests read one definition of it.
 */
export const YOUTUBE_OTLET_MAX = 10

/** The resolve step, per channel. Generous, because it is a process start plus one page fetch. */
const RESOLVE_TIMEOUT_MS = 60_000

/** The feed read, per channel. One GET of about sixty kilobytes. */
const FEED_TIMEOUT_MS = 20_000

/** yt-dlp prints one line here; this is room for a version banner beside it. */
const MAX_BUFFER = 1024 * 1024

/**
 * The most feed this module will accept from a channel. The real feed is about
 * sixty kilobytes for fifteen entries, so this is twenty times the observed
 * size and will not bind on anything YouTube sends.
 *
 * It exists because the process side has an explicit `maxBuffer` and the
 * request side had nothing: `res.text()` reads whatever arrives. A body over
 * the cap is REFUSED BY NAME and not truncated -- a truncated feed is a
 * different feed, and this module would then report a channel's newest videos
 * from a document that stops mid-entry.
 */
const MAX_FEED_BYTE = 4 * 1024 * 1024

/**
 * A YouTube video id, as this module will accept one before building a url
 * out of it. Eleven characters is what YouTube issues today; the range is
 * wider so an id scheme that grows is not refused for a cosmetic reason,
 * while the character class keeps out everything that could make the url mean
 * something else -- a slash, a dot, a query separator, whitespace.
 */
const ID_ALAK = /^[A-Za-z0-9_-]{5,32}$/

/** A channel id, by the same rule and for the same reason: it goes into the feed url this module builds. */
const CSATORNA_ID_ALAK = /^UC[A-Za-z0-9_-]{10,40}$/

/** The channel id inside a url the operator wrote, so the resolve step can be skipped entirely. */
const CSATORNA_URL_ALAK = /\/channel\/(UC[A-Za-z0-9_-]{10,40})(?:[/?#]|$)/

const UA = 'swarmclaw-video/0.1 (+youtube ideas button)'

const execFileAsync = promisify(execFile)

/**
 * The channel list from the settings, normalised, or a refusal naming the
 * field to fill.
 *
 * AN EMPTY LIST IS A REFUSAL, NOT A ZERO. A question nobody asked and a
 * question answered with "nothing" are two different facts, and the button
 * returning "0 new ideas" over an unconfigured module would send the operator
 * looking at their channels instead of at the settings.
 *
 * Two shapes are normalised into urls, because both are things YouTube shows
 * an operator and neither is a url: an `@handle`, and a bare `UC...` channel
 * id. The second becomes a `/channel/` url specifically so that ONE rule --
 * "does this string carry a channel id" -- covers both it and the url form,
 * and both skip the resolve step.
 *
 * Anything else is passed through as typed rather than refused. These entries
 * are the OPERATOR'S own configuration, not text that arrived over the
 * network, and yt-dlp failing on a mistyped one lands in `csatornaHibak`
 * naming the entry, which tells the operator more than a validation message
 * would.
 */
export function csatornakOf(state) {
  const raw = (state.settings() || {}).youtubeCsatornak
  const nyers = typeof raw === 'string' ? raw : ''
  const lista = nyers.split(',').map((s) => s.trim()).filter((s) => s !== '')
    .map((s) => {
      if (s.startsWith('@')) return `https://www.youtube.com/${s}`
      if (CSATORNA_ID_ALAK.test(s)) return `https://www.youtube.com/channel/${s}`
      return s
    })
  if (lista.length === 0) refuse('youtube_nincs_csatorna', 'nincs beállítva YouTube-csatorna: a modul beállításai közt a youtubeCsatornak mezőbe írj csatorna-URL-eket vagy @handle-öket, vesszővel elválasztva')
  return lista
}

/**
 * The yt-dlp path from the settings, or this module's own default.
 *
 * The settings field carries the same path as `defaultValue`, and that is not
 * what makes this fallback unnecessary: a field the operator CLEARS stores ''
 * rather than undefined, and the host's default never fires again (index.mjs
 * says so above `napiSapka`). This reader is the only thing that can turn a
 * blank setting back into a working value.
 */
export function ytDlpUtvonalOf(state) {
  const raw = (state.settings() || {}).ytDlpUtvonal
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : YT_DLP_ALAP
}

/** The channel id the operator already wrote, or null when it has to be resolved. */
export const csatornaIdBol = (csatorna) => {
  const m = CSATORNA_URL_ALAK.exec(csatorna)
  return m === null ? null : m[1]
}

/**
 * XML's five named entities, in the one order that is correct.
 *
 * `&amp;` LAST. Undoing it first would turn the feed's own `&amp;lt;` -- how a
 * title containing a literal `&lt;` is written -- into `<`, which is this
 * function inventing markup that the channel never wrote. Every other entity
 * is undone before the ampersand that could have produced it.
 *
 * Numeric references are not decoded beyond the one YouTube actually emits
 * (`&#39;`): a general numeric decoder is a second escaping surface for a
 * title that this module only ever renders as a React text child.
 */
const xmlBol = (s) => s
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'")
  .replace(/&apos;/g, "'")
  .replace(/&amp;/g, '&')

/** The first `<tag>...</tag>` inside one entry, unescaped, or ''. Deliberately not greedy and deliberately not across entries. */
function mezo(entry, tag) {
  const m = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(entry)
  return m === null ? '' : xmlBol(m[1])
}

/**
 * `<media:statistics views="N"/>`, or null.
 *
 * Null rather than 0 for an entry that does not carry it: a video nobody has
 * watched and a feed that did not say are different facts, and the card would
 * print the second as the first.
 */
function nezettsegOf(entry) {
  const m = /<media:statistics\b[^>]*\bviews="(\d{1,15})"/.exec(entry)
  return m === null ? null : Number(m[1])
}

/** One entry's opening and closing tag, with an optional namespace prefix. See `feedJeloltek` below for why this is a pattern and not seven bytes. */
const ENTRY_NYIT = /<(?:[A-Za-z_][\w.-]*:)?entry[\s>]/
const ENTRY_ZAR = /<\/(?:[A-Za-z_][\w.-]*:)?entry\s*>/

/**
 * The feed's entries as candidates, plus how many it would not take.
 *
 * NO XML LIBRARY. This reads four fields out of a document whose shape is
 * fixed by YouTube and by the Atom spec, and the alternative is a parser
 * dependency in an extension bundle that ships to a browser page. The reader
 * works per `<entry>` BLOCK rather than over the whole document, which is the
 * part that matters: the feed carries a channel-level `<published>` and a
 * channel-level `<title>` of its own, and a document-wide search for either
 * would attribute the channel's creation date to the newest video.
 *
 * An entry missing an id or a date is DROPPED WHOLE and counted, never
 * half-built: a candidate with an id and no date would be a card the window
 * filter cannot judge, and one with a date and no id would be a card that
 * cannot become a url.
 *
 * `atom` AND `blokkok` ARE OBSERVATIONS, NOT DECORATION, and between them
 * they let the caller tell four states apart that all yield no candidate:
 *
 *   atom false                 the body was never an Atom document -- a
 *                              consent interstitial, a rate-limit page, or an
 *                              error page served with HTTP 200
 *   atom, blokkok 0            a REAL feed carrying no entry: a channel with
 *                              no public uploads at all
 *   atom, blokkok > 0, none
 *   of them usable             the feed's entries drifted out of the shape
 *                              this reader knows
 *   atom, usable entries       an ordinary feed; whether any of them is fresh
 *                              is the caller's window to decide
 *
 * `eldobott` cannot make the first distinction and that is the whole reason
 * these two exist: it counts entries the module refused, and a body with no
 * entry block produces ZERO drops rather than fifteen.
 *
 * `atom` is one cheap observation over a string this function already walks --
 * an opening `<feed` tag, or the Atom namespace uri. Either alone is enough:
 * requiring both would fail a feed whose namespaces are arranged differently,
 * and neither appears in the error pages this is meant to catch.
 *
 * THE ENTRY TAG IS MATCHED AS A TAG, NOT AS SEVEN BYTES, and this is the one
 * place the two observations could contradict each other. A literal
 * `'<entry>'` split misses `<atom:entry>` and `<entry xml:lang="hu">` -- both
 * of which still carry the namespace uri, so `atom` stays true, `blokkok`
 * comes back 0, and the caller files the channel as
 * `csatorna_nincs_feltoltes`: a drifted feed reported to the operator as a
 * channel that is perfectly fine and has simply published nothing. That is the
 * "two facts, one code, and the sentence is false about one" defect this file
 * spends sixty lines policing, failing in the worst direction there is. The
 * pattern therefore allows an optional namespace prefix and requires a
 * delimiter after the name, so `<entryPoint>` is not an entry. A prefixed
 * OPENING tag implies a prefixed closing one, so the split below matches the
 * same way. An entry whose FIELDS then drift out of shape is a different fact
 * and lands where it belongs: state 3, `csatorna_feed_ertelmezhetetlen`.
 */
export function feedJeloltek(xml) {
  const jeloltek = []
  let eldobott = 0
  const szoveg = typeof xml === 'string' ? xml : ''
  const atom = /<feed[\s>]/.test(szoveg) || szoveg.includes('http://www.w3.org/2005/Atom')
  const blokkok = szoveg.split(ENTRY_NYIT).slice(1)
  for (const darab of blokkok) {
    const entry = darab.split(ENTRY_ZAR)[0]
    const id = mezo(entry, 'yt:videoId')
    // THE TITLE IS BOUNDED HERE, WHERE IT IS READ, AND NOT AT THE CALLER.
    // `mezo` matches `[^<]*`, so the only thing standing between a channel's
    // `<title>` and this module's storage is `MAX_FEED_BYTE`, four megabytes.
    // The other two doors that store a stranger's text bound it at the door
    // (`nyissVideot`, src/terv.mjs), and this one could have been bounded at
    // `youtubeOtletek` the same way. It is bounded here instead because that
    // is the only place that makes the bound TRUE OF THE MODULE rather than
    // of one caller: `feedJeloltek` is an exported reader, `jeloltek` is what
    // the rpc, the tests and anything later built on this file all read, and
    // a cap one call applies is a cap the next call forgets. After this line
    // no oversized `cim` exists anywhere in the module.
    //
    // The cut is `head`, not `slice`, because `slice` counts UTF-16 units and
    // a title cut between the halves of an emoji would store a lone surrogate
    // (src/db.mjs). `MAX_CIM` comes from terv.mjs so the two doors cannot
    // drift apart on the number.
    //
    // It happens BEFORE the blank test, not after: a title of two hundred
    // spaces followed by text is still a blank title, and cutting first is
    // what keeps the drop test reading the same string that will be stored.
    const cim = head(mezo(entry, 'title'), MAX_CIM)
    const kiadva = mezo(entry, 'published')
    const ms = Date.parse(kiadva)
    if (!ID_ALAK.test(id) || cim.trim() === '' || !Number.isFinite(ms)) { eldobott += 1; continue }
    jeloltek.push({
      id,
      cim,
      url: `https://www.youtube.com/watch?v=${id}`,
      feltoltve: new Date(ms).toISOString(),
      nezettseg: nezettsegOf(entry),
    })
  }
  return { jeloltek, eldobott, blokkok: blokkok.length, atom }
}

/** Whether a rejection is this call's own deadline firing rather than the host failing. `fetch` reports its cancellation as an AbortError, sometimes wrapped. */
function hataridoVolt(e) {
  if (typeof e !== 'object' || e === null) return false
  if (e.name === 'AbortError') return true
  return typeof e.cause === 'object' && e.cause !== null && e.cause.name === 'AbortError'
}

/**
 * One GET of the channel's feed under a deadline: `{ ok: true, szoveg }` or
 * `{ ok: false, kod }` with one of this module's own per-channel codes.
 *
 * It answers rather than throws because a channel that did not answer must
 * not end the press for the other channels; the caller files the code under
 * that channel and carries on. The failure's own text is never carried: it
 * can contain a response body on some transports, and "this channel's feed
 * did not answer" is the whole of what the operator can act on.
 *
 * A NON-2xx IS NOT ONE FACT, AND `res.status` USED TO BE READ ONLY AS A SHAPE
 * GUARD. Every status that was not ok came back as `csatorna_feed_nem_valaszolt`
 * -- "próbáld meg újra" -- which is false advice for half of them. A 404 or a
 * 410 says the feed is not there: retrying is exactly what will not help, and
 * the channel id in the setting is what wants looking at. A 429 or a 5xx says
 * YouTube declined for now, and retrying is the whole of the fix. Anything else
 * refused (a 403, say) is neither: nothing here can tell the operator what it
 * is, so the sentence sends them to look. Three moves, three codes.
 *
 * WHAT STAYS FOLDED, AND IT IS A DECISION. A transport rejection and a
 * response object this module cannot read (no numeric `status`, no `text`)
 * share `csatorna_feed_nem_valaszolt`, because in both cases no answer this
 * module could read arrived and the move is the same: press again, and report
 * it if it repeats. Splitting them would name a difference the operator cannot
 * act on.
 *
 * A reply this call will not read is aborted rather than left open: on a real
 * fetch an uncollected body holds its connection.
 *
 * THE BODY IS BOUNDED, in the two places it can be. A `content-length` over
 * the cap is refused before a byte is read. A body that arrives chunked
 * carries no such header, so the length is checked again once it is in hand;
 * that second check refuses rather than truncates, but it does so AFTER the
 * string exists, and what actually bounds the reading in that case is the
 * deadline above. That residual is stated rather than papered over: closing
 * it means reading `res.body` as a stream, and a stream path that only the
 * real fetch takes -- the test doubles here answer with `text()` -- would be
 * a branch no test covers guarding the case that matters most.
 */
/** Which of the three refusals a refused status is. See `feedSzoveg` for why it is three. */
function feedStatuszKod(status) {
  if (status === 404 || status === 410) return 'csatorna_feed_nincs_meg'
  if (status === 429 || status >= 500) return 'csatorna_feed_kesobb'
  return 'csatorna_feed_elutasitva'
}

async function feedSzoveg({ url, fetchImpl }) {
  const hatarido = new AbortController()
  const timer = setTimeout(() => hatarido.abort(), FEED_TIMEOUT_MS)
  try {
    let res
    try {
      res = await fetchImpl(url, { headers: { 'user-agent': UA, accept: 'application/atom+xml, application/xml' }, signal: hatarido.signal })
    } catch (e) {
      return { ok: false, kod: hataridoVolt(e) ? 'csatorna_feed_idotullepes' : 'csatorna_feed_nem_valaszolt' }
    }
    if (!res || typeof res.status !== 'number' || typeof res.text !== 'function') return { ok: false, kod: 'csatorna_feed_nem_valaszolt' }
    if (!res.ok) {
      hatarido.abort()
      return { ok: false, kod: feedStatuszKod(res.status) }
    }
    const jelzettHossz = Number(typeof res.headers?.get === 'function' ? res.headers.get('content-length') : null)
    if (Number.isFinite(jelzettHossz) && jelzettHossz > MAX_FEED_BYTE) {
      hatarido.abort()
      return { ok: false, kod: 'csatorna_feed_tul_nagy' }
    }
    let szoveg
    try {
      szoveg = await res.text()
    } catch (e) {
      return { ok: false, kod: hataridoVolt(e) ? 'csatorna_feed_idotullepes' : 'csatorna_feed_nem_valaszolt' }
    }
    // Bytes, not UTF-16 code units: the header check above compares real
    // bytes, and one constant may not mean two units.
    if (Buffer.byteLength(szoveg, 'utf8') > MAX_FEED_BYTE) return { ok: false, kod: 'csatorna_feed_tul_nagy' }
    return { ok: true, szoveg }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The channel id, from the string when it is already in there and from yt-dlp
 * otherwise: `{ ok: true, id }` or `{ ok: false, kod }`.
 *
 * `%(playlist_channel_id)s` and not `%(channel_id)s`: measured, the second is
 * `NA` under `--flat-playlist` and the first is the resolved `UC...`.
 * `--playlist-end 1` because one entry is enough to learn whose tab it is,
 * and `--no-update` because without it the binary prints a three-line version
 * warning on every run.
 *
 * THREE ERRNOS ARE NOT ONE OF THE ANSWERS HERE. A binary that is not on the
 * given path (`ENOENT`), one that is there and not executable (`EACCES`), and
 * a path that names a directory (`EISDIR`) are all facts about the MACHINE
 * rather than about this channel: the same file is equally unusable for every
 * channel in the list, so filing them per-channel would send the operator to
 * fix N channel urls that are all fine. They propagate as the refusal of the
 * whole source that they are. `ENOENT` and the other two get different codes,
 * because the move differs -- fill the path in, versus `chmod +x` or point the
 * setting at the binary instead of its folder.
 */
async function csatornaId({ csatorna, ytDlp, execFileImpl }) {
  // The operator wrote the id, so there is nothing to resolve and no process
  // to start: this is the path that costs a press nothing.
  const irott = csatornaIdBol(csatorna)
  if (irott !== null) return { ok: true, id: irott }
  let stdout
  try {
    ({ stdout } = await execFileImpl(
      ytDlp,
      [`${csatorna}/videos`, '--flat-playlist', '--skip-download', '--playlist-end', '1', '--no-update', '--print', '%(playlist_channel_id)s'],
      { timeout: RESOLVE_TIMEOUT_MS, maxBuffer: MAX_BUFFER, windowsHide: true },
    ))
  } catch (err) {
    // The messages name the setting, never the path they were given: the rpc
    // route logs a refusal's message, and the path is a value the operator
    // stored (the rule src/args.mjs states).
    const e = err && typeof err === 'object' ? err : {}
    if (e.code === 'ENOENT') refuse('ytdlp_hianyzik', 'a beállított útvonalon nincs futtatható yt-dlp: a modul beállításai közt az ytDlpUtvonal mezőt állítsd a bináris teljes útvonalára')
    if (e.code === 'EACCES' || e.code === 'EISDIR') refuse('ytdlp_nem_futtathato', 'a beállított útvonalon van valami, de a modul nem tudja elindítani: vagy nincs rajta futtatási jog (chmod +x), vagy az ytDlpUtvonal egy mappára mutat a bináris helyett')
    // MAXBUFFER FIRST, BECAUSE NODE SETS `killed: true` ON IT TOO. A child cut
    // off for writing more than `maxBuffer` is killed exactly the way a child
    // cut off by the timeout is, so the timeout test below claims it, and the
    // operator is told to try again over a fact that will repeat every time.
    // Node's own name for it is the discriminator.
    if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return { ok: false, kod: 'csatorna_valasz_tul_hosszu' }
    return { ok: false, kod: e.killed === true || e.signal === 'SIGTERM' ? 'csatorna_idotullepes' : 'csatorna_nem_valaszolt' }
  }
  const id = String(stdout).split('\n').map((s) => s.trim()).find((s) => s !== '') || ''
  // `NA`, an error line, or anything else that is not a channel id. The feed
  // url is built from this, so a value that does not have the shape does not
  // get to be part of one.
  if (!CSATORNA_ID_ALAK.test(id)) return { ok: false, kod: 'csatorna_azonosito_ismeretlen' }
  return { ok: true, id }
}

/**
 * The channels' recent uploads as candidates, plus what was dropped and what
 * each channel had to say for itself.
 *
 * TWO FAILURES ARE ABOUT THE MACHINE AND END THE PRESS: there is no binary at
 * the configured path (`ENOENT` -> `ytdlp_hianyzik`), or there is one and it
 * cannot be started (`EACCES`, `EISDIR` -> `ytdlp_nem_futtathato`). Nothing
 * about the remaining channels can be learnt, because the same file would be
 * equally unusable for each of them, so the whole source is refused BY NAME on
 * the first channel that needs it. The operator's fix is a setting or a
 * permission bit, never a channel url.
 *
 * EVERY OTHER FACT IS ABOUT ONE CHANNEL and lands in `csatornaHibak`, which
 * is a per-channel report and not only a failure list. One code per thing that
 * happens, because the operator does something different about each:
 *
 *   csatorna_nem_valaszolt          yt-dlp could not read the channel page
 *   csatorna_idotullepes            ...and did not finish in time
 *   csatorna_valasz_tul_hosszu      ...and was cut off for writing more than
 *                                   `maxBuffer`. Node kills that child exactly
 *                                   as it kills a timed-out one, so without
 *                                   its own code it read as a timeout and the
 *                                   operator was told to retry a fact that
 *                                   repeats every press
 *   csatorna_azonosito_ismeretlen   it answered, but not with a channel id --
 *                                   a renamed handle, a deleted channel, a
 *                                   url that is not a channel at all
 *   csatorna_feed_nem_valaszolt     the id resolved; no answer this module
 *                                   could read came back at all
 *   csatorna_feed_idotullepes       ...within the deadline
 *   csatorna_feed_nincs_meg         the feed url answered 404 or 410: there is
 *                                   nothing at it, and retrying will not
 *                                   change that
 *   csatorna_feed_kesobb            it answered 429 or 5xx: declined for now,
 *                                   and the whole fix is to press again later
 *   csatorna_feed_elutasitva        it refused with some other status, which
 *                                   this module cannot interpret for anybody
 *   csatorna_feed_tul_nagy          it answered with more than this module
 *                                   will read, and a cut feed is a different
 *                                   feed
 *   csatorna_feed_ertelmezhetetlen  it answered 200 with something this module
 *                                   could get nothing out of: a body that was
 *                                   never Atom, or an Atom feed whose entries
 *                                   all drifted out of shape
 *   csatorna_nincs_feltoltes        a REAL, well-formed feed carrying no entry
 *                                   at all: the channel has no public uploads
 *   csatorna_nincs_friss            EVERYTHING WORKED, the channel has
 *                                   uploads, and none of them is inside the
 *                                   window. Not a failure, and the page words
 *                                   it as the fact it is.
 *
 * THE FOUR WAYS A CHANNEL YIELDS NO CANDIDATE, AND WHY THEY ARE NOT TWO.
 * Every round of review on this file has found the same defect rotated one
 * notch: several distinct facts sharing one sentence, and the sentence being
 * false about at least one of them. The states are
 *
 *   1. the body was not a feed          -> ertelmezhetetlen. Go and look.
 *   2. a real feed with no entry        -> nincs_feltoltes. Nothing is wrong;
 *                                          this channel has published nothing.
 *   3. a real feed, entries unreadable  -> ertelmezhetetlen. Go and look: the
 *                                          feed's shape moved under us.
 *   4. a real feed, all uploads stale   -> nincs_friss. Wait, or widen napok.
 *
 * 1 AND 3 SHARE A CODE ON PURPOSE and it is not a fold: the code says "this
 * module could read nothing out of this channel's feed", which is exactly
 * true of both, and the operator's move is the same for both -- open the
 * channel and see what is being served. Merging either of them with 2 or 4
 * would be the fold, because "nothing is wrong here" is the opposite advice.
 *
 * 2 GETS A CODE OF ITS OWN rather than borrowing `nincs_friss`. The sentence
 * for `nincs_friss` is about FRESHNESS, and to a channel that has never
 * published it is misleading in the one direction that costs the operator
 * time: it implies there are older uploads, so widening `napok` is worth
 * trying, and it never will be. `nincs_feltoltes` was not free -- it is an
 * eighth code -- but no existing sentence is TRUE of this state, and this
 * module does not print a sentence that is not.
 *
 * `eldobott` counts feed entries the module would not take: a `published`
 * outside the window, an entry missing an id, a title or a readable date, and
 * the entries past `PER_CSATORNA_LIMIT` on a channel that hit the cap. It is
 * a SUM ACROSS CHANNELS and so cannot say which channel drifted -- which is
 * why state 3 above is a per-channel code rather than being left to this
 * number to imply.
 */
export async function fetchYoutube({ csatornak, napok, ytDlp, execFileImpl = execFileAsync, fetchImpl = fetch }) {
  const kuszob = Date.now() - napok * 86_400_000
  const jeloltek = []
  const csatornaHibak = []
  let eldobott = 0
  for (const csatorna of csatornak) {
    const azonosito = await csatornaId({ csatorna, ytDlp, execFileImpl })
    if (!azonosito.ok) { csatornaHibak.push({ csatorna, ok: azonosito.kod }); continue }
    // The url is built here from an id that matched `CSATORNA_ID_ALAK`, never
    // concatenated from whatever the resolve step printed.
    const feed = await feedSzoveg({ url: `https://www.youtube.com/feeds/videos.xml?channel_id=${azonosito.id}`, fetchImpl })
    if (!feed.ok) { csatornaHibak.push({ csatorna, ok: feed.kod }); continue }
    const olvasott = feedJeloltek(feed.szoveg)
    // Counted before the branches: entries the reader refused were dropped
    // whether or not this channel goes on to produce a candidate.
    eldobott += olvasott.eldobott
    // The three states that are NOT "this channel has nothing new". Each gets
    // its own code because the operator's move differs; see the docblock.
    if (!olvasott.atom) { csatornaHibak.push({ csatorna, ok: 'csatorna_feed_ertelmezhetetlen' }); continue }
    if (olvasott.blokkok === 0) { csatornaHibak.push({ csatorna, ok: 'csatorna_nincs_feltoltes' }); continue }
    if (olvasott.jeloltek.length === 0) { csatornaHibak.push({ csatorna, ok: 'csatorna_feed_ertelmezhetetlen' }); continue }
    let db = 0
    for (const [n, jelolt] of olvasott.jeloltek.entries()) {
      // The cap bounds a feed this module did not expect. It counts what it
      // leaves behind rather than walking away from it: an answer that says
      // "0 dropped" while fifty entries went unread would under-report exactly
      // when the input is strangest.
      if (db >= PER_CSATORNA_LIMIT) { eldobott += olvasott.jeloltek.length - n; break }
      if (Date.parse(jelolt.feltoltve) < kuszob) { eldobott += 1; continue }
      jeloltek.push(jelolt)
      db += 1
    }
    if (db === 0) csatornaHibak.push({ csatorna, ok: 'csatorna_nincs_friss' })
  }
  return { jeloltek, csatornaHibak, eldobott }
}
