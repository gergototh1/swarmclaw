import { KIADAS_ALLAPOTOK } from './db.mjs'

/**
 * The calendar's arithmetic: which slot an approved release lands in next,
 * and which already-scheduled releases are due right now.
 *
 * SPEC 7'S CONTRADICTION, RESOLVED
 * =================================
 * Design spec 7 names it directly: the host's `ExtensionManagedScheduleDeclaration`
 * (`index.mjs`'s `SCHEDULES`) is a STATIC declaration, fixed at import time --
 * a cron string or an interval, written once, read by the host's own
 * scheduler. The slots in `ext_publish_savok` are OPERATOR DATA: rows an
 * operator adds, edits and removes at any time, through a page a later task
 * builds. A static declaration cannot "become" whatever the operator's
 * slots currently say, and this module has no way to mint or edit a host
 * schedule from inside a tool call -- `index.mjs`'s `SCHEDULES` is read once,
 * at extension load, the same as every sibling module's.
 *
 * So the two stay separate, on purpose, each doing only what it can:
 *
 *   - The DECLARED SCHEDULE runs at a FIX CADENCE (`index.mjs`, default
 *     every 15 minutes) and does not change when the operator edits a slot.
 *     It does not decide WHAT to send, or WHEN a release is due -- it only
 *     decides how often someone comes and asks `esedekes()`.
 *   - The SLOT decides WHEN, for one release: `kovetkezoSzabadSav` turns
 *     "every Monday at 09:00" plus "what's already taken" into one concrete
 *     instant, written onto that release's row once (a later task's job).
 *     From that point on the slot has done its job; the row carries its own
 *     `idopont` and the slot pattern is never consulted again for it.
 *
 * `esedekes()` is the seam between the two: given "now", which
 * already-scheduled releases have a due instant at or before it. It does not
 * care whether that instant came from a slot or from an operator's manual
 * override (design spec 7's "felülírt időpontút egyaránt" -- an overridden
 * time counts exactly the same as a slotted one) -- by the time a release
 * reaches `esedekes()`, both have collapsed to the same one field.
 *
 * THE SLIP THIS BUYS, AND WHO PAYS IT
 * ====================================
 * A release due at 09:00 is not sent at 09:00. It is sent at the first FIXED
 * run at or after 09:00 -- with the default cadence, up to a quarter hour
 * later. This is not a bug the fix cadence introduces by accident; it is the
 * whole reason the docblock above says "does not change when the operator
 * edits a slot" is a feature, not a gap. Every due release pays the same
 * slip, not only the ones with a manually overridden time, which is why
 * `esedekes` uses `<=` rather than `===`: the run that finally notices a due
 * release is never the run whose clock matches the release's instant to the
 * second.
 *
 * THE BOUNDARY THIS FILE DOES NOT CROSS
 * =======================================
 * `esedekes` filters on `ext_publish_kiadasok.allapot`, the STORED workflow
 * column (`KIADAS_ALLAPOTOK`, src/db.mjs) -- never on `kiadasAllapot`'s
 * computed answer (src/allapot.mjs). A draft's branches are all `var`, and
 * `kiadasAllapot` answers `utemezve` for any release with even one `var`
 * branch -- which is this filter's own trigger word. Routing the derived
 * answer into this filter would publish an unapproved draft to four
 * platforms the moment a caller mistook "what did dispatch do" for "is this
 * approved". `kiadasAllapot` cannot even produce the workflow words any more
 * (see its own docblock), which is what makes that particular mistake hard
 * to write by accident; this file does not reopen it by reading the wrong
 * source for the same word.
 */

const EGY_HET_MS = 7 * 24 * 60 * 60 * 1000

/**
 * One slot's next weekly occurrence STRICTLY AFTER `most`, in UTC.
 *
 * "Strictly after" and not "at or after": an occurrence equal to `most` is
 * a slot the clock is standing on right this instant, not a future one to
 * hand out -- `kovetkezoSzabadSav` must never return a time that is not
 * still ahead of the caller's own clock, and treating an exact match as
 * "free" would be the one case that slips through.
 *
 * Pure arithmetic in UTC only: no local timezone, no DST, so the same
 * `nap`/`ora`/`perc` means the same instant on every host this runs on.
 */
function kovetkezoElofordulas(sav, most) {
  const mostMs = most.getTime()
  const maiNap = most.getUTCDay()
  const napkulonbseg = (sav.nap - maiNap + 7) % 7
  let jelolt = new Date(Date.UTC(
    most.getUTCFullYear(), most.getUTCMonth(), most.getUTCDate() + napkulonbseg,
    sav.ora, sav.perc, 0, 0,
  ))
  if (jelolt.getTime() <= mostMs) jelolt = new Date(jelolt.getTime() + EGY_HET_MS)
  return jelolt
}

