import assert from 'node:assert/strict'
import { test } from 'node:test'
import { splitPagesByPosition } from './use-extension-pages'
import { EXTENSION_NAV_ANCHORS } from '@/lib/extension-page-nav'

const pages = [
  { extensionId: 'a.mjs', id: 'a', label: 'A', path: '/x/a', entry: 'dist/index.js', position: 'after:tasks' },
  { extensionId: 'b.mjs', id: 'b', label: 'B', path: '/x/b', entry: 'dist/index.js', position: 'end' },
  { extensionId: 'c.mjs', id: 'c', label: 'C', path: '/x/c', entry: 'dist/index.js' },
]

test('splitPagesByPosition picks after:<view> pages for a view and the rest for the end slot', () => {
  assert.deepEqual(splitPagesByPosition(pages, 'tasks').map((p) => p.id), ['a'])
  assert.deepEqual(splitPagesByPosition(pages, 'memory').map((p) => p.id), [])
  assert.deepEqual(splitPagesByPosition(pages, null).map((p) => p.id), ['b', 'c'])
})

test('the end slot takes pages anchored at a view the rail does not mount', () => {
  const unmounted = [
    { extensionId: 'd.mjs', id: 'typo', label: 'Typo', path: '/x/d', entry: 'dist/index.js', position: 'after:taks' },
    { extensionId: 'e.mjs', id: 'renamed', label: 'Renamed', path: '/x/e', entry: 'dist/index.js', position: 'after:removed_view' },
    { extensionId: 'f.mjs', id: 'memory', label: 'Memory', path: '/x/f', entry: 'dist/index.js', position: 'after:memory' },
  ]
  assert.deepEqual(splitPagesByPosition(unmounted, null).map((p) => p.id), ['typo', 'renamed', 'memory'])
})

test('every page lands in exactly one mounted slot', () => {
  const all = [...pages, { extensionId: 'g.mjs', id: 'stray', label: 'Stray', path: '/x/g', entry: 'dist/index.js', position: 'after:nowhere' }]
  const rendered = [
    ...EXTENSION_NAV_ANCHORS.flatMap((view) => splitPagesByPosition(all, view)),
    ...splitPagesByPosition(all, null),
  ].map((p) => p.id)
  assert.deepEqual([...rendered].sort(), all.map((p) => p.id).sort())
  assert.equal(new Set(rendered).size, rendered.length)
})

test('splitPagesByPosition returns an empty slot for an empty page list', () => {
  assert.deepEqual(splitPagesByPosition([], null), [])
  assert.deepEqual(splitPagesByPosition([], 'tasks'), [])
})
