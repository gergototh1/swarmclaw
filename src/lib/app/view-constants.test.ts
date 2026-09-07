import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { FULL_WIDTH_VIEWS, VIEW_DESCRIPTIONS, VIEW_LABELS, isPanelSidebarView, shouldAutoOpenPanelSidebar } from './view-constants'

describe('panel sidebar route helpers', () => {
  it('treats knowledge as a panel-backed view', () => {
    assert.equal(isPanelSidebarView('knowledge'), true)
  })

  it('auto-opens panel-backed views only on desktop', () => {
    assert.equal(shouldAutoOpenPanelSidebar('knowledge', true), true)
    assert.equal(shouldAutoOpenPanelSidebar('knowledge', false), false)
  })

  it('does not auto-open full-width views without panel layouts', () => {
    assert.equal(shouldAutoOpenPanelSidebar('home', true), false)
    assert.equal(shouldAutoOpenPanelSidebar('settings', true), false)
    assert.equal(shouldAutoOpenPanelSidebar(null, true), false)
  })

  it('registers quality as a full-width operator workspace', () => {
    assert.equal(VIEW_LABELS.quality, 'Quality')
    assert.match(VIEW_DESCRIPTIONS.quality, /evals/i)
    assert.equal(FULL_WIDTH_VIEWS.has('quality'), true)
    assert.equal(isPanelSidebarView('quality'), false)
  })

  it('does not treat runs or logs as panel-backed now that /stream owns them', () => {
    // Their route layouts (the ones that rendered a SidebarPanelShell) were
    // dropped when /runs and /logs became plain redirects into /stream. If
    // either came back here, clicking them would set sidebarOpen with no
    // panel behind it, and that would leak into the next panel-backed view.
    assert.equal(isPanelSidebarView('runs'), false)
    assert.equal(isPanelSidebarView('logs'), false)
    assert.equal(shouldAutoOpenPanelSidebar('runs', true), false)
    assert.equal(shouldAutoOpenPanelSidebar('logs', true), false)
  })
})
