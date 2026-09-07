import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { FULL_WIDTH_VIEWS, VIEW_DESCRIPTIONS, VIEW_LABELS, isPanelSidebarView, shouldAutoOpenPanelSidebar } from './view-constants'
import { getViewPath, pathToView } from './navigation'

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

  it('does not treat stream as panel-backed', () => {
    // The route layouts that used to render a SidebarPanelShell next to
    // /runs, /activity and /logs were dropped when those routes became plain
    // redirects into /stream. If 'stream' came back here, clicking it would
    // set sidebarOpen with no panel behind it, and that would leak into the
    // next panel-backed view.
    assert.equal(isPanelSidebarView('stream'), false)
    assert.equal(shouldAutoOpenPanelSidebar('stream', true), false)
  })

  it('does not treat vault as panel-backed', () => {
    // secrets/layout.tsx and wallets/layout.tsx (the ones that rendered a
    // SidebarPanelShell next to the page) were deleted when /secrets and
    // /wallets became plain redirects into /vault. If 'vault' came back here,
    // clicking it would set sidebarOpen with no panel behind it, and that
    // would leak into the next panel-backed view (Agents, Tasks, ...) the
    // user opens.
    assert.equal(isPanelSidebarView('vault'), false)
    assert.equal(shouldAutoOpenPanelSidebar('vault', true), false)
  })
})

describe('the merged views', () => {
  it('names stream and vault, and no longer their five predecessors', () => {
    assert.equal(VIEW_LABELS.stream, 'Stream')
    assert.equal(VIEW_LABELS.vault, 'Vault')
    for (const gone of ['runs', 'activity', 'logs', 'secrets', 'wallets']) {
      assert.equal(gone in VIEW_LABELS, false, `${gone} should be gone from VIEW_LABELS`)
    }
  })

  it('routes both merged views', () => {
    assert.equal(getViewPath('stream'), '/stream')
    assert.equal(getViewPath('vault'), '/vault')
  })

  it('maps the merged paths back; a tab query string falls outside the match', () => {
    assert.equal(pathToView('/stream'), 'stream')
    assert.equal(pathToView('/vault'), 'vault')
    // pathToView compares the exact string it's given against the registered
    // path, or a '/'-prefixed suffix of it. It never strips a query string,
    // so a path with one appended doesn't match. This never bites in the app:
    // the only caller (dashboard-shell.tsx) feeds it `usePathname()`, which
    // Next.js already returns without a query string attached.
    assert.equal(pathToView('/stream?tab=logs'), null)
    assert.equal(pathToView('/vault?tab=wallets'), null)
  })
})
