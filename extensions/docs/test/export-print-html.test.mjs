import assert from 'node:assert/strict'
import test from 'node:test'

import { buildPrintHtml, fetchEmbeddedFontsCss } from '../ui/export/print-html.ts'

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

test('the page has no margin band left for the browser to print a footer into', () => {
  const html = buildPrintHtml('text', 'My doc')
  assert.match(html, /@page\s*\{\s*size:\s*A4;\s*margin:\s*0;?\s*\}/)
  // The page margin moved onto the body, as padding, instead.
  assert.match(html, /body\s*\{[^}]*padding:\s*18mm 16mm/)
})

test('headings use Gabarito and the body uses Inter, both with a system fallback', () => {
  const html = buildPrintHtml('text', 'My doc')
  assert.match(html, /h1,\s*h2,\s*h3\s*\{[^}]*'Gabarito'/)
  assert.match(html, /body\s*\{[^}]*'Inter'[^}]*sans-serif/)
})

test('an embedded fonts block, when passed in, lands ahead of the page CSS', () => {
  const html = buildPrintHtml('text', 'My doc', "@font-face { font-family: 'Gabarito'; src: url(data:font/woff2;base64,AAAA); }")
  assert.match(html, /<style>@font-face \{ font-family: 'Gabarito';.*@page/s)
})

test('fetchEmbeddedFontsCss inlines both Gabarito subsets as distinct data URIs', async () => {
  const fakeFetch = async (path) => ({
    ok: true,
    arrayBuffer: async () => new TextEncoder().encode(`bytes-for-${path}`).buffer,
  })
  const css = await fetchEmbeddedFontsCss(fakeFetch)
  const rules = css.match(/@font-face \{ font-family: 'Gabarito'; src: url\(data:font\/woff2;base64,[A-Za-z0-9+/=]+\)[^}]*\}/g) ?? []
  assert.equal(rules.length, 2, 'expected one @font-face rule per subset')
  assert.notEqual(rules[0], rules[1], 'the two subsets should carry different bytes and unicode ranges')
})

test('fetchEmbeddedFontsCss falls back to an empty string when the fetch fails', async () => {
  const failingFetch = async () => { throw new Error('offline') }
  assert.equal(await fetchEmbeddedFontsCss(failingFetch), '')
})

test('fetchEmbeddedFontsCss falls back to an empty string on a non-ok response', async () => {
  const notFoundFetch = async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) })
  assert.equal(await fetchEmbeddedFontsCss(notFoundFetch), '')
})
