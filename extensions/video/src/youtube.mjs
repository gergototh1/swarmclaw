import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { refuse } from './args.mjs'

/**
 * The one source this module can reach on its own: the recent uploads of the
 * channels the operator listed, read with yt-dlp.
 *
 * WHAT THIS IS FOR. The board's two sources both need somebody to act first --
 * a saved AI Signal card, or text the operator pasted -- and neither answers
 * the question "what is worth making a video about today". This file answers
 * it from one press of one button: list the channels' newest uploads, drop the
 * ones this module already opened a video from, and let the rest become cards.
 *
 * IT IS NOT REACHABLE FROM A TOOL, ON PURPOSE. `videoOpen`'s `forras` list is
 * `signal` and `kezi` (src/terv.mjs, FORRASOK) and stays that way: this source
 * spawns a process that talks to a third party for seconds per channel, and an
 * agent that could start it on its own would be a scheduled run reaching the
 * network on every turn. One operator button is the whole surface.
 *
 * WHAT IT DOES WITH WHAT COMES BACK: as little as possible. The lines yt-dlp
 * prints are titles strangers wrote and ids a third party assigned, and this
 * file treats both as data. The title is carried through untouched, for the
 * page to render as a React text child. The id is CHECKED against a shape
 * (`ID_ALAK`) and the watch url is then built here, from the checked id and
 * this module's own constant -- a url is never taken from, or assembled out
 * of, text that arrived over the network. A line whose id does not have that
 * shape is dropped and counted.
 *
 * THE PROCESS IS AN ARGUMENT VECTOR, NEVER A SHELL. `execFile` with a list,
 * the pattern `probeDurationMs` uses (src/narracio.mjs), with a per-channel
 * timeout and a `maxBuffer` -- yt-dlp prints one line per video and exits, so
 * a bounded read with a deadline is exactly the right shape, and `spawn` with
 * a stream reader would be machinery for output that is already bounded.
 *
 * WHAT WAS MEASURED AND WHAT IT DECIDED. Two facts about
 * `yt-dlp --flat-playlist` on a channel's /videos tab, measured by hand
 * against a real channel with the binary this module ships a path to
 * (2025.08.20):
 *
 *   1. `--extractor-args "youtube:player_client=android"` IS NOT NEEDED HERE
 *      and is not passed. The Hermes transcript path requires it for the
 *      SABR block, but that block is on the media, not on the tab listing:
 *      the listing's output was byte-for-byte identical with and without the
 *      flag. A flag that changes nothing is a flag that will one day change
 *      something nobody asked for, so it is not here.
 *   2. `upload_date`, `timestamp` AND `view_count` COME BACK AS `NA` in flat
 *      mode -- the entries are `_type: url` stubs carrying an id and a title
 *      and nothing else. So the `napok` window filter, which is written
 *      below and works, will in practice see no dates at all. That is why an
 *      unknown date is KEPT rather than dropped: "outside the last N days"
 *      and "the listing did not say when" are two different facts, and
 *      dropping the second as if it were the first would make the button
 *      return zero every time. Freshness still holds, from the ordering:
 *      the /videos tab is newest-first and `--playlist-end` cuts it at the
 *      newest `PLAYLIST_END`.
 */

/**
 * The binary the operator's machine has. It is a full path rather than a bare
 * name because yt-dlp is not one of the tools the host resolves for this
 * module (src/binaries.mjs is for ffmpeg, ffprobe, node and npx), and a bare
 * `yt-dlp` would depend on whatever PATH the host process happened to inherit.
 */
export const YT_DLP_ALAP = '/Users/tothgergo/DEV/gergototh.co/apps/yt-dlp/bin/yt-dlp'

/** How far down each channel's tab one press reads. The tab is newest-first, so this is "the newest N". */
export const PLAYLIST_END = 30

/**
 * Candidates one channel may contribute. A bound below `PLAYLIST_END` would
 * be the one doing the work; this one is here so a channel whose tab answers
 * with thousands of lines -- a listing this module did not expect -- cannot
 * fill the answer on its own.
 */
export const PER_CSATORNA_LIMIT = 50

/**
 * What one press of the button may open, and the reason it is not the daily
 * cap. See the `youtubeOtletek` docblock in src/rpc.mjs, which is where the
 * decision belongs; the number lives here with the module's other bounds so
 * the page and the tests read one definition of it.
 */
export const YOUTUBE_OTLET_MAX = 10

/** Per channel, not for the whole press: three channels are three deadlines, and one slow channel must not eat the others'. */
const CSATORNA_TIMEOUT_MS = 60_000

/** One line per video, a few hundred bytes each; this is room for a tab far longer than `PLAYLIST_END` asks for. */
const MAX_BUFFER = 8 * 1024 * 1024

/**
 * A YouTube video id, as this module will accept one before building a url
 * out of it. Eleven characters is what YouTube issues today; the range is
 * wider so an id scheme that grows is not refused for a cosmetic reason,
 * while the character class keeps out everything that could make the url
 * mean something else -- a slash, a dot, a query separator, whitespace.
 */
const ID_ALAK = /^[A-Za-z0-9_-]{5,32}$/

/** `%(upload_date)s` when yt-dlp has one. Anything else -- `NA` included -- is "the listing did not say". */
const DATUM_ALAK = /^\d{8}$/

