import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { validateExtensionPages } from './extension-pages'
import { runWithTempDataDir } from '@/lib/server/test-utils/run-with-temp-data-dir'

const good = { id: 'aisignal', label: 'AI Signal', path: '/x/aisignal', entry: 'dist/index.js' }

describe('validateExtensionPages', () => {
  it('accepts a page under /x/ with an entry', () => {
    const r = validateExtensionPages([good], new Set())
    assert.equal(r.ok, true)
  })
  it('rejects a path outside /x/', () => {
    const r = validateExtensionPages([{ ...good, path: '/settings' }], new Set())
    assert.equal(r.ok, false)
    if (!r.ok) assert.match(r.error, /\/x\//)
  })
  it('rejects a path already taken by another plugin', () => {
    const r = validateExtensionPages([good], new Set(['/x/aisignal']))
    assert.equal(r.ok, false)
    if (!r.ok) assert.match(r.error, /taken/)
  })
  it('rejects duplicates inside one plugin and missing entry', () => {
    assert.equal(validateExtensionPages([good, { ...good, id: 'b' }], new Set()).ok, false)
    assert.equal(validateExtensionPages([{ ...good, entry: '' }], new Set()).ok, false)
  })
  it('rejects entry with path traversal', () => {
    assert.equal(validateExtensionPages([{ ...good, entry: '../x.js' }], new Set()).ok, false)
  })
})

describe('manager.getPages', () => {
  it('lists pages with extensionId and refuses a colliding second plugin', () => {
    const out = runWithTempDataDir<{ pages: Array<{ extensionId: string; path: string }>; failed: string | null }>(`
      const extensionsMod = await import('@/lib/server/extensions')
      const { getExtensionManager } = extensionsMod.default || extensionsMod
      const m = getExtensionManager()
      await m.saveExtensionSource('pg_a.mjs', 'export default { name: "A", tools: [], ui: { pages: [{ id: "a", label: "A", path: "/x/a", entry: "dist/index.js" }] } }')
      await m.saveExtensionSource('pg_b.mjs', 'export default { name: "B", tools: [], ui: { pages: [{ id: "b", label: "B", path: "/x/a", entry: "dist/index.js" }] } }')
      m.reload()
      const failed = m.listExtensions().find((e) => e.filename === 'pg_b.mjs')?.lastFailureError || null
      console.log(JSON.stringify({ pages: m.getPages().map((p) => ({ extensionId: p.extensionId, path: p.path })), failed }))
    `)
    assert.deepEqual(out.pages, [{ extensionId: 'pg_a.mjs', path: '/x/a' }])
    assert.match(out.failed || '', /taken/)
  })
})
