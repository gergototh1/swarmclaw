import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  CLOSED_TABS_CAP, HOME_URL, activateByPosition, activateRelative, activateTab, closeTab, initialTabsState,
  landOnUrl, liveTabIds, moveTab, newTabId, openTab, reopenClosedTab, setTabTitle, setTabUrl, tabsStateFromStorage,
  type TabsState,
} from './tabs'

function ids() {
  let n = 0
  return () => `t${++n}`
}

function withTabs(urls: string[]): TabsState {
  const newId = ids()
  let state = initialTabsState(newId, urls[0])
  for (const url of urls.slice(1)) state = openTab(state, { id: newId(), url, title: null })
  return state
}

describe('initialTabsState', () => {
  it('starts with one Home tab that is active', () => {
    const state = initialTabsState(ids())
    assert.deepEqual(state.tabs, [{ id: 't1', url: HOME_URL, title: null }])
    assert.equal(state.activeId, 't1')
    assert.deepEqual(state.lastUsed, ['t1'])
  })
})

describe('openTab', () => {
  it('inserts right after the active tab and activates it by default', () => {
    let state = withTabs(['/home', '/tasks'])
    state = activateTab(state, 't1')
    state = openTab(state, { id: 'x', url: '/chat', title: null })
    assert.deepEqual(state.tabs.map((t) => t.id), ['t1', 'x', 't2'])
    assert.equal(state.activeId, 'x')
    assert.equal(state.lastUsed[0], 'x')
  })

  it('can open in the background', () => {
    const state = openTab(withTabs(['/home']), { id: 'x', url: '/chat', title: null }, { activate: false })
    assert.equal(state.activeId, 't1')
    assert.deepEqual(state.lastUsed, ['t1', 'x'])
  })
})

describe('closeTab', () => {
  it('activates the right neighbour, else the left one', () => {
    const three = withTabs(['/a', '/b', '/c'])
    const middle = closeTab(activateTab(three, 't2'), 't2', ids())
    assert.equal(middle.activeId, 't3')
    const last = closeTab(three, 't3', ids())
    assert.equal(last.activeId, 't2')
  })

  it('keeps the active tab when a background tab closes', () => {
    const state = closeTab(withTabs(['/a', '/b']), 't1', ids())
    assert.equal(state.activeId, 't2')
    assert.deepEqual(state.lastUsed, ['t2'])
  })

  it('leaves a Home tab when the last tab closes', () => {
    const state = closeTab(initialTabsState(() => 'only', '/tasks'), 'only', () => 'fresh')
    assert.deepEqual(state.tabs, [{ id: 'fresh', url: HOME_URL, title: null }])
    assert.equal(state.activeId, 'fresh')
    assert.equal(state.closed[0].url, '/tasks')
  })

  it('caps the closed stack', () => {
    const newId = ids()
    let state = initialTabsState(newId)
    for (let i = 0; i < CLOSED_TABS_CAP + 3; i++) {
      state = openTab(state, { id: newId(), url: `/p${i}`, title: null })
      state = closeTab(state, state.activeId, newId)
    }
    assert.equal(state.closed.length, CLOSED_TABS_CAP)
  })

  it('returns the same state for an unknown id', () => {
    const state = withTabs(['/a'])
    assert.equal(closeTab(state, 'nope', ids()), state)
  })
})

describe('reopenClosedTab', () => {
  it('brings back the most recently closed tab and activates it', () => {
    let state = withTabs(['/a', '/b'])
    state = closeTab(state, 't2', ids())
    state = reopenClosedTab(state)
    assert.deepEqual(state.tabs.map((t) => t.url), ['/a', '/b'])
    assert.equal(state.activeId, 't2')
    assert.equal(state.closed.length, 0)
  })

  it('does nothing with an empty stack', () => {
    const state = withTabs(['/a'])
    assert.equal(reopenClosedTab(state), state)
  })
})

describe('moveTab, setTabUrl, setTabTitle', () => {
  it('moves a tab to a clamped index', () => {
    const state = moveTab(withTabs(['/a', '/b', '/c']), 't1', 99)
    assert.deepEqual(state.tabs.map((t) => t.id), ['t2', 't3', 't1'])
  })

  it('returns the same state when url or title is unchanged', () => {
    const state = withTabs(['/a'])
    assert.equal(setTabUrl(state, 't1', '/a'), state)
    assert.equal(setTabTitle(state, 't1', null), state)
    assert.equal(setTabUrl(state, 't1', '/b').tabs[0].url, '/b')
    assert.equal(setTabTitle(state, 't1', 'CRM').tabs[0].title, 'CRM')
  })
})

describe('keyboard-style activation', () => {
  it('goes to a position, 9 meaning the last tab', () => {
    const state = withTabs(['/a', '/b', '/c'])
    assert.equal(activateByPosition(state, 2).activeId, 't2')
    assert.equal(activateByPosition(state, 9).activeId, 't3')
    assert.equal(activateByPosition(state, 5), state)
  })

  it('wraps next and previous', () => {
    const state = activateTab(withTabs(['/a', '/b', '/c']), 't3')
    assert.equal(activateRelative(state, 1).activeId, 't1')
    assert.equal(activateRelative(activateTab(state, 't1'), -1).activeId, 't3')
  })
})

describe('liveTabIds', () => {
  it('keeps the most recently used, up to the cap, active first', () => {
    const newId = ids()
    let state = initialTabsState(newId)
    for (let i = 0; i < 7; i++) state = openTab(state, { id: newId(), url: `/p${i}`, title: null })
    const live = liveTabIds(state, 6)
    assert.equal(live.length, 6)
    assert.equal(live[0], state.activeId)
    assert.ok(!live.includes('t1'))
  })
})

describe('landOnUrl', () => {
  it('activates a tab already on that URL', () => {
    const state = landOnUrl(withTabs(['/a', '/b']), '/a', ids())
    assert.equal(state.activeId, 't1')
    assert.equal(state.tabs.length, 2)
  })

  it('opens a new tab for any other URL', () => {
    const state = landOnUrl(withTabs(['/a']), '/tasks', () => 'fresh')
    assert.equal(state.activeId, 'fresh')
    assert.equal(state.tabs.length, 2)
  })
})

describe('tabsStateFromStorage', () => {
  it('reads back what it would store', () => {
    const state = withTabs(['/a', '/b'])
    assert.deepEqual(tabsStateFromStorage(JSON.parse(JSON.stringify(state))), state)
  })

  it('refuses corrupt input rather than half-reading it', () => {
    assert.equal(tabsStateFromStorage(null), null)
    assert.equal(tabsStateFromStorage({ tabs: [], activeId: 'x', lastUsed: [], closed: [] }), null)
    assert.equal(tabsStateFromStorage({ tabs: [{ id: 'a', url: 'https://evil.example', title: null }], activeId: 'a', lastUsed: [], closed: [] }), null)
    assert.equal(tabsStateFromStorage({ tabs: [{ id: 'a', url: '/a', title: null }], activeId: 'missing', lastUsed: [], closed: [] }), null)
  })

  it('drops lastUsed ids that no longer name a tab', () => {
    const read = tabsStateFromStorage({ tabs: [{ id: 'a', url: '/a', title: null }], activeId: 'a', lastUsed: ['gone', 'a'], closed: [] })
    assert.deepEqual(read?.lastUsed, ['a'])
  })
})

describe('newTabId', () => {
  it('returns distinct non-empty ids', () => {
    const a = newTabId()
    const b = newTabId()
    assert.ok(a.length > 0 && a !== b)
  })
})
