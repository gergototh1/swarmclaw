import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { splitMarkdownBlocks } from './markdown-blocks'

describe('splitMarkdownBlocks', () => {
  it('splits on blank lines', () => {
    assert.deepEqual(splitMarkdownBlocks('first para\n\nsecond para'), ['first para', 'second para'])
  })

  it('keeps a fenced code block whole, blank lines included', () => {
    const text = 'before\n\n```ts\nconst a = 1\n\nconst b = 2\n```\n\nafter'
    assert.deepEqual(splitMarkdownBlocks(text), ['before', '```ts\nconst a = 1\n\nconst b = 2\n```', 'after'])
  })

  it('keeps an unterminated fence as one trailing block (a half-streamed code block)', () => {
    const text = 'intro\n\n```sh\nnpm run build'
    assert.deepEqual(splitMarkdownBlocks(text), ['intro', '```sh\nnpm run build'])
  })

  it('treats ~~~ fences the same way', () => {
    assert.deepEqual(splitMarkdownBlocks('~~~\na\n\nb\n~~~'), ['~~~\na\n\nb\n~~~'])
  })

  it('is stable while text is appended: every block but the last stays identical', () => {
    const first = splitMarkdownBlocks('one\n\ntwo\n\nthr')
    const later = splitMarkdownBlocks('one\n\ntwo\n\nthree\n\nfour')
    assert.deepEqual(first.slice(0, 2), later.slice(0, 2))
  })

  it('returns no empty blocks, and nothing for empty text', () => {
    assert.deepEqual(splitMarkdownBlocks(''), [])
    assert.deepEqual(splitMarkdownBlocks('\n\n\n'), [])
    assert.deepEqual(splitMarkdownBlocks('a\n\n\n\nb'), ['a', 'b'])
  })

  it('keeps a loose list (blank lines between items) as one block', () => {
    const text = '- item one\n\n- item two\n\n- item three'
    assert.deepEqual(splitMarkdownBlocks(text), [text])
  })

  it('keeps an ordered list item and its indented continuation paragraph as one block', () => {
    const text = '1. item\n\n   continuation paragraph'
    assert.deepEqual(splitMarkdownBlocks(text), [text])
  })

  it('keeps two block-quote lines separated by a blank line as one block', () => {
    const text = '> quote line one\n\n> quote line two'
    assert.deepEqual(splitMarkdownBlocks(text), [text])
  })

  it('keeps a fenced code block indented under a list item inside that list', () => {
    const text = '- Run it:\n\n  ```sh\n  npm test\n  ```\n\n- Then check'
    assert.deepEqual(splitMarkdownBlocks(text), [text])
  })

  it('keeps an indented fence in a tight list item inside that list', () => {
    const text = '1. Step one\n   ```js\n   const a = 1\n   ```\n2. Step two'
    assert.deepEqual(splitMarkdownBlocks(text), [text])
  })

  it('treats a tab as indentation, like the 4 spaces it stands for', () => {
    const tabbed = '- Run it:\n\n\t```sh\n\tnpm test\n\t```\n\n- Then check'
    assert.deepEqual(splitMarkdownBlocks(tabbed), [tabbed])
    const spaced = '- Run it:\n\n    ```sh\n    npm test\n    ```\n\n- Then check'
    assert.deepEqual(splitMarkdownBlocks(spaced), [spaced])
    const continuation = '- Run it:\n\n\tmore about it\n\n- Then check'
    assert.deepEqual(splitMarkdownBlocks(continuation), [continuation])
    const spaceThenTab = '- Run it:\n\n \t```sh\n \tnpm test\n \t```\n\n- Then check'
    assert.deepEqual(splitMarkdownBlocks(spaceThenTab), [spaceThenTab])
  })

  it('keeps a loose list together across a lazy continuation line', () => {
    const bullets = '- item one\ncontinued lazily\n\n- item two'
    assert.deepEqual(splitMarkdownBlocks(bullets), [bullets])
    const ordered = '1. item one\ncontinued lazily\n\n2. item two'
    assert.deepEqual(splitMarkdownBlocks(ordered), [ordered])
  })

  it('stops the lazy-continuation walk at a line that opens a block of its own', () => {
    // The heading ends the list; the bullet after the blank line starts a new one.
    assert.deepEqual(splitMarkdownBlocks('# Title\ntext\n\n- item'), ['# Title\ntext', '- item'])
    assert.deepEqual(splitMarkdownBlocks('para one\n\npara two\n\n- item'), ['para one', 'para two', '- item'])
  })

  it('does not let a fence of the other character close the block', () => {
    const text = '```\nx\n~~~~\n\nafter'
    assert.deepEqual(splitMarkdownBlocks(text), [text])
  })

  it('sees a definition through its block-quote prefix', () => {
    const linkRef = '> [d]: https://example.com\n\n[see][d]'
    assert.deepEqual(splitMarkdownBlocks(linkRef), [linkRef])
    const footnote = 'a[^1]\n\n> [^1]: body'
    assert.deepEqual(splitMarkdownBlocks(footnote), [footnote])
  })

  it('keeps a line\'s leading indentation, so an indented code block stays code', () => {
    assert.deepEqual(splitMarkdownBlocks('    const a = 1\n\nafter'), ['    const a = 1', 'after'])
  })

  it('closes a fence only on a run of the same character that is at least as long', () => {
    assert.deepEqual(splitMarkdownBlocks('````\n```\ninner\n```\n````'), ['````\n```\ninner\n```\n````'])
    assert.deepEqual(splitMarkdownBlocks('~~~~\n~~~\nx\n~~~\n~~~~'), ['~~~~\n~~~\nx\n~~~\n~~~~'])
    // A longer run of the same character does close a shorter fence.
    assert.deepEqual(splitMarkdownBlocks('```\na\n````\n\nafter'), ['```\na\n````', 'after'])
  })

  it('returns the whole text as one block when a definition binds to another block', () => {
    const footnote = 'See note[^1] here.\n\n[^1]: The footnote body.'
    assert.deepEqual(splitMarkdownBlocks(footnote), [footnote])
    const linkRef = 'See [the docs][d] please.\n\n[d]: https://example.com'
    assert.deepEqual(splitMarkdownBlocks(linkRef), [linkRef])
  })

  it('returns the whole text as one block for raw HTML, which may run past a blank line', () => {
    const html = '<div class="x">\n\n<span>hi</span>\n\n</div>'
    assert.deepEqual(splitMarkdownBlocks(html), [html])
  })

  it('still splits when the definition-like line is only a code sample', () => {
    const text = '```\n[d]: https://example.com\n```\n\ntext'
    assert.deepEqual(splitMarkdownBlocks(text), ['```\n[d]: https://example.com\n```', 'text'])
  })

  it('keeps a half-typed list marker with the list above it', () => {
    assert.deepEqual(splitMarkdownBlocks('1. one\n\n2.'), ['1. one\n\n2.'])
  })
})
