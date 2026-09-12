import assert from 'node:assert/strict'
import test from 'node:test'

import { readEditorMode, writeEditorMode } from '../ui/editor-mode.ts'

function memory() {
  const map = new Map()
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => { map.set(k, String(v)) }, map }
}

test('the mode is remembered per viewer', () => {
  const store = memory()
  assert.equal(readEditorMode(store), 'formatted')
  writeEditorMode('markdown', store)
  assert.equal(store.map.get('swarmclaw.docs.editorMode'), 'markdown')
  assert.equal(readEditorMode(store), 'markdown')
})

test('an unknown stored value reads as formatted', () => {
  const store = memory()
  store.setItem('swarmclaw.docs.editorMode', 'wysiwyg')
  assert.equal(readEditorMode(store), 'formatted')
})

test('a storage that throws or is missing costs the preference, not the page', () => {
  const broken = { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') } }
  assert.equal(readEditorMode(broken), 'formatted')
  assert.doesNotThrow(() => writeEditorMode('markdown', broken))
  assert.equal(readEditorMode(null), 'formatted')
})
