import { DocsError, ERR } from './errors.mjs'

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
 * `videoScript` therefore names all eleven and nothing else, and a test fails
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
export const SOURCE_WARNING = 'The title and narration below come from outside text, not from an agent or the operator. Check them before using any of it in an outgoing channel — post, ad, email, caption.'

/**
 * What the operator has to do about each reason the host can give.
 *
 * Four reasons, four sentences, because they are four different movements:
 * install an extension, switch one back on, update one of the two, and fix
 * this module. One shared "no contract" sentence would send the operator to
 * the wrong page three times out of four. The reason word itself is kept in
 * the sentence, so a report that reaches a maintainer carries the host's own
 * vocabulary and not a translation of it.
 */
const CONTRACT_REASONS = Object.freeze(Object.assign(Object.create(null), {
  not_declared: 'the Docs module does not request the video.videos contract (not_declared). This is a bug in the Docs extension, not yours: reinstall or update it on the Extensions page.',
  provider_missing: 'the Video extension is not installed (provider_missing). Install it on the Extensions page, then call this tool again.',
  provider_disabled: 'the Video extension is switched off (provider_disabled). Turn it on from the Extensions page, then call this tool again.',
  version_mismatch: `the Video extension does not offer version ${VIDEOS_CONTRACT_VERSION} of the videos contract (version_mismatch). Update whichever of the two extensions is older, then call this tool again.`,
}))

/**
 * One of the four sentences, or a passed-through reason word.
 *
 * The table has a null prototype, because the lookup key is not this module's
 * to choose: it is whatever word the host puts in `reason`, and on an ordinary
 * object literal `CONTRACT_REASONS['constructor']` answers a function, which
 * would stringify into the operator's message instead of taking the fallback.
 * The host uses `Object.create(null)` for its own handles for exactly this
 * (extension-contracts.ts, `buildContractHandle`).
 *
 * An unknown word is passed through rather than folded into one of the four:
 * naming an unknown state as a known one is the failure an operator cannot
 * debug.
 */
function reasonSentence(why) {
  return CONTRACT_REASONS[why] ?? `the contract cannot be resolved (${why}). Check the Video extension's status on the Extensions page.`
}

/** Prefixes every refusal, so the sentence reads whole wherever it is quoted. */
const CANNOT_FETCH = 'The video script cannot be fetched because '

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
      ERR.contract_missing,
      `${CANNOT_FETCH}the Docs module has not been granted contract access by the host yet. Restart the extension on the Extensions page, then call this tool again.`,
    )
  }
  const handle = contracts.get(VIDEO_EXTENSION, VIDEOS_CONTRACT)
  if (handle) return handle

  const why = typeof contracts.why === 'function' ? contracts.why(VIDEO_EXTENSION, VIDEOS_CONTRACT) : null
  if (why === null || why === undefined || why === '') {
    throw new DocsError(
      ERR.contract_missing,
      `${CANNOT_FETCH}the contract could not be resolved, and the reason changed between the two queries. Call this tool again.`,
    )
  }
  throw new DocsError(ERR.contract_missing, `${CANNOT_FETCH}${reasonSentence(why)}`)
}

/**
 * An `ExtensionContractError`, recognised by shape.
 *
 * The host's class lives in `src/lib/server/extensions/extension-contracts.ts`
 * and an extension may not import from the host's `src/`, so `instanceof` is
 * not available across this boundary and would silently answer false if it
 * were tried. The four string fields are the ones the host sets on every such
 * error and on nothing else. This is the same recognition
 * `extensions/video/src/args.mjs` does, for the same reason.
 */
function isHostContractError(err) {
  return err instanceof Error
    && typeof err.code === 'string'
    && typeof err.extensionId === 'string'
    && typeof err.consumerId === 'string'
    && typeof err.contract === 'string'
}

/** What the operator does about a call that did not go through, by host code. */
function callFailureSentence(err) {
  if (err.code === 'unavailable') {
    // The same race `videosHandle` guards one step earlier, and the host loses
    // it too: `callContractMethod` re-resolves on every call, so an extension
    // switched off between the handle and the call fails here rather than
    // there. `reason` is the host's own word for why, so it gets the same four
    // sentences -- the operator's move is identical either side of the race.
    const reason = typeof err.reason === 'string' && err.reason !== '' ? err.reason : null
    return reason === null
      ? 'the Video extension became unreachable during the call (unavailable). Call this tool again; if you get this again, check the Video extension\'s status on the Extensions page.'
      : `the Video extension became unreachable during the call (unavailable): ${reasonSentence(reason)}`
  }
  if (err.code === 'provider_threw') {
    // Not the same fact at all: the extension is installed, switched on and
    // answered -- its own code raised. Nothing the agent can change about the
    // call fixes it, and no page the operator can toggle does either; the next
    // step is the Video module's log.
    return 'the Video extension\'s own code threw during the call (provider_threw). Your call was fine: check the Video module\'s log, and if there is no trace there, tell the operator.'
  }
  return `the contract call did not go through (${err.code}). Check the Video extension's status on the Extensions page, and tell the operator.`
}

