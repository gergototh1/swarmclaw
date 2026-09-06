import { DocsError, HIBA } from './errors.mjs'

/**
 * The one thing this module asks another extension for: a finished video's
 * script, laid down as a document.
 *
 * This is the `consumes` side of the host-mediated seam
 * (src/lib/server/extensions/extension-contracts.ts), and it is the whole of
 * this module's reach outside itself. Declaring the consumption IS the access:
 * the host looks for an entry in `index.mjs`'s `consumes` array naming this
 * extension, this contract and this version, and if there is one the call goes
 * through. There is no grant, no approve and no revoke, so the entry is written
 * as narrowly as it reads, and this file calls exactly one method on it.
 *
 * WHY THE VIDEO MODULE AND NOT THE OTHER WAY ROUND. The video module could
 * have consumed `docs` and pushed its scripts across. It does not, and must
 * not: a push happens on the producer's schedule and lands in a folder its
 * `ext:` actor owns, which is a fourth writer in the vault nobody asked for.
 * Pulled from here, the document is created by the agent that wanted it, in
 * that agent's own folder, at the moment it asked -- and the write goes through
 * `service.create` with the ordinary permission check, unchanged.
 *
 * WHAT ARRIVES AND WHAT DOES NOT. The contract answers exactly eleven columns
 * (`VIDEO_CONTRACT_COLUMNS` in extensions/video/src/contract.mjs). There is no
 * scene list, no `forras_szoveg`, no verdict and no QA measurement, and this
 * file must not pretend otherwise: a field written here that the projection
 * does not carry would render as the word "undefined" in somebody's document.
 * `forgatokonyv` therefore names all eleven and nothing else, and a test fails
 * if a twelfth appears.
 *
 * WHOSE TEXT IT IS. The provider's own summary says it: the title and the
 * narration are agent and stranger text, to be checked before any outgoing
 * channel. The host cleans nothing crossing the boundary and does not claim to.
 * The document carries that text as data -- unedited, because an edited quote
 * is a worse quote -- and its first line says where it came from, so whoever
 * opens the file to copy a sentence into a post reads the warning first.
 */

/** The provider, as the host spells it in `consumes` and in `contracts.get`. */
export const VIDEO_EXTENSION = 'video'

/** The contract's name on the provider's side. */
export const VIDEOS_CONTRACT = 'videos'

/**
 * The version this module pins. A provider offering any other number answers
 * `version_mismatch` and no handle -- which is the point of pinning: a column
 * that changed meaning must not arrive silently.
 */
export const VIDEOS_CONTRACT_VERSION = 1

/** The line at the top of every document this tool writes. */
export const FORRAS_FIGYELMEZTETES = 'A cím és a narráció szövege a Videó modulból származik: ügynök és idegen szöveg. Kimenő csatorna — poszt, hirdetés, e-mail, felirat — elé csak ellenőrizve.'

/**
 * What the operator has to do about each reason the host can give.
 *
 * Four reasons, four sentences, because they are four different movements:
 * install a bővítmény, switch one back on, update one of the two, and fix this
 * module. One shared "nincs szerződés" sentence would send the operator to the
 * wrong page three times out of four. The reason word itself is kept in the
 * sentence, so a report that reaches a maintainer carries the host's own
 * vocabulary and not a translation of it.
 */
const SZERZODES_OKOK = Object.freeze({
  not_declared: 'a Doksik modul nem kéri a video.videos szerződést (not_declared). Ez a Doksik bővítmény hibája, nem a tiéd: telepítsd újra vagy frissítsd a Bővítmények lapon.',
  provider_missing: 'a Videó bővítmény nincs telepítve (provider_missing). Telepítsd a Bővítmények lapon, aztán hívd újra ezt a toolt.',
  provider_disabled: 'a Videó bővítmény ki van kapcsolva (provider_disabled). Kapcsold be a Bővítmények lapon, aztán hívd újra ezt a toolt.',
  version_mismatch: `a Videó bővítmény nem a(z) ${VIDEOS_CONTRACT_VERSION}. verziójú videos szerződést kínálja (version_mismatch). Frissítsd a két bővítmény közül a régebbit, aztán hívd újra ezt a toolt.`,
})

/** Prefixes every refusal, so the sentence reads whole wherever it is quoted. */
const NEM_KERHETO = 'A videó forgatókönyve nem kérhető le, mert '

/**
 * The handle for `video.videos`, or a named refusal.
 *
 * `get` answers null for four different facts and `why` says which. A silent
 * skip -- returning nothing and writing no document -- would tell the agent
 * that there was nothing to lay down, which is false in all four cases and
 * sends it on to the next step with a gap it does not know about.
 *
 * `get` and `why` are two separate resolutions and the provider can change
 * between them; then `why` answers null for a handle `get` did not give. That
 * is reported as what it is -- ask again -- rather than as any of the four,
 * none of which was observed.
 */
