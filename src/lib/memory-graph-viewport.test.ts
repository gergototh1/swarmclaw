import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  IDENTITY_VIEWPORT,
  MAX_GRAPH_ZOOM,
  MIN_GRAPH_ZOOM,
  fitViewport,
  panViewport,
  toCanvasPoint,
  viewportTransform,
  zoomViewportAt,
} from './memory-graph-viewport'

/*
 * A memória-gráf vászna eddig egy fix `viewBox="0 0 800 600"` volt: nem lehetett
 * nagyítani, kicsinyíteni, sem mozogni rajta. Sok bejegyzésnél a pontok
 * egymásra csúsznak, és semmi nem segít rajta.
 *
 * A nagyítás a kurzor alatti pontot tartja helyben -- ez az, amitől a zoom
 * irányíthatónak érződik: amire ránézel, az marad a helyén, nem a vászon
 * közepe.
 */
describe('zoomViewportAt', () => {
  it('keeps the point under the cursor where it is', () => {
    const before = toCanvasPoint(IDENTITY_VIEWPORT, { x: 300, y: 200 })
    const zoomed = zoomViewportAt(IDENTITY_VIEWPORT, { x: 300, y: 200 }, 1.5)
    const after = toCanvasPoint(zoomed, { x: 300, y: 200 })
    assert.ok(Math.abs(after.x - before.x) < 0.001, `x moved: ${before.x} -> ${after.x}`)
    assert.ok(Math.abs(after.y - before.y) < 0.001, `y moved: ${before.y} -> ${after.y}`)
  })

  it('zooms in and out', () => {
    assert.ok(zoomViewportAt(IDENTITY_VIEWPORT, { x: 0, y: 0 }, 2).scale > IDENTITY_VIEWPORT.scale)
    assert.ok(zoomViewportAt(IDENTITY_VIEWPORT, { x: 0, y: 0 }, 0.5).scale < IDENTITY_VIEWPORT.scale)
  })

  it('stops at the limits instead of vanishing or filling the screen', () => {
    let view = IDENTITY_VIEWPORT
    for (let i = 0; i < 40; i++) view = zoomViewportAt(view, { x: 0, y: 0 }, 1.4)
    assert.equal(view.scale, MAX_GRAPH_ZOOM)
    for (let i = 0; i < 80; i++) view = zoomViewportAt(view, { x: 0, y: 0 }, 0.7)
    assert.equal(view.scale, MIN_GRAPH_ZOOM)
  })

  it('ignores a factor that is not a usable number', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.deepEqual(zoomViewportAt(IDENTITY_VIEWPORT, { x: 10, y: 10 }, bad), IDENTITY_VIEWPORT)
    }
  })
})

describe('panViewport', () => {
  it('moves the canvas by the drag distance', () => {
    const moved = panViewport(IDENTITY_VIEWPORT, 40, -25)
    assert.equal(moved.x, IDENTITY_VIEWPORT.x + 40)
    assert.equal(moved.y, IDENTITY_VIEWPORT.y - 25)
    assert.equal(moved.scale, IDENTITY_VIEWPORT.scale)
  })

  it('pans by the same screen distance whatever the zoom', () => {
    // A húzás képernyőpixelben történik; a transzformáció a scale-t nem érinti.
    const zoomed = zoomViewportAt(IDENTITY_VIEWPORT, { x: 0, y: 0 }, 2)
    const moved = panViewport(zoomed, 10, 10)
    assert.equal(moved.x - zoomed.x, 10)
  })
})

describe('viewportTransform', () => {
  it('renders as an SVG transform', () => {
    assert.equal(viewportTransform({ x: 12, y: -3, scale: 1.5 }), 'translate(12,-3) scale(1.5)')
  })

  it('rounds, so a drag does not rewrite the attribute with noise', () => {
    const t = viewportTransform({ x: 0.123456, y: 9.987654, scale: 1.234567 })
    assert.equal(t, 'translate(0.12,9.99) scale(1.235)')
  })
})

describe('fitViewport', () => {
  const size = { width: 800, height: 600 }

  it('centres a cluster that sits off to one side', () => {
    const view = fitViewport([{ x: 1000, y: 900 }, { x: 1100, y: 1000 }], size)
    const centre = toCanvasPoint(view, { x: size.width / 2, y: size.height / 2 })
    assert.ok(Math.abs(centre.x - 1050) < 40, `centre x = ${centre.x}`)
    assert.ok(Math.abs(centre.y - 950) < 40, `centre y = ${centre.y}`)
  })

  it('does not blow a single node up to fill the canvas', () => {
    const view = fitViewport([{ x: 400, y: 300 }], size)
    assert.ok(view.scale <= 1, `a lone node should not be magnified, got ${view.scale}`)
  })

  it('falls back to the identity view when there is nothing to fit', () => {
    assert.deepEqual(fitViewport([], size), IDENTITY_VIEWPORT)
  })

  it('never returns a scale outside the limits', () => {
    const wide = fitViewport([{ x: -100000, y: -100000 }, { x: 100000, y: 100000 }], size)
    assert.ok(wide.scale >= MIN_GRAPH_ZOOM && wide.scale <= MAX_GRAPH_ZOOM, `scale ${wide.scale}`)
  })
})
