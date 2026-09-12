import test from 'node:test'
import assert from 'node:assert/strict'
import { MAX_PDF_HTML_BYTES, readSavePdfInput, safePdfFileName } from './pdf-export'

test('a PDF file name drops refused characters and ends in .pdf once', () => {
  assert.equal(safePdfFileName('Q3 report: draft/v2'), 'Q3 report draftv2.pdf')
  assert.equal(safePdfFileName('already.pdf'), 'already.pdf')
  assert.equal(safePdfFileName('   '), 'document.pdf')
  assert.equal(safePdfFileName('x'.repeat(300)).length, 124)
})

test('only a non-empty html string within the size cap is accepted', () => {
  assert.deepEqual(readSavePdfInput({ html: '<p>x</p>', fileName: 'a.pdf' }), { html: '<p>x</p>', fileName: 'a.pdf' })
  assert.deepEqual(readSavePdfInput({ html: '<p>x</p>' }), { html: '<p>x</p>', fileName: '' })
  assert.equal(readSavePdfInput(null), null)
  assert.equal(readSavePdfInput({ html: '' }), null)
  assert.equal(readSavePdfInput({ html: 42 }), null)
  assert.equal(readSavePdfInput({ html: 'a'.repeat(MAX_PDF_HTML_BYTES + 1) }), null)
})
