import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  CLOSED_TABS_CAP, HOME_URL, MAX_TABS, activateByPosition, activateRelative, activateTab, closeTab, initialTabsState,
  landOnUrl, liveTabIds, moveTab, newTabId, openTab, reopenClosedTab, restoreTabsState, setTabTitle, setTabUrl, tabsStateFromStorage,
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

  it('opens nothing new at the tab cap, but still activates a tab already on that URL', () => {
    const full = withTabs(Array.from({ length: MAX_TABS }, (_, i) => `/p${i}`))
    assert.equal(full.tabs.length, MAX_TABS)
    assert.equal(openTab(full, { id: 'x', url: '/new', title: null }), full)
    assert.equal(openTab(full, { id: 'x', url: '/new', title: null }, { activate: false }), full)
    const existing = openTab(full, { id: 'x', url: '/p3', title: null })
    assert.equal(existing.tabs.length, MAX_TABS)
    assert.equal(existing.activeId, 't4')
    assert.equal(openTab(full, { id: 'x', url: '/p3', title: null }, { activate: false }), full)
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

  it('keeps the closed tab on the stack when the strip is at the cap', () => {
    const newId = ids()
    let state = initialTabsState(newId, '/p0')
    for (let i = 1; i <= MAX_TABS; i++) state = openTab(state, { id: newId(), url: `/p${i}`, title: null })
    state = closeTab(state, state.activeId, newId)
    assert.equal(state.tabs.length, MAX_TABS - 1)
    state = openTab(state, { id: newId(), url: '/filler', title: null })
    assert.equal(state.tabs.length, MAX_TABS)
    // The filler did not fit, so the strip is still full with one closed tab waiting.
    assert.equal(reopenClosedTab(state), state)
    assert.equal(state.closed.length, 1)
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

  it('drops tabs whose URL fails the app-path gate, keeping the rest', () => {
    const read = tabsStateFromStorage({
      tabs: [
        { id: 'a', url: '/tasks', title: null },
        { id: 'b', url: '/\\evil.example', title: null },
        { id: 'c', url: '/s/token', title: null },
        { id: 'd', url: '/login', title: null },
        { id: 'e', url: '/api/files/serve', title: null },
        { id: 'f', url: '/%2e%2e/api/x', title: null },
      ],
      activeId: 'a',
      lastUsed: ['a', 'b', 'c'],
      closed: [],
    })
    assert.deepEqual(read?.tabs.map((t) => t.id), ['a'])
    assert.deepEqual(read?.lastUsed, ['a'])
  })

  it('drops invalid closed tabs too', () => {
    const read = tabsStateFromStorage({
      tabs: [{ id: 'a', url: '/a', title: null }],
      activeId: 'a',
      lastUsed: ['a'],
      closed: [{ id: 'x', url: '/\\evil.example', title: null }, { id: 'y', url: '/tasks', title: null }],
    })
    assert.deepEqual(read?.closed.map((t) => t.id), ['y'])
  })

  it('moves the active tab to the most recently used valid one when the active URL is invalid', () => {
    const read = tabsStateFromStorage({
      tabs: [
        { id: 'a', url: '/a', title: null },
        { id: 'bad', url: '/\\evil.example', title: null },
        { id: 'b', url: '/b', title: null },
      ],
      activeId: 'bad',
      lastUsed: ['bad', 'b', 'a'],
      closed: [],
    })
    assert.equal(read?.activeId, 'b')
  })

  it('refuses storage in which no tab has a valid URL, so the host starts over', () => {
    assert.equal(tabsStateFromStorage({ tabs: [{ id: 'a', url: '/\\evil.example', title: null }], activeId: 'a', lastUsed: ['a'], closed: [] }), null)
  })

  it('drops lastUsed ids that no longer name a tab', () => {
    const read = tabsStateFromStorage({ tabs: [{ id: 'a', url: '/a', title: null }], activeId: 'a', lastUsed: ['gone', 'a'], closed: [] })
    assert.deepEqual(read?.lastUsed, ['a'])
  })

  it('returns null when two tabs share an id', () => {
    const read = tabsStateFromStorage({
      tabs: [
        { id: 'a', url: '/a', title: null },
        { id: 'a', url: '/b', title: null },
      ],
      activeId: 'a',
      lastUsed: ['a'],
      closed: [],
    })
    assert.equal(read, null)
  })

  it('de-duplicates lastUsed, keeping the first occurrence', () => {
    const read = tabsStateFromStorage({
      tabs: [
        { id: 'a', url: '/a', title: null },
        { id: 'b', url: '/b', title: null },
      ],
      activeId: 'a',
      lastUsed: ['a', 'a', 'b'],
      closed: [],
    })
    assert.deepEqual(read?.lastUsed, ['a', 'b'])
  })

  it('returns null when tabs array exceeds 200 entries', () => {
    const tabs = Array.from({ length: 201 }, (_, i) => ({
      id: `t${i}`,
      url: `/p${i}`,
      title: null,
    }))
    const read = tabsStateFromStorage({
      tabs,
      activeId: 't0',
      lastUsed: [],
      closed: [],
    })
    assert.equal(read, null)
  })

  it('returns null when lastUsed array exceeds 200 entries', () => {
    const read = tabsStateFromStorage({
      tabs: [{ id: 'a', url: '/a', title: null }],
      activeId: 'a',
      lastUsed: Array.from({ length: 201 }, (_, i) => `id${i}`),
      closed: [],
    })
    assert.equal(read, null)
  })

  it('returns null when closed array exceeds 50 entries', () => {
    const closed = Array.from({ length: 51 }, (_, i) => ({
      id: `c${i}`,
      url: `/closed${i}`,
      title: null,
    }))
    const read = tabsStateFromStorage({
      tabs: [{ id: 'a', url: '/a', title: null }],
      activeId: 'a',
      lastUsed: [],
      closed,
    })
    assert.equal(read, null)
  })
})

describe('newTabId', () => {
  it('returns distinct non-empty ids', () => {
    const a = newTabId()
    const b = newTabId()
    assert.ok(a.length > 0 && a !== b)
  })
})

describe('restoreTabsState', () => {
  const origin = 'http://app.example'

  it('lands the stored tabs on the address the host loaded at', () => {
    const stored = { tabs: [{ id: 'a', url: '/home', title: null }], activeId: 'a', lastUsed: ['a'], closed: [] }
    const state = restoreTabsState(stored, `${origin}/tasks?x=1`, origin, ids())
    assert.deepEqual(state.tabs.map((t) => t.url), ['/home', '/tasks?x=1'])
    assert.equal(state.tabs.find((t) => t.id === state.activeId)?.url, '/tasks?x=1')
  })

  it('lands on Home instead of an address that is not a tabbable app path', () => {
    for (const href of [`${origin}/\\evil.example`, `${origin}/s/token`, `${origin}/login`, 'https://evil.example/tasks']) {
      const state = restoreTabsState(null, href, origin, ids())
      assert.deepEqual(state.tabs.map((t) => t.url), [HOME_URL], href)
    }
  })

  it('starts over on Home when the stored value does not parse', () => {
    const state = restoreTabsState({ nonsense: true }, `${origin}/home`, origin, ids())
    assert.deepEqual(state.tabs, [{ id: 't1', url: HOME_URL, title: null }])
  })
})
