import assert from 'node:assert/strict'
import test from 'node:test'

import crm, { state } from '../index.mjs'

test('a manifest a kötelező mezőket viszi', () => {
  assert.equal(crm.name, 'CRM')
  assert.ok(Array.isArray(crm.migrations))
  assert.equal(crm.ui.pages[0].path, '/x/crm')
  assert.equal(crm.ui.pages[0].entry, 'dist/index.js')
})

test('a setup szinkron, idempotens, és nem indít semmit', () => {
  const ctx = { storage: { exec() {}, all: () => [], get: () => undefined, transaction: (f) => f() },
                settings: () => ({}), log: console, oauth: {}, tablePrefix: 'ext_crm_' }
  crm.setup(ctx)
  const first = state.storage
  crm.setup(ctx)
  assert.equal(state.storage, first, 'a második setup ugyanoda mutat')
})

test('a manifest deklarálja a CRM projektet', () => {
  const projects = crm.managedResources.projects
  assert.equal(projects.length, 1)
  assert.equal(projects[0].projectKey, 'crm')
  assert.equal(projects[0].displayName, 'CRM')
})
