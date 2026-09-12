import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ExtensionPage } from '@/hooks/use-extension-pages'
import { extensionPageNavTargets } from './palette-extension-pages'

const page = (extensionId: string, id: string, label: string, path: string): ExtensionPage => ({
  extensionId, id, label, path, entry: 'dist/index.js',
})

describe('extensionPageNavTargets', () => {
  it('offers every extension page as a palette destination at its declared path', () => {
    const targets = extensionPageNavTargets([page('crm.mjs', 'crm', 'CRM', '/x/crm')])
    assert.deepEqual(targets, [{
      id: 'nav:x:crm.mjs:crm',
      label: 'Go to CRM',
      description: 'Extension page',
      keywords: ['CRM', 'crm.mjs', 'crm'],
      href: '/x/crm',
    }])
  })

  it('lists them by label so the order does not depend on install order', () => {
    const targets = extensionPageNavTargets([
      page('video.mjs', 'video', 'Videó', '/x/video'),
      page('docs.mjs', 'docs', 'Doksik', '/x/docs'),
    ])
    assert.deepEqual(targets.map((t) => t.href), ['/x/docs', '/x/video'])
  })
})
