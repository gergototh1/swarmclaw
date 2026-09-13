import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { detectShellMode, tabIdFromWindow } from './shell-mode'

function top(name = '') {
  const win = { name, parent: null as unknown, self: null as unknown }
  win.parent = win
  win.self = win
  return win
}

function framed(name: string) {
  const win = { name, parent: {}, self: null as unknown }
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
})
