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
  it('draws no border and no fill in the resting state', () => {
    const cls = toolPillClass(false, false)
    assert.ok(!cls.includes('border-'), `resting pill must be borderless, got: ${cls}`)
    assert.ok(!cls.includes('bg-'), `resting pill must have no fill, got: ${cls}`)
  })

  it('still colours a running pill, because that one is live', () => {
    assert.match(toolPillClass(true, false), /amber/)
  })

  it('still colours a mostly-failed pill, because that one needs the eye', () => {
    assert.match(toolPillClass(false, true), /rose/)
  })
})
