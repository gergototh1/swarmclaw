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
})
