import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { navigateInActiveTab, routeLinkClick, setTabNavigator, type TabNavigator } from './tab-navigation'

function recorder() {
  const calls: string[] = []
  const navigator: TabNavigator = {
    navigateActive: (href) => { calls.push(`active:${href}`) },
    openInNewTab: (href, opts) => { calls.push(`new:${href}:${opts?.activate ?? true}`) },
  }
  return { calls, navigator }
}

function click(over: Partial<{ metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; button: number }> = {}) {
  let prevented = false
  return {
    event: { metaKey: false, ctrlKey: false, shiftKey: false, button: 0, ...over, preventDefault: () => { prevented = true } },
    prevented: () => prevented,
  }
}

afterEach(() => setTabNavigator(null))

describe('routeLinkClick', () => {
  it('does nothing without a host, so the link navigates normally', () => {
    const c = click()
    assert.equal(routeLinkClick(c.event, '/tasks'), false)
    assert.equal(c.prevented(), false)
  })

  it('sends a plain click into the active tab', () => {
    const { calls, navigator } = recorder()
    setTabNavigator(navigator)
    const c = click()
    assert.equal(routeLinkClick(c.event, '/tasks'), 'active')
    assert.equal(c.prevented(), true)
    assert.deepEqual(calls, ['active:/tasks'])
  })

  it('opens a modified or middle click in a background tab', () => {
    const { calls, navigator } = recorder()
    setTabNavigator(navigator)
    assert.equal(routeLinkClick(click({ metaKey: true }).event, '/a'), 'background')
    assert.equal(routeLinkClick(click({ button: 1 }).event, '/b'), 'background')
    assert.equal(routeLinkClick(click({ ctrlKey: true }).event, '/c'), 'background')
    assert.equal(routeLinkClick(click({ shiftKey: true }).event, '/d'), 'background')
    assert.deepEqual(calls, ['new:/a:false', 'new:/b:false', 'new:/c:false', 'new:/d:false'])
  })
})

describe('navigateInActiveTab', () => {
  it('reports whether a host took the navigation', () => {
    assert.equal(navigateInActiveTab('/tasks'), false)
    const { calls, navigator } = recorder()
    setTabNavigator(navigator)
    assert.equal(navigateInActiveTab('/tasks'), true)
    assert.deepEqual(calls, ['active:/tasks'])
  })
})
