/**
 * The one promise per-block rendering makes: the reader sees no difference.
 *
 * `splitMarkdownBlocks` exists to cut the cost of re-parsing a streaming answer,
 * and it is only allowed to change *what gets re-parsed*. This renders each shape
 * twice through the app's own pipeline (`MarkdownBlock` — react-markdown +
 * remark-gfm + rehype-highlight and the app's component overrides): once as the
 * whole text, once block by block, concatenated. The two must be the same HTML.
 *
 * Markdown carries parser state across blank lines — a fence inside a list item,
 * a footnote definition that belongs to a use three paragraphs earlier, the
 * indentation of a code block — so a splitter that looks right on prose can still
 * break any of these. Every shape below is one that did.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MarkdownBlock } from '@/components/shared/markdown-body'
import { splitMarkdownBlocks } from './markdown-blocks'

/** Collapse whitespace: only the rendered structure and text is being compared. */
function normalize(html: string): string {
  return html.replace(/>\s+</g, '><').replace(/\s+/g, ' ').trim()
}

function renderWhole(text: string): string {
  return renderToStaticMarkup(React.createElement(MarkdownBlock, { text }))
}

function renderPerBlock(text: string): string {
  return splitMarkdownBlocks(text).map(renderWhole).join('')
}

const SHAPES: Array<[name: string, markdown: string]> = [
  // The fence escaped the <li> and kept the list's indentation, so the copy
  // button handed the reader wrongly indented code.
  ['a list item with a fenced code block', '- Run it:\n\n  ```sh\n  npm test\n  ```\n\n- Then check'],
  ['an ordered list with a fenced code block', '1. Step one\n\n   ```js\n   const a = 1\n   ```\n\n2. Step two\n\n3. Step three'],
  ['an ordered list with a tight fenced code block', '1. Step one\n   ```js\n   const a = 1\n   ```\n2. Step two'],
  ['a fenced code block under a nested list item', '1. Outer\n\n   - inner\n\n     ```py\n     x = 1\n     ```\n\n   - inner two\n\n2. Next'],

  // Document-level definitions: the use can sit in any earlier block.
  ['a footnote definition', 'See note[^1] here.\n\n[^1]: The footnote body.'],
  ['a link reference definition', 'See [the docs][d] please.\n\n[d]: https://example.com'],
  ['an image reference definition', '![alt][img]\n\n[img]: https://example.com/a.png'],

  // `.trim()`ing a block used to strip the indentation that made it code.
  ['a 4-space indented code block', '    const a = 1\n\nafter'],
  ['a 4-space indented code block after a fence', 'x\n\n```\ny\n```\n\n    indented code\n\nz'],

  // A 3-char fence regex let the inner ``` close the outer ````.
  ['a 4-backtick fence containing a 3-backtick fence', '````\n```\ninner\n```\n````'],
  ['a 4-backtick md fence containing a js fence', '````md\n# Title\n\n```js\nx\n```\n````'],
  ['a 4-tilde fence containing a 3-tilde fence', '~~~~\n~~~\nx\n~~~\n~~~~'],

  ['a setext heading', 'Title\n===\n\nbody'],
  ['a table followed by a paragraph', '| a | b |\n| --- | --- |\n| 1 | 2 |\n\nnormal para'],
  ['a thematic break', 'para one\n\n---\n\npara two'],
  ['hard line breaks with trailing spaces', 'line one  \nline two\n\nnext para'],
  ['CRLF line endings', 'para one\r\n\r\n```ts\r\nconst a = 1\r\n```\r\n\r\npara two'],
  ['CRLF around a fence inside a list', '1. one\r\n\r\n   ```js\r\n   x\r\n   ```\r\n\r\n2. two'],

  // Raw HTML: types 1-5 run past a blank line by their own rules.
  ['a raw HTML block split by blank lines', '<div class="x">\n\n<span>hi</span>\n\n</div>'],
  ['an HTML comment spanning a blank line', '<!-- a\n\nb -->\n\ntext'],
  ['an HTML sample inside a code fence', '```html\n<div>\n\n</div>\n```\n\nafter'],

  ['a loose list', '- item one\n\n- item two\n\n- item three'],
  ['a loose list with an indented sublist', '- one\n\n  - sub a\n  - sub b\n\n- two\n\n- three'],
  ['a loose task list', '- [ ] a\n\n- [x] b'],
  ['a list interrupted by a paragraph', '1. a\n2. b\n\ntext\n\n3. c'],
  ['a block quote with a list inside', '> quote\n>\n> - item\n>\n> more'],
  ['a GFM alert', '> [!NOTE]\n> Useful info.\n\nafter'],
  ['consecutive fences', '```js\na\n```\n\n```js\nb\n```'],

  // The everyday streaming case: the message ends mid-code-block.
  ['two paragraphs and a fence still open', 'Here is the plan.\n\nFirst, the setup.\n\n```ts\nconst a = 1\nconst b'],
  ['a half-typed ordered list marker', 'Here is the plan.\n\n1. Install it:\n\n   ```sh\n   npm install\n   ```\n\n2.'],
]

describe('splitMarkdownBlocks renders identically to the whole message', () => {
  for (const [name, markdown] of SHAPES) {
    it(name, () => {
      assert.equal(
        normalize(renderPerBlock(markdown)),
        normalize(renderWhole(markdown)),
        `per-block rendering changed the output for ${name}\nblocks: ${JSON.stringify(splitMarkdownBlocks(markdown))}`,
      )
    })
  }

  /*
   * A streamed answer is rendered at every length it passes through, so the
   * promise has to hold for every prefix, not only for the finished message.
   */
  it('holds for every prefix of a streaming answer', () => {
    const answer = [
      'Here is the plan.',
      '',
      '1. Install it:',
      '',
      '   ```sh',
      '   npm install',
      '   ```',
      '',
      '2. Then run:',
      '',
      '   ```sh',
      '   npm test',
      '   ```',
      '',
      '> Note: takes a while.',
      '',
      'Done.',
    ].join('\n')
    for (let length = 1; length <= answer.length; length++) {
      const prefix = answer.slice(0, length)
      assert.equal(
        normalize(renderPerBlock(prefix)),
        normalize(renderWhole(prefix)),
        `per-block rendering changed the output at length ${length}: ${JSON.stringify(prefix)}`,
      )
    }
  })
})
