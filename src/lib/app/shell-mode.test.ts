import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { detectShellMode, tabIdFromWindow, type WindowLike } from './shell-mode'

const ORIGIN = 'http://a.example'

function top(name = '', origin = ORIGIN): WindowLike {
  const win: WindowLike = { name, parent: null as unknown as WindowLike, self: null, location: { origin } }
  win.parent = win
  win.self = win
  return win
}

interface FramedOptions {
  origin?: string
  parentOrigin?: string
  parentThrows?: boolean
}

function framed(name: string, opts: FramedOptions = {}): WindowLike {
  const origin = opts.origin ?? ORIGIN
  const parent: WindowLike = opts.parentThrows
    ? {
        name: '',
        parent: null as unknown as WindowLike,
        self: null,
        get location(): { origin: string } {
          throw new Error('blocked: cross-origin frame')
        },
      }
    : { name: '', parent: null as unknown as WindowLike, self: null, location: { origin: opts.parentOrigin ?? origin } }
  const win: WindowLike = { name, parent, self: null, location: { origin } }
  win.self = win
  return win
}

describe('detectShellMode', () => {
  it('is plain on the server', () => {
    assert.equal(detectShellMode(undefined, { isDesktop: true, tabsEnabled: true }), 'plain')
  })

  it('is host for a top window at desktop width with tabs on', () => {
    assert.equal(detectShellMode(top(), { isDesktop: true, tabsEnabled: true }), 'host')
    assert.equal(detectShellMode(top(), { isDesktop: false, tabsEnabled: true }), 'plain')
    assert.equal(detectShellMode(top(), { isDesktop: true, tabsEnabled: false }), 'plain')
  })

  it('is tab for a frame the host named, whatever the width', () => {
    assert.equal(detectShellMode(framed('sc-tab:t1'), { isDesktop: false, tabsEnabled: false }), 'tab')
    assert.equal(tabIdFromWindow(framed('sc-tab:t1')), 't1')
  })

  it('is plain when framed by anything else, and never host there', () => {
    assert.equal(detectShellMode(framed('embed'), { isDesktop: true, tabsEnabled: true }), 'plain')
    assert.equal(tabIdFromWindow(top('sc-tab:t1')), null)
  })

  it('is plain (not tab) for a tab-named frame whose parent is a different origin', () => {
    const win = framed('sc-tab:t1', { origin: ORIGIN, parentOrigin: 'http://b.example' })
    assert.equal(tabIdFromWindow(win), null)
    assert.equal(detectShellMode(win, { isDesktop: false, tabsEnabled: false }), 'plain')
  })

  it('is plain (not tab) for a tab-named frame whose parent throws reading location', () => {
    const win = framed('sc-tab:t1', { parentThrows: true })
    assert.equal(tabIdFromWindow(win), null)
    assert.equal(detectShellMode(win, { isDesktop: false, tabsEnabled: false }), 'plain')
  })

  it('is tab for a tab-named frame with a same-origin parent', () => {
    const win = framed('sc-tab:t1')
    assert.equal(tabIdFromWindow(win), 't1')
    assert.equal(detectShellMode(win, { isDesktop: false, tabsEnabled: false }), 'tab')
  })
})
