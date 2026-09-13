import assert from 'node:assert/strict'
import test from 'node:test'

import { docIdFromSubPath, legacyDocIdFromSearch, subPathForDoc } from '../ui/doc-route.ts'

test('the page root has no open doc', () => {
  assert.equal(docIdFromSubPath(''), null)
  assert.equal(subPathForDoc(null), '')
})

test('the first segment is the doc id', () => {
  assert.equal(docIdFromSubPath('doc_1a2b3c4d'), 'doc_1a2b3c4d')
  assert.equal(docIdFromSubPath('doc_1a2b3c4d/'), 'doc_1a2b3c4d')
})

test('an id that is not URL-safe round-trips', () => {
  assert.equal(subPathForDoc('a/b c'), 'a%2Fb%20c')
  assert.equal(docIdFromSubPath(subPathForDoc('a/b c')), 'a/b c')
})

test('a malformed escape opens no doc and does not throw', () => {
  assert.equal(docIdFromSubPath('%E0%A4%A'), null)
})

test('the older ?doc= form is still read', () => {
  assert.equal(legacyDocIdFromSearch('?doc=doc_1'), 'doc_1')
  assert.equal(legacyDocIdFromSearch('?doc=%20'), null)
  assert.equal(legacyDocIdFromSearch('?doc='), null)
  assert.equal(legacyDocIdFromSearch('?other=1'), null)
  assert.equal(legacyDocIdFromSearch(''), null)
})
