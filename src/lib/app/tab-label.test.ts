import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { tabLabel, type TabLabelLookups } from './tab-label'

const lookups: TabLabelLookups = {
  agentNames: { a1: 'Marveen' },
  sessionTitles: { s1: 'Offer thread' },
  chatroomNames: { r1: 'Team room' },
  extensionPages: [
    { path: '/x/crm', label: 'CRM', icon: 'Users' },
    { path: '/x/docs', label: 'Docs', icon: 'FileText', section: 'knowledge' },
  ],
}

describe('tabLabel', () => {
  it('names a built-in view and its section', () => {
    assert.deepEqual(tabLabel('/tasks', null, lookups), { title: 'Tasks', sectionId: 'work', extensionIcon: null })
  })

  it('names an entity when the URL carries one, and falls back when it is gone', () => {
    assert.equal(tabLabel('/agents/a1', null, lookups).title, 'Marveen')
    assert.equal(tabLabel('/chat/s1', null, lookups).title, 'Offer thread')
    assert.equal(tabLabel('/agents/deleted', null, lookups).title, 'All Agents')
  })

  it('uses the extension page label, or the raw title the page reported', () => {
    assert.deepEqual(tabLabel('/x/crm/ugyfelek/acc_1', null, lookups), { title: 'CRM', sectionId: 'work', extensionIcon: 'Users' })
    assert.equal(tabLabel('/x/crm/ugyfelek/acc_1', 'CRM · Kovacs Kft', lookups).title, 'CRM · Kovacs Kft')
    assert.equal(tabLabel('/x/docs?doc=1', null, lookups).sectionId, 'knowledge')
  })

  it('ignores a raw title on a built-in view', () => {
    assert.equal(tabLabel('/tasks', 'stale page title', lookups).title, 'Tasks')
  })

  it('falls back to the path for an unknown route', () => {
    assert.deepEqual(tabLabel('/nowhere', null, lookups), { title: '/nowhere', sectionId: null, extensionIcon: null })
  })
})
