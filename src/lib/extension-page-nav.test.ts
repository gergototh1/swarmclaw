import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { resolvePageOrder, resolvePageSection } from './extension-page-nav'

describe('extension page section resolution', () => {
  it('honours an explicit section', () => {
    assert.equal(resolvePageSection({ section: 'knowledge' }), 'knowledge')
    assert.equal(resolvePageSection({ section: 'operations' }), 'operations')
  })

  it('defaults to work when nothing is declared', () => {
    assert.equal(resolvePageSection({}), 'work')
  })

  it('maps every legacy position onto work', () => {
    // 'after:tasks' was the one anchor the rail ever mounted, and 'end' exiled
    // the page to the bottom of the rail. Both belong in Work now.
    assert.equal(resolvePageSection({ position: 'after:tasks' }), 'work')
    assert.equal(resolvePageSection({ position: 'end' }), 'work')
    assert.equal(resolvePageSection({ position: 'after:memory' }), 'work')
    assert.equal(resolvePageSection({ position: 'after:taks' }), 'work')
  })

  it('falls back to work for a section that does not exist', () => {
    assert.equal(resolvePageSection({ section: 'nonsense' }), 'work')
    assert.equal(resolvePageSection({ section: '' }), 'work')
  })

  it('lets section win over a legacy position', () => {
    assert.equal(resolvePageSection({ section: 'connect', position: 'after:tasks' }), 'connect')
  })

  it('defaults order to 100 and rejects a non-number', () => {
    assert.equal(resolvePageOrder({}), 100)
    assert.equal(resolvePageOrder({ order: 20 }), 20)
    assert.equal(resolvePageOrder({ order: 0 }), 0)
    assert.equal(resolvePageOrder({ order: Number.NaN }), 100)
  })
})
