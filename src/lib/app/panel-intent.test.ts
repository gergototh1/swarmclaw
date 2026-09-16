import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { panelIntentForView, sidebarOpenAfter, sidebarOpenForNavigate } from './panel-intent'

describe('panelIntentForView', () => {
  it('toggles on a view with a panel, closes on a full-width view', () => {
    assert.equal(panelIntentForView('agents'), 'toggle')
    assert.equal(panelIntentForView('conversations'), 'toggle')
    // tasks is now the kanban board itself, rendered full width with no side
    // list beside it -- see FULL_WIDTH_VIEWS in view-constants.ts.
    assert.equal(panelIntentForView('tasks'), 'close')
    assert.equal(panelIntentForView('home'), 'close')
    assert.equal(panelIntentForView('settings'), 'close')
  })

})

describe('sidebarOpenAfter', () => {
  it('toggle collapses the open panel of the view you are already on', () => {
    assert.equal(sidebarOpenAfter('toggle', { currentView: 'tasks', targetView: 'tasks', sidebarOpen: true }), false)
  })

  it('toggle opens it when it is closed, or when coming from another view', () => {
    assert.equal(sidebarOpenAfter('toggle', { currentView: 'tasks', targetView: 'tasks', sidebarOpen: false }), true)
    assert.equal(sidebarOpenAfter('toggle', { currentView: 'agents', targetView: 'tasks', sidebarOpen: true }), true)
    assert.equal(sidebarOpenAfter('toggle', { currentView: null, targetView: null, sidebarOpen: true }), true)
  })

  it('open and close ignore where you are', () => {
    assert.equal(sidebarOpenAfter('open', { currentView: 'tasks', targetView: 'tasks', sidebarOpen: true }), true)
    assert.equal(sidebarOpenAfter('close', { currentView: null, targetView: 'home', sidebarOpen: true }), false)
  })
})

describe('sidebarOpenForNavigate', () => {
  it('reads both views from paths, ignoring query and hash', () => {
    assert.equal(sidebarOpenForNavigate('toggle', '/tasks', '/tasks?x=1#y', true), false)
    assert.equal(sidebarOpenForNavigate('toggle', '/chat/abc', '/chat', true), false)
    assert.equal(sidebarOpenForNavigate('toggle', '/agents', '/tasks', true), true)
    assert.equal(sidebarOpenForNavigate('close', '/tasks', '/x/docs', true), false)
  })
})
