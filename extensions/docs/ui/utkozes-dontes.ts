/**
 * Whether a save's conflict response is our own earlier save landing first,
 * or a real conflict with somebody else's edit.
 *
 * A save can be issued while an earlier save for the SAME document is still
 * in flight (a flush racing a debounce, a Cmd+S racing the autosave). If that
 * earlier save lands first, the version it bumped makes this save's own
 * `baseVersion` stale, and the server answers with a conflict that is not
 * really a conflict -- it is this save arriving on top of ourselves. The fix
 * is to retry once, immediately, with the same markdown and the version the
 * server just reported.
 *
 * Any other conflict -- no other save was in flight for this document -- is
 * somebody else's edit, and so is a retry that itself conflicts: retrying
 * twice would either loop or paper over a real conflict, so the second one
 * always shows the conflict bar.
 */
export function dontsUjraprobalni(opts: {
  /** Was another save for the same document already in flight when this save was issued? */
  masikMentesFolyamatban: boolean
  /** Has this save call already retried once? */
  marUjraprobalt: boolean
}): boolean {
  return opts.masikMentesFolyamatban && !opts.marUjraprobalt
}

/**
 * Whether a save's SUCCESS response is stale.
 *
 * Two saves for the same document can be in flight at once (the autosave
 * debounce fires, then a Cmd+S or a flush races it before it returns). If the
 * later one lands first, it advances the version we hold; when the earlier
 * one's response arrives after that, applying it would roll the version and
 * the saved-text baseline backwards, and the next autosave would then send a
 * `baseVersion` the server already considers old -- an unprompted, false
 * conflict.
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

/**
 * Whether a save's CONFLICT response is stale.
 *
 * The same race as above can turn up as a conflict instead of a success: the
 * server's refusal names a `jelenlegiVerzio` that is itself no longer current
 * once a later save of ours has already landed. Such a conflict is not about
 * somebody else's edit; it is about a version our own later save has already
 * superseded, so it must neither show the conflict bar nor trigger a retry.
 */
export function utkozesElavult(opts: {
  /** The version the conflict response reports the server holding. */
  jelenlegiVerzio: number
  /** The version we already hold (before applying this response). */
  jelenlegi: number
}): boolean {
  return opts.jelenlegiVerzio <= opts.jelenlegi
}
