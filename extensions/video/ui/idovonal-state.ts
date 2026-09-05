/**
 * The timeline's arithmetic, with no DOM and no React in it.
 *
 * The timeline is the one place on this page where a click becomes two stored
 * numbers -- `at_ms` and `jelenet` on a feedback row -- so the mapping from a
 * pixel to those numbers is a pure function the test drives directly rather
 * than something only a browser can exercise.
 */

/** One scene's span on a finished render, as `render.mjs` stored it in `jelenet_hatarok`. */
export interface Hatar {
  jelenet: number
  kezdetMs: number
  vegMs: number
}

/**
 * The scene whose bounds contain `atMs`, or null outside the timeline.
 *
 * Bounds are half-open, [kezdetMs, vegMs): the boundary millisecond belongs to
 * the scene that starts there, so two adjacent scenes never both claim it and
 * the last scene's own `vegMs` is outside the video. That is the same rule
 * `sablon.mjs` maps feedback to a scene by, and the two must agree or a note
 * would count towards one template on the Video view and another in the
 * template table.
 */
export function pontbolJelenet(hatarok: Hatar[], atMs: number): number | null {
  const hit = hatarok.find((h) => atMs >= h.kezdetMs && atMs < h.vegMs)
  return hit ? hit.jelenet : null
}

/**
 * Pixel offset to ms on a timeline of `teljesMs` drawn `widthPx` wide.
 *
 * Clamped to the timeline at both ends, so a pointer dragged off the element
 * yields the first or the last millisecond rather than a negative time the
 * rpc layer would refuse. A zero or negative width or duration is 0 rather
 * than a division by zero: an element that has not been laid out yet cannot
 * say where the click landed, and 0 is the only answer that is not invented.
 */
export function pixelbolMs(x: number, widthPx: number, teljesMs: number): number {
  if (widthPx <= 0 || teljesMs <= 0) return 0
  const arany = Math.min(1, Math.max(0, x / widthPx))
  return Math.round(arany * teljesMs)
}

/** The end of the last scene, which is what the timeline is drawn against. 0 for no scenes. */
export function teljesHossz(hatarok: Hatar[]): number {
  return hatarok.reduce((max, h) => (h.vegMs > max ? h.vegMs : max), 0)
}

/**
 * A span's left edge and width as percentages of the whole timeline.
 *
 * Percentages rather than pixels because the element is fluid and the bounds
 * are known before it is measured. A `teljesMs` of 0 puts everything at the
 * left edge with no width, which is what an empty timeline should draw.
 */
export function szazalek(kezdetMs: number, vegMs: number, teljesMs: number): { left: number; width: number } {
  if (teljesMs <= 0) return { left: 0, width: 0 }
  const left = Math.min(100, Math.max(0, (kezdetMs / teljesMs) * 100))
  const right = Math.min(100, Math.max(0, (vegMs / teljesMs) * 100))
  return { left, width: Math.max(0, right - left) }
}
