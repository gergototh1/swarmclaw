/**
 * The one thing this module asks another extension for, in Task 1: a
 * finished video's data, through `video.videos@1`.
 *
 * This is the `consumes` side of the host-mediated seam
 * (src/lib/server/extensions/extension-contracts.ts), declared in `index.mjs`
 * and read here. Declaring the consumption IS the access: the host looks for
 * an entry in `index.mjs`'s `consumes` array naming this extension, this
 * contract and this version, and if there is one, the call goes through.
 * There is no grant, no approve and no revoke, so the entry is written as
 * narrowly as it reads (index.mjs's own comment says why), and this file's
 * job is only to resolve that entry into a handle, or refuse by name.
 *
 * MODELLED ON `extensions/docs/src/video-forgatokonyv.mjs`'s
 * `videosHandle(contracts)`, on the brief's own instruction: that function
 * names four different reasons for a null handle and separately handles the
 * provider vanishing mid-call, and this module needs the same discipline for
 * the same reason -- an agent that gets back an undifferentiated "no videos"
 * cannot tell "install the video module" from "wait, it is mid-reload" apart,
 * and would keep retrying the one it cannot fix.
 *
 * TASK 4 CLOSES THE pub-2 TODO ABOVE. `videosHandle` alone was fine while
 * nothing called `.get`/`.list` on the handle it returns; `publishOpen`
 * (src/szoveg.mjs) is the first caller, and the call itself can fail two
 * ways the resolution above never sees: `unavailable` (the provider was
 * switched off between `videosHandle` and the call, because
 * `callContractMethod` re-resolves on every call) and `provider_threw` (the
 * provider's own code raised). `videoLekerdez` below wraps the call the same
 * way `extensions/docs/src/video-forgatokonyv.mjs`'s function of the same
 * name does -- `szerzodesHiba` and `hivasMondat` are copied from there,
 * unchanged in shape, translated into this module's own sentences. Without
 * this wrapping both host codes would fall through to whichever tool called
 * `.get` and reach the agent as a stack string with no next step in it.
 *
 * The `typeof handle.get !== 'function'` guard below is NOT part of that
 * follow-up and is here now, because it belongs to resolving the handle
 * rather than to calling it: the host matches the contract's name and version
 * and not its method list, so a provider offering `videos@1` without `get`
 * hands back a perfectly valid handle.
 */

/** The provider, as `index.mjs`'s `consumes` and `contracts.get` both spell it. */
export const VIDEO_EXTENSION = 'video'

/** The contract's name on the provider's side. */
export const VIDEOS_CONTRACT = 'videos'

/**
 * The version this module pins. A provider offering any other number answers
 * `version_mismatch` and no handle -- which is the point of pinning: a column
 * that changed meaning must not arrive silently.
 */
export const VIDEOS_CONTRACT_VERSION = 1

/**
 * This module's own failure codes.
 *
 * One entry today. Later tasks that add named refusals of their own extend
 * this table rather than starting a second one, the way
 * `extensions/docs/src/errors.mjs` collects every code the docs module can
 * throw in one place.
 */
export const HIBA = Object.freeze({
  /** A contract this module `consumes` did not resolve to a handle. */
  szerzodes_hianyzik: 'szerzodes_hianyzik',
})

/**
 * An error carrying one of the codes above.
 *
 * Thrown inside `src/`, meant to be caught at whichever tool or rpc boundary
 * a later task adds and turned into that boundary's own `{ error }` shape --
 * the same split `extensions/docs/src/errors.mjs`'s `DocsError` makes.
 */
export class PublishError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'PublishError'
    this.code = code
  }
}

/**
 * What the operator has to do about each reason the host can give.
 *
 * Four reasons, four sentences, for the reason `video-forgatokonyv.mjs` gives:
 * they are four different movements -- install the extension, switch it back
 * on, update one of the two, or fix this module -- and one shared "nincs
 * szerződés" sentence would send the operator to the wrong page three times
 * out of four. The reason word itself stays in the sentence, so a report that
 * reaches a maintainer carries the host's own vocabulary rather than a
 * translation of it.
 */
