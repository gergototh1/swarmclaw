import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { refuse } from './args.mjs'

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
 * The binary the operator's machine has. It is a full path rather than a bare
 * name because yt-dlp is not one of the tools the host resolves for this
 * module (src/binaries.mjs is for ffmpeg, ffprobe, node and npx), and a bare
 * `yt-dlp` would depend on whatever PATH the host process happened to inherit.
 */
export const YT_DLP_ALAP = '/Users/tothgergo/DEV/gergototh.co/apps/yt-dlp/bin/yt-dlp'

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
 */
export function feedJeloltek(xml) {
  const jeloltek = []
  let eldobott = 0
  const szoveg = typeof xml === 'string' ? xml : ''
  for (const darab of szoveg.split('<entry>').slice(1)) {
    const entry = darab.split('</entry>')[0]
    const id = mezo(entry, 'yt:videoId')
    const cim = mezo(entry, 'title')
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
  return { jeloltek, eldobott }
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
 * A reply this call will not read is aborted rather than left open: on a real
 * fetch an uncollected body holds its connection.
 */
async function feedSzoveg({ url, fetchImpl, timeoutMs }) {
  const hatarido = new AbortController()
  const timer = setTimeout(() => hatarido.abort(), timeoutMs)
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
      return { ok: false, kod: 'csatorna_feed_nem_valaszolt' }
    }
    try {
      return { ok: true, szoveg: await res.text() }
    } catch (e) {
      return { ok: false, kod: hataridoVolt(e) ? 'csatorna_feed_idotullepes' : 'csatorna_feed_nem_valaszolt' }
    }
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
 * ENOENT IS NOT ONE OF THE ANSWERS HERE. A binary that is not on the given
 * path is a fact about the machine rather than about this channel, and it
 * propagates as the refusal of the whole source that it is.
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
    // The message names the setting, never the path it was given: the rpc
    // route logs a refusal's message, and the path is a value the operator
    // stored (the rule src/args.mjs states).
    if (err && typeof err === 'object' && err.code === 'ENOENT') refuse('ytdlp_hianyzik', 'a beállított útvonalon nincs futtatható yt-dlp: a modul beállításai közt az ytDlpUtvonal mezőt állítsd a bináris teljes útvonalára')
    const e = err && typeof err === 'object' ? err : {}
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
 * ONE FAILURE IS ABOUT THE MACHINE AND ENDS THE PRESS: the binary is not on
 * the configured path (`ENOENT`). Nothing about the remaining channels can be
 * learnt, because the same missing file would be missing for each of them, so
 * the whole source is refused BY NAME (`ytdlp_hianyzik`) on the first channel
 * that needs it. The operator's fix is a setting.
 *
 * EVERY OTHER FACT IS ABOUT ONE CHANNEL and lands in `csatornaHibak`, which
 * is a per-channel report and not only a failure list. Five codes, because
 * five different things happen and the operator does something different
 * about each:
 *
 *   csatorna_nem_valaszolt          yt-dlp could not read the channel page
 *   csatorna_idotullepes            ...and did not finish in time
 *   csatorna_azonosito_ismeretlen   it answered, but not with a channel id --
 *                                   a renamed handle, a deleted channel, a
 *                                   url that is not a channel at all
 *   csatorna_feed_nem_valaszolt     the id resolved; the feed did not answer
 *   csatorna_feed_idotullepes       ...within the deadline
 *   csatorna_nincs_friss            EVERYTHING WORKED and the channel simply
 *                                   had nothing inside the window. Not a
 *                                   failure, and the page words it as the
 *                                   fact it is -- but it belongs here,
 *                                   because "this channel had nothing" and
 *                                   "this channel could not be read" are the
 *                                   two states a quiet board most needs
 *                                   telling apart.
 *
 * `eldobott` counts feed entries the module would not take: a `published`
 * outside the window, and an entry missing an id, a title or a readable date.
 * The number exists so a feed whose shape drifted reads as "the module
 * dropped 15 entries" rather than as a quiet channel.
 */
export async function fetchYoutube({ csatornak, napok, ytDlp, execFileImpl = execFileAsync, fetchImpl = fetch, feedTimeoutMs = FEED_TIMEOUT_MS }) {
  const kuszob = Date.now() - napok * 86_400_000
  const jeloltek = []
  const csatornaHibak = []
  let eldobott = 0
  for (const csatorna of csatornak) {
    const azonosito = await csatornaId({ csatorna, ytDlp, execFileImpl })
    if (!azonosito.ok) { csatornaHibak.push({ csatorna, ok: azonosito.kod }); continue }
    // The url is built here from an id that matched `CSATORNA_ID_ALAK`, never
    // concatenated from whatever the resolve step printed.
    const feed = await feedSzoveg({ url: `https://www.youtube.com/feeds/videos.xml?channel_id=${azonosito.id}`, fetchImpl, timeoutMs: feedTimeoutMs })
    if (!feed.ok) { csatornaHibak.push({ csatorna, ok: feed.kod }); continue }
    const olvasott = feedJeloltek(feed.szoveg)
    eldobott += olvasott.eldobott
    let db = 0
    for (const jelolt of olvasott.jeloltek) {
      if (db >= PER_CSATORNA_LIMIT) break
      if (Date.parse(jelolt.feltoltve) < kuszob) { eldobott += 1; continue }
      jeloltek.push(jelolt)
      db += 1
    }
    if (db === 0) csatornaHibak.push({ csatorna, ok: 'csatorna_nincs_friss' })
  }
  return { jeloltek, csatornaHibak, eldobott }
}
