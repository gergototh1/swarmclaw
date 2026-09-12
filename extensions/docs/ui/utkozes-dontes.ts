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