export const SZERZODES_OKOK = Object.freeze(Object.assign(Object.create(null), {
  not_declared: 'a Publikálás modul nem kéri a video.videos szerződést (not_declared). Ez a Publikálás bővítmény hibája, nem a tiéd: telepítsd újra vagy frissítsd a Bővítmények lapon.',
  provider_missing: 'a Videó bővítmény nincs telepítve (provider_missing). Telepítsd a Bővítmények lapon, aztán próbáld újra.',
  provider_disabled: 'a Videó bővítmény ki van kapcsolva (provider_disabled). Kapcsold be a Bővítmények lapon, aztán próbáld újra.',
  version_mismatch: `a Videó bővítmény nem a(z) ${VIDEOS_CONTRACT_VERSION}. verziójú videos szerződést kínálja (version_mismatch). Frissítsd a két bővítmény közül a régebbit, aztán próbáld újra.`,
}))

/**
 * One of the four sentences, or a passed-through reason word.
 *
 * Null-prototype lookup table for the reason `docs`' own `okMondat` uses:
 * the key is whatever word the host puts in `reason`, not this module's to
 * choose, and an ordinary object literal would answer a function for
 * `SZERZODES_OKOK['constructor']` instead of falling through. An unknown word
 * is passed through rather than folded into one of the four -- naming an
 * unknown state as a known one is the failure an operator cannot debug.
 */
function okMondat(why) {
  return SZERZODES_OKOK[why] ?? `a szerződés nem oldható fel (${why}). Nézd meg a Videó bővítmény állapotát a Bővítmények lapon.`
}

/** Prefixes every refusal, so the sentence reads whole wherever it is quoted. */
export const NEM_ERHETO_EL = 'A videó szerződés nem érhető el, mert '

/**
 * The handle for `video.videos`, or a named refusal.
 *
 * Takes `state` -- the module-wide seam every tool and rpc handler reads
 * (index.mjs) -- rather than `state.contracts` directly, so a caller that
 * forgot `setup()` has run yet (`state.contracts` still `null`) gets the same
 * named refusal as a caller the host genuinely has no contract for, instead
 * of a raw TypeError two lines into `contracts.get`.
 *
 * `get` answers null for four different facts and `why` says which. A silent
 * skip would tell whichever future caller reads this that there was simply
 * nothing to do, which is false in all four cases and would send it on with a
 * gap it does not know about.
 *
 * `get` and `why` are two separate calls and the provider can change between
 * them; then `why` answers null for a handle `get` did not give. That is
 * reported as what it is -- ask again -- rather than as any of the four, none
 * of which was actually observed. That refusal deliberately names none of the
 * four reason words: naming one would state a fact nobody observed.
 *
 * A handle that arrives without a `get` method is refused here too -- see the
 * comment on the guard -- because the host matches the contract's name and
 * version, never its method list.
 */
export function videosHandle(state) {
  const contracts = state && state.contracts
  if (!contracts || typeof contracts.get !== 'function') {
    throw new PublishError(
      HIBA.szerzodes_hianyzik,
      `${NEM_ERHETO_EL}a Publikálás modul még nem kapott szerződés-hozzáférést a hosttól. Indítsd újra a bővítményt a Bővítmények lapon, aztán próbáld újra.`,
    )
  }
  const handle = contracts.get(VIDEO_EXTENSION, VIDEOS_CONTRACT)
  if (handle) {
    // A HANDLE MEGVAN, A METÓDUS NEM FELTÉTLENÜL. A host a `videos@1` nevet és
    // verziót egyezteti, a metódus-listát nem: egy szolgáltató, ami ezt a
    // szerződést kínálja `get` nélkül, ép handle-t ad -- és a hívó egy sorral
    // lejjebb egy csupasz `TypeError: videos.get is not a function`-be fut,
    // amin nincs `code`, tehát semmi nem ismeri fel megnevezett elutasításnak.
    // A hívó teendője ugyanaz, mint `version_mismatch`-nél (frissítsd a
    // régebbi bővítményt), tehát ugyanaz a kód, a saját mondatával.
    if (typeof handle.get !== 'function') {
      throw new PublishError(
        HIBA.szerzodes_hianyzik,
        `${NEM_ERHETO_EL}a Videó bővítmény ${VIDEOS_CONTRACT} szerződése nem kínálja a "get" metódust, amire ennek a modulnak szüksége van. Frissítsd a két bővítmény közül a régebbit a Bővítmények lapon, aztán próbáld újra.`,
      )
    }
    return handle
  }

  const why = typeof contracts.why === 'function' ? contracts.why(VIDEO_EXTENSION, VIDEOS_CONTRACT) : null
  if (why === null || why === undefined || why === '') {
    throw new PublishError(
      HIBA.szerzodes_hianyzik,
      `${NEM_ERHETO_EL}a szerződés nem oldható fel, és az ok a két lekérdezés között megváltozott. Próbáld újra.`,
    )
  }
  throw new PublishError(HIBA.szerzodes_hianyzik, `${NEM_ERHETO_EL}${okMondat(why)}`)
}

