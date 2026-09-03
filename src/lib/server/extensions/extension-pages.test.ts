import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { validateExtensionPages } from './extension-pages'
import { EXTENSION_NAV_ANCHORS, EXTENSION_PAGE_ICON_NAMES, EXTENSION_PAGE_PATH_PREFIX } from '@/lib/extension-page-nav'
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
  it('rejects a path already taken by another extension', () => {
    const r = validateExtensionPages([good], new Set(['/x/aisignal']))
    assert.equal(r.ok, false)
    if (!r.ok) assert.match(r.error, /taken/)
  })
  it('rejects duplicates inside one extension and missing entry', () => {
    assert.equal(validateExtensionPages([good, { ...good, id: 'b' }], new Set()).ok, false)
    assert.equal(validateExtensionPages([{ ...good, entry: '' }], new Set()).ok, false)
  })
  it('rejects entry with path traversal', () => {
    assert.equal(validateExtensionPages([{ ...good, entry: '../x.js' }], new Set()).ok, false)
  })
  it('rejects an absolute entry path', () => {
    const r = validateExtensionPages([{ ...good, entry: '/etc/passwd.js' }], new Set())
    assert.equal(r.ok, false)
  })
  it('rejects an absolute css path', () => {
    const r = validateExtensionPages([{ ...good, css: '/etc/passwd.css' }], new Set())
    assert.equal(r.ok, false)
  })
  it('accepts a dist/-prefixed entry and css, including a nested one', () => {
    const r = validateExtensionPages([{ ...good, entry: 'dist/assets/app.js', css: 'dist/assets/app.css' }], new Set())
    assert.equal(r.ok, true)
    if (r.ok) {
      assert.equal(r.pages[0].entry, 'dist/assets/app.js')
      assert.equal(r.pages[0].css, 'dist/assets/app.css')
    }
  })
  it('rejects an entry outside dist/, because only dist/ is ever served', () => {
    const r = validateExtensionPages([{ ...good, entry: 'build/app.js' }], new Set())
    assert.equal(r.ok, false)
    if (!r.ok) assert.match(r.error, /dist\//)
  })
  it('rejects a bare entry filename with no dist/ prefix', () => {
    const r = validateExtensionPages([{ ...good, entry: 'index.js' }], new Set())
    assert.equal(r.ok, false)
    if (!r.ok) assert.match(r.error, /dist\//)
  })
  it('rejects a css file outside dist/', () => {
    const r = validateExtensionPages([{ ...good, css: 'build/app.css' }], new Set())
    assert.equal(r.ok, false)
    if (!r.ok) assert.match(r.error, /dist\//)
  })
  it('treats an empty css string as no stylesheet declared', () => {
    const r = validateExtensionPages([{ ...good, css: '' }], new Set())
    assert.equal(r.ok, true)
    if (r.ok) assert.equal(r.pages[0].css, undefined)
  })
})

describe('manager.getPages', () => {
  it('lists pages with extensionId and refuses a colliding second extension', () => {
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

describe('extension page nav contract', () => {
  it('exposes the icon key set and the mounted rail anchors to server code', () => {
    assert.ok(EXTENSION_PAGE_ICON_NAMES.length > 0)
    assert.ok(EXTENSION_PAGE_ICON_NAMES.includes('Puzzle'))
    assert.equal(new Set(EXTENSION_PAGE_ICON_NAMES).size, EXTENSION_PAGE_ICON_NAMES.length)
    assert.ok(EXTENSION_NAV_ANCHORS.length > 0)
    assert.equal(EXTENSION_PAGE_PATH_PREFIX, '/x/')
  })

  it('stays importable from server code by not being a client module', () => {
    const src = readFileSync(new URL('../../extension-page-nav.ts', import.meta.url), 'utf8')
    assert.ok(!src.includes('use client'))
  })
})
