import assert from 'node:assert/strict'
import { test } from 'node:test'
import { splitPagesByPosition } from './use-extension-pages'

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
