import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { VAULT_REDIRECTS, VAULT_TABS, vaultTabFromSearch } from './vault-tabs'

describe('vault tab resolution', () => {
  it('holds both credential stores', () => {
    assert.deepEqual(VAULT_TABS.map((t) => t.key), ['secrets', 'wallets'])
  })

  it('defaults to secrets', () => {
    assert.equal(vaultTabFromSearch(null), 'secrets')
    assert.equal(vaultTabFromSearch('nonsense'), 'secrets')
  })

  it('honours a named tab', () => {
    assert.equal(vaultTabFromSearch('wallets'), 'wallets')
  })

  it('sends each retired route at a tab that exists', () => {
    assert.deepEqual(Object.keys(VAULT_REDIRECTS).sort(), ['secrets', 'wallets'])
    for (const [from, to] of Object.entries(VAULT_REDIRECTS)) {
      assert.ok(VAULT_TABS.some((t) => t.href === to), `${from} redirects to ${to}, which is not a tab`)
    }
  })
})
