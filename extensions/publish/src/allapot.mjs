import { AG_ALLAPOTOK } from './db.mjs'

/**
 * The one rule a release's four branches add up to.
 *
 * `kiadasAllapot(agak)` is the spine task-2-brief.md names it: the calendar
 * page, the scheduled dispatch run and the operator report all ask this same
 * question -- "given what happened to each platform branch, what is this
 * release?" -- and this file exists so that question has exactly one answer,
 * asked in exactly one place. Said three times, the three copies would drift
 * (design spec 5's whole point); said once and imported three times, they
 * cannot.
 *
 * WHERE THE JURISDICTION ENDS, IN ONE SENTENCE: the workflow states
 * (`vazlat`, `lektoralt`, `jovahagyva`) are told by the stored
 * `ext_publish_kiadasok.allapot` column, the outcome states are computed by
 * this function, and a caller must never write this function's answer back
 * onto a release that has not been approved.
 *
 * That last clause is the sharp one. A release still in draft has every
 * branch in `var`, and any `var` makes this function answer `utemezve` --
 * which is exactly the value task 3's `esedekes()` filters on. Nothing in
 * this module writes this answer onto the column today, and nothing may
 * start: a single `patch(kiadas, { allapot: kiadasAllapot(agak) })` would
 * send an unapproved draft to four platforms. `kiadasAllapot` cannot even
 * name the workflow words any more (see `KIADAS_ALLAPOT` below), so the
 * mistake now has to be written on purpose rather than by picking a
 * plausible-looking constant.
 *
 * A branch (`ag`, `ext_publish_agak` row) carries its own `allapot`, one of
 * the four words `AG_ALLAPOTOK` (src/db.mjs) spells beside the column that
 * stores them: `var`, `kesz`, `hiba`, `nincs_fiok`.
 *
 * THREE DIFFERENT FACTS, THREE DIFFERENT STATES (constraints.md's first
 * rule, sharpest in this module): a platform with no connected account, a
 * platform that tried and failed, and a platform that has not had its turn
 * yet are three different things that happened (or did not), not shades of
 * "not kész" that could share a state. `kiadasAllapot` keeps them apart
 * below rather than folding any pair into a boolean -- and `ismeretlen` is
 * the fourth such fact, added for the same reason: see below.
 */

/**
 * The release-level outcomes this function can actually produce -- all of
 * them, and nothing else.
 *
 * This is NOT the `ext_publish_kiadasok.allapot` domain. That column holds
 * eight words and is spelled out in `KIADAS_ALLAPOTOK` (src/db.mjs), beside
 * itself; five of these six overlap with it and `ismeretlen` deliberately
 * does not. The three workflow words (`vazlat`, `lektoralt`, `jovahagyva`)
 * are absent here because this function cannot produce them: they are moved
 * by an operator and a reviewer, not derived from branches, and a union
 * advertising a value the function never returns is a lying type -- tasks 3
 * and 6 would write a `case` for it that never fires.
 */
export const KIADAS_ALLAPOT = Object.freeze({
  UTEMEZVE: 'utemezve',
  KESZ: 'kesz',
  RESZBEN: 'reszben',
  HIBA: 'hiba',
  NINCS_HOVA: 'nincs_hova',
  ISMERETLEN: 'ismeretlen',
})

/** The branch words this version of the module understands. Anything else on a branch row is a fact this code has no reading of -- see `ismeretlen` below. */
const ISMERT_AG_ALLAPOT = new Set(Object.values(AG_ALLAPOTOK))

/**
 * One release's status, from its branches alone.
 *
 * Pure: no database read. It throws only on a malformed `agak` -- see the
 * refusals at the top of the body -- and never on a well-formed branch list,
 * whatever those branches say.
 *
 * `nincs_fiok` COUNTS FOR NEITHER SIDE. Design spec 5: a platform with no
 * connected account "nem hiba" (not a failure) and the release "nem várja
 * meg" it (does not wait on it). So those branches are dropped before
 * anything is counted -- they are not successes, not failures, and not
 * pending; they are simply not part of the set that decides the release.
 *
 * AN EMPTY SET IS `nincs_hova`, NEVER `kesz`. This is the case the brief
 * calls out by name: "minden ág kiment" (every branch went out) is VACUOUSLY
 * true over zero branches, so a release connected to nothing would report
 * `kesz` and the page would state that something is published when it is
 * nowhere on the internet. The empty check therefore runs before any
 * counting can turn zero branches into `kesz` by accident.
 *
 * AN UNRECOGNISED BRANCH WORD IS `ismeretlen`, NOT `hiba`. Folding it into
 * the failure count would put an unobserved fact in the denominator but not
 * the numerator, and the release would then assert a failed dispatch on the
 * strength of a row nobody here can read -- the exact "one fact spoken with
 * another fact's state" this module's first constraint forbids. `ismeretlen`
 * is the only answer that neither stays silent nor lies, and it wins over
 * every other outcome, `utemezve` included: a release this version does not
 * understand must not slip into task 3's dispatch set.
 *
 * @param {Array<{ platform: string, allapot: string }>} agak
 * @returns {'utemezve'|'kesz'|'reszben'|'hiba'|'nincs_hova'|'ismeretlen'}
 * @throws {TypeError} if `agak` is not an array of branch rows. A malformed
 *   argument is a programmer error, and loud is correct: the old silent
 *   fallback answered `nincs_hova`, which is not a neutral default but a
 *   specific claim ("no platform is connected at all") that task 6 prints to
 *   the operator verbatim. Every caller passes `repo.agak(id)`, which is
 *   always an array of rows, so a throw here can only mean a bug upstream.
 */
export function kiadasAllapot(agak) {
  if (!Array.isArray(agak)) {
    throw new TypeError('kiadasAllapot: az agak csak ág-sorok tömbje lehet -- add át a repo.agak(kiadasId) eredményét')
  }
  for (const a of agak) {
    if (typeof a !== 'object' || a === null || typeof a.allapot !== 'string') {
      throw new TypeError('kiadasAllapot: az agak minden eleme ág-sor kell legyen, string allapot mezővel -- add át a repo.agak(kiadasId) eredményét')
    }
  }

  if (agak.some((a) => !ISMERT_AG_ALLAPOT.has(a.allapot))) return KIADAS_ALLAPOT.ISMERETLEN

  const relevans = agak.filter((a) => a.allapot !== AG_ALLAPOTOK.NINCS_FIOK)

  if (relevans.length === 0) return KIADAS_ALLAPOT.NINCS_HOVA
  if (relevans.some((a) => a.allapot === AG_ALLAPOTOK.VAR)) return KIADAS_ALLAPOT.UTEMEZVE

  const kiment = relevans.filter((a) => a.allapot === AG_ALLAPOTOK.KESZ).length
  if (kiment === relevans.length) return KIADAS_ALLAPOT.KESZ
  if (kiment === 0) return KIADAS_ALLAPOT.HIBA
  return KIADAS_ALLAPOT.RESZBEN
}