export function videosHandle(contracts) {
  if (!contracts || typeof contracts.get !== 'function') {
    throw new DocsError(
      HIBA.szerzodes_hianyzik,
      `${NEM_KERHETO}a Doksik modul még nem kapott szerződés-hozzáférést a hosttól. Indítsd újra a bővítményt a Bővítmények lapon, aztán hívd újra ezt a toolt.`,
    )
  }
  const handle = contracts.get(VIDEO_EXTENSION, VIDEOS_CONTRACT)
  if (handle) return handle

  const why = typeof contracts.why === 'function' ? contracts.why(VIDEO_EXTENSION, VIDEOS_CONTRACT) : null
  if (why === null || why === undefined || why === '') {
    throw new DocsError(
      HIBA.szerzodes_hianyzik,
      `${NEM_KERHETO}a szerződés nem oldható fel, és az ok a két lekérdezés között megváltozott. Hívd újra ezt a toolt.`,
    )
  }
  // A reason word this module has not learnt yet is passed through rather than
  // folded into one of the four: naming an unknown state as a known one is the
  // one failure an operator cannot debug.
  const mondat = SZERZODES_OKOK[why] ?? `a szerződés nem oldható fel (${why}). Nézd meg a Videó bővítmény állapotát a Bővítmények lapon.`
  throw new DocsError(HIBA.szerzodes_hianyzik, `${NEM_KERHETO}${mondat}`)
}

/** A column the contract answered null for. Never the word "null" in a document. */
const HIANYZIK = '—'

const EGY_SORBA = /\s+/g

/**
 * The document's title: the video's, folded onto one line.
 *
 * The fold is not cosmetic. `cim` is stranger-derived text, and the vault's
 * front matter is line-based (`serializeDoc`): an embedded newline would cut
 * the header in two and the document would come back titleless. Trimming it
 * here is the consumer guarding text the provider explicitly does not clean.
 *
 * `videoId` rather than `video.id` is the fallback, because it is the id the
 * caller typed and the one it would search for.
 */
function cimOf(video, videoId) {
  const folded = (typeof video.cim === 'string' ? video.cim : '').replace(EGY_SORBA, ' ').trim()
  return folded === '' ? `Videó ${videoId}` : folded
}

/** A scalar as a list value: backticked when present, a dash when not. */
function mezo(value) {
  return typeof value === 'string' && value.trim() !== '' ? `\`${value}\`` : HIANYZIK
}

/** Milliseconds as seconds, with the Hungarian decimal comma. */
function hossz(ms) {
  return typeof ms === 'number' && Number.isFinite(ms) ? `${(ms / 1000).toFixed(1).replace('.', ',')} mp` : HIANYZIK
}

/** `forras_tipus` and `forras_id` together, because neither says much alone. */
function forras(video) {
  const tipus = typeof video.forras_tipus === 'string' && video.forras_tipus !== '' ? video.forras_tipus : HIANYZIK
  return `${tipus} / ${mezo(video.forras_id)}`
}

/**
 * The document a finished video becomes: `{ cim, tartalom }`.
 *
 * The warning is the first line rather than a section at the bottom, because
 * the reader who most needs it -- somebody scrolling to the narration to copy a
 * sentence out -- passes the top and may never reach the bottom.
 *
 * An empty narration says so instead of leaving a bare heading: a video whose
 * plan has no sentences yet and a video whose narration failed to arrive would
 * otherwise produce the same silent gap.
 */
export function forgatokonyv(video, videoId) {
  const narracio = typeof video.narracio_szoveg === 'string' ? video.narracio_szoveg.trim() : ''
  const tartalom = [
    `> ${FORRAS_FIGYELMEZTETES}`,
    '',
    `- Videó id: ${mezo(video.id ?? videoId)}`,
    `- Státusz: ${mezo(video.status)}`,
    `- Forrás: ${forras(video)}`,
    `- Videófájl: ${mezo(video.out_path)}`,
    `- Fájl sha256: ${mezo(video.file_sha256)}`,
    `- Hossz: ${hossz(video.hossz_ms)}`,
    `- Létrehozva: ${mezo(video.created_at)}`,
    `- QA rendben: ${mezo(video.qa_ok_at)}`,
    '',
    '## Narráció',
    '',
    narracio === '' ? '_Ehhez a videóhoz még nincs narráció a tervben._' : narracio,
    '',
  ].join('\n')
  return { cim: cimOf(video, videoId), tartalom }
}
