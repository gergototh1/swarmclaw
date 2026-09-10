import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { RecentItem } from '@/lib/app/recent-items'
import { resolveRecentItems, type RecentLabelLookups } from './recent-item-label'

const lookups: RecentLabelLookups = {
  agentNames: { a1: 'Marketing' },
  sessionTitles: { s1: 'Budget review' },
  chatroomNames: { r1: 'Standup' },
  taskTitles: { t1: 'Ship the release' },
}

const item = (view: RecentItem['view'], id: string | null): RecentItem => ({ view, id, at: 1 })

describe('resolveRecentItems', () => {
  it('names an id-less view from the nav sections', () => {
    const out = resolveRecentItems([item('usage', null)], lookups, 8)
    assert.deepEqual(out, [{ view: 'usage', id: null, label: 'Usage' }])
  })

  it('names entities from the lookups', () => {
    const out = resolveRecentItems(
      [item('agents', 'a1'), item('conversations', 's1'), item('chatrooms', 'r1'), item('tasks', 't1')],
      lookups,
      8,
    )
    assert.deepEqual(out.map((r) => r.label), ['Marketing', 'Budget review', 'Standup', 'Ship the release'])
  })

  it('names a task from the lookups and keeps its id', () => {
    const out = resolveRecentItems([item('tasks', 't1')], lookups, 8)
    assert.deepEqual(out, [{ view: 'tasks', id: 't1', label: 'Ship the release' }])
  })

  it('drops a task that no longer exists', () => {
    const out = resolveRecentItems([item('tasks', 'gone'), item('usage', null)], lookups, 8)
    assert.deepEqual(out.map((r) => r.view), ['usage'])
  })

  it('drops an entity that no longer exists', () => {
    const out = resolveRecentItems([item('agents', 'gone'), item('usage', null)], lookups, 8)
    assert.deepEqual(out.map((r) => r.view), ['usage'])
  })

  it('follows a rename, because the label is never stored', () => {
    const renamed: RecentLabelLookups = { ...lookups, agentNames: { a1: 'Growth' } }
    const out = resolveRecentItems([item('agents', 'a1')], renamed, 8)
    assert.equal(out[0]!.label, 'Growth')
  })

  it('applies the limit after dropping missing entities', () => {
    const items = [item('agents', 'gone'), item('usage', null), item('tasks', null)]
    const out = resolveRecentItems(items, lookups, 2)
    assert.deepEqual(out.map((r) => r.view), ['usage', 'tasks'])
  })

  it('drops an item with an invalid view', () => {
    const out = resolveRecentItems([item('not-a-real-view' as RecentItem['view'], null), item('usage', null)], lookups, 8)
    assert.deepEqual(out.map((r) => r.view), ['usage'])
  })
})
