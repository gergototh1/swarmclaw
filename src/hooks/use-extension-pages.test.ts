import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pagesForSection } from './use-extension-pages'
import { NAV_SECTION_IDS } from '@/lib/app/nav-sections'

const pages = [
  { extensionId: 'aisignal.mjs', id: 'aisignal', label: 'AI Signal', path: '/x/aisignal', entry: 'dist/index.js', position: 'after:tasks' },
  { extensionId: 'crm.mjs', id: 'crm', label: 'CRM', path: '/x/crm', entry: 'dist/index.js', position: 'end' },
  { extensionId: 'docs.mjs', id: 'docs', label: 'Doksik', path: '/x/docs', entry: 'dist/index.js', position: 'after:tasks' },
  { extensionId: 'video.mjs', id: 'video', label: 'Videó', path: '/x/video', entry: 'dist/index.js', position: 'after:tasks' },
]

test('every installed page lands in Work without being edited', () => {
  assert.deepEqual(pagesForSection(pages, 'work').map((p) => p.id).sort(), ['aisignal', 'crm', 'docs', 'video'])
})

test('a section nobody declared is empty, not a fallback dumping ground', () => {
  assert.deepEqual(pagesForSection(pages, 'knowledge'), [])
  assert.deepEqual(pagesForSection(pages, 'operations'), [])
})

test('order decides, and label breaks ties', () => {
  const ordered = [
    { extensionId: 'c.mjs', id: 'c', label: 'Zulu', path: '/x/c', entry: 'dist/index.js', section: 'work', order: 10 },
    { extensionId: 'a.mjs', id: 'a', label: 'Alfa', path: '/x/a', entry: 'dist/index.js', section: 'work', order: 30 },
    { extensionId: 'b.mjs', id: 'b', label: 'Bravo', path: '/x/b', entry: 'dist/index.js', section: 'work', order: 30 },
  ]
  assert.deepEqual(pagesForSection(ordered, 'work').map((p) => p.id), ['c', 'a', 'b'])
})

test('an explicit section moves a page out of Work', () => {
  const moved = [{ extensionId: 'k.mjs', id: 'k', label: 'K', path: '/x/k', entry: 'dist/index.js', section: 'knowledge' }]
  assert.deepEqual(pagesForSection(moved, 'knowledge').map((p) => p.id), ['k'])
  assert.deepEqual(pagesForSection(moved, 'work'), [])
})

test('every page lands in exactly one section', () => {
  const all = [...pages, { extensionId: 'x.mjs', id: 'stray', label: 'Stray', path: '/x/x', entry: 'dist/index.js', section: 'nowhere' }]
  const rendered = NAV_SECTION_IDS.flatMap((s) => pagesForSection(all, s)).map((p) => p.id)
  assert.deepEqual([...rendered].sort(), all.map((p) => p.id).sort())
  assert.equal(new Set(rendered).size, rendered.length)
})

test('an empty page list yields an empty section', () => {
  assert.deepEqual(pagesForSection([], 'work'), [])
})
