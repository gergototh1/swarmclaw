import assert from 'node:assert/strict'
import { test } from 'node:test'

import { markdownToTelegramHtml, hasTelegramMarkup } from './telegram-markdown'

const ALLOWED_TAGS = new Set(['b', 'i', 's', 'a', 'code', 'pre', 'blockquote'])

/** Telegram rejects the whole message on an unknown or unbalanced tag. */
function assertTelegramSafe(html: string): void {
  const open: string[] = []
  for (const match of html.matchAll(/<(\/?)([a-zA-Z-]+)[^>]*>/g)) {
    const [, closing, rawTag] = match
    const tag = rawTag.toLowerCase()
    assert.ok(ALLOWED_TAGS.has(tag), `unsupported tag <${tag}>`)
    if (closing) assert.equal(open.pop(), tag, `unbalanced </${tag}>`)
    else open.push(tag)
  }
  assert.deepEqual(open, [], 'unclosed tags remain')
}

test('markdownToTelegramHtml converts inline emphasis', () => {
  assert.equal(markdownToTelegramHtml('**bold** and *italic*'), '<b>bold</b> and <i>italic</i>')
  assert.equal(markdownToTelegramHtml('~~gone~~'), '<s>gone</s>')
})

test('markdownToTelegramHtml turns headings into bold lines', () => {
  assert.equal(markdownToTelegramHtml('# Title'), '<b>Title</b>')
  assert.equal(markdownToTelegramHtml('### Deeper'), '<b>Deeper</b>')
})

test('markdownToTelegramHtml keeps code spans verbatim', () => {
  assert.equal(markdownToTelegramHtml('run `a < b`'), 'run <code>a &lt; b</code>')
  assert.equal(
    markdownToTelegramHtml('```js\nconst x = a && b\n```'),
    '<pre>const x = a &amp;&amp; b</pre>',
  )
})

test('markdownToTelegramHtml does not treat emphasis inside code as markup', () => {
  assert.equal(markdownToTelegramHtml('`**not bold**`'), '<code>**not bold**</code>')
})

test('markdownToTelegramHtml renders links', () => {
  assert.equal(
    markdownToTelegramHtml('[docs](https://example.com/a)'),
    '<a href="https://example.com/a">docs</a>',
  )
})

test('markdownToTelegramHtml renders a table as an aligned monospace block', () => {
  const html = markdownToTelegramHtml('| a | bb |\n|---|----|\n| 1 | 2 |')
  assert.equal(html, '<pre>a  bb\n-  --\n1  2</pre>')
  assertTelegramSafe(html)
})

test('markdownToTelegramHtml escapes characters that would break parsing', () => {
  assert.equal(markdownToTelegramHtml('5 < 6 & 7 > 3'), '5 &lt; 6 &amp; 7 &gt; 3')
  assert.equal(markdownToTelegramHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;')
})

test('markdownToTelegramHtml converts bullets and quotes', () => {
  assert.equal(markdownToTelegramHtml('- one\n- two'), '• one\n• two')
  assert.equal(markdownToTelegramHtml('> quoted'), '<blockquote>quoted</blockquote>')
})

test('markdownToTelegramHtml leaves plain prose untouched', () => {
  const plain = 'Semmilyen jelölés nincs ebben a mondatban.'
  assert.equal(markdownToTelegramHtml(plain), plain)
  assert.equal(hasTelegramMarkup(plain, markdownToTelegramHtml(plain)), false)
})

test('markdownToTelegramHtml handles empty input', () => {
  assert.equal(markdownToTelegramHtml(''), '')
})

test('markdownToTelegramHtml emits only balanced, supported tags for a mixed document', () => {
  const html = markdownToTelegramHtml([
    '# Fejléc',
    '',
    'Ez **fontos**, ez meg *dőlt*, és itt egy `kód`.',
    '',
    '| Oszlop | Érték |',
    '|---|---|',
    '| a | 1 |',
    '',
    '- pont **egy**',
    '- pont `kettő`',
    '',
    '> idézet',
    '',
    '[link](https://example.com)',
    '',
    '```sh',
    'echo "a" > b',
    '```',
  ].join('\n'))
  assertTelegramSafe(html)
  assert.ok(hasTelegramMarkup('x', html))
})
