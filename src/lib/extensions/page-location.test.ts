import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { extensionPageHref, extensionSubPath, pageDocumentTitle } from './page-location'

describe('extensionSubPath', () => {
  it('is empty at the page root', () => {
    assert.equal(extensionSubPath('/x/crm', '/x/crm'), '')
    assert.equal(extensionSubPath('/x/crm', '/x/crm/'), '')
  })

  it('returns the part below the declared path without slashes at either end', () => {
    assert.equal(extensionSubPath('/x/crm', '/x/crm/ugyfelek/a1'), 'ugyfelek/a1')
    assert.equal(extensionSubPath('/x/crm', '/x/crm/ugyek/'), 'ugyek')
  })

  it('does not treat a longer sibling slug as a sub path', () => {
    assert.equal(extensionSubPath('/x/crm', '/x/crmx/a'), '')
  })
})

describe('extensionPageHref', () => {
  it('is the page path for an empty sub path', () => {
    assert.equal(extensionPageHref('/x/crm', ''), '/x/crm')
  })

  it('joins a sub path with exactly one slash', () => {
    assert.equal(extensionPageHref('/x/crm', 'ugyfelek/a1'), '/x/crm/ugyfelek/a1')
    assert.equal(extensionPageHref('/x/crm', '/ugyek/'), '/x/crm/ugyek')
  })
})

describe('pageDocumentTitle', () => {
  it('keeps the base title when the page names nothing', () => {
    assert.equal(pageDocumentTitle(null, 'SidekickOS'), 'SidekickOS')
    assert.equal(pageDocumentTitle('   ', 'SidekickOS'), 'SidekickOS')
  })

  it('puts the page title in front of the base title', () => {
    assert.equal(pageDocumentTitle('CRM · Kovács Kft', 'SidekickOS'), 'CRM · Kovács Kft · SidekickOS')
  })
})