function ervenytelenSav(sav) {
  return typeof sav !== 'object' || sav === null || typeof sav.id !== 'string'
    || !Number.isInteger(sav.nap) || sav.nap < 0 || sav.nap > 6
    || !Number.isInteger(sav.ora) || sav.ora < 0 || sav.ora > 23
    || !Number.isInteger(sav.perc) || sav.perc < 0 || sav.perc > 59
}

/**
 * The next free occurrence, across every declared slot, strictly after
 * `most` -- or `null` when there are no slots at all.
 *
 * "Free" is decided per (sav, occurrence): `foglaltak` is the list of
 * occurrences already handed to a release (`{ savId, idopont }`, `idopont`
 * an ISO instant). A slot whose next occurrence is already taken does not
 * drop out of the running -- it rolls forward a week at a time until it
 * finds one that is not, exactly the way the slot recurs in reality. The
 * WINNER is the single earliest free occurrence over every slot, not the
 * first slot in the array to have one free: a slot later in `savok` with an
 * earlier free time wins over one earlier in the array with a later one.
 *
 * Pure: no clock read, no database read. `most` is always the caller's own
 * `new Date()` (or a fixture's), so this is testable without one.
 *
 * @param {Array<{ id: string, nap: number, ora: number, perc: number }>} savok
 * @param {Array<{ savId: string, idopont: string }>} foglaltak
 * @param {Date} most
 * @returns {{ savId: string, idopont: string } | null}
 */
export function kovetkezoSzabadSav(savok, foglaltak, most) {
  if (!Array.isArray(savok)) throw new TypeError('kovetkezoSzabadSav: a savok csak sáv-sorok tömbje lehet')
  if (!Array.isArray(foglaltak)) throw new TypeError('kovetkezoSzabadSav: a foglaltak csak foglalt sáv-előfordulások tömbje lehet')
  if (!(most instanceof Date) || Number.isNaN(most.getTime())) throw new TypeError('kovetkezoSzabadSav: a most csak érvényes Date lehet')
  if (savok.some(ervenytelenSav)) {
    throw new TypeError('kovetkezoSzabadSav: minden sáv id, nap (0-6), ora (0-23) és perc (0-59) mezőt kell hordozzon')
  }
  if (savok.length === 0) return null

  const foglaltKulcsok = new Set(foglaltak.map((f) => `${f.savId}@${new Date(f.idopont).toISOString()}`))

  let legjobb = null
  for (const sav of savok) {
    let jelolt = kovetkezoElofordulas(sav, most)
    while (foglaltKulcsok.has(`${sav.id}@${jelolt.toISOString()}`)) {
      jelolt = new Date(jelolt.getTime() + EGY_HET_MS)
    }
    if (legjobb === null || jelolt.getTime() < legjobb.jelolt.getTime()) {
      legjobb = { savId: sav.id, jelolt }
    }
  }
  return { savId: legjobb.savId, idopont: legjobb.jelolt.toISOString() }
}

/**
 * The scheduled releases whose due instant has come, as of `most`.
 *
 * Two conditions, both required: `allapot === KIADAS_ALLAPOTOK.UTEMEZVE` --
 * the STORED workflow column, see the docblock above for why this is never
 * `kiadasAllapot`'s computed answer -- and `idopont <= most` (`<=`, not
 * `<`: a release due at exactly `most` is due, not "due next run").
 *
 * A row missing `idopont` (a stored value only a scheduled release carries)
 * is simply not due rather than a thrown error, since a caller may well pass
 * the whole `kiadasok()` table, drafts included, and a draft has no `idopont`
 * at all.
 *
 * @param {Array<{ id: string, allapot: string, idopont?: string | null }>} kiadasok
 * @param {Date} most
 * @returns {Array<{ id: string, allapot: string, idopont?: string | null }>}
 */
export function esedekes(kiadasok, most) {
  if (!Array.isArray(kiadasok)) throw new TypeError('esedekes: a kiadasok csak kiadás-sorok tömbje lehet')
  for (const k of kiadasok) {
    if (typeof k !== 'object' || k === null || typeof k.allapot !== 'string') {
      throw new TypeError('esedekes: a kiadasok minden eleme kiadás-sor kell legyen, string allapot mezővel')
    }
  }
  if (!(most instanceof Date) || Number.isNaN(most.getTime())) throw new TypeError('esedekes: a most csak érvényes Date lehet')
  const mostMs = most.getTime()
  return kiadasok.filter((k) => k.allapot === KIADAS_ALLAPOTOK.UTEMEZVE && typeof k.idopont === 'string' && Date.parse(k.idopont) <= mostMs)
}
