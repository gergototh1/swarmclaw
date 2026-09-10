import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { collectCollapsedMedia } from './tool-events-section'

describe('collectCollapsedMedia', () => {
  const screenshotEvent = {
    id: 'tool-1',
    name: 'browser',
    input: '{"action":"screenshot"}',
    output: '![Screenshot](/api/uploads/screenshot-123.png)',
    status: 'done' as const,
  }

  it('collects explicit screenshot media when enabled', () => {
    const media = collectCollapsedMedia([screenshotEvent], { showCollapsedMedia: true })

    assert.deepEqual(media?.images, ['/api/uploads/screenshot-123.png'])
  })

  it('skips collapsed media previews when disabled', () => {
    const media = collectCollapsedMedia([screenshotEvent], { showCollapsedMedia: false })

    assert.equal(media, null)
  })
})

import { toolPillClass } from './tool-events-section'

/*
 * A csukott tool-sor nem kártya.
 *
 * Egy tool-hívás egy sor metaadat, nem strukturált rekord -- keretben
 * ugyanannyi helyet foglal a képernyőn, mint a válasz, amihez tartozik.
 * A keret a kinyitott állapoté, ahol tényleg van tartalom, amit el kell
 * határolni.
 */
describe('toolPillClass', () => {
  it('draws no unconditional border and no unconditional fill in the resting state', () => {
    const cls = toolPillClass(false, false)
    // A variant-prefixed token (e.g. `hover:bg-layer-1`) only applies on
    // interaction, not at rest -- it is out of scope for this assertion.
    // Only bare utility tokens describe the resting state itself.
    for (const token of cls.split(/\s+/)) {
      if (token.includes(':')) continue
      assert.ok(!/^border(-|$)/.test(token), `resting pill must have no unconditional border, got token: ${token}`)
      assert.ok(!/^bg-/.test(token), `resting pill must have no unconditional fill, got token: ${token}`)
    }
  })

  it('gains a hover surface, so the row still reads as clickable at rest', () => {
    const cls = toolPillClass(false, false)
    const hasHoverFill = cls.split(/\s+/).some((token) => /^hover:bg-/.test(token))
    assert.ok(hasHoverFill, `resting pill must gain a fill on hover, got: ${cls}`)
  })

  it('still colours a running pill, because that one is live', () => {
    assert.match(toolPillClass(true, false), /amber/)
  })

  it('still colours a mostly-failed pill, because that one needs the eye', () => {
    assert.match(toolPillClass(false, true), /rose/)
  })
})
