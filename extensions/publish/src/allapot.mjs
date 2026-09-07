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
 * A branch (`ag`, `ext_publish_agak` row) carries its own `allapot`, written
 * by `src/db.mjs`'s `ujAg` and later tasks' adapters:
 *
 *   - `var`        -- opened, not yet sent (`AG_KEZDO_ALLAPOT`)
 *   - `kesz`       -- sent, the platform has it
 *   - `hiba`       -- sent and refused, named by `hiba_kod`
 *   - `nincs_fiok` -- this release has no connected account for this
 *                     platform, so nothing was ever attempted
 *
 * THREE DIFFERENT FACTS, THREE DIFFERENT STATES (constraints.md's first
 * rule, sharpest in this module): a platform with no connected account, a
 * platform that tried and failed, and a platform that has not had its turn
 * yet are three different things that happened (or did not), not shades of
 * "not kész" that could share a state. `kiadasAllapot` keeps them apart
 * below rather than folding any pair into a boolean.
 */

/** The four branch-level facts `kiadasAllapot` reads. Not exported: nothing outside this file needs to name a branch's own state to compute a release's. */
const AG = Object.freeze({
  VAR: 'var',
  KESZ: 'kesz',
  HIBA: 'hiba',
  NINCS_FIOK: 'nincs_fiok',
})

/**
 * The release-level outcomes this function can actually produce.
 *
 * `kiadasAllapot`'s declared range (task-2-brief.md's interface line) is
 * `'vazlat' | 'utemezve' | 'kesz' | 'reszben' | 'hiba' | 'nincs_hova'` --
 * the full domain of the `ext_publish_kiadasok.allapot` column, so a caller
 * reading either source names the same six words. `vazlat` and `lektoralt`
 * (design spec 4's first two arrow steps) are NOT reachable through this
 * function and are written on the constant below only for that domain
 * match, never returned: a release drafts and gets reviewed before its
 * branches carry any fact worth asking about, and at that point the caller
 * has not opened branches to ask this question of yet, or -- once it has --
 * every branch still reads `var`, which is indistinguishable from a
 * scheduled-and-waiting release. That distinction is not a branch fact; it
 * lives on the release row itself (`ext_publish_kiadasok.allapot`, written
 * by the approval step, a later task), and a caller still drafting a
 * release must read that column directly rather than call this function.
 */
export const KIADAS_ALLAPOT = Object.freeze({
  VAZLAT: 'vazlat',
  UTEMEZVE: 'utemezve',
  KESZ: 'kesz',
  RESZBEN: 'reszben',
  HIBA: 'hiba',
  NINCS_HOVA: 'nincs_hova',
})

/**
 * One release's status, from its branches alone.
 *
 * Pure: no database read, no throw, for any input -- a malformed `agak`
 * (not an array, or an array holding something other than
 * `{ platform, allapot }`) is treated as no branches rather than raising,
 * because every caller of this function (the calendar page, the dispatch
 * run, the report) is a read path with nothing to catch a throw with.
 *
 * The logic, in the order it decides:
 *
 * 1. Drop every `nincs_fiok` branch first. Design spec 5: a platform with no
 *    connected account "nem hiba" (not a failure) and the release "nem várja
 *    meg" it (does not wait on it) -- it counts toward neither "kiment" nor
 *    "elbukott" nor "vár", so it is simply not part of the count that
 *    decides the release.
 *
 * 2. If NOTHING is left after that drop -- either `agak` was empty, or every
 *    branch was `nincs_fiok` -- the release is `nincs_hova`, never `kesz`.
 *    This is the case the brief calls out by name: "minden ág kiment" (every
 *    branch went out) is VACUOUSLY true over zero branches, and reporting
 *    `kesz` for a release connected to nothing would state that something is
 *    published when it is nowhere on the internet. `nincs_hova` is checked
 *    before anything else below can turn an empty set into `kesz` by
 *    accident.
 *
 * 3. If any remaining branch is still `var` (waiting its turn), the release
 *    is `utemezve` -- REGARDLESS of what the other branches already did.
 *    One branch already `kesz` and one still `var` is not "partially done
 *    already, so reszben" -- the release has not finished being dispatched
 *    yet, and `reszben`/`hiba` are outcomes for when nothing is pending any
 *    more.
 *
 * 4. Otherwise every remaining branch is settled (`kesz` or `hiba`, or any
 *    other value a future branch state might introduce -- treated here as
 *    "not kész", the safe default for an outcome this function does not yet
 *    know the name of): all `kesz` is `kesz`, none `kesz` is `hiba`, and a
 *    mix is `reszben`.
 *
 * @param {Array<{ platform: string, allapot: string }>} agak
 * @returns {'vazlat'|'utemezve'|'kesz'|'reszben'|'hiba'|'nincs_hova'}
 */
export function kiadasAllapot(agak) {
  const relevant = (Array.isArray(agak) ? agak : [])
    .filter((a) => a && a.allapot !== AG.NINCS_FIOK)

  if (relevant.length === 0) return KIADAS_ALLAPOT.NINCS_HOVA
  if (relevant.some((a) => a.allapot === AG.VAR)) return KIADAS_ALLAPOT.UTEMEZVE

  const kiment = relevant.filter((a) => a.allapot === AG.KESZ).length
  if (kiment === relevant.length) return KIADAS_ALLAPOT.KESZ
  if (kiment === 0) return KIADAS_ALLAPOT.HIBA
  return KIADAS_ALLAPOT.RESZBEN
}