/**
 * One video from the provider, or a named refusal.
 *
 * The call is wrapped and not just the resolution, because the host re-resolves
 * on EVERY call (`callContractMethod`): everything `videosHandle` refuses by
 * name can happen one line later instead, and arrive as a thrown
 * `unavailable` rather than as a null handle. Unwrapped, both that and a
 * provider whose own code raised would fall through to the tool's generic
 * catch and reach the agent as `invalid_argument` over a stack string -- the
 * exact pairing `errors.mjs` argues against, since nothing about the call was
 * wrong and the message would name no next step.
 *
 * An error that is not the host's is rethrown untouched. This module does not
 * own it and must not guess a sentence for it.
 */
export async function fetchVideo(contracts, videoId) {
  const videos = videosHandle(contracts)
  // THE HANDLE EXISTS, THE METHOD MAY NOT. The host reconciles the `videos@1`
  // name and version, not the method list: a provider offering this contract
  // without `get` gives a healthy handle, and the call dies a line further
  // down on a plain TypeError. `isHostContractError` does not recognise that --
  // it has no `extensionId` -- so it falls to the tool's generic branch and
  // `invalid_argument: "videos.get is not a function"` reaches the agent:
  // exactly the pairing `errors.mjs`'s eighth code was created against, just
  // through the one door it did not close. The caller's fix is the same as for
  // `version_mismatch` -- update the older extension -- so it gets the same
  // code, with its own sentence.
  if (typeof videos.get !== 'function') {
    throw new DocsError(
      ERR.contract_missing,
      `${CANNOT_FETCH}the Video extension's ${VIDEOS_CONTRACT} contract does not offer the "get" method that this tool needs. Update whichever of the two extensions is older on the Extensions page, then call this tool again.`,
    )
  }
  try {
    return await videos.get({ id: videoId })
  } catch (err) {
    if (isHostContractError(err)) throw new DocsError(ERR.contract_missing, `${CANNOT_FETCH}${callFailureSentence(err)}`)
    throw err
  }
}

/** A column the contract answered null for. Never the word "null" in a document. */
const MISSING = '—'

const ONE_LINE = /\s+/g

/**
 * The document's title: the video's, folded onto one line.
 *
 * The fold is not cosmetic. `video.cim` is stranger-derived text, and the
 * vault's front matter is line-based (`serializeDoc`): an embedded newline would cut
 * the header in two and the document would come back titleless. Trimming it
 * here is the consumer guarding text the provider explicitly does not clean.
 *
 * `videoId` rather than `video.id` is the fallback, because it is the id the
 * caller typed and the one it would search for.
 */
function titleOf(video, videoId) {
  const folded = (typeof video.cim === 'string' ? video.cim : '').replace(ONE_LINE, ' ').trim()
  return folded === '' ? `Video ${videoId}` : folded
}

/** A scalar as a list value: backticked when present, a dash when not. */
function field(value) {
  return typeof value === 'string' && value.trim() !== '' ? `\`${value}\`` : MISSING
}

/** Milliseconds as seconds, to one decimal place. */
function seconds(ms) {
  return typeof ms === 'number' && Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)} s` : MISSING
}

/** `forras_tipus` and `forras_id` together, because neither says much alone. */
function source(video) {
  const kind = typeof video.forras_tipus === 'string' && video.forras_tipus !== '' ? video.forras_tipus : MISSING
  return `${kind} / ${field(video.forras_id)}`
}

/**
 * The document a finished video becomes: `{ title, content }`.
 *
 * The warning is the first line rather than a section at the bottom, because
 * the reader who most needs it -- somebody scrolling to the narration to copy a
 * sentence out -- passes the top and may never reach the bottom.
 *
 * An empty narration says so instead of leaving a bare heading: a video whose
 * plan has no sentences yet and a video whose narration failed to arrive would
 * otherwise produce the same silent gap.
 */
export function videoScript(video, videoId) {
  const title = titleOf(video, videoId)
  const narration = typeof video.narracio_szoveg === 'string' ? video.narracio_szoveg.trim() : ''
  const content = [
    `> ${SOURCE_WARNING}`,
    '',
    `# Video script: ${title}`,
    '',
    `- Status: ${field(video.status)}`,
    `- Source: ${source(video)}`,
    // The file's path and the id and hash it was written under travel
    // together: none of the three says much about the video on its own.
    `- File: ${field(video.out_path)} (id ${field(video.id ?? videoId)}, sha256 ${field(video.file_sha256)})`,
    `- Length: ${seconds(video.hossz_ms)}`,
    `- Created: ${field(video.created_at)}`,
    `- QA passed: ${field(video.qa_ok_at)}`,
    '',
    '## Narration',
    '',
    narration === '' ? '_This video has no narration in the plan yet._' : narration,
    '',
  ].join('\n')
  return { title, content }
}
