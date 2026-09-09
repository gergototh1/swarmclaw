import test from 'node:test'
import assert from 'node:assert/strict'
import { focusedSnapshot } from './use-window-focused'

test('document nelkul (SSR) true', () => {
  const g = globalThis as { document?: unknown }
  const saved = g.document
  delete g.document
  try {
    assert.equal(focusedSnapshot(), true)
  } finally {
    if (saved !== undefined) g.document = saved
  }
})

test('document.hasFocus() eredmenyet adja vissza', () => {
  const g = globalThis as { document?: unknown }
  const saved = g.document
  g.document = { hasFocus: () => false }
  try {
    assert.equal(focusedSnapshot(), false)
    g.document = { hasFocus: () => true }
    assert.equal(focusedSnapshot(), true)
  } finally {
    if (saved === undefined) delete g.document
    else g.document = saved
  }
})
