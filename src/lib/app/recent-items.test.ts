import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseViewPath } from './navigation'
import { pushRecentItem, RECENT_ITEMS_CAP, type RecentItem } from './recent-items'

describe('parseViewPath', () => {
  it('reads a plain view with no entity id', () => {
    assert.deepEqual(parseViewPath('/usage'), { view: 'usage', id: null })
  })

  it('reads the entity id off the three id-carrying views', () => {
    assert.deepEqual(parseViewPath('/agents/marketing'), { view: 'agents', id: 'marketing' })
    assert.deepEqual(parseViewPath('/chat/sess-1'), { view: 'conversations', id: 'sess-1' })
    assert.deepEqual(parseViewPath('/chatrooms/room-9'), { view: 'chatrooms', id: 'room-9' })
  })

  it('decodes a percent-encoded id', () => {
    assert.deepEqual(parseViewPath('/agents/a%2Fb'), { view: 'agents', id: 'a/b' })
  })

  it('ignores a trailing segment on a view that carries no id', () => {
    assert.deepEqual(parseViewPath('/settings/anything'), { view: 'settings', id: null })
  })

  it('returns null for an unknown path', () => {
    assert.equal(parseViewPath('/x/some-extension-page'), null)
  })
})

describe('pushRecentItem', () => {
  const item = (view: RecentItem['view'], id: string | null, at: number): RecentItem => ({ view, id, at })

  it('puts the newest entry first', () => {
    const list = pushRecentItem([item('usage', null, 1)], item('tasks', null, 2))
    assert.deepEqual(list.map((r) => r.view), ['tasks', 'usage'])
  })

  it('moves a repeat visit to the front instead of duplicating it', () => {
    const start = [item('tasks', null, 2), item('usage', null, 1)]
    const list = pushRecentItem(start, item('usage', null, 3))
    assert.deepEqual(list.map((r) => r.view), ['usage', 'tasks'])
    assert.equal(list.length, 2)
    assert.equal(list[0]!.at, 3)
  })

  it('treats the same view with different ids as different entries', () => {
    const start = [item('agents', 'a', 1)]
    const list = pushRecentItem(start, item('agents', 'b', 2))
    assert.equal(list.length, 2)
  })

  it('caps the list', () => {
    let list: RecentItem[] = []
    for (let i = 0; i < RECENT_ITEMS_CAP + 5; i++) {
      list = pushRecentItem(list, item('agents', `a${i}`, i))
    }
    assert.equal(list.length, RECENT_ITEMS_CAP)
    assert.equal(list[0]!.id, `a${RECENT_ITEMS_CAP + 4}`)
  })
})
