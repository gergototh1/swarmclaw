import assert from 'node:assert/strict'
import test from 'node:test'

import JSZip from 'jszip'
import { Packer } from 'docx'

import { buildDocxDocument } from '../ui/export/docx-from-markdown.ts'
import { exportFileName } from '../ui/export/file-name.ts'
import { withTitleHeading } from '../ui/export/title-heading.ts'

async function documentXml(md, title) {
  const buffer = await Packer.toBuffer(buildDocxDocument(md, title))
  const zip = await JSZip.loadAsync(buffer)
  return zip.file('word/document.xml').async('string')
}

async function stylesXml(md, title) {
  const buffer = await Packer.toBuffer(buildDocxDocument(md, title))
  const zip = await JSZip.loadAsync(buffer)
  return zip.file('word/styles.xml').async('string')
}

test('headings and inline styles reach the Word document', async () => {
  const xml = await documentXml('# Report\n\nSome **bold** and *leaning* and `code`.\n\n## Part two', 'Report')
  assert.match(xml, /w:val="Heading1"/)
  assert.match(xml, /w:val="Heading2"/)
  assert.match(xml, /Report/)
  assert.match(xml, /bold/)
  assert.match(xml, /<w:b\/>|<w:b w:val="true"\/>/)
  assert.match(xml, /<w:i\/>|<w:i w:val="true"\/>/)
})

test('lists, tables, code and wiki links are converted', async () => {
  const md = '# T\n\n- a\n- b\n\n1. one\n2. two\n\n| h1 | h2 |\n|---|---|\n| c1 | c2 |\n\n```\nconst x = 1\n```\n\nSee [[Other doc]].'
  const xml = await documentXml(md, 'T')
  assert.match(xml, /<w:numPr>/)
  assert.match(xml, /<w:tbl>/)
  assert.match(xml, /c2/)
  assert.match(xml, /Menlo/)
  assert.match(xml, /const x = 1/)
  assert.match(xml, /Other doc/)
  assert.doesNotMatch(xml, /\[\[/)
})

test('the title becomes the first heading only when the doc does not start with one', () => {
  assert.equal(withTitleHeading('Just text', 'My doc'), '# My doc\n\nJust text')
  assert.equal(withTitleHeading('\n# Own heading\n\nx', 'My doc'), '\n# Own heading\n\nx')
  assert.equal(withTitleHeading('## Sub first', 'My doc'), '# My doc\n\n## Sub first')
  assert.equal(withTitleHeading('text', '  '), 'text')
})

test('paragraphs get default spacing so they do not touch, and the body font is Helvetica Neue', async () => {
  const xml = await stylesXml('# Report\n\nSome text.', 'Report')
  // The document defaults, not just an individual style: this is what stops
  // every paragraph in the file from touching its neighbour.
  assert.match(xml, /<w:docDefaults>[\s\S]*<w:spacing[^>]*w:after="240"[^>]*\/>[\s\S]*<\/w:docDefaults>/)
  assert.match(xml, /<w:docDefaults>[\s\S]*<w:rFonts[^>]*w:ascii="Helvetica Neue"[^>]*\/>[\s\S]*<\/w:docDefaults>/)
})

test('headings get clearly more space before them than after, and list items stay tighter than body paragraphs', async () => {
  const xml = await stylesXml('# Report\n\n## Part two\n\n- a\n- b', 'Report')
  const styleBlock = (id) => new RegExp(`<w:style [^>]*w:styleId="${id}"[^>]*>[\\s\\S]*?<\\/w:style>`).exec(xml)?.[0] ?? ''
  const spacingOf = (block) => {
    const match = /<w:spacing\b([^/]*)\/>/.exec(block)
    const attrs = match?.[1] ?? ''
    const before = /w:before="(\d+)"/.exec(attrs)?.[1]
    const after = /w:after="(\d+)"/.exec(attrs)?.[1]
    return { before: before ? Number(before) : undefined, after: after ? Number(after) : undefined }
  }

  const heading1 = spacingOf(styleBlock('Heading1'))
  const heading2 = spacingOf(styleBlock('Heading2'))
  const listParagraph = spacingOf(styleBlock('ListParagraph'))

  assert.ok(heading1.before !== undefined && heading1.after !== undefined)
  assert.ok(heading1.before > heading1.after * 2, 'Heading1 should have well over double the space before as after')
  assert.ok(heading2.before !== undefined && heading2.after !== undefined)
  assert.ok(heading2.before > heading2.after * 2, 'Heading2 should have well over double the space before as after')

  const bodyAfter = 240
  assert.ok(listParagraph.after !== undefined && listParagraph.after < bodyAfter, 'list items should stay tighter than body paragraphs')
})

test('heading styles are a dark colour, never Word\'s default blue', async () => {
  const xml = await stylesXml('# Report\n\n## Part two', 'Report')
  const heading1 = /<w:style [^>]*w:styleId="Heading1"[^>]*>[\s\S]*?<\/w:style>/.exec(xml)?.[0] ?? ''
  assert.ok(heading1, 'Heading1 style is not defined')
  assert.match(heading1, /w:val="1A1A1A"/)
  // 2E74B5 is Word's own default Heading 1 blue -- the colour this fix replaces.
  assert.doesNotMatch(heading1, /w:val="2E74B5"/i)
})

test('file names drop what a file system refuses, and never come out empty', () => {
  assert.equal(exportFileName('Q3 report: draft/v2', 'docx'), 'Q3 report draftv2.docx')
  assert.equal(exportFileName('Ügyfél — ajánlat', 'pdf'), 'Ügyfél — ajánlat.pdf')
  assert.equal(exportFileName('  ', 'pdf'), 'doc.pdf')
  assert.equal(exportFileName('a'.repeat(300), 'docx').length, 125)
})
