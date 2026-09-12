/**
 * What to do with a save's CONFLICT response: retry it, show the conflict bar,
 * or discard it as stale.
 *
 * A save can be issued while an earlier save for the SAME document is still in
 * flight (a flush racing a debounce, a Cmd+S racing the autosave, a rename
 * racing either). If that earlier save lands first, the version it bumped
 * makes this save's own `baseVersion` stale, and the server answers with a
 * conflict that is not really a conflict -- it is this save arriving on top of
 * ourselves. That is a SELF-INFLICTED conflict, and the fix is to retry once,
 * immediately, with the same markdown and the version WE currently hold (which
 * is at least as new as the conflict's `jelenlegiVerzio`, because it already
 * reflects whichever of our own saves landed first).
 *
 * ONE RULE, NOT TWO STEPS. An earlier version of this decision checked
 * staleness first and asked about retrying only if the conflict was not
 * stale. That ordering has a hole: two saves for one document, an older-text
 * S1 and a newer-text S2, both built on the same base version. If S1 succeeds
 * first, the held version advances, and S2's conflict reports that very same
 * version -- which the staleness check reads as "stale" and discards BEFORE
 * the retry check ever runs, even though S2's conflict is exactly the
 * self-inflicted case the retry exists for. S2's newer text is then neither
 * retried nor shown as a conflict; it is silently lost. Checking
 * self-inflictedness FIRST, unconditionally, closes that hole: it does not
 * matter which of two racing saves for the same document reports the
 * conflict, or in which order they arrive, self-infliction alone decides.
 *
 * A conflict that is not self-inflicted is somebody else's edit -- and so is a
 * conflict from a save that has already retried once (retrying twice would
 * either loop or paper over a real conflict). For those, whether to show the
 * conflict bar depends on whether the reported version is actually newer than
 * what we hold: if it is not (our own later, unrelated save already moved us
 * past it, or the report is simply stale), there is nothing to show and the
 * response is discarded.
 */
export type UtkozesDontes = 'ujraprobal' | 'sav' | 'eldob'

export function dontsUtkozesrol(opts: {
  /** Was another save for the same document already in flight when this save was issued? */
  masikMentesFolyamatban: boolean
  /** Has this save call already retried once? */
  marUjraprobalt: boolean
  /** The version the conflict response reports the server holding. */
  jelenlegiVerzio: number
  /** The version we already hold (before applying this response). */
  jelenlegi: number
}): UtkozesDontes {
  if (opts.masikMentesFolyamatban && !opts.marUjraprobalt) return 'ujraprobal'
  if (opts.jelenlegiVerzio > opts.jelenlegi) return 'sav'
  return 'eldob'
}

/**
 * Whether a save's SUCCESS response is stale.
 *
 * Two saves for the same document can be in flight at once (the autosave
 * debounce fires, then a Cmd+S, a flush or a rename races it before it
 * returns). If the later one lands first, it advances the version we hold;
 * when the earlier one's response arrives after that, applying it would roll
 * the version and the saved-text baseline backwards, and the next autosave
 * would then send a `baseVersion` the server already considers old -- an
 * unprompted, false conflict.
 *
 * A response is stale when the version it reports is not newer than the
 * version we already hold. A response that reports no version at all (older
 * server behaviour) is never stale -- there is nothing to compare, so it is
 * applied as before.
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
