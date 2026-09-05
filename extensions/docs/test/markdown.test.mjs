import assert from 'node:assert/strict'
import test from 'node:test'

import { htmlToMd, mdToHtml } from '../ui/markdown.ts'

/**
 * The round trip is the risk this module carries.
 *
 * The editor works in HTML and the file is markdown, so opening a document
 * converts one way and saving converts back. If that trip is not faithful, a
 * document changes because somebody looked at it. These tests are what say it
 * is faithful for the shapes the editor can produce.
 */

const trip = (md) => htmlToMd(mdToHtml(md))

test('headings, emphasis and lists survive a round trip', () => {
  const md = [
    '# Cím',
    '',
    'Egy **félkövér** és egy *dőlt* szó.',
    '',
    '## Alcím',
    '',
    '-   első',
    '-   második',
    '',
    '1.  egy',
    '2.  kettő',
    '',
  ].join('\n')
  const back = trip(md)
  assert.match(back, /^# Cím/)
  assert.match(back, /\*\*félkövér\*\*/)
  assert.match(back, /\*dőlt\*/)
  assert.match(back, /## Alcím/)
  assert.match(back, /- {3}első/)
  assert.match(back, /1\. {2}egy/)
})

test('a fenced code block keeps its content and stays fenced', () => {
  const back = trip('```js\nconst x = 1\n```\n')
  assert.match(back, /```/)
  assert.match(back, /const x = 1/)
})

test('a wiki link is still a wiki link after a round trip', () => {
  // Enélkül a Turndown kiescape-eli a szögletes zárójeleket, és a link némán
  // megszűnik linknek lenni.
  const back = trip('Lásd [[Ügyfélprofil]] és [[doc_a1b2c3d4]].\n')
  assert.match(back, /\[\[Ügyfélprofil\]\]/)
  assert.match(back, /\[\[doc_a1b2c3d4\]\]/)
})

test('an unresolved wiki link is marked so the operator can see it', () => {
  const html = mdToHtml('Lásd [[Van ilyen]] és [[Nincs ilyen]].', new Set(['Van ilyen']))
  assert.match(html, /class="docs-link">Van ilyen</)
  assert.match(html, /docs-link-unresolved">Nincs ilyen</)
})

test('html in a document is shown as text, not rendered', () => {
  const html = mdToHtml('<script>alert(1)</script> és <b>vastag</b>')
  assert.ok(!html.includes('<script>'), 'a script tag átment nyers HTML-ként')
  assert.ok(html.includes('&lt;script&gt;'), 'nem szövegként jelenik meg')
  assert.ok(!html.includes('<b>vastag</b>'), 'a nyers HTML formázásként ment át')
})

test('a table survives as a table', () => {
  const back = trip('| a | b |\n| --- | --- |\n| 1 | 2 |\n')
  assert.match(back, /\| a \| b \|/)
  assert.match(back, /\| 1 \| 2 \|/)
})

test('an empty document stays empty rather than gaining a newline forever', () => {
  assert.equal(trip(''), '')
})

test('a document that only holds plain text comes back unchanged', () => {
  assert.equal(trip('Csak egy sor.\n'), 'Csak egy sor.\n')
})
