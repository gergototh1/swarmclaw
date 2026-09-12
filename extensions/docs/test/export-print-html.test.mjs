import assert from 'node:assert/strict'
import test from 'node:test'

import { buildPrintHtml } from '../ui/export/print-html.ts'

test('the print page carries the title and the rendered markdown', () => {
  const html = buildPrintHtml('Some **bold** text', 'My doc')
  assert.match(html, /<title>My doc<\/title>/)
  assert.match(html, /<h1[^>]*>My doc<\/h1>/)
  assert.match(html, /<strong>bold<\/strong>/)
  assert.match(html, /@page/)
})

test('raw HTML in a doc stays text in the PDF', () => {
  const html = buildPrintHtml('<script>alert(1)</script>', 'X <b>')
  assert.doesNotMatch(html, /<script>/)
  assert.match(html, /&lt;script&gt;/)
  assert.match(html, /<title>X &lt;b&gt;<\/title>/)
})