/**
 * An `ExtensionContractError`, recognised by shape -- copied from
 * `extensions/docs/src/video-forgatokonyv.mjs`'s function of the same name.
 * The host's class lives in `src/lib/server/extensions/extension-contracts.ts`
 * and an extension may not import from the host's `src/`, so `instanceof` is
 * not available across this boundary; the four string fields are the ones
 * the host sets on every such error and on nothing else.
 */
function szerzodesHiba(err) {
  return err instanceof Error
    && typeof err.code === 'string'
    && typeof err.extensionId === 'string'
    && typeof err.consumerId === 'string'
    && typeof err.contract === 'string'
}

/** What the operator does about a call that did not go through, by host code -- same two codes and same reasoning as `video-forgatokonyv.mjs`'s function of the same name. */
function hivasMondat(err) {
  if (err.code === 'unavailable') {
    const reason = typeof err.reason === 'string' && err.reason !== '' ? err.reason : null
    return reason === null
      ? 'a Videó bővítmény elérése a hívás közben szűnt meg (unavailable). Hívd újra ezt a toolt; ha újra ezt kapod, nézd meg a Videó bővítmény állapotát a Bővítmények lapon.'
      : `a Videó bővítmény elérése a hívás közben szűnt meg (unavailable): ${okMondat(reason)}`
  }
  if (err.code === 'provider_threw') {
    return 'a Videó bővítmény saját kódja hibára futott a hívás közben (provider_threw). A hívásod rendben volt: nézd meg a Videó modul naplóját, és ha ott nincs nyom, szólj az operátornak.'
  }
  return `a szerződéshívás nem ment át (${err.code}). Nézd meg a Videó bővítmény állapotát a Bővítmények lapon, és szólj az operátornak.`
}

/**
 * One video from the provider, by id, or a named refusal.
 *
 * The call is wrapped and not just the resolution -- see the file docblock's
 * "TASK 4 CLOSES THE pub-2 TODO" note for why. An error that is not the
 * host's is rethrown untouched: this module does not own it and must not
 * guess a sentence for it.
 *
 * The same `typeof videos.get !== 'function'` guard as `videosHandle` above
 * applies here too, for the same reason: the host matches the contract's
 * name and version, never its method list.
 */
export async function videoLekerdez(state, videoId) {
  const videos = videosHandle(state)
  if (typeof videos.get !== 'function') {
    throw new PublishError(
      HIBA.szerzodes_hianyzik,
      `${NEM_ERHETO_EL}a Videó bővítmény ${VIDEOS_CONTRACT} szerződése nem kínálja a "get" metódust, amire ennek a modulnak szüksége van. Frissítsd a két bővítmény közül a régebbit a Bővítmények lapon, aztán próbáld újra.`,
    )
  }
  try {
    return await videos.get({ id: videoId })
  } catch (err) {
    if (szerzodesHiba(err)) throw new PublishError(HIBA.szerzodes_hianyzik, `${NEM_ERHETO_EL}${hivasMondat(err)}`)
    throw err
  }
}
