/**
 * Whether switching between the formatted and markdown views should save
 * first.
 *
 * The switch always converts the current view's text through the other
 * view's format on its way across (HTML -> markdown, or markdown -> HTML),
 * and that round-trip alone can change the text -- a table pipe gains
 * spaces, a horizontal rule becomes `* * *`, a numbered heading gets an
 * escaped dot -- even when the viewer never typed anything. Comparing the
 * round-tripped text to what the server last confirmed reports "different"
 * on every switch, whether or not anything was actually edited, which is
 * what used to save a new version -- authored by the viewer -- out of a
 * pure view change.
 *
 * The correct signal is `dirty`: whether the viewer actually edited since
 * the doc was loaded (or last saved), set by the editor's own change
 * handlers. The text-equality check stays as a second guard so an edit that
 * nets no change (typed, then undone) does not queue a no-op save either.
 */
export function shouldSaveOnModeSwitch(dirty: boolean, currentMd: string, savedMd: string): boolean {
  return dirty && currentMd !== savedMd
}
