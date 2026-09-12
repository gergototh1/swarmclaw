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

test('file names drop what a file system refuses, and never come out empty', () => {
  assert.equal(exportFileName('Q3 report: draft/v2', 'docx'), 'Q3 report draftv2.docx')
  assert.equal(exportFileName('Ügyfél — ajánlat', 'pdf'), 'Ügyfél — ajánlat.pdf')
  assert.equal(exportFileName('  ', 'pdf'), 'doc.pdf')
  assert.equal(exportFileName('a'.repeat(300), 'docx').length, 125)
})
