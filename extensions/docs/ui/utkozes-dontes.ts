/**
 * What to do with a save's CONFLICT response: show the conflict bar, or
 * discard it as stale.
 *
 * Saves for one document are serialized (`mentes-sor.ts`): a save always
 * reads its base version only after the previous save for that same document
 * has settled, so by the time it is issued its base is guaranteed fresh. That
 * removes the self-inflicted conflict this module used to special-case --
 * two saves for the same document racing each other and one's success
 * making the other's own base stale is now impossible, because they can no
 * longer be in flight at the same time. What is left is simpler: a conflict
 * on the still-open document can only be somebody else's edit. Whether to
 * show the conflict bar for it depends on whether the reported version is
 * actually newer than what we hold: if it is not (a stale report, or our own
 * later, unrelated save already moved us past it), there is nothing to show
 * and the response is discarded.
 */
export type UtkozesDontes = 'sav' | 'eldob'

export function dontsUtkozesrol(opts: {
  /** The version the conflict response reports the server holding. */
  jelenlegiVerzio: number
  /** The version we already hold (before applying this response). */
  jelenlegi: number
}): UtkozesDontes {
  if (opts.jelenlegiVerzio > opts.jelenlegi) return 'sav'
  return 'eldob'
}

/**
 * Whether a save's SUCCESS response is stale.
 *
 * Saves for one document are serialized, so two of them cannot be in flight
 * at once -- but a save's response can still race a DOCUMENT SWITCH (the
 * component moves on before the awaited response lands) or a rename issued
 * right after a save started applying its own version bump. A response is
 * stale when the version it reports is not newer than the version we already
 * hold. A response that reports no version at all (older server behaviour)
 * is never stale -- there is nothing to compare, so it is applied as before.
 */
export function valaszElavult(opts: {
  /** The version this response reports, if any. */
  uj: number | undefined
  /** The version we already hold (before applying this response). */
  jelenlegi: number
}): boolean {
  if (typeof opts.uj !== 'number') return false
  return opts.uj <= opts.jelenlegi
}