/** The four fields, in this order, joined by `|`. The title is last because it is the one that may contain the separator. */
const PRINT_FORMAT = '%(id)s|%(upload_date)s|%(view_count)s|%(title)s'

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
 * The entries are the OPERATOR'S own configuration, not text that arrived
 * over the network, so an entry this function does not recognise is passed
 * through as typed rather than refused: yt-dlp will fail on it, and that
 * failure lands in `csatornaHibak` naming the entry, which tells the operator
 * more than a validation message would. What is normalised is the one shape
 * that is not a url at all -- `@handle` -- because that is what YouTube shows
 * an operator on the channel page.
 */
export function csatornakOf(state) {
  const raw = (state.settings() || {}).youtubeCsatornak
  const nyers = typeof raw === 'string' ? raw : ''
  const lista = nyers.split(',').map((s) => s.trim()).filter((s) => s !== '')
    .map((s) => (s.startsWith('@') ? `https://www.youtube.com/${s}` : s))
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

/** `YYYYMMDD` as an ISO instant, or null when the listing did not carry a date. */
function feltoltveOf(raw) {
  if (!DATUM_ALAK.test(raw)) return null
  const iso = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T00:00:00.000Z`
  return Number.isFinite(Date.parse(iso)) ? iso : null
}

/** `%(view_count)s` as a number, or null for `NA` and anything else that is not a count. */
function nezettsegOf(raw) {
  if (!/^\d{1,15}$/.test(raw)) return null
  return Number(raw)
}

/**
 * One printed line as a candidate, or null when the line named nothing this
 * module will act on.
 *
 * SPLIT ON THE FIRST THREE SEPARATORS ONLY. A YouTube title routinely
 * contains `|` -- "DHH: Future of Programming | Lex Fridman Podcast #501" is
 * a real one -- so a plain `split('|')` would hand back a title cut at its
 * first pipe and drop the rest on the floor. The first three fields are
 * fixed-shape and the fourth is whatever is left.
 */
function jeloltOf(sor) {
  const reszek = sor.split('|')
  if (reszek.length < 4) return null
  const [id, datum, nezettseg] = reszek
  const cim = reszek.slice(3).join('|')
  if (!ID_ALAK.test(id) || cim.trim() === '') return null
  return { id, cim, url: `https://www.youtube.com/watch?v=${id}`, feltoltve: feltoltveOf(datum), nezettseg: nezettsegOf(nezettseg) }
}

/**
 * Why one channel's call failed, in this module's own vocabulary.
 *
 * `ENOENT` is deliberately NOT one of the answers here: it is a fact about
 * the machine rather than about a channel, and `fetchYoutube` turns it into a
 * refusal of the whole source before this function is reached.
 */
const csatornaHibaOk = (err) => {
  const e = err && typeof err === 'object' ? err : {}
  return e.killed === true || e.signal === 'SIGTERM' ? 'csatorna_idotullepes' : 'csatorna_nem_valaszolt'
}

/**
 * The channels' recent uploads as candidates, plus what was dropped and which
 * channels did not answer.
 *
 * TWO FAILURES, TWO ANSWERS, AND THEY ARE NOT THE SAME FACT.
 *
 *   - The binary is not on the given path (`ENOENT`). Nothing about the
 *     remaining channels can be learnt, because the same missing file would
 *     be missing for each of them, so the whole source is refused BY NAME
 *     (`ytdlp_hianyzik`) on the first one. The operator's fix is a setting.
 *   - One channel's call failed. Every other channel is still readable and is
 *     still read; the failed one is named in `csatornaHibak` with a code, and
 *     the page prints the names. A press that quietly returned fewer ideas
 *     because one channel was renamed would look exactly like a quiet week.
 *
 * `eldobott` counts every printed line the module did not take: a date
 * outside the window, an id it will not build a url from, a blank title, and
 * a line that did not carry the four fields at all. Blank lines are not lines
 * and are not counted. The number exists so a listing whose format drifted --
 * a yt-dlp upgrade, a changed tab layout -- reads as "the module dropped 30
 * rows" rather than as an empty channel.
 */
export async function fetchYoutube({ csatornak, napok, ytDlp, execFileImpl = execFileAsync, playlistEnd = PLAYLIST_END }) {
  const kuszob = Date.now() - napok * 86_400_000
  const jeloltek = []
  const csatornaHibak = []
  let eldobott = 0
  for (const csatorna of csatornak) {
    let stdout
    try {
      ({ stdout } = await execFileImpl(
        ytDlp,
        [`${csatorna}/videos`, '--flat-playlist', '--skip-download', '--playlist-end', String(playlistEnd), '--print', PRINT_FORMAT],
        { timeout: CSATORNA_TIMEOUT_MS, maxBuffer: MAX_BUFFER, windowsHide: true },
      ))
    } catch (err) {
      // The message names the setting, never the path it was given: the rpc
      // route logs a refusal's message, and the path is a value the operator
      // stored (the rule src/args.mjs states).
      if (err && typeof err === 'object' && err.code === 'ENOENT') refuse('ytdlp_hianyzik', 'a beállított útvonalon nincs futtatható yt-dlp: a modul beállításai közt az ytDlpUtvonal mezőt állítsd a bináris teljes útvonalára')
      csatornaHibak.push({ csatorna, ok: csatornaHibaOk(err) })
      continue
    }
    let db = 0
    for (const sor of String(stdout).split('\n')) {
      if (db >= PER_CSATORNA_LIMIT) break
      if (sor.trim() === '') continue
      const jelolt = jeloltOf(sor)
      if (jelolt === null) { eldobott += 1; continue }
      // An unknown date is kept: see this file's header on what was measured.
      if (jelolt.feltoltve !== null && Date.parse(jelolt.feltoltve) < kuszob) { eldobott += 1; continue }
      jeloltek.push(jelolt)
      db += 1
    }
  }
  return { jeloltek, csatornaHibak, eldobott }
}
