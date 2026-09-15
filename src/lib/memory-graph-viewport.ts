/**
 * Pan and zoom for the memory graph canvas.
 *
 * The graph used to render into a fixed `viewBox="0 0 800 600"` with no way to
 * move or scale it: once a store holds more than a handful of memories the
 * nodes pile on top of each other and nothing helps. These are the pure parts
 * of the fix, kept out of the component so the arithmetic can be tested without
 * a DOM.
 *
 * The convention is the usual one for an SVG scene: a single wrapper group
 * carries `translate(x,y) scale(k)`, screen coordinates go in, canvas
 * coordinates come out.
 */

export interface GraphViewport {
  /** Screen-space translation of the canvas origin. */
  x: number
  y: number
  scale: number
}

export interface Point {
  x: number
  y: number
}

export const MIN_GRAPH_ZOOM = 0.2
export const MAX_GRAPH_ZOOM = 6
export const IDENTITY_VIEWPORT: GraphViewport = { x: 0, y: 0, scale: 1 }

function clampScale(scale: number): number {
  return Math.min(MAX_GRAPH_ZOOM, Math.max(MIN_GRAPH_ZOOM, scale))
}

/** Where a screen point lands on the canvas under this viewport. */
export function toCanvasPoint(view: GraphViewport, screen: Point): Point {
  return {
    x: (screen.x - view.x) / view.scale,
    y: (screen.y - view.y) / view.scale,
  }
}

/**
 * Zoom about a fixed screen point.
 *
 * Holding the point under the cursor still is what makes zooming feel
 * steerable: what you are looking at stays where it is, rather than the canvas
 * centre being the thing that never moves.
 */
export function zoomViewportAt(view: GraphViewport, screen: Point, factor: number): GraphViewport {
  if (!Number.isFinite(factor) || factor <= 0) return view
  const scale = clampScale(view.scale * factor)
  if (scale === view.scale) return view
  // Solve for the translation that keeps `screen` mapping to the same canvas point.
  const anchor = toCanvasPoint(view, screen)
  return {
    scale,
    x: screen.x - anchor.x * scale,
    y: screen.y - anchor.y * scale,
  }
}

/** Drag the canvas by a screen-space delta. */
export function panViewport(view: GraphViewport, dx: number, dy: number): GraphViewport {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return view
  return { ...view, x: view.x + dx, y: view.y + dy }
}

/** The SVG transform for one wrapper group. Rounded so a drag does not churn the attribute. */
export function viewportTransform(view: GraphViewport): string {
  const round = (value: number, places: number) => {
    const factor = 10 ** places
    return String(Math.round(value * factor) / factor)
  }
  return `translate(${round(view.x, 2)},${round(view.y, 2)}) scale(${round(view.scale, 3)})`
}

/** Padding around a fitted cluster, as a fraction of the shorter side. */
const FIT_PADDING = 0.12

/**
 * Frame every node inside the canvas.
 *
 * Never magnifies: a lone node, or a tight cluster, would otherwise be blown up
 * to fill the screen, which reads as a bug rather than as a fit.
 */
export function fitViewport(points: Point[], size: { width: number; height: number }): GraphViewport {
  const usable = points.filter((p) => Number.isFinite(p?.x) && Number.isFinite(p?.y))
  if (!usable.length || !(size.width > 0) || !(size.height > 0)) return IDENTITY_VIEWPORT

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of usable) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }

  const spanX = Math.max(1, maxX - minX)
  const spanY = Math.max(1, maxY - minY)
  const pad = 1 + FIT_PADDING * 2
  const scale = clampScale(Math.min(1, Math.min(size.width / (spanX * pad), size.height / (spanY * pad))))

  const centreX = (minX + maxX) / 2
  const centreY = (minY + maxY) / 2
  return {
    scale,
    x: size.width / 2 - centreX * scale,
    y: size.height / 2 - centreY * scale,
  }
}
